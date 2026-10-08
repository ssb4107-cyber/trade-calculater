// Browser integration uses the real Supabase SDK and a controlled Auth/PostgREST server.
// Database permissions and functions are verified separately in server.sql.cjs.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
const { randomUUID } = require("node:crypto");
const accounts = { "a@example.test": "11111111-1111-4111-8111-111111111111", "b@example.test": "22222222-2222-4222-8222-222222222222" };
const documents = new Map(), mutations = new Map(), backups = [];
const contexts = [], errors = [];
const snapshots = [];
const trash = [], requests = [], passwords = new Map();
function trashExpiry(created) {
    const date = new Date(Date.parse(created)+9*3600000), day = date.getUTCDate();
    date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth()+6);
    const last = new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();
    date.setUTCDate(Math.min(day,last)); return new Date(date.getTime()-9*3600000).toISOString();
}
function captureDeleted(uid,key,old = [],next = []) {
    const keep = (kind,label,payload) => {
        const created_at = new Date().toISOString();
        trash.push({ id: randomUUID(), owner: uid, kind,label,payload,created_at,expires_at:trashExpiry(created_at) });
    };
    if (key === "portfolioStocks") for (const stock of old) {
        const newStock = next.find(s => s.id === stock.id);
        if (!newStock) { keep("stock", stock.displayName || stock.id,{item:stock}); continue; }
        for (const position of stock.positions) {
            const newPosition = newStock.positions.find(p => p.id === position.id);
            if (!newPosition) { keep("position",stock.id + " position",{item:position,stock_id:stock.id}); continue; }
            for (const trade of position.trades) if (!newPosition.trades.some(t => t.id === trade.id)) keep("trade",stock.id + " sale",{item:trade,stock_id:stock.id,position_id:position.id});
        }
    }
    if (key === "stockHistory") { const removed = old.filter(h => !next.some(n => n.id === h.id)); if (removed.length) keep("history","계산 기록",{item:removed}); }
}
function snapshot(uid, reason = "manual") {
    const value = { portfolioStocks: [], silverStrategySettings: {}, stockHistory: [],
        ...Object.fromEntries([...(documents.get(uid) || new Map())].map(([key, row]) => [key, row.value])) };
    const row = { id: String(snapshots.length + 1), owner: uid, reason, created_at: new Date().toISOString(), documents: structuredClone(value) };
    snapshots.push(row); return row;
}
let browser, base, failWrites = false, failAfterCommit = false, dropResponses = 0, conflicts = 0;
let signupRequests = 0, confirmSignup = false;
const jwt = email => [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"),
    Buffer.from(JSON.stringify({ sub: accounts[email], email, role: "authenticated", exp: Math.floor(Date.now()/1000)+3600 })).toString("base64url"), "test-signature"].join(".");
const owner = req => {
    try { return JSON.parse(Buffer.from(req.headers.authorization.split(" ")[1].split(".")[1], "base64url")).sub; } catch { return null; }
};
function reply(res, status, data) { res.writeHead(status, { "Content-Type": "application/json", "X-Supabase-Api-Version": "2024-01-01" }); res.end(JSON.stringify(data)); }
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/backend/")) {
        let body = ""; for await (const chunk of req) body += chunk;
        const input = body ? JSON.parse(body) : {};
        requests.push({ path:url.pathname, input });
        if (url.pathname.endsWith("/auth/v1/recover")) return reply(res,200,{});
        if (url.pathname.endsWith("/auth/v1/signup")) {
            signupRequests++;
            await new Promise(resolve => setTimeout(resolve, 150));
            if (input.email === "rate@example.test") return reply(res, 429, { code: "over_request_rate_limit", msg: "Too many requests" });
            if (accounts[input.email]) return reply(res, 422, { code: "user_already_exists", msg: "Already registered" });
            const id = randomUUID(); accounts[input.email] = id;
            const user = { id, email: input.email, aud: "authenticated", role: "authenticated" };
            if (confirmSignup) return reply(res, 200, user);
            return reply(res, 200, { access_token: jwt(input.email), refresh_token: "refresh-test", expires_in: 3600, token_type: "bearer", user });
        }
        if (url.pathname.endsWith("/auth/v1/token")) {
            const email = input.email || "a@example.test";
            if (!accounts[email] || input.password && input.password !== (passwords.get(email) || "test-password")) return reply(res, 400, { error: "invalid_grant", error_description: "Invalid credentials" });
            return reply(res, 200, { access_token: jwt(email), refresh_token: "refresh-test", expires_in: 3600, token_type: "bearer", user: { id: accounts[email], email, aud: "authenticated", role: "authenticated" } });
        }
        if (url.pathname.endsWith("/auth/v1/logout")) { res.writeHead(204); return res.end(); }
        const uid = owner(req);
        if (!uid) return reply(res, 401, { message: "Login required", code: "42501" });
        if (url.pathname.endsWith("/auth/v1/user")) {
            const email = Object.keys(accounts).find(email => accounts[email] === uid);
            if (req.method === "PUT" && input.password) passwords.set(email,input.password);
            return reply(res,200,{id:uid,email,aud:"authenticated",role:"authenticated"});
        }
        const rows = documents.get(uid) || new Map(); documents.set(uid, rows);
        const name = url.pathname.split("/").pop();
        if (name === "silver_read_all") return reply(res, 200, [...rows.values()]);
        if (name === "silver_read_changes") return reply(res,200,[...rows.values()].filter(row => row.version > (input.p_versions[row.key] || 0)));
        if (name === "silver_operation_status") { const result = mutations.get(uid + input.p_mutation); return reply(res,200,result ? { saved:result.saved,key:result.document?.key } : null); }
        if (name === "silver_list_trash") return reply(res,200,trash.filter(t => t.owner === uid && Date.parse(t.expires_at)>Date.now()).map(({id,kind,label,created_at,expires_at}) => ({id,kind,label,created_at,expires_at})));
        if (name === "silver_trash_action") {
            if (input.p_owner !== uid) return reply(res,403,{code:"42501"});
            const receipt = uid + input.p_mutation; if (mutations.has(receipt)) return reply(res,200,mutations.get(receipt));
            const entry = trash.find(t => t.owner === uid && t.id === input.p_id);
            if (!entry && input.p_action !== "empty") return reply(res,400,{message:"Trash item missing"});
            if (input.p_action === "restore" && Date.parse(entry.expires_at)<=Date.now()) return reply(res,400,{message:"Trash item expired"});
            let result = {done:true};
            if (input.p_action === "restore") {
                const key = entry.kind === "history" ? "stockHistory" : "portfolioStocks";
                const prior = rows.get(key), value = structuredClone(prior?.value || []), item = structuredClone(entry.payload.item);
                if (entry.kind === "stock") value.push(item);
                else if (entry.kind === "history") value.unshift(...item);
                else { const stock = value.find(s => s.id === entry.payload.stock_id);
                    if (!stock) return reply(res,400,{message:"Restore parent missing"});
                    if (entry.kind === "position") stock.positions.push(item);
                    else { const p = stock.positions.find(p => p.id === entry.payload.position_id); if (!p) return reply(res,400,{message:"Restore parent missing"}); p.trades.push(item); }
                }
                const document = {owner_id:uid,key,value,version:(prior?.version||0)+1}; rows.set(key,document); result.document = document;
            }
            for (let i=trash.length-1;i>=0;i--) if (trash[i].owner === uid && (input.p_action === "empty" || trash[i].id === input.p_id)) trash.splice(i,1);
            mutations.set(receipt,result);
            if (dropResponses > 0) { dropResponses--; res.destroy(); return; }
            return reply(res,200,result);
        }
        if (name === "silver_read_document") return reply(res, 200, rows.get(input.p_key) || null);
        if (name === "silver_read_operation") return reply(res, 200, mutations.get(uid + input.p_mutation) || null);
        if (name === "silver_list_snapshots") return reply(res, 200, snapshots.filter(row => row.owner === uid).slice().reverse().map(({ id, reason, created_at }) => ({ id, reason, created_at })));
        if (name === "silver_create_snapshot") return reply(res, 200, snapshot(uid));
        if (name === "silver_read_snapshot") return reply(res, 200, snapshots.find(row => row.owner === uid && row.id === String(input.p_id))?.documents || null);
        if (name === "silver_restore_documents") {
            if (input.p_owner !== uid) return reply(res, 403, { code: "42501" });
            if (failWrites) return reply(res, 503, { message: "Simulated offline" });
            const mutationKey = uid + input.p_mutation;
            if (mutations.has(mutationKey)) return reply(res, 200, mutations.get(mutationKey));
            if (Object.keys(input.p_values).some(key => (rows.get(key)?.version || 0) !== input.p_versions[key])) return reply(res, 200, { restored: false });
            const prior = snapshot(uid, "before_restore");
            for (const [key, value] of Object.entries(input.p_values)) rows.set(key, { owner_id: uid, key, value, version: (rows.get(key)?.version || 0) + 1 });
            const result = { restored: true, documents: [...rows.values()], before_snapshot: prior };
            mutations.set(mutationKey, result);
            if (dropResponses > 0) { dropResponses--; res.destroy(); return; }
            return reply(res, 200, result);
        }
        if (name === "market-data") return reply(res, 200, input.action === "quote" ? { c: 25 } : { result: [] });
        if (name === "silver_write_document") {
            if (failWrites) return reply(res, 503, { message: "Simulated offline" });
            const mutationKey = uid + input.p_mutation;
            if (mutations.has(mutationKey)) {
                if (failAfterCommit) return reply(res, 400, { message: "Simulated lost commit receipt" });
                if (dropResponses > 0) { dropResponses--; res.destroy(); return; }
                return reply(res, 200, mutations.get(mutationKey));
            }
            // Force both browser requests to read the same revision before one commits.
            await new Promise(resolve => setTimeout(resolve, 35));
            const prior = rows.get(input.p_key);
            if ((prior?.version || 0) !== input.p_version) { conflicts++; return reply(res, 200, { saved: false }); }
            const document = { owner_id: uid, key: input.p_key, value: input.p_value, version: (prior?.version || 0)+1 };
            captureDeleted(uid,input.p_key,prior?.value,document.value);
            rows.set(input.p_key, document);
            if (input.p_backup) backups.push({ owner: uid, key: input.p_key, raw: input.p_backup });
            const result = { saved: true, document }; mutations.set(mutationKey, result);
            if (failAfterCommit) return reply(res, 400, { message: "Simulated lost commit receipt" });
            if (dropResponses > 0) { dropResponses--; res.destroy(); return; }
            return reply(res, 200, result);
        }
        if (name === "silver_import_local") {
            if (rows.size) return reply(res, 200, { imported: false });
            for (const [key, value] of Object.entries(input.p_values)) {
                rows.set(key, { owner_id: uid, key, value, version: 1 });
                if (input.p_originals[key] !== null) backups.push({ owner: uid, key, raw: input.p_originals[key] });
            }
            return reply(res, 200, { imported: true, documents: [...rows.values()] });
        }
        return reply(res, 404, { message: "Unknown endpoint" });
    }
    const file = path.resolve(root, "." + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    try {
        res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
        res.end(file.endsWith("backendConfig.js") ? `const SilverBackendConfig = ${JSON.stringify({ url: base + "/backend", publishableKey: "sb_publishable_test" })};` : fs.readFileSync(file));
    } catch { res.writeHead(404); res.end(); }
});
async function computer(seed) {
    const context = await browser.newContext(); contexts.push(context);
    await context.route("https://**/*", route => route.abort());
    if (seed) await context.addInitScript(seed => {
        if (!localStorage.getItem("migrationSeed")) {
            for (const [key,value] of Object.entries(seed)) localStorage.setItem(key, JSON.stringify(value));
            localStorage.setItem("migrationSeed", "1");
        }
    }, seed);
    const page = await context.newPage(); page.on("pageerror", e => errors.push(e.message));
    page.on("dialog", dialog => dialog.accept());
    await page.goto(base + "/index.html");
    return page;
}
async function login(page, email = "a@example.test") {
    await page.locator("#loginEmail").fill(email); await page.locator("#loginPassword").fill("test-password");
    await page.locator("#loginButton").click();
}
async function fillSignup(page, email, password = "test-password", confirmation = password) {
    await page.locator("#signupEmail").fill(email);
    await page.locator("#signupPassword").fill(password);
    await page.locator("#signupPasswordConfirm").fill(confirmation);
}
async function portfolio(page) {
    await page.waitForFunction(() => document.getElementById("pageFrame")?.contentWindow?.location.pathname.endsWith("/pages/portfolio.html"));
    const child = page.frames().find(frame => frame.url().endsWith("/pages/portfolio.html"));
    await child.locator(".stock-row").first().waitFor({ state: "visible" });
    return child;
}
module.exports = {
    async start() {
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); base = `http://127.0.0.1:${server.address().port}`;
        browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || "msedge" });
        return { browser, base };
    },
    async close() { for (const context of contexts) await context.close(); if (browser) await browser.close(); server.close(); },
    computer, login, portfolio, accounts, documents, mutations, snapshots, errors, trash, requests, jwt,
    addAccount(email, values = {}) {
        const id = randomUUID(); accounts[email] = id;
        documents.set(id, new Map(Object.entries(values).map(([key, value]) => [key, { owner_id: id, key, value, version: 1 }])));
        return id;
    },
    controls(options) {
        if ("failWrites" in options) failWrites = options.failWrites;
        if ("dropResponses" in options) dropResponses = options.dropResponses;
    }
};
if (require.main === module) (async () => {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || "msedge" });
    const seed = { portfolioStocks: [{ id: "A", displayName: "A", symbol: "", connected: false, positions: [] }, { id: "B", displayName: "B", symbol: "", connected: false, positions: [] }],
        silverStrategySettings: { pinnedSymbols: ["B"], stockOrder: ["B", "A"], manuallyOrderedStocks: ["B"], darkMode: true },
        stockHistory: [{ id: "123", price: 10, pct: 1, buy: "9.9", sell: "10.1" }] };
    const first = await computer(seed);
    if (process.env.TEST_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.TEST_SCREENSHOT_DIR, { recursive: true });
        await first.screenshot({ path: path.join(process.env.TEST_SCREENSHOT_DIR, "login.png") });
    }
    assert.equal(await first.locator("#appLayout").isVisible(), false);
    await first.locator("#loginEmail").fill("a@example.test"); await first.locator("#loginPassword").fill("wrong"); await first.locator("#loginButton").click();
    await first.waitForFunction(() => document.getElementById("authMessage").textContent.includes("비밀번호"));
    await login(first); await first.locator("#importLocalButton").click();
    await first.locator("#authPanel").waitFor({ state: "hidden" });
    let one = await portfolio(first);
    if (process.env.TEST_SCREENSHOT_DIR) await first.screenshot({ path: path.join(process.env.TEST_SCREENSHOT_DIR, "portfolio.png") });
    assert.equal(backups.length, 3);
    assert.equal(documents.get(accounts["a@example.test"]).size, 3);
    assert.deepEqual(await one.locator(".stock-row").evaluateAll(rows => rows.map(r => r.dataset.stockId)), ["B", "A"]);
    const second = await computer(); await login(second); await second.locator("#authPanel").waitFor({ state: "hidden" }); const two = await portfolio(second);
    assert.equal(await second.evaluate(() => localStorage.getItem("portfolioStocks")), null);
    await Promise.all([one.evaluate(() => PortfolioStorage.updateStocks(stocks => { stocks[0].memo = "first computer"; })),
        two.evaluate(() => PortfolioStorage.updateStocks(stocks => { stocks[1].memo = "second computer"; }))]);
    assert(conflicts > 0, "Both computers must exercise a real CAS conflict");
    assert.deepEqual(documents.get(accounts["a@example.test"]).get("portfolioStocks").value.map(s => s.memo), ["first computer", "second computer"]);
    assert.deepEqual(await first.evaluate(() => JSON.parse(localStorage.getItem("portfolioStocks"))), seed.portfolioStocks);
    await first.reload(); one = await portfolio(first);
    assert.equal(await one.evaluate(() => getStockById("B").memo), "second computer");
    failWrites = true;
    await one.evaluate(() => { openAddPositionModal(); dom.buyPrice.value = "10"; dom.buyQty.value = ".5"; });
    await one.locator("#savePositionBtn").click();
    await one.waitForFunction(() => !dom.savePositionBtn.disabled);
    assert.equal(await one.locator("#positionModal").isVisible(), true);
    assert.equal(await one.locator("#buyQty").inputValue(), ".5");
    failWrites = false; dropResponses = 1;
    await one.locator("#savePositionBtn").click(); await one.locator("#positionModal").waitFor({ state: "hidden" });
    assert.equal(documents.get(accounts["a@example.test"]).get("portfolioStocks").value[0].positions.length, 1);
    await one.evaluate(() => { openAddPositionModal(); dom.buyPrice.value = "10"; dom.buyQty.value = ".2"; });
    failAfterCommit = true;
    await one.locator("#savePositionBtn").click(); await one.waitForFunction(() => !dom.savePositionBtn.disabled);
    assert.equal(await one.locator("#positionModal").isVisible(), true);
    assert.equal(documents.get(accounts["a@example.test"]).get("portfolioStocks").value[0].positions.length, 2);
    failAfterCommit = false;
    await one.locator("#savePositionBtn").click(); await one.locator("#positionModal").waitFor({ state: "hidden" });
    assert.equal(documents.get(accounts["a@example.test"]).get("portfolioStocks").value[0].positions.length, 2);
    for (const page of [first, second]) await page.locator('[data-page="calculator"]').click();
    for (const page of [first, second]) await page.frameLocator("#pageFrame").locator("#autoDecimal").uncheck();
    await first.frameLocator("#pageFrame").locator("#basePrice").fill("10");
    await second.frameLocator("#pageFrame").locator("#basePrice").fill("20");
    await Promise.all([first.frameLocator("#pageFrame").locator('[data-percent="1"]').click(), second.frameLocator("#pageFrame").locator('[data-percent="1"]').click()]);
    await first.frameLocator("#pageFrame").locator("#historyBody tr").nth(2).waitFor();
    const history = documents.get(accounts["a@example.test"]).get("stockHistory").value;
    assert.equal(history.length, 3);
    assert.deepEqual(history.map(r => r.price).sort((a,b) => a-b), [10,10,20]);
    assert.equal(new Set(history.map(r => r.id)).size, 3);
    assert.equal(await second.evaluate(() => localStorage.getItem("stockHistory")), null);
    const other = await computer(); await login(other, "b@example.test"); await other.locator("#authPanel").waitFor({ state: "hidden" }); const three = await portfolio(other);
    assert.equal(await three.locator(".stock-row").count(), 1);
    assert.equal(await three.evaluate(() => getStockById("A")), null);
    await first.locator("#logoutButton").click(); await first.locator("#loginForm").waitFor({ state: "visible" });
    assert.equal(await first.locator("#appLayout").isVisible(), false);
    await login(first, "b@example.test"); await first.locator("#authPanel").waitFor({ state: "hidden" });
    assert.equal(await (await portfolio(first)).evaluate(() => getStockById("A")), null);

    const member = await computer();
    assert.equal(await member.locator("#signupForm").isVisible(), false);
    await member.locator("#loginEmail").fill("member@example.test");
    await member.locator("#showSignupButton").click();
    assert.equal(await member.locator("#loginForm").isVisible(), false);
    assert.equal(await member.locator("#signupEmail").inputValue(), "member@example.test");
    await fillSignup(member, "member@example.test", "test-password", "different-password");
    await member.locator("#signupButton").click();
    await member.waitForFunction(() => document.getElementById("authMessage").textContent.includes("일치하지"));
    assert.equal(signupRequests, 0, "Mismatched passwords must not create an account");
    await fillSignup(member, "member@example.test", "short");
    await member.locator("#signupButton").click();
    assert.equal(await member.locator("#signupPassword").evaluate(field => field.validity.tooShort), true);
    assert.equal(signupRequests, 0, "Short passwords must not create an account");
    await fillSignup(member, "a@example.test"); await member.locator("#signupButton").click();
    await member.waitForFunction(() => document.getElementById("authMessage").textContent.includes("이미 가입"));
    assert.equal(await member.locator("#signupForm").isVisible(), true);
    assert.equal(await member.locator("#signupEmail").inputValue(), "a@example.test");
    assert.equal(await member.locator("#signupPassword").inputValue(), "test-password");
    await fillSignup(member, "rate@example.test"); await member.locator("#signupButton").click();
    await member.waitForFunction(() => document.getElementById("authMessage").textContent.includes("요청이 많"));
    assert.equal(await member.locator("#signupButton").isEnabled(), true);
    const beforeSignup = signupRequests;
    await fillSignup(member, "member@example.test");
    await member.evaluate(() => { document.getElementById("signupForm").requestSubmit(); document.getElementById("signupForm").requestSubmit(); });
    assert.equal(await member.locator("#showLoginButton").isDisabled(), true);
    await member.locator("#authPanel").waitFor({ state: "hidden" });
    const memberPortfolio = await portfolio(member);
    assert.equal(signupRequests, beforeSignup + 1, "Repeated submission must create only one account");
    assert.equal(await member.locator("#accountText").textContent(), "member@example.test");
    assert.equal(await member.locator("#signupPassword").inputValue(), "");
    assert.equal(await memberPortfolio.evaluate(() => getStockById("A")), null);
    await member.reload(); await portfolio(member);
    assert.equal(await member.locator("#authPanel").isVisible(), false, "A new member's session must survive reload");
    await member.locator("#logoutButton").click(); await member.locator("#loginForm").waitFor({ state: "visible" });

    confirmSignup = true;
    await member.locator("#showSignupButton").click(); await fillSignup(member, "confirm@example.test");
    await member.locator("#signupButton").click();
    await member.waitForFunction(() => document.getElementById("authMessage").textContent.includes("확인 이메일"));
    assert.equal(await member.locator("#loginForm").isVisible(), true);
    assert.equal(await member.locator("#appLayout").isVisible(), false);
    assert.equal(await member.locator("#loginEmail").inputValue(), "confirm@example.test");
    assert.equal(await member.locator("#signupPassword").inputValue(), "");
    assert.equal(await member.locator("#loginButton").isEnabled(), true);
    confirmSignup = false;
    await member.locator("#showSignupButton").click();
    await member.setViewportSize({ width: 600, height: 300 });
    await member.locator("#signupButton").scrollIntoViewIfNeeded();
    const signupBounds = await member.locator("#signupButton").boundingBox();
    assert.ok(signupBounds.y >= 0 && signupBounds.y + signupBounds.height <= 301, "Signup remains reachable in short windows");
    if (process.env.TEST_SCREENSHOT_DIR) {
        await member.setViewportSize({ width: 1280, height: 900 });
        await member.screenshot({ path: path.join(process.env.TEST_SCREENSHOT_DIR, "signup.png") });
    }
    await member.locator("#showLoginButton").click();
    assert.equal(await member.locator("#signupForm").isVisible(), false);
    assert.equal(await member.locator("#loginEmail").inputValue(), "confirm@example.test");
    assert.deepEqual(errors, []);
    console.log("PASS Supabase SDK login/error/session/logout, account switch, migration and original backup, cross-computer CAS, no local business writes, failed-save draft retention and idempotent retry");
    console.log("PASS self-service signup, password confirmation/length, duplicate/rate-limit guidance, single submission, immediate account session/restore, confirmation fallback and short-window access");
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    for (const context of contexts) await context.close(); if (browser) await browser.close(); server.close();
});
