const assert = require("node:assert/strict");
const fixture = require("./server.browser.cjs");
let browser, base;
async function menu(page,name) {
    const [frame] = await Promise.all([page.waitForEvent("framenavigated", f => f.url().endsWith(`/pages/${name}.html`)),page.locator(`[data-page="${name}"]`).click()]);
    await frame.waitForFunction(() => document.body && !document.body.inert); return frame;
}
(async () => {
    ({browser,base} = await fixture.start());
    const user = fixture.addAccount("p3@example.test", {
        portfolioStocks:[{id:"A",displayName:"휴지통 시험 종목",symbol:"",connected:false,positions:[{id:1,number:1,buyPrice:10,buyQty:10,trades:[{id:10,type:"SELL",price:20,qty:2}]}]}],
        silverStrategySettings:{darkMode:false},stockHistory:[{id:1,price:10,pct:1}]
    });
    const page = await fixture.computer(); await fixture.login(page,"p3@example.test");
    let portfolio = await fixture.portfolio(page);
    await portfolio.locator("#addPositionBtn").click();
    assert.equal(await portfolio.locator("#positionModal").getAttribute("role"),"dialog");
    assert.equal(await portfolio.locator("#positionModal").getAttribute("aria-modal"),"true");
    await portfolio.locator("#buyPrice").focus(); await page.keyboard.press("Shift+Tab");
    assert.equal(await portfolio.evaluate(() => document.activeElement.id),"savePositionBtn");
    await page.keyboard.press("Tab"); assert.equal(await portfolio.evaluate(() => document.activeElement.id),"buyPrice");
    await page.keyboard.press("Escape"); assert.equal(await portfolio.evaluate(() => document.activeElement.id),"addPositionBtn");
    console.log("PASS P3 modal role, focus trapping and focus return");

    const quoteTime = Math.floor(Date.now()/1000)-3600;
    await page.context().route("**/backend/functions/v1/market-data",route => route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({c:25,t:quoteTime})}));
    const quote = await portfolio.evaluate(async () => {
        const result = await PriceProvider.getCurrentPrice("A",{force:true,deferCache:true});
        await PriceProvider.saveCachedPrice("A",result.price,result.updatedAt);
        stocks[0].symbol="A";stocks[0].connected=true;stocks[0].currentPrice=25; renderPriceStatus(stocks[0]);
        return {time:result.updatedAt,label:dom.priceUpdatedAt.textContent};
    });
    assert.equal(quote.time,new Date(quoteTime*1000).toISOString()); assert.match(quote.label,/오래된 시세/);
    await page.context().unroute("**/backend/functions/v1/market-data");
    const unknown = await portfolio.evaluate(() => PriceProvider.getCurrentPrice("UNKNOWN",{force:true,deferCache:true}));
    assert.equal(unknown.updatedAt,null);
    console.log("PASS P3 provider timestamp, stale quote label and unknown-time handling");

    const before = fixture.requests.length;
    await portfolio.evaluate(() => Promise.all([ServerStore.reload(),parent.ServerStore.reload(),parent.ServerStore.reload()]));
    const reads = fixture.requests.slice(before).filter(r => /silver_read_(all|changes)$/.test(r.path));
    assert.equal(reads.length,1); assert.ok(reads[0].path.endsWith("silver_read_changes"));
    const remote = fixture.documents.get(user).get("silverStrategySettings"); remote.value.darkMode=true; remote.version++;
    await portfolio.evaluate(() => parent.ServerStore.reload());
    assert.equal(await portfolio.evaluate(() => SilverSettings.load().darkMode),true);
    console.log("PASS P3 shell/iframe share one coalesced changes-only read and remote settings");

    await portfolio.evaluate(() => { stocks=PortfolioStorage.loadStocks();selectedIndex=0;refreshUI();return deleteTrade(1,10); });
    assert.equal(fixture.trash.filter(t => t.owner===user).length,1);
    let trash = await menu(page,"trash");
    fixture.controls({dropResponses:1}); await trash.getByRole("button",{name:"복원",exact:true}).click();
    await trash.waitForFunction(() => document.getElementById("trashMessage").textContent.includes("복원했습니다"));
    assert.equal(fixture.documents.get(user).get("portfolioStocks").value[0].positions[0].trades.length,1);
    assert.equal(fixture.trash.filter(t => t.owner===user).length,0);
    portfolio = await menu(page,"portfolio"); await portfolio.evaluate(() => deleteStock("A"));
    assert.equal(fixture.trash.find(t => t.owner===user).payload.item.positions[0].trades.length,1);
    trash = await menu(page,"trash");
    if (process.env.TEST_SCREENSHOT_DIR) {
        require("node:fs").mkdirSync(process.env.TEST_SCREENSHOT_DIR,{recursive:true});
        await page.screenshot({path:require("node:path").join(process.env.TEST_SCREENSHOT_DIR,"trash.png"),fullPage:true});
    }
    await trash.getByRole("button",{name:"복원",exact:true}).click();
    await trash.waitForFunction(() => document.getElementById("trashMessage").textContent.includes("복원했습니다"));
    assert.equal(fixture.documents.get(user).get("portfolioStocks").value.length,1);
    const calculator = await menu(page,"calculator"); await calculator.locator("#clearHistoryBtn").click();
    await calculator.waitForFunction(() => document.querySelector("#historyBody").textContent.includes("아직 저장된 기록"));
    trash = await menu(page,"trash"); await trash.locator("#trashFilter").selectOption("history");
    assert.equal(await trash.locator(".trash-item").count(),1);
    await page.setViewportSize({width:600,height:300});
    await trash.getByRole("button",{name:"영구 삭제",exact:true}).scrollIntoViewIfNeeded();
    const bounds = await trash.getByRole("button",{name:"영구 삭제",exact:true}).boundingBox(); assert.ok(bounds.x>=0 && bounds.x+bounds.width<=600);
    await trash.getByRole("button",{name:"영구 삭제",exact:true}).click();
    await trash.waitForFunction(() => document.getElementById("trashMessage").textContent.includes("제거했습니다"));
    console.log("PASS trash nested capture, item restore, lost-response replay, history filter/delete and narrow-window access");

    await page.setViewportSize({width:1280,height:800});
    const settings = await menu(page,"settings");
    await settings.locator("#currentPassword").fill("wrong-password"); await settings.locator("#newPassword").fill("new-test-password"); await settings.locator("#confirmNewPassword").fill("new-test-password");
    await settings.locator("#changePasswordBtn").click(); await settings.waitForFunction(() => document.getElementById("passwordMessage").textContent.includes("현재 비밀번호"));
    await settings.locator("#currentPassword").fill("test-password"); await settings.locator("#changePasswordBtn").click();
    await settings.waitForFunction(() => document.getElementById("passwordMessage").textContent.includes("변경했습니다"));
    assert.equal(await settings.locator("#newPassword").inputValue(),""); assert.equal(await page.locator("#appLayout").isVisible(),true);
    console.log("PASS P3 current-password validation, password update, form clearing and retained account session");

    const recoveryPage = await fixture.computer(); await recoveryPage.locator("#showRecoveryButton").click();
    await recoveryPage.locator("#recoveryEmail").fill("p3@example.test"); await recoveryPage.locator("#requestRecoveryButton").click();
    await recoveryPage.waitForFunction(() => document.getElementById("authMessage").textContent.includes("가입된 이메일이면"));
    await recoveryPage.context().route("**/backend/auth/v1/recover**",route => route.fulfill({status:403,headers:{"X-Supabase-Api-Version":"2024-01-01"},contentType:"application/json",body:JSON.stringify({code:"email_address_not_authorized",msg:"Email not authorized"})}));
    const restricted = recoveryPage.waitForResponse(r => new URL(r.url()).pathname.endsWith("/auth/v1/recover"));
    await recoveryPage.locator("#requestRecoveryButton").click();
    assert.equal((await restricted).status(),403);
    await recoveryPage.waitForFunction(() => document.getElementById("authMessage").textContent.includes("메일 발송 설정"));
    const context = await browser.newContext();
    const reset = await context.newPage();
    await reset.goto(base+"/index.html#"+new URLSearchParams({access_token:fixture.jwt("p3@example.test"),refresh_token:"refresh-test",expires_in:"3600",token_type:"bearer",type:"recovery"}));
    await reset.locator("#resetPasswordForm").waitFor({state:"visible"});
    assert.equal(await reset.locator("#appLayout").isVisible(),false);
    await reset.locator("#resetPassword").fill("recovered-password"); await reset.locator("#resetPasswordConfirm").fill("recovered-password"); await reset.locator("#resetPasswordButton").click();
    await reset.waitForFunction(() => document.getElementById("authMessage").textContent.includes("새 비밀번호로 로그인"));
    assert.equal(new URL(reset.url()).hash,""); await context.close();
    assert.deepEqual(fixture.errors,[]);
    console.log("PASS P3 recovery request, SMTP restriction guidance, recovery-token form, reset and token URL cleanup (no real emails)");
})().catch(error => { console.error(error);process.exitCode=1; }).finally(() => fixture.close());
