// Official SDK + isolated HTTP fixture. No live accounts, data or email are used.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const fixture = require("./server.browser.cjs");
const stock = { id: "A", displayName: "점검 종목", symbol: "", connected: false, positions: [] };
const values = () => ({ portfolioStocks: [structuredClone(stock)], silverStrategySettings: { darkMode: false, apiRefreshIntervalMinutes: 5 }, stockHistory: [] });
let browser, base;
async function settings(page) {
    const [frame] = await Promise.all([
        page.waitForEvent("framenavigated", frame => frame.url().endsWith("/pages/settings.html")),
        page.locator('[data-page="settings"]').click()
    ]);
    await frame.waitForFunction(() => window.SilverPageState?.page === "settings" && !document.body.inert);
    return frame;
}
async function remoteRefresh(frame) {
    await frame.evaluate(() => window.dispatchEvent(new Event("focus")));
}
(async () => {
    ({ browser, base } = await fixture.start());
    const uid = fixture.addAccount("audit@example.test", values());
    const page = await fixture.computer(); await fixture.login(page, "audit@example.test");
    let portfolio = await fixture.portfolio(page);
    await portfolio.locator("#addPositionBtn").click();
    await portfolio.locator("#buyPrice").fill("10.00"); await portfolio.locator("#buyQty").fill("2");
    await portfolio.locator("#buyMemo").fill("메뉴 이동 전 입력");
    const priceDraft = await portfolio.locator("#buyPrice").inputValue();
    await page.locator('[data-page="calculator"]').click();
    await page.frameLocator("#pageFrame").locator("#autoDecimal").uncheck();
    await page.frameLocator("#pageFrame").locator("#basePrice").fill("12.34");
    await page.locator('[data-page="portfolio"]').click(); portfolio = await fixture.portfolio(page);
    await portfolio.locator("#positionModal").waitFor({ state: "visible" });
    assert.equal(await portfolio.locator("#buyPrice").inputValue(), priceDraft);
    assert.equal(await portfolio.locator("#buyQty").inputValue(), "2");
    assert.equal(await portfolio.locator("#buyMemo").inputValue(), "메뉴 이동 전 입력");
    await page.locator('[data-page="portfolio"]').click();
    assert.equal(await portfolio.locator("#buyMemo").inputValue(), "메뉴 이동 전 입력");
    await page.locator('[data-page="calculator"]').click();
    await page.frameLocator("#pageFrame").locator("body").evaluate(() => new Promise(resolve => {
        const ready = () => document.body.inert ? setTimeout(ready, 20) : resolve(); ready();
    }));
    assert.equal(await page.frameLocator("#pageFrame").locator("#basePrice").inputValue(), "12.34");
    assert.equal(await page.frameLocator("#pageFrame").locator("#autoDecimal").isChecked(), false);
    console.log("PASS A01 portfolio/calculator drafts survive menu changes and same-menu clicks");

    await page.locator('[data-page="portfolio"]').click(); portfolio = await fixture.portfolio(page);
    const rate = await portfolio.evaluate(() => {
        const position = { id: 1, number: 1, buyPrice: 10, buyQty: 10, remainQty: 1, realizedPnL: 90, trades: [{ id: 2, type: "SELL", price: 20, qty: 9 }], status: "PARTIAL" };
        stocks = [{ id: "RATE", symbol: "AUDIT", connected: true, currentPrice: 10, positions: [position] }]; selectedIndex = 0;
        const result = [getPositionTotalPnL(position), getPositionRate(position), calculateDashboard(getStock()).rate];
        stocks = PortfolioStorage.loadStocks(); selectedIndex = 0; refreshUI();
        return result;
    });
    assert.deepEqual(rate, [90, 90, 90]);
    console.log("PASS A02 partial-sale card rate agrees with total profit and dashboard");

    let form = await settings(page);
    const remote = fixture.documents.get(uid).get("silverStrategySettings");
    remote.value.apiRefreshIntervalMinutes = 1; remote.version++;
    await remoteRefresh(form);
    await form.waitForFunction(() => document.getElementById("apiRefreshInterval").value === "1");
    await form.locator("#darkModeToggle").check(); await form.locator("#saveSettingsBtn").click();
    await form.waitForFunction(() => document.getElementById("saveSettingsBtn").disabled === false);
    assert.equal(fixture.documents.get(uid).get("silverStrategySettings").value.apiRefreshIntervalMinutes, 1);
    await form.locator("#apiRefreshInterval").selectOption("10");
    fixture.documents.get(uid).get("silverStrategySettings").value.apiRefreshIntervalMinutes = 30;
    fixture.documents.get(uid).get("silverStrategySettings").version++;
    await remoteRefresh(form);
    await form.waitForFunction(() => SilverSettings.load().apiRefreshIntervalMinutes === 30);
    assert.equal(await form.locator("#apiRefreshInterval").inputValue(), "10");
    await page.locator('[data-page="calculator"]').click(); form = await settings(page);
    assert.equal(await form.locator("#apiRefreshInterval").inputValue(), "10");
    await form.locator("#saveSettingsBtn").click();
    await form.waitForFunction(() => !document.getElementById("saveSettingsBtn").disabled);
    assert.equal(fixture.documents.get(uid).get("silverStrategySettings").value.apiRefreshIntervalMinutes, 10);
    console.log("PASS A03 latest untouched settings sync; only edited fields save and dirty fields survive remote updates/navigation");

    await page.context().route("**/backend/rest/v1/rpc/silver_write_document", async route => {
        const response = await route.fetch(); await new Promise(resolve => setTimeout(resolve, 200)); await route.fulfill({ response });
    });
    await form.locator("#darkModeToggle").uncheck(); await form.locator("#saveSettingsBtn").click();
    await form.locator("#darkModeToggle").check();
    await form.waitForFunction(() => !document.getElementById("saveSettingsBtn").disabled);
    assert.equal(await form.locator("#darkModeToggle").isChecked(), true);
    assert.equal(fixture.documents.get(uid).get("silverStrategySettings").value.darkMode, false);
    await page.context().unroute("**/backend/rest/v1/rpc/silver_write_document");
    await form.locator("#saveSettingsBtn").click();
    await form.waitForFunction(() => !document.getElementById("saveSettingsBtn").disabled);
    assert.equal(fixture.documents.get(uid).get("silverStrategySettings").value.darkMode, true);
    console.log("PASS A03 edits made during a pending settings save remain retryable");

    fixture.addAccount("partial@example.test", { silverStrategySettings: { darkMode: false } });
    const partial = await fixture.computer({ portfolioStocks: [stock] }); await fixture.login(partial, "partial@example.test");
    await partial.locator("#appLayout").waitFor({ state: "visible" });
    assert.equal(await partial.locator("#migrationPanel").isVisible(), false);
    console.log("PASS A04 a partially populated server account opens normally without impossible migration");

    fixture.addAccount("blocked@example.test", values());
    const blockedContext = await browser.newContext();
    await blockedContext.addInitScript(() => { for (const method of ["getItem", "setItem", "removeItem"]) Storage.prototype[method] = () => { throw new DOMException("Blocked", "SecurityError"); }; });
    const blocked = await blockedContext.newPage(); await blocked.goto(base + "/index.html"); await fixture.login(blocked, "blocked@example.test");
    await blocked.locator("#appLayout").waitFor({ state: "visible" }); await blockedContext.close();
    console.log("PASS A05 cloud login succeeds when legacy localStorage is blocked");

    await page.locator('[data-page="portfolio"]').click(); portfolio = await fixture.portfolio(page);
    await page.context().route("**/backend/functions/v1/market-data", route => route.fulfill({ status: 429, contentType: "application/json", body: '{"error":"Try again shortly"}' }));
    await portfolio.evaluate(async () => { showStockForm(); dom.stockSearchInput.value = "AUDIT-NOMATCH"; await searchStocks(); });
    assert((await portfolio.locator("#stockSearchResults").textContent()).includes("요청이 많습니다"));
    assert(!(await portfolio.locator("#stockSearchResults").textContent()).includes("검색 결과가 없습니다"));
    await page.context().unroute("**/backend/functions/v1/market-data");
    console.log("PASS A06 quota failures are distinguished from empty search results");

    form = await settings(page); await form.locator("#downloadAccountBackupBtn").waitFor({ state: "visible" });
    await form.waitForFunction(() => !document.getElementById("downloadAccountBackupBtn").disabled);
    const downloaded = page.waitForEvent("download"); await form.locator("#downloadAccountBackupBtn").click();
    const download = await downloaded;
    const original = JSON.parse(await fs.readFile(await download.path(), "utf8"));
    assert.equal(original.format, "silver-strategy-backup"); assert.equal(original.data.portfolioStocks[0].id, "A");
    await form.locator("#createServerBackupBtn").click();
    await form.waitForFunction(() => document.getElementById("serverBackupSelect").value !== "" && !document.getElementById("createServerBackupBtn").disabled);
    const serverId = await form.locator("#serverBackupSelect").inputValue();
    assert.equal(fixture.snapshots.find(s => s.id === serverId).owner, uid);
    const restoredValues = values(); restoredValues.portfolioStocks = [{ ...stock, id: "RESTORED", displayName: "복원 종목" }];
    const upload = { name: "backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ format: "silver-strategy-backup", version: 1, data: restoredValues })) };
    await form.locator("#restoreBackupFile").setInputFiles(upload);
    await form.locator("#restorePreview").waitFor({ state: "visible" });
    fixture.documents.get(uid).get("silverStrategySettings").version++;
    await form.locator("#restoreBackupBtn").click();
    await form.waitForFunction(() => document.getElementById("backupMessage").textContent.includes("다른 화면"));
    assert.equal(fixture.documents.get(uid).get("portfolioStocks").value[0].id, "A");
    assert.equal(await form.locator("#restorePreview").isVisible(), false);
    console.log("PASS A07 backup export/create/preview and stale restore protect current server data");

    await form.locator("#restoreBackupFile").setInputFiles(upload);
    await form.locator("#restorePreview").waitFor({ state: "visible" });
    fixture.controls({ dropResponses: 1 });
    await form.locator("#restoreBackupBtn").click();
    await form.waitForFunction(() => document.getElementById("backupMessage").textContent.includes("자료를 복원했습니다"));
    assert.equal(fixture.documents.get(uid).get("portfolioStocks").value[0].id, "RESTORED");
    assert.equal(fixture.snapshots.filter(s => s.owner === uid && s.reason === "before_restore").length, 1);
    assert.equal(fixture.snapshots.find(s => s.owner === uid && s.reason === "before_restore").documents.portfolioStocks[0].id, "A");
    await page.locator('[data-page="portfolio"]').click(); portfolio = await fixture.portfolio(page);
    assert.equal(await portfolio.locator("#positionModal").isVisible(), false, "Restore clears drafts from the replaced portfolio");
    assert.equal(await portfolio.evaluate(() => getStock().id), "RESTORED");
    console.log("PASS A07 lost restore response retries exactly once, keeps pre-restore data and clears replaced drafts");

    form = await settings(page);
    await form.waitForFunction(() => !document.getElementById("restoreBackupFile").disabled);
    await form.locator("#restoreBackupFile").setInputFiles({ name: "broken.json", mimeType: "application/json", buffer: Buffer.from('{"format":"silver-strategy-backup","version":1,"data":{"portfolioStocks":[]}}') });
    await form.waitForFunction(() => document.getElementById("backupMessage").textContent.includes("포함된 백업"));
    assert.equal(await form.locator("#restorePreview").isVisible(), false);
    if (process.env.TEST_SCREENSHOT_DIR) {
        await fs.mkdir(process.env.TEST_SCREENSHOT_DIR, { recursive: true });
        const standalone = await page.context().newPage();
        await standalone.setViewportSize({ width: 950, height: 900 });
        await standalone.goto(base + "/pages/settings.html");
        await standalone.waitForFunction(() => !document.body.inert && !document.getElementById("restoreBackupFile").disabled);
        await standalone.locator("#restoreBackupFile").setInputFiles(upload);
        await standalone.locator("#restorePreview").waitFor({ state: "visible" });
        await standalone.screenshot({ path: process.env.TEST_SCREENSHOT_DIR + "/settings-backup.png", fullPage: true });
        await standalone.close();
    }
    await page.setViewportSize({ width: 600, height: 300 });
    await form.locator("#restoreBackupFile").scrollIntoViewIfNeeded();
    const smallBounds = await form.locator("#restoreBackupFile").boundingBox();
    assert(smallBounds.y >= 0 && smallBounds.y + smallBounds.height <= 301);
    await page.locator("#logoutButton").click();
    await fixture.login(page, "partial@example.test"); await fixture.portfolio(page);
    await page.locator('[data-page="calculator"]').click();
    assert.equal(await page.frameLocator("#pageFrame").locator("#basePrice").inputValue(), "");
    console.log("PASS A07 malformed files rejected, small-window controls reachable, account switch clears drafts");
    assert.deepEqual(fixture.errors, []);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fixture.close());
