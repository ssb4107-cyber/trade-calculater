// Run with @electric-sql/pglite on NODE_PATH; executes the real migration in PostgreSQL.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");
(async () => {
    const db = new PGlite();
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    await db.exec(`create role anon; create role authenticated; create schema auth;
        create table auth.users(id uuid primary key);
        create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        grant usage on schema auth to authenticated, anon;
        insert into auth.users values ('${a}'), ('${b}');`);
    const migrations = path.join(__dirname, "../supabase/migrations");
    for (const file of fs.readdirSync(migrations).filter(file => file.endsWith(".sql")).sort()) {
        await db.exec(fs.readFileSync(path.join(migrations, file), "utf8"));
    }
    await db.exec(fs.readFileSync(path.join(__dirname, "../supabase/checks/server-storage.sql"), "utf8"));
    const asUser = async id => {
        await db.exec("reset role; set role authenticated;");
        await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
    };
    const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].value;
    const write = (key, value, version, mutation = randomUUID()) => scalar("select public.silver_write_document($1, $2::jsonb, $3, $4::uuid, null) as value", [key, JSON.stringify(value), version, mutation]);
    await asUser(a);
    assert.deepEqual((await db.query("select * from public.silver_read_all()")).rows, []);
    const token = randomUUID();
    const first = await write("portfolioStocks", [{ id: "A", positions: [] }], 0, token);
    assert.equal(first.saved, true);
    assert.equal(first.document.version, 1);
    assert.deepEqual(await write("portfolioStocks", [{ id: "A", positions: [] }], 0, token), first);
    assert.deepEqual(await scalar("select public.silver_read_operation($1::uuid) as value", [token]), first);
    assert.equal((await write("portfolioStocks", [{ id: "B", positions: [] }], 0)).saved, false);
    const second = await write("portfolioStocks", [{ id: "A", positions: [] }, { id: "B", positions: [] }], 1);
    assert.equal(second.document.version, 2);
    await asUser(b);
    assert.equal(await scalar("select public.silver_read_operation($1::uuid) as value", [token]), null);
    assert.equal(await scalar("select silver_private.silver_read_operation($1::uuid) as value", [token]), null);
    assert.deepEqual((await db.query("select * from public.silver_read_all()")).rows, []);
    assert.equal(await scalar("select public.silver_read_document('portfolioStocks') as value"), null);
    assert.equal((await write("portfolioStocks", [{ id: "C", positions: [] }], 0)).document.owner_id, b);
    await assert.rejects(db.query("update public.silver_documents set value = '[]'"), /permission denied/);
    await assert.rejects(db.query("select * from public.silver_mutations"), /permission denied/);
    await asUser(a);
    assert.equal((await scalar("select public.silver_read_document('portfolioStocks') as value")).value.length, 2);
    for (const bad of [
        [{ id: "A", positions: [] }, { id: "A", positions: [] }],
        [{ id: "A", positions: [{ id: 1, buyQty: 1, buyPrice: 10, trades: [{ id: 1, type: "SELLL", qty: 1, price: 12 }] }] }],
        [{ id: "A", positions: [{ id: 1, buyQty: 1, buyPrice: 10, trades: [{ id: 1, type: "SELL", qty: 2, price: 12 }] }] }],
        [{ id: "A", positions: [{ id: 1, buyQty: 1e-20, buyPrice: 10, trades: [{ id: 1, type: "SELL", qty: 2e-20, price: 12 }] }] }]
    ]) await assert.rejects(write("portfolioStocks", bad, 2));
    await assert.rejects(write("silverStrategySettings", { finnhubApiKey: "not-a-server-secret" }, 0));
    await db.exec("reset role; set role anon;");
    await assert.rejects(db.query("select silver_private.silver_read_operation($1::uuid)", [token]), /permission denied/);
    await assert.rejects(db.query("select * from public.silver_documents"), /permission denied/);
    await assert.rejects(db.query("select public.silver_read_all()"), /permission denied/);
    await asUser(a);
    assert.equal(await scalar("select public.silver_market_allow() as value"), true);
    for (let i = 1; i < 12; i++) assert.equal(await scalar("select public.silver_market_allow() as value"), true);
    assert.equal(await scalar("select public.silver_market_allow() as value"), false);
    await asUser(b);
    assert.equal(await scalar("select public.silver_market_allow() as value"), true);
    await db.exec("reset role; delete from public.silver_documents;");
    await asUser(a);
    const values = { portfolioStocks: [{ id: "imported", positions: [] }], silverStrategySettings: {}, stockHistory: [] };
    const importArgs = [JSON.stringify(values), JSON.stringify({ portfolioStocks: "original-bytes" }), randomUUID()];
    const imported = await scalar("select public.silver_import_local($1::jsonb, $2::jsonb, $3::uuid) as value", importArgs);
    assert.equal(imported.imported, true);
    assert.equal(imported.documents.length, 3);
    assert.equal((await db.query("select * from public.silver_recovery_backups")).rows[0].original, "original-bytes");
    assert.deepEqual(await scalar("select public.silver_import_local($1::jsonb, $2::jsonb, $3::uuid) as value", importArgs), imported);
    assert.equal((await scalar("select public.silver_import_local($1::jsonb, '{}'::jsonb, $2::uuid) as value", [JSON.stringify(values), randomUUID()])).imported, false);
    await asUser(b);
    assert.equal((await db.query("select * from public.silver_recovery_backups")).rows.length, 0);
    assert.equal((await db.query("select * from public.silver_documents")).rows.length, 0);
    await db.close();
    console.log("PASS PostgreSQL migration, RLS, anonymous denial, account isolation, CAS, idempotency, validation, quota, atomic import and raw backup");
})().catch(error => { console.error(error); process.exitCode = 1; });
