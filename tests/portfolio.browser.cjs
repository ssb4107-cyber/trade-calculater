const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
const errors = [];
let browser;
let base;
let passed = 0;
const contexts = [];

const position = (qty = 1, overrides = {}) => ({
    id: 1, number: 1, buyPrice: 10, buyQty: qty, remainQty: qty,
    buyDate: "2026-10-06", memo: "", realizedPnL: 0, trades: [], ...overrides
});
const stock = (id = "A", overrides = {}) => ({
    id, displayName: id, name: id, symbol: "", connected: false,
    currentPrice: null, memo: "", positions: [], ...overrides
});
const server = http.createServer((req, res) => {
    const file = path.resolve(root, `.${decodeURIComponent(req.url.split("?")[0])}`);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    try {
        res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript"
            : file.endsWith(".css") ? "text/css" : "text/html");
        // Never serve the repository's real API key during tests.
        res.end(file.endsWith("appConfig.js")
            ? 'const SilverAppConfig = { DEFAULT_FINNHUB_API_KEY: "" };'
            : file.endsWith("backendConfig.js") ? 'const SilverBackendConfig = {};'
            : fs.readFileSync(file));
    } catch { res.writeHead(404); res.end(); }
});

async function scenario(stocks, settings = {}) {
    const context = await browser.newContext({ timezoneId: "Asia/Seoul" });
    contexts.push(context);
    await context.route("https://**/*", route => route.abort());
    await context.addInitScript(seed => {
        if (!localStorage.getItem("p1TestSeeded")) {
            localStorage.setItem("portfolioStocks", JSON.stringify(seed.stocks));
            localStorage.setItem("silverStrategySettings", JSON.stringify(seed.settings));
            localStorage.setItem("p1TestSeeded", "1");
        }
    }, { stocks, settings: { finnhubApiKey: "", ...settings } });
    const alerts = [];
    const open = async () => {
        const page = await context.newPage();
        page.on("pageerror", error => errors.push(error.message));
        page.on("dialog", async dialog => { alerts.push(dialog.message()); await dialog.accept(); });
        await page.goto(`${base}/pages/portfolio.html`);
        await page.waitForFunction(() => typeof persistStockChange === "function" && document.body && !document.body.inert);
        return page;
    };
    return { context, page: await open(), open, alerts };
}

async function check(name, run) {
    if (process.env.BROWSER_TEST_MATCH && !name.includes(process.env.BROWSER_TEST_MATCH)) return;
    await run();
    passed += 1;
    console.log(`PASS ${name}`);
}

async function addPosition(page, qty, price = "10.00") {
    await page.locator("#addPositionBtn").click();
    await page.locator("#buyPrice").fill(price);
    await page.locator("#buyQty").fill(qty);
    await page.locator("#savePositionBtn").click();
    await page.locator("#positionModal").waitFor({ state: "hidden" });
}

async function sell(page, qty, price = "12.00") {
    await page.locator(".sellBtn").click();
    await page.locator("#sellPrice").fill(price);
    await page.locator("#sellQty").fill(qty);
    await page.locator("#saveTradeBtn").click();
    await page.locator("#tradeModal").waitFor({ state: "hidden" });
}

const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem("portfolioStocks")));

(async () => {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || "msedge" });

    for (const connected of [false, true]) {
        await check(`F02 missing quote, connected=${connected}`, async () => {
            const { page } = await scenario([stock("A", { symbol: connected ? "A" : "", connected, positions: [position(2)] })]);
            for (const id of ["currentPriceText", "totalValue", "unrealizedPnL", "totalRate"]) {
                assert.equal(await page.locator(`#${id}`).textContent(), "—");
            }
            assert.equal(await page.locator("#totalBuy").textContent(), "$20.00");
            assert.equal(await page.locator("#realizedPnL").textContent(), "$0.00");
            assert(!await page.locator("#positionList").textContent().then(text => text.includes("-100.00%")));
        });
    }

    await check("F02 known quote retains normal valuation", async () => {
        const { page } = await scenario([stock("A", { symbol: "A", connected: true, currentPrice: 12, positions: [position(2)] })]);
        assert.equal(await page.locator("#unrealizedPnL").textContent(), "$4.00");
        assert.equal(await page.locator("#totalRate").textContent(), "20.00%");
    });

    await check("F05 blur, save, edit, clone and reload retain precision", async () => {
        const { page } = await scenario([stock()]);
        await page.locator("#addPositionBtn").click();
        await page.locator("#buyPrice").fill("10.1234567");
        await page.locator("#buyQty").fill("0.005");
        await page.locator("#buyDate").focus();
        assert.equal(await page.locator("#buyQty").inputValue(), "0.005");
        await page.locator("#savePositionBtn").click();
        await page.locator("#positionModal").waitFor({ state: "hidden" });
        await page.locator(".editPositionBtn").click();
        assert.equal(await page.locator("#buyPrice").inputValue(), "10.1234567");
        assert.equal(await page.locator("#buyQty").inputValue(), "0.005");
        await page.locator("#buyMemo").fill("memo only");
        await page.locator("#savePositionBtn").click();
        await page.locator("#positionModal").waitFor({ state: "hidden" });
        await page.locator(".clonePositionBtn").click();
        assert.equal(await page.locator("#buyQty").inputValue(), "0.005");
        await page.locator("#savePositionBtn").click();
        await page.locator("#positionModal").waitFor({ state: "hidden" });
        await page.reload();
        const data = (await saved(page))[0].positions;
        assert.equal(data.length, 2);
        for (const item of data) { assert.equal(item.buyQty, 0.005); assert.equal(item.buyPrice, 10.1234567); }
        assert((await page.locator("#positionList").textContent()).includes("0.005 / 0.005주"));
    });

    await check("F05 very small and grouped quantities retain their numeric values", async () => {
        const { page } = await scenario([stock()]);
        await addPosition(page, "0.0000000000000000000000001");
        await addPosition(page, "1234.5678912345");
        const data = (await saved(page))[0].positions;
        assert.equal(data[0].buyQty, 1e-25);
        assert.equal(data[1].buyQty, 1234.5678912345);
        assert.equal(await page.evaluate(() => formatEditableNumber(-1e-7)), "-0.0000001");
    });

    await check("fractional sales close exactly and closed results are stable", async () => {
        const { page, alerts } = await scenario([stock("A", { positions: [position(0.3)] })]);
        await sell(page, "0.1");
        await sell(page, "0.2");
        const item = (await saved(page))[0].positions[0];
        assert.equal(item.remainQty, 0);
        assert.equal(item.status, "CLOSED");
        assert.equal(item.trades.length, 2);
        assert.equal(alerts.length, 0);
        assert.equal(await page.locator("#totalRate").textContent(), "20.00%");
    });

    await check("F05 trade editing preserves quantity and price precision", async () => {
        const { page } = await scenario([stock("A", { positions: [position(1)] })]);
        await sell(page, "0.001234567", "12.3456789");
        await page.evaluate(() => openTradeModal(getStock().positions[0], getStock().positions[0].trades[0]));
        assert.equal(await page.locator("#sellQty").inputValue(), "0.001234567");
        assert.equal(await page.locator("#sellPrice").inputValue(), "12.3456789");
        await page.locator("#saveTradeBtn").click();
        await page.locator("#tradeModal").waitFor({ state: "hidden" });
        const trade = (await saved(page))[0].positions[0].trades[0];
        assert.equal(trade.qty, 0.001234567);
        assert.equal(trade.price, 12.3456789);
    });

    for (const switchBack of [false, true]) {
        await check(`F03 delayed quote discarded after reconnection, switchBack=${switchBack}`, async () => {
            const { page } = await scenario([stock("A", { symbol: "A", connected: true })]);
            await page.evaluate(() => {
                PriceProvider.getCurrentPrice = () => new Promise(resolve => window.resolveQuote = resolve);
                window.pendingQuote = updateCurrentPrice();
            });
            await page.evaluate(async switchBack => {
                for (const symbol of switchBack ? ["B", "A"] : ["B"]) {
                    openStockSettingsModal(getStock());
                    pendingQuoteConnection = { symbol, companyName: symbol, exchange: "TEST" };
                    await saveStockSettings();
                }
                window.resolveQuote({ ok: true, price: 777 });
                await window.pendingQuote;
            }, switchBack);
            const item = (await saved(page))[0];
            assert.equal(item.symbol, switchBack ? "A" : "B");
            assert.equal(item.currentPrice, null);
            assert.equal(item.quoteRevision, switchBack ? 2 : 1);
            assert.equal(await page.locator("#currentPriceText").textContent(), "—");
        });
    }

    await check("F03 quote response from another tab respects reconnection", async () => {
        const { page, open } = await scenario([stock("A", { symbol: "A", connected: true })]);
        const second = await open();
        await page.evaluate(() => {
            PriceProvider.getCurrentPrice = () => new Promise(resolve => window.resolveQuote = resolve);
            window.pendingQuote = updateCurrentPrice();
        });
        await second.evaluate(async () => {
            openStockSettingsModal(getStock());
            pendingQuoteConnection = { symbol: "B", companyName: "B", exchange: "TEST" };
            await saveStockSettings();
        });
        await page.evaluate(async () => { window.resolveQuote({ ok: true, price: 777 }); await window.pendingQuote; });
        assert.equal((await saved(page))[0].currentPrice, null);
        assert.equal((await saved(page))[0].symbol, "B");
    });

    await check("F03 older same-symbol response cannot replace a newer response", async () => {
        const { page } = await scenario([stock("A", { symbol: "A", connected: true })]);
        await page.evaluate(async () => {
            const resolvers = [];
            PriceProvider.getCurrentPrice = () => new Promise(resolve => resolvers.push(resolve));
            const first = updateCurrentPrice();
            const second = updateCurrentPrice();
            while (resolvers.length < 2) await new Promise(resolve => setTimeout(resolve, 10));
            resolvers[1]({ ok: true, price: 22 });
            await second;
            resolvers[0]({ ok: true, price: 11 });
            await first;
        });
        assert.equal((await saved(page))[0].currentPrice, 22);
        assert.equal(await page.locator("#updatePriceBtn").isDisabled(), false);
    });

    await check("failed quote from a different selected stock does not repaint its price", async () => {
        const { page } = await scenario([stock("A", { symbol: "A", connected: true, currentPrice: 11 }), stock("B", { symbol: "B", connected: true, currentPrice: 25 })]);
        await page.evaluate(() => {
            PriceProvider.getCurrentPrice = () => new Promise(resolve => window.resolveQuote = resolve);
            window.pendingQuote = updateCurrentPrice();
        });
        await page.locator('.stock-card[data-stock-id="B"]').click();
        await page.evaluate(async () => { window.resolveQuote({ ok: false, price: null }); await window.pendingQuote; });
        assert.equal(await page.locator("#stockTitle").textContent(), "B");
        assert.equal(await page.locator("#currentPriceText").textContent(), "$25");
    });

    await check("F04 simultaneous new stocks are preserved", async () => {
        const { page, open } = await scenario([stock()]);
        const second = await open();
        await Promise.all([page.evaluate(() => addStockFromData({ name: "from first" })), second.evaluate(() => addStockFromData({ name: "from second" }))]);
        assert.equal((await saved(page)).length, 3);
        await page.waitForFunction(() => stocks.length === 3);
        await second.waitForFunction(() => stocks.length === 3);
    });

    await check("F04 simultaneous positions survive stale tab arrays and duplicate timestamps", async () => {
        const { page, open } = await scenario([stock()]);
        const second = await open();
        const add = page => page.evaluate(async () => {
            openAddPositionModal();
            dom.buyPrice.value = "10.00";
            dom.buyQty.value = "1";
            await savePosition();
        });
        for (let index = 0; index < 10; index += 1) await Promise.all([add(page), add(second)]);
        // Another renderer's localStorage write arrives asynchronously. Wait for
        // propagation before checking all records, while retaining the exact count.
        await page.waitForFunction(() => JSON.parse(localStorage.getItem("portfolioStocks"))[0].positions.length === 20);
        const data = (await saved(page))[0].positions;
        assert.equal(data.length, 20);
        assert.equal(new Set(data.map(item => item.id)).size, 20);
        assert.equal(new Set(data.map(item => item.number)).size, 20);
    });

    await check("F04 local commit confirmation failure rolls back data and keeps the draft retryable", async () => {
        const { page, alerts } = await scenario([stock()]);
        await page.evaluate(() => {
            window.restoreLocalConfirmation = IDBObjectStore.prototype.put;
            IDBObjectStore.prototype.put = function(value, key) {
                if (this.name === "versions") throw new DOMException("test confirmation quota", "QuotaExceededError");
                return window.restoreLocalConfirmation.call(this, value, key);
            };
            openAddPositionModal(); dom.buyPrice.value = "10"; dom.buyQty.value = "2";
            return savePosition();
        });
        assert.equal((await saved(page))[0].positions.length, 0);
        assert.equal(await page.locator("#positionModal").isVisible(), true);
        assert.equal(await page.locator("#buyQty").inputValue(), "2");
        assert(alerts.some(message => message.includes("저장하지 못했습니다")));
        await page.evaluate(() => { IDBObjectStore.prototype.put = window.restoreLocalConfirmation; return savePosition(); });
        assert.equal((await saved(page))[0].positions.length, 1);
        assert.equal(await page.locator("#positionModal").isVisible(), false);
    });

    await check("F04 draft stays intact while another tab adds a trade", async () => {
        const { page, open } = await scenario([stock("A", { positions: [position(1)] })]);
        const second = await open();
        await page.locator(".editPositionBtn").click();
        await page.locator("#buyMemo").fill("draft memo");
        await sell(second, "0.25");
        await page.waitForFunction(() => getStock().positions[0].trades.length === 1);
        assert.equal(await page.locator("#buyMemo").inputValue(), "draft memo");
        assert.equal(await page.locator("#positionModal").isVisible(), true);
        await page.locator("#savePositionBtn").click();
        await page.locator("#positionModal").waitFor({ state: "hidden" });
        const item = (await saved(page))[0].positions[0];
        assert.equal(item.memo, "draft memo");
        assert.equal(item.trades.length, 1);
        assert.equal(item.remainQty, 0.75);
    });

    await check("F04 concurrent sales validate latest quantity before committing", async () => {
        const { page, open } = await scenario([stock("A", { positions: [position(1)] })]);
        const second = await open();
        // Background-tab native dialogs can be suppressed by Chromium. Record
        // the application's warning call, while verifying real form/save state.
        for (const target of [page, second]) await target.evaluate(() => {
            window.recordedSaleAlerts = [];
            window.alert = message => window.recordedSaleAlerts.push(String(message));
        });
        const sellDraft = page => page.evaluate(async () => {
            openTradeModal(getStock().positions[0]);
            dom.sellPrice.value = "12";
            dom.sellQty.value = "0.75";
            await saveTrade();
        });
        await Promise.all([sellDraft(page), sellDraft(second)]);
        const item = (await saved(page))[0].positions[0];
        assert.equal(item.trades.length, 1);
        assert.equal(item.remainQty, 0.25);
        const alerts = (await Promise.all([page, second].map(target => target.evaluate(() => window.recordedSaleAlerts)))).flat();
        assert(alerts.some(message => message.includes("보유수량을 초과")), JSON.stringify({ alerts }));
        assert.equal((await Promise.all([page, second].map(target => target.locator("#tradeModal").isVisible()))).filter(Boolean).length, 1);
    });

    await check("F04 concurrent valid sales both survive with unique trade ids", async () => {
        const { page, open, alerts } = await scenario([stock("A", { positions: [position(1)] })]);
        const second = await open();
        const sellDraft = page => page.evaluate(async () => {
            openTradeModal(getStock().positions[0]);
            dom.sellPrice.value = "12";
            dom.sellQty.value = "0.25";
            await saveTrade();
        });
        await Promise.all([sellDraft(page), sellDraft(second)]);
        const item = (await saved(page))[0].positions[0];
        assert.equal(item.trades.length, 2);
        assert.equal(new Set(item.trades.map(trade => trade.id)).size, 2);
        assert.equal(item.remainQty, 0.5);
        assert.equal(item.realizedPnL, 1);
        assert.equal(alerts.length, 0);
    });

    await check("F04 editing one trade keeps a concurrent added trade", async () => {
        const { page, open } = await scenario([stock("A", { positions: [position(1)] })]);
        await sell(page, "0.1");
        const second = await open();
        await page.evaluate(() => openTradeModal(getStock().positions[0], getStock().positions[0].trades[0]));
        await page.locator("#sellPrice").fill("14.12345");
        await sell(second, "0.2");
        await page.locator("#saveTradeBtn").click();
        await page.locator("#tradeModal").waitFor({ state: "hidden" });
        const item = (await saved(page))[0].positions[0];
        assert.equal(item.trades.length, 2);
        assert.equal(item.trades[0].price, 14.12345);
        assert.equal(item.trades[1].qty, 0.2);
        assert.equal(item.remainQty, 0.7);
    });

    await check("F04 simultaneous duplicate quote connections are rejected", async () => {
        const { page, open, alerts } = await scenario([stock()]);
        const second = await open();
        await Promise.all([page.evaluate(() => addStockFromData({ symbol: "SAME", name: "first" })),
            second.evaluate(() => addStockFromData({ symbol: "SAME", name: "second" }))]);
        assert.equal((await saved(page)).filter(item => item.symbol === "SAME").length, 1);
        assert(alerts.some(message => message.includes("이미 추가")));
    });

    await check("F04 deleted positions cannot be resurrected by an open editor", async () => {
        const { page, open, alerts } = await scenario([stock("A", { positions: [position(1)] })]);
        const second = await open();
        await page.locator(".editPositionBtn").click();
        await second.evaluate(() => deletePosition(1));
        await page.locator("#savePositionBtn").click();
        await page.waitForFunction(() => !dom.savePositionBtn.disabled);
        assert.equal((await saved(page))[0].positions.length, 0);
        assert(alerts.some(message => message.includes("포지션이 삭제")));
    });

    await check("F04 quote writes preserve another tab's new positions", async () => {
        const { page, open } = await scenario([stock("A", { symbol: "A", connected: true })]);
        const second = await open();
        await page.evaluate(() => {
            PriceProvider.getCurrentPrice = () => new Promise(resolve => window.resolveQuote = resolve);
            window.pendingQuote = updateCurrentPrice();
        });
        await addPosition(second, "0.005");
        await page.evaluate(async () => { window.resolveQuote({ ok: true, price: 15 }); await window.pendingQuote; });
        const item = (await saved(page))[0];
        assert.equal(item.currentPrice, 15);
        assert.equal(item.positions.length, 1);
        assert.equal(item.positions[0].buyQty, 0.005);
    });

    await check("F03 deleting a stock while its quote loads never resurrects it", async () => {
        const { page, open } = await scenario([stock("A", { symbol: "A", connected: true }), stock("B")]);
        const second = await open();
        await page.evaluate(() => {
            PriceProvider.getCurrentPrice = () => new Promise(resolve => window.resolveQuote = resolve);
            window.pendingQuote = updateCurrentPrice();
        });
        await second.evaluate(() => deleteStock("A"));
        await page.evaluate(async () => { window.resolveQuote({ ok: true, price: 777 }); await window.pendingQuote; });
        assert.deepEqual((await saved(page)).map(item => item.id), ["B"]);
    });

    await check("empty portfolio survives deletion and reload", async () => {
        const { page } = await scenario([stock()]);
        await page.evaluate(() => deleteStock("A"));
        await page.reload();
        assert.equal(await page.locator(".stock-row").count(), 0);
        assert.equal((await saved(page)).length, 0);
    });

    await check("pin/manual ordering survives portfolio writes and reload", async () => {
        const { page } = await scenario([stock("A"), stock("B"), stock("C"), stock("D")], {
            pinnedSymbols: ["B"], stockOrder: ["B", "C", "A", "D"], manuallyOrderedStocks: ["C"], recentSymbols: ["D", "A"]
        });
        assert.deepEqual(await page.locator(".stock-row").evaluateAll(rows => rows.map(row => row.dataset.stockId)), ["B", "C", "D", "A"]);
        await addPosition(page, "0.005");
        await page.reload();
        assert.deepEqual(await page.locator(".stock-row").evaluateAll(rows => rows.map(row => row.dataset.stockId)), ["B", "C", "D", "A"]);
    });

    await check("save failure preserves editor draft and prevents false success", async () => {
        const { page, alerts } = await scenario([stock()]);
        await page.evaluate(() => {
            openAddPositionModal();
            dom.buyPrice.value = "10";
            dom.buyQty.value = "0.005";
            const original = Storage.prototype.setItem;
            Storage.prototype.setItem = function(key, value) {
                if (key === "portfolioStocks") throw new DOMException("test quota", "QuotaExceededError");
                return original.call(this, key, value);
            };
        });
        await page.locator("#savePositionBtn").click();
        await page.waitForFunction(() => !dom.savePositionBtn.disabled);
        assert.equal((await saved(page))[0].positions.length, 0);
        assert.equal(await page.evaluate(() => stocks[0].positions.length), 0);
        assert.equal(await page.locator("#buyQty").inputValue(), "0.005");
        assert.equal(await page.locator("#positionModal").isVisible(), true);
        assert(alerts.some(message => message.includes("저장하지 못했습니다")));
    });

    await check("file launch supports serialized storage transactions", async () => {
        const context = await browser.newContext();
        contexts.push(context);
        await context.route("https://**/*", route => route.abort());
        await context.route("**/backendConfig.js", route => route.fulfill({ contentType: "text/javascript", body: "const SilverBackendConfig = {};" }));
        const page = await context.newPage();
        await page.goto(pathToFileURL(path.join(root, "pages/calculator.html")).href);
        assert.equal(await page.evaluate(() => Boolean(navigator.locks)), true);
        await page.addScriptTag({ path: path.join(root, "js/storage.js") });
        await page.evaluate(() => PortfolioStorage.updateStocks(latest => { latest[0].memo = "file transaction"; }));
        assert.equal(await page.evaluate(() => PortfolioStorage.loadStocks()[0].memo), "file transaction");
    });

    await check("responsive layout and stock scrolling survive storage changes at 15 viewport sizes", async () => {
        const { page } = await scenario(Array.from({ length: 40 }, (_, index) =>
            stock(`STOCK-${String(index).padStart(2, "0")}`, { positions: [position(0.005)] })));
        await page.goto(`${base}/index.html`);
        const frame = page.frames().find(item => item.url().endsWith("/pages/portfolio.html"));
        await frame.waitForFunction(() => typeof persistStockChange === "function");
        const sizes = [[1920, 1080], [1600, 900], [1536, 864], [1440, 900], [1366, 768],
            [1280, 720], [1024, 768], [900, 700], [800, 600], [768, 600], [767, 600],
            [600, 900], [430, 932], [390, 844], [360, 800]];
        for (const [width, height] of sizes) {
            await page.setViewportSize({ width, height });
            for (const collapsed of [false, true]) {
                await page.evaluate(collapsed => SilverSettings.update({ sidebarCollapsed: collapsed }), collapsed);
                await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `shell overflow at ${width}`);
                assert(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `portfolio overflow at ${width}`);
                assert.equal(await frame.evaluate(() => document.documentElement.classList.contains("compact-layout")), width < 768);
                const scroll = await frame.locator("#stockList").evaluate(list => {
                    list.scrollTop = list.scrollHeight;
                    return { top: list.scrollTop, height: list.clientHeight, total: list.scrollHeight };
                });
                assert(scroll.total <= scroll.height || scroll.top > 0, `stock scroll blocked at ${width}`);
                await frame.locator(".stock-card").last().click();
            }
        }
    });

    await check("F09 valid stocks survive broken records and settings with an original backup", async () => {
        const { page } = await scenario([stock("VALID", { positions: [position(1), null] }), null],
            { stockOrder: { broken: true }, pinnedSymbols: ["VALID"], darkMode: true });
        assert.equal(await page.locator(".stock-row").count(), 1);
        assert.equal(await page.locator(".editPositionBtn").count(), 1);
        const original = await page.evaluate(() => localStorage.getItem("portfolioStocks"));
        await page.locator(".editPositionBtn").click();
        await page.locator("#buyMemo").fill("recovered draft");
        await page.locator("#savePositionBtn").click();
        await page.locator("#positionModal").waitFor({ state: "hidden" });
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("portfolioStocks.recoveryBackup")).raw), original);
        await page.locator(".pin-stock-btn").click();
        await page.waitForFunction(() => Boolean(localStorage.getItem("silverStrategySettings.recoveryBackup")));
        assert.equal(await page.evaluate(() => SilverSettings.load().darkMode), true);
        assert.equal(await page.evaluate(() => Array.isArray(SilverSettings.load().stockOrder)), true);
        assert(await page.evaluate(() => Boolean(localStorage.getItem("silverStrategySettings.recoveryBackup"))));
        await page.reload();
        assert.equal(await page.locator(".stock-row").count(), 1);
        assert.equal((await saved(page))[0].positions[0].memo, "recovered draft");
    });

    await check("F09 unparseable portfolio protects the original on a save attempt", async () => {
        const { page, alerts } = await scenario([stock()]);
        await page.evaluate(() => localStorage.setItem("portfolioStocks", '[{"id":"broken"'));
        await page.reload();
        assert.equal(await page.locator(".stock-row").count(), 0);
        await page.evaluate(() => addStockFromData({ name: "Cannot overwrite" }));
        assert.equal(await page.evaluate(() => localStorage.getItem("portfolioStocks")), '[{"id":"broken"');
        assert(alerts.some(message => message.includes("원본을 보호")));
    });

    await check("F10 settings failure keeps persisted state, reports failure and permits retry", async () => {
        const { page } = await scenario([stock()], { darkMode: false });
        await page.goto(`${base}/pages/settings.html`);
        await page.evaluate(() => {
            window.restoreSetItem = Storage.prototype.setItem;
            Storage.prototype.setItem = function(key, value) {
                if (key === "silverStrategySettings") throw new DOMException("test quota", "QuotaExceededError");
                return window.restoreSetItem.call(this, key, value);
            };
        });
        await page.locator("#darkModeToggle").check();
        await page.locator("#saveSettingsBtn").click();
        await page.waitForFunction(() => !document.getElementById("saveSettingsBtn").disabled);
        assert.equal(await page.evaluate(() => SilverSettings.load().darkMode), false);
        assert((await page.locator("#settingsSavedText").textContent()).includes("저장하지 못했습니다"));
        assert.equal(await page.evaluate(() => document.documentElement.classList.contains("dark-mode")), false);
        await page.evaluate(() => Storage.prototype.setItem = window.restoreSetItem);
        await page.locator("#saveSettingsBtn").click();
        await page.waitForFunction(() => SilverSettings.load().darkMode);
        assert.equal(await page.evaluate(() => SilverSettings.load().darkMode), true);
    });

    await check("F10 calculator save, delete and clear failures preserve visible history", async () => {
        const { page } = await scenario([stock()]);
        await page.evaluate(() => localStorage.setItem("stockHistory", JSON.stringify([
            { id: 1, time: "09:00", price: 10, pct: 1, buy: "9.90", sell: "10.10", currency: "USD" }
        ])));
        await page.goto(`${base}/pages/calculator.html`);
        await page.locator("#autoDecimal").uncheck();
        await page.locator("#basePrice").fill("25.50");
        await page.evaluate(() => {
            const original = Storage.prototype.setItem;
            Storage.prototype.setItem = function(key, value) {
                if (key === "stockHistory") throw new DOMException("test quota", "QuotaExceededError");
                return original.call(this, key, value);
            };
        });
        await page.locator(".table-action").first().click();
        await page.locator("[data-delete-id]").click();
        await page.locator("#clearHistoryBtn").click();
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("stockHistory")).length), 1);
        assert.equal(await page.locator("[data-delete-id]").count(), 1);
        assert.equal(await page.locator("#basePrice").inputValue(), "25.50");
        assert((await page.locator("#appToast").textContent()).includes("저장하지 못했습니다"));
    });

    await check("F11 adding the first connected stock starts immediate and periodic refresh", async () => {
        const { page } = await scenario([stock()]);
        await page.clock.install();
        await page.evaluate(async () => {
            window.quoteCalls = 0;
            PriceProvider.getCurrentPrice = async () => ({ ok: true, price: 25 + ++window.quoteCalls });
            await SilverSettings.tryUpdate({ finnhubApiKey: "TEST" });
            await addStockFromData({ name: "Connected", symbol: "NEW" });
        });
        await page.waitForFunction(() => getStock().currentPrice === 26 && !dom.updatePriceBtn.disabled);
        await page.clock.fastForward(6 * 60 * 1000);
        await page.waitForFunction(() => window.quoteCalls >= 2 && getStock().currentPrice >= 27);
    });

    await check("F11 quote connection and interval changes take effect without reloading", async () => {
        const { page } = await scenario([stock()]);
        await page.clock.install();
        await page.evaluate(async () => {
            window.quoteCalls = 0;
            PriceProvider.getCurrentPrice = async () => ({ ok: true, price: 25 + ++window.quoteCalls });
            await SilverSettings.tryUpdate({ finnhubApiKey: "TEST" });
            openStockSettingsModal(getStock());
            pendingQuoteConnection = { symbol: "NEW", companyName: "NEW", exchange: "TEST" };
            await saveStockSettings();
        });
        await page.waitForFunction(() => getStock().currentPrice === 26 && !dom.updatePriceBtn.disabled);
        await page.evaluate(() => SilverSettings.tryUpdate({ apiRefreshIntervalMinutes: 1 }));
        await page.waitForFunction(() => window.quoteCalls >= 2 && !dom.updatePriceBtn.disabled);
        const before = await page.evaluate(() => window.quoteCalls);
        await page.clock.fastForward(61000);
        await page.waitForFunction(before => window.quoteCalls > before, before);
    });

    await check("F11 API changes and switching stocks immediately update the selected quote", async () => {
        const { page } = await scenario([stock("A", { connected: true, symbol: "A" }), stock("B", { connected: true, symbol: "B" })]);
        await page.evaluate(async () => {
            window.quoteCalls = [];
            PriceProvider.getCurrentPrice = async symbol => {
                window.quoteCalls.push(symbol);
                return { ok: true, price: symbol === "A" ? 11 : 22 };
            };
            await SilverSettings.tryUpdate({ finnhubApiKey: "TEST-1" });
        });
        await page.waitForFunction(() => getStock().currentPrice === 11);
        await page.locator('.stock-card[data-stock-id="B"]').click();
        await page.waitForFunction(() => getStock().currentPrice === 22);
        const before = await page.evaluate(() => window.quoteCalls.length);
        await page.evaluate(() => SilverSettings.tryUpdate({ finnhubApiKey: "TEST-2" }));
        await page.waitForFunction(before => window.quoteCalls.length > before, before);
    });

    for (const connection of [false, true]) {
        await check(`F13 latest search wins and closed modal responses stay discarded, connection=${connection}`, async () => {
            const { page } = await scenario([stock()]);
            const result = await page.evaluate(async connection => {
                const resolves = {};
                PriceProvider.searchStocks = query => new Promise(resolve => resolves[query] = resolve);
                if (connection) { openStockSettingsModal(getStock()); openQuoteConnectionModal(); }
                else showStockForm();
                const input = connection ? dom.quoteSearchInput : dom.stockSearchInput;
                const results = connection ? dom.quoteSearchResults : dom.stockSearchResults;
                const search = connection ? searchQuoteConnections : searchStocks;
                input.value = "OLD";
                const old = search();
                input.value = "NEW";
                const current = search();
                resolves.NEW([{ symbol: "NEW", name: "New", exchange: "TEST" }]);
                await current;
                resolves.OLD([{ symbol: "OLD", name: "Old", exchange: "TEST" }]);
                await old;
                const winner = results.querySelector(".stock-result").dataset.symbol;
                input.value = "LATE";
                const late = search();
                if (connection) { closeQuoteConnectionModal(); openQuoteConnectionModal(); }
                else { hideStockForm(); showStockForm(); }
                input.value = "LATE";
                resolves.LATE([{ symbol: "LATE", name: "Late", exchange: "TEST" }]);
                await late;
                return { winner, staleButtons: results.querySelectorAll(".stock-result").length };
            }, connection);
            assert.equal(result.winner, "NEW");
            assert.equal(result.staleButtons, 0);
        });
    }

    await check("F14 add and clone use the current Korean date after midnight", async () => {
        const { page } = await scenario([stock("A", { positions: [position(1)] })]);
        await page.clock.install({ time: new Date("2026-10-01T15:01:00Z") });
        await page.locator("#addPositionBtn").click();
        assert.equal(await page.locator("#buyDate").inputValue(), "2026-10-02");
        await page.locator("#cancelPositionBtn").click();
        await page.locator(".clonePositionBtn").click();
        assert.equal(await page.locator("#buyDate").inputValue(), "2026-10-02");
    });

    await check("F15 Enter moves input focus and activates save and cancel buttons", async () => {
        const { page } = await scenario([stock()]);
        await page.locator("#addPositionBtn").click();
        await page.locator("#buyPrice").fill("10.00");
        await page.locator("#buyPrice").press("Enter");
        assert.equal(await page.evaluate(() => document.activeElement.id), "buyQty");
        await page.locator("#buyQty").fill("0.005");
        await page.locator("#savePositionBtn").focus();
        await page.keyboard.press("Enter");
        await page.locator("#positionModal").waitFor({ state: "hidden" });
        assert.equal((await saved(page))[0].positions[0].buyQty, 0.005);
        await page.locator("#addPositionBtn").click();
        await page.locator("#cancelPositionBtn").focus();
        await page.keyboard.press("Enter");
        await page.locator("#positionModal").waitFor({ state: "hidden" });
        assert.equal((await saved(page))[0].positions.length, 1);
        await page.locator(".sellBtn").click();
        await page.locator("#cancelTradeBtn").focus();
        await page.keyboard.press("Enter");
        await page.locator("#tradeModal").waitFor({ state: "hidden" });
    });

    await check("F16 impossible declines preserve the last valid price and allow large rises", async () => {
        const { page, alerts } = await scenario([stock()]);
        await page.goto(`${base}/pages/calculator.html`);
        await page.locator("#autoDecimal").uncheck();
        await page.locator("#currentPrice").fill("25.50");
        await page.locator("#changePercent").fill("3");
        await page.locator("#convertPriceBtn").click();
        const valid = await page.locator("#basePrice").inputValue();
        assert.equal(valid, "26.29");
        for (const percent of ["100", "150"]) {
            await page.locator("#changePercent").fill(percent);
            await page.locator("#convertPriceBtn").click();
            assert.equal(await page.locator("#basePrice").inputValue(), valid);
        }
        assert.equal(alerts.filter(message => message.includes("100% 미만")).length, 2);
        await page.locator("#changeSignBtn").click();
        await page.locator("#convertPriceBtn").click();
        assert.equal(await page.locator("#basePrice").inputValue(), "10.20");
    });

    await check("F17 context menus remain accessible at screen edges and close on scroll", async () => {
        const { page } = await scenario(Array.from({ length: 30 }, (_, index) => stock(`S-${index}`)));
        await page.setViewportSize({ width: 1024, height: 600 });
        await page.locator(".stock-card").last().click({ button: "right" });
        for (const [x, y] of [[0, 0], [1023, 0], [0, 599], [1023, 599]]) {
            const bounds = await page.evaluate(([x, y]) => {
                showStockContextMenu(getStockKey(getStock()), x, y);
                const rect = dom.stockContextMenu.getBoundingClientRect();
                return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
            }, [x, y]);
            assert(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= 1024 && bounds.bottom <= 600);
        }
        await page.evaluate(() => {
            window.dispatchEvent(new Event("resize"));
            dom.stockList.dispatchEvent(new Event("scroll"));
        });
        assert.equal(await page.locator("#stockContextMenu").isVisible(), true);
        await page.locator("#openStockSettingsMenuBtn").click();
        assert.equal(await page.locator("#stockSettingsModal").isVisible(), true);
        await page.locator("#cancelStockSettingsBtn").click();
        await page.evaluate(() => { showStockContextMenu(getStockKey(getStock()), 500, 500); dom.stockList.scrollTop = 0; });
        await page.waitForFunction(() => dom.stockContextMenu.hidden);
    });

    await check("F18 a hung quote times out, keeps the last price and resumes next interval", async () => {
        const { page } = await scenario([stock("A", { connected: true, symbol: "A", currentPrice: 25 })]);
        await page.clock.install();
        await page.evaluate(async () => {
            window.requestCalls = 0;
            window.fetch = () => ++window.requestCalls === 1 ? new Promise(() => {})
                : Promise.resolve({ ok: true, json: async () => ({ c: 30 }) });
            await SilverSettings.tryUpdate({ finnhubApiKey: "TEST", apiRefreshIntervalMinutes: 1,
                priceCacheBySymbol: { A: { price: 25, cachedAt: 0, updatedAt: "2026-10-06T00:00:00Z" } } });
        });
        await page.clock.runFor(15001);
        await page.waitForFunction(() => SilverSettings.load().apiFailureCountBySymbol.A === 1);
        assert.equal(await page.locator("#currentPriceText").textContent(), "$25");
        assert.equal(await page.locator("#updatePriceBtn").isDisabled(), false);
        await page.clock.fastForward(45000);
        await page.waitForFunction(() => getStock().currentPrice === 30);
        assert.equal(await page.evaluate(() => window.requestCalls), 2);
        assert.equal(await page.locator("#priceApiStatus").textContent(), "🟢 정상");
    });

    assert.deepEqual(errors, []);
    console.log(`${passed} browser scenarios passed; no uncaught page errors.`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    for (const context of contexts) await context.close();
    if (browser) await browser.close();
    server.close();
});
