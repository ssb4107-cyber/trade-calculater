// Real SDK against an isolated HTTP fixture; no live account or market request.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const fixture = require("./server.browser.cjs");
let releaseQuote;
const shots = process.env.TEST_SCREENSHOT_DIR;
async function screenshot(page, name) {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, name + ".png") });
}
(async () => {
    await fixture.start();
    const uid = fixture.addAccount("refresh@example.test", {
        portfolioStocks: [
            { id: "A", displayName: "시세 연결 종목", symbol: "A", connected: true, currentPrice: 10,
                positions: [{ id: 1, number: 1, buyPrice: 10, buyQty: 2, trades: [] }] },
            { id: "B", displayName: "연결하지 않은 종목", symbol: "", connected: false, positions: [] }
        ],
        silverStrategySettings: { sidebarCollapsed: false, manuallyOrderedStocks: ["A", "B"],
            priceCacheBySymbol: { A: { price: 10, cachedAt: Date.now(), updatedAt: new Date(Date.now() - 120000).toISOString() } } },
        stockHistory: []
    });
    let calls = 0, mode = "ok", price = 25;
    const page = await fixture.computer();
    await page.context().route("**/backend/functions/v1/market-data", async route => {
        assert.equal(route.request().postDataJSON().symbol, "A");
        calls++;
        if (mode === "hold") await new Promise(resolve => { releaseQuote = resolve; });
        await route.fulfill({ status: mode === "rate" ? 429 : mode === "error" ? 503 : 200,
            contentType: "application/json", body: JSON.stringify({ c: price, t: Math.floor(Date.now() / 1000) }) });
    });
    assert.equal(await page.title(), "세호의 꿈");
    assert.equal(await page.locator("#authPanel h1").textContent(), "세호의 꿈");
    await screenshot(page, "login");
    await fixture.login(page, "refresh@example.test");
    let portfolio = await fixture.portfolio(page);
    await portfolio.waitForFunction(() => !document.body.inert && !dom.updatePriceBtn.disabled);
    const logoutCalls = () => fixture.requests.filter(r => r.path.endsWith("/auth/v1/logout")).length;
    for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 600, height: 300 }]) {
        await page.setViewportSize(size);
        await page.locator("#sidebarToggle").click();
        await page.waitForFunction(() => document.getElementById("appLayout").classList.contains("sidebar-collapsed") && document.getElementById("logoutButton").disabled);
        assert.equal(await page.locator(".account-area").isVisible(), false);
        assert.equal(await page.locator("#sidebarToggle").getAttribute("aria-expanded"), "false");
        await page.locator("#logoutButton").evaluate(button => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
        assert.equal(logoutCalls(), 0);
        if (size.width === 1280) {
            await screenshot(page, "sidebar-collapsed");
            await page.reload(); portfolio = await fixture.portfolio(page);
            await page.waitForFunction(() => document.getElementById("appLayout").classList.contains("sidebar-collapsed"));
            assert.equal(await page.locator("#logoutButton").isDisabled(), true);
        }
        await page.locator("#sidebarToggle").click();
        await page.waitForFunction(() => !document.getElementById("logoutButton").disabled);
        assert.equal(await page.locator("#logoutButton").isVisible(), true);
        const button = portfolio.locator("#updatePriceBtn");
        await button.scrollIntoViewIfNeeded();
        const bounds = await button.boundingBox();
        const frameBounds = await page.locator("#pageFrame").boundingBox();
        const width = await portfolio.evaluate(() => innerWidth);
        assert.ok(bounds && frameBounds && bounds.width > 80 && bounds.x >= frameBounds.x && bounds.x + bounds.width <= frameBounds.x + width, JSON.stringify({ size, bounds, frameBounds, width }));
        assert.ok(bounds.y >= frameBounds.y - 1 && bounds.y + bounds.height <= Math.min(size.height, frameBounds.y + frameBounds.height) + 1, "The refresh button must be visible after scrolling");
        assert.equal(await portfolio.evaluate(() => document.querySelector(".portfolio-content").scrollWidth <= document.querySelector(".portfolio-content").clientWidth), true);
        await screenshot(page, "refresh-" + size.width + "x" + size.height);
    }
    console.log("PASS persisted collapsed sidebar disables logout; expansion restores it; refresh fits desktop, mobile and short windows");

    await page.setViewportSize({ width: 1280, height: 800 });
    await portfolio.waitForFunction(() => !dom.updatePriceBtn.disabled);
    assert.equal(await portfolio.evaluate(() => PriceProvider.saveCachedPrice("A", 10, new Date(Date.now() - 60000).toISOString())), true);
    const before = calls;
    await portfolio.locator("#updatePriceBtn").click();
    await portfolio.waitForFunction(() => getStock().currentPrice === 25 && !dom.updatePriceBtn.disabled);
    assert.equal(calls, before + 1, "A manual refresh must request a quote even with a fresh saved cache");
    assert.equal(fixture.documents.get(uid).get("portfolioStocks").value[0].currentPrice, 25);
    assert.equal(await portfolio.evaluate(() => PriceProvider.getCachedPrice("A").price), 25);
    assert.equal(await portfolio.locator("#totalValue").textContent(), "$50.00");
    assert.equal(await page.evaluate(() => localStorage.getItem("portfolioStocks")), null);
    console.log("PASS manual refresh bypasses the browser cache, updates valuation and saves the selected quote on the server");

    mode = "hold"; price = 30;
    await portfolio.locator("#updatePriceBtn").click();
    await portfolio.waitForFunction(() => dom.updatePriceBtn.disabled && dom.updatePriceBtn.textContent === "조회 중");
    const deadline = Date.now() + 5000;
    while (!releaseQuote) {
        assert.ok(Date.now() < deadline, "The delayed quote request must begin");
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    const during = calls;
    await portfolio.locator("#updatePriceBtn").evaluate(button => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.equal(calls, during);
    assert.equal(await portfolio.locator("#updatePriceBtn").getAttribute("aria-busy"), "true");
    await portfolio.locator('.stock-row[data-stock-id="B"] .stock-card').click();
    releaseQuote(); releaseQuote = null;
    await portfolio.waitForFunction(() => pendingQuoteCount === 0 && getStock().id === "B");
    assert.equal(await portfolio.locator("#updatePriceBtn").isDisabled(), true);
    assert.equal(await portfolio.locator("#currentPriceText").textContent(), "—");
    const stored = fixture.documents.get(uid).get("portfolioStocks").value;
    assert.equal(stored[0].currentPrice, 30); assert.equal(stored[1].currentPrice, null);
    assert.equal(await portfolio.evaluate(() => PriceProvider.getCachedPrice("A").price), 30);
    mode = "ok";
    await portfolio.locator('.stock-row[data-stock-id="A"] .stock-card').click();
    await portfolio.waitForFunction(() => !dom.updatePriceBtn.disabled && getStock().currentPrice === 30);
    console.log("PASS quote request ignores repeated clicks and keeps a changed selection separate; unconnected quotes stay disabled");

    for (const failure of ["rate", "error"]) {
        mode = failure;
        await portfolio.locator("#updatePriceBtn").click();
        await portfolio.waitForFunction(() => !dom.updatePriceBtn.disabled && document.getElementById("priceApiStatus").textContent.includes("잠시 후"));
        assert.equal(await portfolio.locator("#currentPriceText").textContent(), "$30");
        assert.equal(fixture.documents.get(uid).get("portfolioStocks").value[0].currentPrice, 30);
    }
    mode = "ok"; price = 35;
    await portfolio.locator("#updatePriceBtn").click();
    await portfolio.waitForFunction(() => getStock().currentPrice === 35 && !dom.updatePriceBtn.disabled);
    assert.equal(await portfolio.locator("#priceApiStatus").textContent(), "🟢 정상");
    await screenshot(page, "refresh-success");
    await page.locator("#logoutButton").click();
    await page.locator("#loginForm").waitFor({ state: "visible" });
    assert.equal(logoutCalls(), 1);
    assert.deepEqual(fixture.errors, []);
    console.log("PASS failed/rate-limited quotes retain the last price, allow retry and recover; expanded logout still works");
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    releaseQuote?.(); await fixture.close();
});
