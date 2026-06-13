// build-static.mjs — produce ONE self-contained, shareable HTML file.
// Fetches a fresh snapshot of all feeds and inlines the data + CSS + JS into
// reading-dashboard.html, with no external dependencies and no server. The file
// can be sent over WhatsApp/email and opened by double-click on any device.
//
//   npm run build:static
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPayload } from "./lib/feeds.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(__dirname, "public");
const OUT = path.join(__dirname, "reading-dashboard.html");

console.log("Fetching a fresh snapshot of all sources…");
const payload = await buildPayload();
console.log(`Got ${payload.totalItems} articles.`);

const [html, css, js] = await Promise.all([
  fs.readFile(path.join(pub, "index.html"), "utf8"),
  fs.readFile(path.join(pub, "styles.css"), "utf8"),
  fs.readFile(path.join(pub, "app.js"), "utf8"),
]);

// Escape "<" so nothing in the data/script can close the <script> early.
const dataJson = JSON.stringify(payload).replace(/</g, "\\u003c");
const safeJs = js.replace(/<\/script>/gi, "<\\/script>");

const out = html
  .replace(
    '<link rel="stylesheet" href="./styles.css" />',
    `<style>\n${css}\n</style>`
  )
  .replace(
    '<script src="./app.js"></script>',
    `<script>window.__FEEDS__ = ${dataJson};</script>\n  <script>\n${safeJs}\n</script>`
  );

await fs.writeFile(OUT, out, "utf8");
const kb = Math.round((Buffer.byteLength(out, "utf8") / 1024) * 10) / 10;
console.log(`\nWrote ${OUT}  (${kb} KB)`);
console.log("Send that single file over WhatsApp/email — it opens by double-click, no install.");
