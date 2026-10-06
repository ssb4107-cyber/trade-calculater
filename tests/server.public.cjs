// Checks the deployed public endpoints without passwords or privileged keys.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const config = vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../js/backendConfig.js"), "utf8") + "; SilverBackendConfig;");
const origin = "https://ssb4107-cyber.github.io";

async function request(route, options = {}) {
    return fetch(config.url + route, {
        ...options,
        headers: { apikey: config.publishableKey, Origin: origin, "Content-Type": "application/json", ...options.headers },
        signal: AbortSignal.timeout(15000)
    });
}
(async () => {
    assert.ok(config.url && config.publishableKey.startsWith("sb_publishable_"), "Configure a deployed project with a publishable key");
    for (const route of ["/rest/v1/silver_documents?select=key", "/rest/v1/silver_recovery_backups?select=id"]) {
        assert.ok([401, 403].includes((await request(route)).status), "Anonymous table access must be denied");
    }
    const read = await request("/rest/v1/rpc/silver_read_all", { method: "POST", body: "{}" });
    assert.ok([401, 403].includes(read.status), "Anonymous RPC must be denied");
    console.log("PASS deployed anonymous table and RPC access denied");

    const route = "/functions/v1/market-data";
    const body = JSON.stringify({ action: "quote", symbol: "AAPL" });
    assert.equal((await request(route, { method: "POST", body })).status, 401);
    assert.equal((await request(route, { method: "POST", body, headers: { Authorization: "Bearer invalid-token" } })).status, 401);
    assert.equal((await request(route)).status, 405);
    assert.equal((await request(route, { method: "POST", body, headers: { Origin: "https://invalid.example" } })).status, 403);
    const preflight = await request(route, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    console.log("PASS deployed market authentication, origin, method and browser preflight");

    const settingsResponse = await request("/auth/v1/settings");
    assert.equal(settingsResponse.status, 200);
    const settings = await settingsResponse.json();
    console.log("CONFIG " + JSON.stringify({ signupClosed: settings.disable_signup === true,
        anonymousDisabled: settings.external?.anonymous_users === false, emailEnabled: settings.external?.email === true }));
    // This test deliberately does not create accounts, send emails, or claim that
    // password login / configured market quotes have been verified.
})().catch(() => { console.error("FAIL deployed public endpoint check; inspect project availability and configuration"); process.exitCode = 1; });
