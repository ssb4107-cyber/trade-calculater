const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { stripTypeScriptTypes } = require("node:module");
function edge(options = {}) {
    let handler, calls = 0;
    const source = stripTypeScriptTypes(fs.readFileSync(path.join(__dirname, "../supabase/functions/market-data/index.ts"), "utf8")).replace(/^import .*;$/m, "");
    const context = vm.createContext({ Request, Response, URL, AbortSignal, Number, Date, Map,
        Deno: { env: { get: key => ({ SUPABASE_URL: "https://example.test", SUPABASE_ANON_KEY: "test-public", FINNHUB_API_KEY: options.missingKey ? "" : "test-private" })[key] }, serve: callback => handler = callback },
        createClient: (_url, _key, config) => ({ auth: { getUser: async () => config.global.headers.Authorization === "Bearer valid"
            ? { data: { user: { id: "A" } }, error: null } : { data: { user: null }, error: {} } },
            rpc: async () => ({ data: !options.deniedQuota, error: null }) }),
        fetch: async url => { calls++; assert.equal(url.hostname, "finnhub.io"); assert.equal(url.searchParams.get("token"), "test-private");
            return options.failure ? new Response("upstream secret must not be exposed", { status: 500 })
                : new Response(JSON.stringify(url.pathname.endsWith("quote") ? { c: 25, t: 123, privateField: "discard" }
                    : { result: [{ symbol: "A", description: "Company A", type: "Common Stock", extra: "discard" }] })); }
    });
    vm.runInContext(source, context);
    const invoke = (body = { action: "quote", symbol: "A" }, token = "valid", origin = "https://ssb4107-cyber.github.io", method = "POST") => handler(new Request("https://example.test/market-data", {
        method, headers: { Origin: origin, Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: method === "POST" ? JSON.stringify(body) : undefined
    }));
    return { invoke, calls: () => calls };
}
test("market rejects missing/invalid auth even when a cached quote exists", async () => {
    const app = edge(); assert.equal((await app.invoke()).status, 200);
    assert.equal((await app.invoke(undefined, "invalid")).status, 401);
    assert.equal(app.calls(), 1);
});
test("market limits origin, method, action and symbol without forwarding requests", async () => {
    const app = edge();
    assert.equal((await app.invoke(undefined, "valid", "https://other.test")).status, 403);
    assert.equal((await app.invoke(undefined, "valid", undefined, "GET")).status, 405);
    assert.equal((await app.invoke({ action: "anything", symbol: "A" })).status, 400);
    assert.equal((await app.invoke({ action: "quote", symbol: "http://wrong" })).status, 400);
    assert.equal(app.calls(), 0);
});
test("market enforces quota and missing secret with meaningful HTTP status", async () => {
    assert.equal((await edge({ deniedQuota: true }).invoke()).status, 429);
    assert.equal((await edge({ missingKey: true }).invoke()).status, 503);
});
test("market forwards only whitelisted results and shares cached quotes", async () => {
    const app = edge();
    assert.deepEqual(await (await app.invoke()).json(), { c: 25, t: 123 });
    assert.deepEqual(await (await app.invoke()).json(), { c: 25, t: 123 });
    assert.equal(app.calls(), 1);
    assert.deepEqual(await (await app.invoke({ action: "search", query: "A" })).json(), { result: [{ symbol: "A", description: "Company A", type: "Common Stock" }] });
});
test("market error responses never return upstream bodies or the provider secret", async () => {
    const response = await edge({ failure: true }).invoke();
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "Market data unavailable" });
});
