// Crush Radio — Build step
// Inlines static assets into workers/main/index.js placeholders and writes
// workers/main/index.built.js:
//   `__HTML__`   ← index.html      (home page shell)
//   `__APP_JS__` ← web/app.js      (client app, served at /assets/app.js)
// Run automatically before `npm run dev` and `npm run deploy`
// via the package.json predev/predeploy hooks.

import { readFile, writeFile } from "node:fs/promises";

const WORKER_PATH = "workers/main/index.js";
const OUT_PATH = "workers/main/index.built.js";

const ASSETS = [
  { placeholder: "`__HTML__`", path: "index.html" },
  { placeholder: "`__APP_JS__`", path: "web/app.js" },
];

// Escape each asset so it survives being embedded inside a JS template
// literal: backslashes first, then backticks, then ${ interpolation.
function escapeForTemplate(s) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
}

let built = await readFile(WORKER_PATH, "utf8");
const sizes = [];

for (const { placeholder, path } of ASSETS) {
  if (!built.includes(placeholder)) {
    throw new Error(`Placeholder ${placeholder} not found in ${WORKER_PATH}`);
  }
  const content = await readFile(path, "utf8");
  built = built.replace(placeholder, "`" + escapeForTemplate(content) + "`");
  sizes.push(`${path} ${content.length.toLocaleString()} bytes`);
}

await writeFile(OUT_PATH, built);

console.log(`Built ${OUT_PATH} (${built.length.toLocaleString()} bytes; ${sizes.join("; ")})`);
