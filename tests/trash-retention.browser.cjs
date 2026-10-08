// Controlled Auth/PostgREST fixture; never creates live users or changes live trash.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const fixture = require("./server.browser.cjs");
async function menu(page, name) {
    const [frame] = await Promise.all([
        page.waitForEvent("framenavigated", f => f.url().endsWith(`/pages/${name}.html`)),
        page.locator(`[data-page="${name}"]`).click()
    ]);
    await frame.waitForFunction(() => document.body && !document.body.inert); return frame;
}
(async () => {
    await fixture.start();
    const uid = fixture.addAccount("retention@example.test", {
        portfolioStocks: [{ id: "A", displayName: "보관기한 확인 종목", connected: false, positions: [
            { id: 1, number: 1, buyPrice: 10, buyQty: 5, trades: [{ id: 10, type: "SELL", qty: 2, price: 20 }] }
        ] }], silverStrategySettings: {}, stockHistory: []
    });
    const page = await fixture.computer(); await fixture.login(page, "retention@example.test");
    let portfolio = await fixture.portfolio(page);
    await portfolio.evaluate(() => deleteTrade(1, 10));
    let trash = await menu(page, "trash");
    await trash.locator(".trash-item").waitFor();
    const entry = fixture.trash.find(t => t.owner === uid);
    const deadline = await trash.evaluate(value => new Date(value).toLocaleString("ko-KR"), entry.expires_at);
    assert.ok((await trash.locator(".trash-item").textContent()).includes("복원 기한: " + deadline));
    assert.match(await trash.locator(".helper-text").textContent(), /6개월/);
    await page.setViewportSize({ width: 600, height: 300 });
    await trash.getByRole("button", { name: "복원", exact: true }).scrollIntoViewIfNeeded();
    const bounds = await trash.getByRole("button", { name: "복원", exact: true }).boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 600);
    if (process.env.TEST_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.TEST_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.TEST_SCREENSHOT_DIR, "trash-retention.png") });
    }
    console.log("PASS trash retention policy and per-item deadline are visible and controls fit a short window");

    entry.expires_at = new Date(Date.now() - 1000).toISOString();
    await trash.getByRole("button", { name: "복원", exact: true }).click();
    await trash.waitForFunction(() => document.getElementById("trashMessage").textContent.includes("보관기한 6개월"));
    assert.equal(fixture.documents.get(uid).get("portfolioStocks").value[0].positions[0].trades.length, 0);
    assert.equal(await trash.locator("#trashMessage").getAttribute("data-state"), "error");
    await trash.locator("#reloadTrashBtn").click();
    await trash.waitForFunction(() => document.querySelectorAll(".trash-item").length === 0);
    assert.equal(await trash.locator("#emptyTrashBtn").isDisabled(), true);
    console.log("PASS a stale open list cannot restore an expired item; expiry guidance and reload remove it without changing active data");

    await page.setViewportSize({ width: 1280, height: 800 });
    portfolio = await menu(page, "portfolio"); await portfolio.evaluate(() => deletePosition(1));
    trash = await menu(page, "trash"); await trash.locator(".trash-item").waitFor();
    await trash.getByRole("button", { name: "복원", exact: true }).click();
    await trash.waitForFunction(() => document.getElementById("trashMessage").textContent.includes("복원했습니다"));
    assert.equal(fixture.documents.get(uid).get("portfolioStocks").value[0].positions.length, 1);
    assert.deepEqual(fixture.errors, []);
    console.log("PASS a valid item still restores normally after adding the retention policy");
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fixture.close());
