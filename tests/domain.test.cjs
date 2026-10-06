const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");

function runtime(files, globals = {}) {
    const context = vm.createContext({ console, ...globals });
    for (const file of new Set(["safeStorage.js", ...files])) {
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

test("F09 isolates damaged items and preserves the exact original before saving", async () => {
    const localStorage = storage();
    const original = JSON.stringify([stock(null, false, [holding(), null]), null]);
    localStorage.setItem("portfolioStocks", original);
    const context = runtime(["storage.js"], { localStorage });
    assert.equal(vm.runInContext("PortfolioStorage.loadStocks().length", context), 1);
    assert.equal(vm.runInContext("PortfolioStorage.loadStocks()[0].positions.length", context), 1);
    assert.equal(localStorage.getItem("portfolioStocks"), original);
    await vm.runInContext("PortfolioStorage.updateStocks(latest => { latest[0].memo = 'recovered'; })", context);
    assert.equal(JSON.parse(localStorage.getItem("portfolioStocks.recoveryBackup")).raw, original);
    assert.equal(JSON.parse(localStorage.getItem("portfolioStocks"))[0].memo, "recovered");
});

test("F09 unparseable data is never replaced with an empty/default portfolio", async () => {
    const localStorage = storage();
    const original = '[{"id":"A"';
    localStorage.setItem("portfolioStocks", original);
    const context = runtime(["storage.js"], { localStorage });
    assert.equal(vm.runInContext("PortfolioStorage.loadStocks().length", context), 0);
    await assert.rejects(vm.runInContext("PortfolioStorage.updateStocks(latest => latest.push({id: 'new'}))", context),
        error => error.name === "StorageRecoveryRequired");
    assert.equal(localStorage.getItem("portfolioStocks"), original);
    assert.equal(JSON.parse(localStorage.getItem("portfolioStocks.recoveryBackup")).raw, original);
});

test("F09 a failed recovery backup cannot overwrite the damaged original", async () => {
    const localStorage = storage();
    const original = JSON.stringify([stock(null, false), null]);
    localStorage.setItem("portfolioStocks", original);
    const set = localStorage.setItem;
    localStorage.setItem = (key, value) => {
        if (key.includes("recoveryBackup")) throw new Error("quota");
        set(key, value);
    };
    const context = runtime(["storage.js"], { localStorage });
    await assert.rejects(vm.runInContext("PortfolioStorage.updateStocks(latest => { latest[0].memo = 'new'; })", context), /quota/);
    assert.equal(localStorage.getItem("portfolioStocks"), original);
});

function settingsGlobals(localStorage) {
    return { localStorage, window: { dispatchEvent() {} }, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } };
}

test("F09 wrong settings types fall back while valid settings and raw backup survive", () => {
    const localStorage = storage();
    const original = JSON.stringify({ stockOrder: {}, pinnedSymbols: ["A", null], recentSymbols: 1,
        apiRefreshIntervalMinutes: true, darkMode: true, priceCacheBySymbol: { A: null } });
    localStorage.setItem("silverStrategySettings", original);
    const context = runtime(["settingsStore.js"], settingsGlobals(localStorage));
    const loaded = vm.runInContext("SilverSettings.load()", context);
    assert.deepEqual(Array.from(loaded.stockOrder), []);
    assert.deepEqual(Array.from(loaded.pinnedSymbols), ["A"]);
    assert.equal(loaded.darkMode, true);
    assert.equal(loaded.apiRefreshIntervalMinutes, 5);
    vm.runInContext("SilverSettings.update({ apiRefreshIntervalMinutes: 10 })", context);
    assert.equal(JSON.parse(localStorage.getItem("silverStrategySettings.recoveryBackup")).raw, original);
    assert.equal(vm.runInContext("SilverSettings.load().apiRefreshIntervalMinutes", context), 10);
});

test("F10 failed settings saves retain saved state and emit no success event", () => {
    const localStorage = storage();
    localStorage.setItem("silverStrategySettings", JSON.stringify({ darkMode: false }));
    let events = 0;
    const globals = settingsGlobals(localStorage);
    globals.window.dispatchEvent = () => events += 1;
    const context = runtime(["settingsStore.js"], globals);
    localStorage.setItem = () => { throw new Error("quota"); };
    assert.equal(vm.runInContext("SilverSettings.tryUpdate({ darkMode: true })", context), null);
    assert.equal(vm.runInContext("SilverSettings.load().darkMode", context), false);
    assert.equal(events, 0);
});

function fakeTimers() {
    let clock = 0;
    let id = 0;
    const jobs = new Map();
    return {
        setTimeout(callback, delay) { const key = ++id; jobs.set(key, { callback, time: clock + delay }); return key; },
        clearTimeout(key) { jobs.delete(key); },
        async tick(delay) {
            const target = clock + delay;
            while (true) {
                const next = [...jobs].filter(([, job]) => job.time <= target).sort((a, b) => a[1].time - b[1].time)[0];
                if (!next) break;
                clock = next[1].time;
                jobs.delete(next[0]);
                next[1].callback();
                for (let index = 0; index < 12; index += 1) await Promise.resolve();
            }
            clock = target;
        }
    };
}

test("F10 a quote cache write failure keeps the persisted cache and valid API result", async () => {
    const localStorage = storage();
    localStorage.setItem("silverStrategySettings", JSON.stringify({ finnhubApiKey: "TEST",
        priceCacheBySymbol: { A: { price: 20, cachedAt: 0, updatedAt: "2026-10-06T00:00:00Z" } } }));
    const context = runtime(["settingsStore.js", "priceProvider.js"], { ...settingsGlobals(localStorage),
        SilverAppConfig: { DEFAULT_FINNHUB_API_KEY: "" }, AbortController, setTimeout, clearTimeout,
        fetch: async () => ({ ok: true, json: async () => ({ c: 25 }) }) });
    localStorage.setItem = () => { throw new Error("quota"); };
    const result = await vm.runInContext("PriceProvider.getCurrentPrice('A', {force: true})", context);
    assert.equal(result.ok, true);
    assert.equal(result.price, 25);
    assert.equal(result.cacheSaved, false);
    assert.equal(vm.runInContext("PriceProvider.getCachedPrice('A').price", context), 20);
});

test("F18 timeout covers stalled fetch and response body", async () => {
    for (const bodyStalls of [false, true]) {
        const localStorage = storage();
        localStorage.setItem("silverStrategySettings", JSON.stringify({ finnhubApiKey: "TEST" }));
        const timers = fakeTimers();
        let signal;
        const context = runtime(["settingsStore.js", "priceProvider.js"], { ...settingsGlobals(localStorage),
            SilverAppConfig: { DEFAULT_FINNHUB_API_KEY: "" }, AbortController,
            setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
            fetch: (_url, options) => { signal = options.signal; return bodyStalls
                ? Promise.resolve({ ok: true, json: () => new Promise(() => {}) }) : new Promise(() => {}); } });
        const pending = vm.runInContext("PriceProvider.getCurrentPrice('A', {force: true})", context);
        await timers.tick(15000);
        const result = await pending;
        assert.equal(result.ok, false);
        assert.equal(result.price, null);
        assert.equal(signal.aborted, true);
    }
});

test("F18 after a timeout the next scheduled refresh succeeds", async () => {
    const localStorage = storage();
    localStorage.setItem("silverStrategySettings", JSON.stringify({ finnhubApiKey: "TEST" }));
    const timers = fakeTimers();
    let calls = 0;
    const context = runtime(["settingsStore.js", "priceProvider.js", "refreshManager.js"], { ...settingsGlobals(localStorage),
        SilverAppConfig: { DEFAULT_FINNHUB_API_KEY: "" }, AbortController,
        setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
        fetch: () => ++calls === 1 ? new Promise(() => {}) : Promise.resolve({ ok: true, json: async () => ({ c: 30 }) }) });
    vm.runInContext("RefreshManager.start({refresh: () => PriceProvider.getCurrentPrice('A', {force:true}), getIntervalMs: () => 60000})", context);
    await timers.tick(15000);
    await timers.tick(45000);
    assert.equal(calls, 2);
    assert.equal(vm.runInContext("PriceProvider.getCachedPrice('A').price", context), 30);
});

test("F11 a disabled initial selection still has an active scheduler", async () => {
    const timers = fakeTimers();
    let enabled = false;
    let calls = 0;
    const context = runtime(["refreshManager.js"], { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
        isEnabled: () => enabled, refresh: async () => calls += 1 });
    vm.runInContext("RefreshManager.start({refresh, isEnabled, getIntervalMs: () => 60000})", context);
    assert.equal(calls, 0);
    enabled = true;
    await timers.tick(60000);
    assert.equal(calls, 1);
});
