const fs = require("node:fs"), path = require("node:path");
const root = path.resolve(__dirname,".."), output = path.join(root,"dist");
// A fixed output path only; never copy credentials, diagnostics, tests or node_modules.
if (path.dirname(output) !== root || path.basename(output) !== "dist") throw new Error("Unexpected build output path");
fs.rmSync(output,{recursive:true,force:true});
fs.mkdirSync(output,{recursive:true});
for (const name of ["index.html","pages","js","css"]) fs.cpSync(path.join(root,name),path.join(output,name),{recursive:true});
fs.writeFileSync(path.join(output,".nojekyll"),"");
console.log("Built reviewed public site files in dist");
