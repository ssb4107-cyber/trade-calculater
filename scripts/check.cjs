const fs = require("node:fs"), path = require("node:path"), { spawnSync } = require("node:child_process"), { createHash } = require("node:crypto");
const root = path.resolve(__dirname,"..");
function run(args) { const result = spawnSync(process.execPath,args,{cwd:root,stdio:"inherit",env:process.env}); if (result.status !== 0) process.exit(result.status || 1); }
for (const file of fs.readdirSync(path.join(root,"js")).filter(file => file.endsWith(".js"))) run(["--check","js/"+file]);
if (createHash("sha256").update(fs.readFileSync(path.join(root,"js/vendor/supabase.js"))).digest("hex") !== "59d39487c3589843b410322d8a3d562ce022aba1e5ccb16898ef3fb2a0da2ecd") throw new Error("Vendored SDK checksum changed: review version and checksum together");
run(["--test","tests/domain.test.cjs","tests/market.test.cjs"]);
for (const file of ["server.sql.cjs","portfolio.browser.cjs","p2.browser.cjs","server.browser.cjs","audit-p2.browser.cjs","p3.browser.cjs","ui-refresh.browser.cjs"]) run(["tests/"+file]);
