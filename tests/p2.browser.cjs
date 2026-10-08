const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
const errors = [];
const contexts = [];
let browser, base, passed = 0;
const stock = (id = "A", extra = {}) => ({ id, displayName: id, symbol: "", connected: false, positions: [], ...extra });
const position = (extra = {}) => ({ id: 1, number: 1, buyPrice: 10, buyQty: 1, trades: [], ...extra });
const server = http.createServer((req, res) => {
    const file = path.resolve(root, "." + decodeURIComponent(req.url.split("?")[0]));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    try {
        res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
        res.end(file.endsWith("backendConfig.js") ? 'const SilverBackendConfig = {};' : fs.readFileSync(file));
    } catch { res.writeHead(404); res.end(); }
});
async function check(name, test) { await test(); passed++; console.log("PASS " + name); }
async function setup(stocks, settings = {}, history = []) {
    const context = await browser.newContext(); contexts.push(context);
    await context.route("https://**/*", route => route.abort());
    await context.addInitScript(seed => {
        if (!localStorage.getItem("p2seed")) {
            localStorage.setItem("portfolioStocks", JSON.stringify(seed.stocks));
            localStorage.setItem("silverStrategySettings", JSON.stringify(seed.settings));
            localStorage.setItem("stockHistory", JSON.stringify(seed.history));
            localStorage.setItem("p2seed", "1");
        }
    }, { stocks, settings, history });
    const open = async (url = "/pages/portfolio.html") => {
        const page = await context.newPage();
        page.on("pageerror", error => errors.push(error.message));
        page.on("dialog", dialog => dialog.accept());
        await page.goto(base + url);
        await page.waitForFunction(() => typeof SilverSettings !== "undefined");
        return page;
    };
    return { context, page: await open(), open };
}
(async () => {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || "msedge" });
    await check("R01 simultaneous pins and independent map updates survive 10 repetitions", async () => {
        const { page, open } = await setup([stock("A"), stock("B")]); const second = await open();
        for (let i = 0; i < 10; i++) {
            await page.evaluate(() => SilverSettings.update({ pinnedSymbols: [], apiFailureCountBySymbol: {} }));
            await Promise.all([page.evaluate(() => togglePinnedStock(getStockById("A"))), second.evaluate(() => togglePinnedStock(getStockById("B")))]);
            await Promise.all([page.evaluate(() => setApiFailureCount("A", 1)), second.evaluate(() => setApiFailureCount("B", 2))]);
            await page.waitForFunction(() => SilverSettings.load().pinnedSymbols.length === 2 && Object.keys(SilverSettings.load().apiFailureCountBySymbol).length === 2);
            assert.deepEqual(await page.evaluate(() => SilverSettings.load().pinnedSymbols.slice().sort()), ["A", "B"]);
        }
    });
    await check("R02 calculator concurrent saves preserve both records and unique IDs", async () => {
        const { page, open } = await setup([]); await page.goto(base + "/pages/calculator.html"); const second = await open("/pages/calculator.html");
        await page.locator("#autoDecimal").uncheck(); await second.locator("#autoDecimal").uncheck();
        await page.locator("#basePrice").fill("10"); await second.locator("#basePrice").fill("20");
        for (let i = 0; i < 10; i++) {
            await page.evaluate(() => HistoryStorage.update(items => { items.length = 0; }));
            await Promise.all([page.locator('[data-percent="1"]').click(), second.locator('[data-percent="1"]').click()]);
            await page.waitForFunction(() => HistoryStorage.load().length === 2);
            const records = await page.evaluate(() => HistoryStorage.load());
            assert.deepEqual(records.map(r => r.price).sort((a,b) => a-b), [10,20]);
            assert.equal(new Set(records.map(r => r.id)).size, 2);
        }
    });
    for (const kind of ["position", "trade", "stockSettings"]) await check("R03 pending save preserves reopened " + kind + " draft", async () => {
        const { page, open } = await setup([stock("A", { positions: [position()] })]); const second = await open();
        await second.evaluate(() => new Promise(resolve => {
            window.held = navigator.locks.request("silver-write:portfolioStocks", async () => {
                const blocked = new Promise(release => { window.release = release; }); resolve(); await blocked;
            });
        }));
        await page.evaluate(kind => {
            if (kind === "position") { openAddPositionModal(); dom.buyPrice.value = "10"; dom.buyQty.value = "2"; window.saving = savePosition(); }
            if (kind === "trade") { openTradeModal(getStock().positions[0]); dom.sellPrice.value = "12"; dom.sellQty.value = ".2"; window.saving = saveTrade(); }
            if (kind === "stockSettings") { openStockSettingsModal(getStock()); dom.stockDisplayName.value = "first"; window.saving = saveStockSettings(); }
        }, kind);
        await page.locator(kind === "position" ? "#cancelPositionBtn" : kind === "trade" ? "#cancelTradeBtn" : "#cancelStockSettingsBtn").click();
        await page.evaluate(kind => {
            if (kind === "position") { openAddPositionModal(); dom.buyMemo.value = "new draft"; }
            if (kind === "trade") { openTradeModal(getStock().positions[0]); dom.sellPrice.value = "99"; }
            if (kind === "stockSettings") { openStockSettingsModal(getStock()); dom.stockDisplayName.value = "new draft"; }
        }, kind);
        await second.evaluate(async () => { window.release(); await window.held; });
        await page.evaluate(() => window.saving);
        assert.deepEqual(await page.evaluate(kind => ({ hidden: (kind === "position" ? dom.positionModal : kind === "trade" ? dom.tradeModal : dom.stockSettingsModal).getAttribute("aria-hidden"),
            value: kind === "position" ? dom.buyMemo.value : kind === "trade" ? dom.sellPrice.value : dom.stockDisplayName.value }), kind),
            { hidden: "false", value: kind === "trade" ? "99" : "new draft" });
    });
    await check("R03 edits made in the same pending form survive completion", async () => {
        const { page, open } = await setup([stock("A")]); const second = await open();
        await second.evaluate(() => new Promise(resolve => {
            window.held = navigator.locks.request("silver-write:portfolioStocks", async () => {
                const blocked = new Promise(release => { window.release = release; }); resolve(); await blocked;
            });
        }));
        await page.evaluate(() => { openAddPositionModal(); dom.buyPrice.value = "10"; dom.buyQty.value = "1"; window.saving = savePosition(); dom.buyMemo.value = "typed while saving"; });
        await second.evaluate(async () => { window.release(); await window.held; }); await page.evaluate(() => window.saving);
        assert.equal(await page.locator("#positionModal").isVisible(), true);
        assert.equal(await page.locator("#buyMemo").inputValue(), "typed while saving");
    });
    await check("R04 duplicate position and sale IDs delete only the selected item, with raw backup", async () => {
        const trades = [{ id: 1, type: "SELL", qty: .1, price: 12 }, { id: 1, type: "SELL", qty: .2, price: 13 }];
        const initial = [stock("A", { positions: [position({ trades }), position({ memo: "keep" })] })];
        const { page } = await setup(initial);
        assert.equal(await page.evaluate(() => new Set(getStock().positions.map(p => p.id)).size), 2);
        await page.evaluate(() => deleteTrade(1, 1));
        assert.equal(await page.evaluate(() => getStock().positions[0].trades.length), 1);
        await page.evaluate(() => deletePosition(1));
        assert.equal(await page.evaluate(() => getStock().positions.length), 1);
        assert.equal(await page.evaluate(() => getStock().positions[0].memo), "keep");
        assert.deepEqual(await page.evaluate(() => JSON.parse(JSON.parse(localStorage.getItem("portfolioStocks.recoveryBackup")).raw)), initial);
    });
    await check("R05 unknown sale type and oversold positions are quarantined with original preserved", async () => {
        const initial = [stock("A", { positions: [position(), position({ id: 2, trades: [{ id: 1, type: "SELLL", qty: .5, price: 12 }] }),
            position({ id: 3, trades: [{ id: 1, type: "SELL", qty: 2, price: 12 }] })] })];
        const { page } = await setup(initial);
        assert.equal(await page.evaluate(() => getStock().positions.length), 1);
        await page.evaluate(() => persistStockChange(latest => { latest[0].memo = "safe edit"; }));
        assert.deepEqual(await page.evaluate(() => JSON.parse(JSON.parse(localStorage.getItem("portfolioStocks.recoveryBackup")).raw)), initial);
    });
    await check("R06 numeric string calculator ID deletes successfully", async () => {
        const { page } = await setup([], {}, [{ id: "123", price: 10, pct: 1, buy: "9.9", sell: "10.1" }]);
        await page.goto(base + "/pages/calculator.html"); await page.locator('[data-delete-id="123"]').click();
        await page.waitForFunction(() => HistoryStorage.load().length === 0);
    });
    await check("R07 real mouse drag survives another tab's background settings update", async () => {
        const { page, open } = await setup([stock("A"), stock("B"), stock("C")]); const second = await open();
        const a = await page.locator(".stock-row").nth(0).boundingBox(), c = await page.locator(".stock-row").nth(2).boundingBox();
        await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
        await page.mouse.move(c.x + c.width / 2, c.y + c.height - 2, { steps: 15 });
        await page.waitForFunction(() => Boolean(document.querySelector(".dragging")));
        await second.evaluate(() => setApiFailureCount("A", 1));
        await page.waitForFunction(() => getApiFailureCount("A") === 1);
        assert.equal(await page.locator(".dragging").count(), 1);
        await page.mouse.up();
        await page.waitForFunction(() => SilverSettings.load().stockOrder.join(",") === "B,C,A");
        await page.reload(); assert.deepEqual(await page.locator(".stock-row").evaluateAll(rows => rows.map(r => r.dataset.stockId)), ["B", "C", "A"]);
    });
    await check("R08 older quote from another window cannot overwrite a newer quote", async () => {
        const { page, open } = await setup([stock("A", { connected: true, symbol: "A" })]); const second = await open();
        for (const target of [page, second]) {
            await target.evaluate(() => {
                PriceProvider.getCurrentPrice = () => new Promise(resolve => { window.resolvePrice = resolve; });
                window.pendingPrice = updateCurrentPrice();
            });
            await target.waitForFunction(() => typeof window.resolvePrice === "function");
        }
        await second.waitForFunction(() => typeof window.resolvePrice === "function");
        await second.evaluate(async () => { window.resolvePrice({ ok: true, price: 25 }); await window.pendingPrice; });
        await page.evaluate(async () => { window.resolvePrice({ ok: true, price: 20 }); await window.pendingPrice; });
        await page.reload(); assert.equal(await page.evaluate(() => getStock().currentPrice), 25);
    });
    for (const [width, height] of [[600,300],[667,375],[683,384]]) for (const collapsed of [false,true]) await check(`R09 content accessible at ${width}x${height}, collapsed=${collapsed}`, async () => {
        const { page } = await setup([stock("A", { positions: [position()] })], { sidebarCollapsed: collapsed });
        await page.setViewportSize({ width, height }); await page.goto(base + "/index.html");
        const inner = page.frameLocator("#pageFrame");
        await inner.locator("#addPositionBtn").scrollIntoViewIfNeeded();
        await inner.locator("#addPositionBtn").click();
        await inner.locator("#buyQty").fill(".5");
        await inner.locator("#cancelPositionBtn").click();
        if (process.env.TEST_SCREENSHOT_DIR && width === 683 && collapsed) {
            fs.mkdirSync(process.env.TEST_SCREENSHOT_DIR, { recursive: true });
            await page.screenshot({ path: path.join(process.env.TEST_SCREENSHOT_DIR, "short-screen.png") });
        }
        assert.equal(await inner.locator(".portfolio-content").evaluate(node => node.clientHeight > 32), true);
    });
    assert.deepEqual(errors, []);
    console.log(`${passed} P2 browser scenarios passed; no uncaught page errors.`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    for (const context of contexts) await context.close();
    if (browser) await browser.close(); server.close();
});
