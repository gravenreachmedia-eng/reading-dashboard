// server.js — serves the dashboard and a small JSON API.
//   GET  /                  → the dashboard page
//   GET  /api/feeds         → cached feed payload (fetches on first run)
//   POST /api/refresh       → force a re-fetch of all sources
//   GET  /api/bookmarks     → saved articles
//   POST /api/bookmarks     → save one  { url, title, source }
//   DELETE /api/bookmarks   → remove one { url }
//
// Feeds refresh automatically on startup and every morning at 06:00 (local) via cron.
import express from "express";
import cron from "node-cron";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { refreshAndCache, readCache } from "./lib/feeds.js";
import * as bookmarks from "./lib/bookmarks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4321;

// On hosts with an ephemeral filesystem (e.g. Render free tier) a server-side
// bookmarks file wouldn't survive restarts, so tell the client to keep bookmarks
// in the browser's localStorage instead. Set CLIENT_BOOKMARKS=1 in that case.
const CLIENT_BOOKMARKS = process.env.CLIENT_BOOKMARKS === "1";
const INDEX_PATH = path.join(__dirname, "public", "index.html");

app.use(express.json({ limit: "64kb" }));

// Serve the page ourselves so we can inject runtime config; assets via static.
app.get("/", async (_req, res, next) => {
  try {
    let html = await fs.readFile(INDEX_PATH, "utf8");
    if (CLIENT_BOOKMARKS) {
      html = html.replace("</head>", '  <script>window.__CONFIG__={bookmarks:"local"};</script>\n</head>');
    }
    res.type("html").send(html);
  } catch (e) { next(e); }
});

// Lightweight health check (used by uptime pingers / the host).
app.get("/healthz", (_req, res) => res.type("text").send("ok"));

app.use(express.static(path.join(__dirname, "public"), { index: false }));

let refreshing = null; // shared promise so concurrent callers don't double-fetch

function refresh() {
  if (!refreshing) {
    refreshing = refreshAndCache()
      .catch((e) => { console.error("[feeds] refresh failed:", e.message); return readCache(); })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

app.get("/api/feeds", async (_req, res) => {
  let payload = await readCache();
  if (!payload) payload = await refresh();
  res.json(payload || { updatedAt: null, sections: [], error: "No data yet" });
});

app.post("/api/refresh", async (_req, res) => {
  const payload = await refresh();
  res.json(payload || { error: "Refresh failed" });
});

app.get("/api/bookmarks", async (_req, res) => {
  res.json(await bookmarks.list());
});

app.post("/api/bookmarks", async (req, res) => {
  try {
    res.json(await bookmarks.add(req.body));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/bookmarks", async (req, res) => {
  const url = String(req.body?.url || "");
  res.json(await bookmarks.remove(url));
});

app.listen(PORT, () => {
  console.log(`\n  Reading dashboard → http://localhost:${PORT}\n`);
  refresh().then((p) => {
    if (p?.totalItems != null) console.log(`  Loaded ${p.totalItems} articles across all sources.`);
  });
});

// Refresh every morning at 06:00 local time.
cron.schedule("0 6 * * *", () => {
  console.log("[cron] morning refresh");
  refresh();
});
