// Crush Radio — Build step
// Inlines index.html into workers/main/index.js by replacing the
// `__HTML__` placeholder, then writes workers/main/index.built.js.
// Run automatically before `npm run dev` and `npm run deploy`
// via the package.json predev/predeploy hooks.

import { readFile, writeFile } from "node:fs/promises";

const HTML_PATH = "index.html";
const WORKER_PATH = "workers/main/index.js";
const OUT_PATH = "workers/main/index.built.js";

const html = await readFile(HTML_PATH, "utf8");
const worker = await readFile(WORKER_PATH, "utf8");

// Escape the HTML so it survives being embedded inside a JS template
// literal: backslashes first, then backticks, then ${ interpolation.
const escaped = html
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\$\{/g, "\\${");

const placeholder = "`__HTML__`";
if (!worker.includes(placeholder)) {
  throw new Error(`Placeholder ${placeholder} not found in ${WORKER_PATH}`);
}

const built = worker.replace(placeholder, "`" + escaped + "`");
await writeFile(OUT_PATH, built);

console.log(
  `Built ${OUT_PATH} (${built.length.toLocaleString()} bytes; HTML payload ${html.length.toLocaleString()} bytes)`
);
