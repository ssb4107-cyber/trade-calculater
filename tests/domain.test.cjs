const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");

function runtime(files, globals = {}) {
    const context = vm.createContext({ console, ...globals });
    for (const file of files) {
        vm.runInContext(fs.readFileSync(path.join(root, "js", file), "utf8"), context);
    }
    return context;
}

function storage() {
    const data = new Map();
    return {
        getItem: key => data.get(key) ?? null,
        setItem: (key, value) => data.set(key, value)
    };
}

const holding = (qty = 2, trades = []) => ({
    id: 1, buyPrice: 10, buyQty: qty, remainQty: qty, trades, realizedPnL: 0
});
const stock = (price, connected = true, positions = [holding()]) => ({
    id: "A", symbol: "A", connected, currentPrice: price, positions
});

test("unknown quotes never become zero-price losses", () => {
    const context = runtime(["dashboard.js"], { stocks: [], selectedIndex: 0 });
    for (const item of [stock(null), stock(null, false), stock(0), stock(Infinity)]) {
        context.stocks = [item];
        const summary = vm.runInContext("calculateDashboard(stocks[0])", context);
        assert.equal(summary.totalBuy, 20);
        assert.equal(summary.realized, 0);
        assert.equal(summary.totalValue, null);
        assert.equal(summary.unrealized, null);
        assert.equal(summary.rate, null);
        assert.equal(vm.runInContext("getPositionRate(stocks[0].positions[0])", context), null);
    }
});

test("dashboard uses the supplied stock and known prices", () => {
    const context = runtime(["dashboard.js"], {
        stocks: [stock(12), { ...stock(99), id: "B" }], selectedIndex: 1
    });
    const summary = vm.runInContext("calculateDashboard(stocks[0])", context);
    assert.equal(summary.totalValue, 24);
    assert.equal(summary.unrealized, 4);
    assert.equal(summary.rate, 20);
});

test("completed trades keep realized results without a quote", () => {
    const position = { ...holding(), remainQty: 0, realizedPnL: 4 };
    const context = runtime(["dashboard.js"], { stocks: [stock(null, false, [position])], selectedIndex: 0 });
    const summary = vm.runInContext("calculateDashboard(stocks[0])", context);
    assert.equal(summary.totalValue, 0);
    assert.equal(summary.unrealized, 0);
    assert.equal(summary.realized, 4);
    assert.equal(summary.rate, 20);
    assert.equal(vm.runInContext("getPositionRate(stocks[0].positions[0])", context), 20);
    context.stocks[0].connected = true;
    context.stocks[0].currentPrice = 1000;
    assert.equal(vm.runInContext("getPositionRate(stocks[0].positions[0])", context), 20);
});

test("partial sales expose realized profit and mark unknown valuation", () => {
    const position = { ...holding(), remainQty: 1, realizedPnL: 3 };
    const context = runtime(["dashboard.js"], { stocks: [stock(null, true, [position])], selectedIndex: 0 });
    const summary = vm.runInContext("calculateDashboard(stocks[0])", context);
    assert.equal(summary.realized, 3);
    assert.equal(summary.unrealized, null);
    assert.equal(vm.runInContext("getPositionTotalPnL(stocks[0].positions[0])", context), null);
});

test("decimal and very small quantities close exactly", () => {
    const context = runtime(["positionService.js"]);
    const service = vm.runInContext("PositionService", context);
    for (const [qty, sells] of [[0.3, [0.1, 0.2]], [0.005, [0.001, 0.004]], [1e-25, [2e-26, 8e-26]]]) {
        const position = holding(qty, sells.map((amount, index) => ({ id: index + 1, type: "SELL", qty: amount, price: 12 })));
        service.recalculatePosition(position);
        assert.equal(position.remainQty, 0);
        assert.equal(position.status, "CLOSED");
        assert.equal(service.getTotalSoldQty(position), qty);
    }
    assert.equal(service.sumQuantities(0.1, 0.2), 0.3);
    assert.equal(service.sumQuantities(1e21, -1e21, 0.005), 0.005);
    assert.equal(service.sumQuantities(), 0);
});

test("loading preserves empty portfolios and never writes", () => {
    const localStorage = storage();
    localStorage.setItem("portfolioStocks", "[]");
    localStorage.setItem = () => { throw new Error("A read must not write"); };
    const context = runtime(["storage.js"], { localStorage });
    assert.equal(vm.runInContext("PortfolioStorage.loadStocks().length", context), 0);
});

test("legacy records have stable identities across read-only loads", () => {
    const localStorage = storage();
    localStorage.setItem("portfolioStocks", JSON.stringify([{ symbol: "a", positions: [{ buyQty: 1, trades: [{ qty: 0.5, date: "2026-10-06T00:00:00Z" }] }] }]));
    const context = runtime(["storage.js"], { localStorage });
    assert.equal(vm.runInContext("JSON.stringify(PortfolioStorage.loadStocks())", context),
        vm.runInContext("JSON.stringify(PortfolioStorage.loadStocks())", context));
});

test("simultaneous tab transactions preserve both writes and unique position ids", async () => {
    const localStorage = storage();
    localStorage.setItem("portfolioStocks", JSON.stringify([stock(null, false, [])]));
    let pending = Promise.resolve();
    const navigator = { locks: { request: (_name, callback) => {
        const next = pending.then(callback);
        pending = next.catch(() => {});
        return next;
    } } };
    const tabs = [0, 1].map(() => runtime(["storage.js", "positionService.js"], { localStorage, navigator }));
    await Promise.all(tabs.map((context, index) => {
        context.label = `tab-${index}`;
        return vm.runInContext(`PortfolioStorage.updateStocks(latest => {
            latest[0].positions.push({ ...${JSON.stringify(holding())},
                id: PositionService.nextId(latest[0].positions), memo: label });
        })`, context);
    }));
    const positions = JSON.parse(localStorage.getItem("portfolioStocks"))[0].positions;
    assert.equal(positions.length, 2);
    assert.equal(new Set(positions.map(item => item.id)).size, 2);
    assert.deepEqual(positions.map(item => item.memo), ["tab-0", "tab-1"]);
});

test("a failed write does not poison subsequent transactions", async () => {
    const localStorage = storage();
    localStorage.setItem("portfolioStocks", JSON.stringify([stock(null, false)]));
    const context = runtime(["storage.js"], { localStorage });
    const originalSet = localStorage.setItem;
    localStorage.setItem = () => { throw new Error("quota"); };
    await assert.rejects(vm.runInContext("PortfolioStorage.updateStocks(latest => { latest[0].memo = 'lost'; })", context), /quota/);
    localStorage.setItem = originalSet;
    await vm.runInContext("PortfolioStorage.updateStocks(latest => { latest[0].memo = 'saved'; })", context);
    assert.equal(JSON.parse(localStorage.getItem("portfolioStocks"))[0].memo, "saved");
});
