// bookmarks.js — server-side saved-articles store, persisted to data/bookmarks.json
// so saves survive browser clears and are shared across devices on this machine.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "..", "data", "bookmarks.json");

async function load() {
  try {
    const data = JSON.parse(await fs.readFile(FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function save(list) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(list, null, 2), "utf8");
}

export async function list() {
  return load();
}

// Add a bookmark (deduped by url). Keeps newest first.
export async function add(article) {
  const url = String(article?.url || "").trim();
  const title = String(article?.title || "").trim();
  if (!/^https?:\/\//i.test(url) || !title) {
    throw new Error("A valid url and title are required");
  }
  const list = await load();
  if (list.some((b) => b.url === url)) return list; // already saved
  list.unshift({
    url,
    title: title.slice(0, 300),
    source: String(article?.source || "").slice(0, 80),
    savedAt: new Date().toISOString(),
  });
  await save(list);
  return list;
}

// Remove a bookmark by url.
export async function remove(url) {
  const list = (await load()).filter((b) => b.url !== url);
  await save(list);
  return list;
}
