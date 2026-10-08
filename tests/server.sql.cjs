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
    await db.exec(fs.readFileSync(path.join(__dirname, "../supabase/checks/server-isolation.sql"), "utf8"));
    await db.exec(fs.readFileSync(path.join(__dirname, "../supabase/checks/trash-and-sync.sql"), "utf8"));
    await db.exec(fs.readFileSync(path.join(__dirname, "../supabase/checks/trash-retention.sql"), "utf8"));
    console.log("PASS trash six-month expiry, month end/leap year, expired access/restore denial, capacity cleanup, owner isolation and active data protection");
    console.log("PASS trash atomic capture, parent restore, totals, retry, duplicate/ownership protection, capacity rollback, history and compact changes");
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
    const c = randomUUID();
    await db.exec("reset role;"); await db.query("insert into auth.users(id) values ($1)", [c]); await asUser(c);
    const oldValues = { portfolioStocks: [{ id: "old", positions: [] }], silverStrategySettings: { darkMode: false }, stockHistory: [] };
    for (const [key, value] of Object.entries(oldValues)) await write(key, value, 0);
    const manual = await scalar("select public.silver_create_snapshot() as value");
    assert.deepEqual(await scalar("select public.silver_read_snapshot($1::bigint) as value", [manual.id]), oldValues);
    await write("silverStrategySettings", { darkMode: true }, 1);
    assert.equal((await db.query("select * from public.silver_snapshots where reason = 'automatic'")).rows.length, 1);
    await write("silverStrategySettings", { darkMode: false }, 2);
    assert.equal((await db.query("select * from public.silver_snapshots where reason = 'automatic'")).rows.length, 1);
    const restore = (values, versions, token, owner = c) => scalar("select public.silver_restore_documents($1::jsonb,$2::jsonb,$3::uuid,$4::uuid) as value", [JSON.stringify(values), JSON.stringify(versions), token, owner]);
    const versions = { portfolioStocks: 1, silverStrategySettings: 3, stockHistory: 1 };
    const newValues = { portfolioStocks: [{ id: "new", positions: [] }], silverStrategySettings: { darkMode: true }, stockHistory: [] };
    assert.equal((await restore(newValues, { ...versions, stockHistory: 0 }, randomUUID())).restored, false);
    assert.equal((await scalar("select public.silver_read_document('portfolioStocks') as value")).value[0].id, "old");
    await assert.rejects(restore({ ...newValues, stockHistory: [{ id: 1, price: -1, pct: 1 }] }, versions, randomUUID()));
    await assert.rejects(restore(newValues, versions, randomUUID(), a), /Authentication required/);
    const restoreToken = randomUUID(); const restored = await restore(newValues, versions, restoreToken);
    assert.equal(restored.restored, true);
    assert.equal(restored.documents.length, 3);
    assert.deepEqual(await restore(oldValues, versions, restoreToken), restored, "Lost responses replay the receipt without another restore");
    assert.deepEqual(await scalar("select public.silver_read_snapshot($1::bigint) as value", [restored.before_snapshot.id]), oldValues);
    await assert.rejects(db.query("delete from public.silver_snapshots"), /permission denied/);
    await asUser(b);
    assert.equal(await scalar("select public.silver_read_snapshot($1::bigint) as value", [manual.id]), null);
    assert((await scalar("select public.silver_list_snapshots() as value")).every(row => row.id !== manual.id && row.id !== restored.before_snapshot.id));
    await db.exec("reset role; set role anon;");
    for (const sql of ["select public.silver_list_snapshots()", "select public.silver_create_snapshot()", "select * from public.silver_snapshots"])
        await assert.rejects(db.query(sql), /permission denied/);
    await asUser(c);
    for (let i = 0; i < 24; i++) await scalar("select public.silver_create_snapshot() as value");
    assert.equal((await db.query("select * from public.silver_snapshots")).rows.length, 20);
    await db.close();
    console.log("PASS daily snapshots, account isolation, atomic restore, validation, stale-version rejection, idempotent replay, pre-restore protection and retention");
    console.log("PASS PostgreSQL migration, RLS, anonymous denial, account isolation, CAS, idempotency, validation, quota, atomic import and raw backup");
})().catch(error => { console.error(error); process.exitCode = 1; });
