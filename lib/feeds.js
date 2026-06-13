// feeds.js — fetch + parse the configured sources into a normalized JSON shape.
// No XML library: a tolerant regex parser tuned to the 9 known feeds (all RSS 2.0,
// with Atom <entry> support kept as a safety net). Verified against live feeds.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
export const CACHE_FILE = path.join(DATA_DIR, "feeds.json");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const ITEMS_PER_PANEL = 12;

// bing(domain) builds a Bing News RSS query scoped to one site. Used for Reuters,
// which has no public RSS. Bing (unlike Google News) is reachable from datacenter
// IPs, so it works on hosted deployments; the direct article URL is embedded in the
// redirect link and unwrapped in parseFeed.
const bing = (domain) =>
  `https://www.bing.com/news/search?q=site%3A${encodeURIComponent(domain)}&format=rss`;

// The dashboard layout: 3 sections, each with one or more source panels.
export const SECTIONS = [
  {
    id: "world",
    title: "World News",
    panels: [
      { id: "guardian-world", label: "The Guardian — World", home: "https://www.theguardian.com/world",
        url: "https://www.theguardian.com/world/rss", kind: "rss" },
      { id: "reuters", label: "Reuters", home: "https://www.reuters.com",
        url: bing("reuters.com"), kind: "bing", note: "via Bing News" },
      { id: "guardian-longread", label: "The Guardian — The Long Read", home: "https://www.theguardian.com/news/series/the-long-read",
        url: "https://www.theguardian.com/news/series/the-long-read/rss", kind: "rss", weekly: true },
    ],
  },
  {
    id: "economics",
    title: "Economics Research",
    panels: [
      { id: "voxdev", label: "VoxDev", home: "https://voxdev.org",
        url: "https://voxdev.org/rss.xml", kind: "rss" },
      { id: "ideasforindia", label: "Ideas for India", home: "https://www.ideasforindia.in",
        url: "https://www.ideasforindia.in/", kind: "scrape", note: "from ideasforindia.in" },
      { id: "worldbank", label: "World Bank Blogs", home: "https://blogs.worldbank.org",
        url: "https://blogs.worldbank.org/en/home", kind: "scrape", note: "from blogs.worldbank.org" },
      { id: "nber", label: "NBER — New Working Papers", home: "https://www.nber.org/papers",
        url: "https://back.nber.org/rss/new.xml", kind: "rss", undated: true },
    ],
  },
  {
    id: "ideas",
    title: "Ideas & Essays",
    panels: [
      { id: "aeon", label: "Aeon", home: "https://aeon.co",
        url: "https://aeon.co/feed.rss", kind: "rss" },
      { id: "psyche", label: "Psyche", home: "https://psyche.co",
        url: "https://psyche.co/feed.rss", kind: "rss" },
    ],
  },
];

// ---- parsing helpers -------------------------------------------------------

const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", rsquo: "’",
  lsquo: "‘", ldquo: "“", rdquo: "”", eacute: "é",
};
function decodeEntities(s = "") {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => (n in NAMED ? NAMED[n] : m));
}
function stripTags(s = "") {
  // Decode entities FIRST: feeds like the Guardian entity-encode their HTML
  // (&lt;p&gt;…), so tags only become strippable after decoding.
  return decodeEntities(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function unCdata(s = "") {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? unCdata(m[1]).trim() : "";
}
function attr(block, name, a) {
  const m = block.match(new RegExp(`<${name}\\b[^>]*\\b${a}=["']([^"']+)["']`, "i"));
  return m ? m[1] : "";
}

function extractLink(block) {
  // RSS: <link>url</link>; Atom: <link href="url"/> (prefer rel="alternate"/html)
  const rss = tag(block, "link");
  if (rss && /^https?:/i.test(rss)) return rss.trim();
  const alt = block.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i);
  if (alt) return alt[1];
  const href = attr(block, "link", "href");
  return href || rss || "";
}

function extractImage(block) {
  return (
    attr(block, "media:content", "url") ||
    attr(block, "media:thumbnail", "url") ||
    attr(block, "enclosure", "url") ||
    tag(block, "cover_image") ||
    (block.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i) || [])[1] ||
    ""
  );
}

function extractDate(block) {
  const raw =
    tag(block, "pubDate") || tag(block, "published") ||
    tag(block, "updated") || tag(block, "dc:date") || "";
  return toIso(raw);
}

// Parse a date string (RSS dates or human "March 6, 2026") → ISO, or null.
function toIso(raw) {
  if (!raw) return null;
  const t = Date.parse(raw.trim());
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// Bing News links are redirects like .../apiclick.aspx?...&url=<encoded real url>.
// The feed entity-encodes the ampersands (&amp;), so decode before matching url=.
function unwrapBing(link) {
  const decoded = decodeEntities(link);
  const m = decoded.match(/[?&]url=([^&]+)/i);
  if (m) { try { return decodeURIComponent(m[1]); } catch { /* fall through */ } }
  return decoded;
}

// "maritime-chokepoints-indias-energy" → "Maritime chokepoints indias energy".
// Used where a site's article titles can't be reliably scraped but the URL slug
// can — slug-derived titles are always correctly paired with their article.
function slugToTitle(slug) {
  const t = decodeURIComponent(slug).replace(/-/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function parseFeed(xml, panel) {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  const items = [];
  for (const block of blocks) {
    let title = stripTags(tag(block, "title"));
    let url = extractLink(block);
    // Bing News wraps the real article URL in a redirect; unwrap the ?url= param.
    if (panel.kind === "bing") url = unwrapBing(url);
    // Only http(s) article links reach the page — a feed could carry a
    // javascript:/data: URL, which must never become a clickable href.
    if (!title || !/^https?:\/\//i.test(url)) continue;

    let summary = stripTags(
      tag(block, "description") || tag(block, "summary") || tag(block, "content") || tag(block, "content:encoded")
    );
    // NBER encodes authors in the title as "Title -- by A, B"; lift it out.
    let author = stripTags(tag(block, "dc:creator") || tag(block, "author"));
    if (panel.id === "nber") {
      const m = title.match(/^(.*?)\s+--\s+by\s+(.+)$/i);
      if (m) { title = m[1].trim(); author = m[2].replace(/ⓡ/g, "&").trim(); }
    }
    if (summary.length > 240) summary = summary.slice(0, 237).trimEnd() + "…";

    const image = extractImage(block);
    items.push({
      id: (tag(block, "guid") || url).slice(0, 300),
      title,
      url,
      date: extractDate(block),
      author: author || "",
      summary,
      image: /^https?:\/\//i.test(image) ? image : "",
    });
  }
  // newest first when dated; otherwise preserve feed order (e.g. NBER)
  if (!panel.undated) {
    items.sort((a, b) => (b.date ? Date.parse(b.date) : 0) - (a.date ? Date.parse(a.date) : 0));
  }
  return items.slice(0, ITEMS_PER_PANEL);
}

// Scrape an article listing straight from the source site, for sources that have
// no public feed AND can't use a news aggregator from a datacenter IP. These are
// HTML extractors keyed by panel id — more fragile than RSS (they break if the
// site is redesigned), so each is best-effort and isolated by fetchPanel's catch.
function scrapeSite(html, panel) {
  const items = [];
  const push = (url, title, dateRaw) => {
    title = stripTags(title);
    if (!title || !/^https?:\/\//i.test(url)) return;
    items.push({ id: url, title, url, date: toIso(dateRaw), author: "", summary: "", image: "" });
  };

  if (panel.id === "worldbank") {
    // <h3 class="swiper_card_title"><a href="/en/…">Title</a></h3><p>July 01, 2024</p>
    const re = /swiper_card_title[^>]*>\s*<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h3>\s*<p>([^<]*)<\/p>/gi;
    let m;
    while ((m = re.exec(html))) {
      const href = m[1].startsWith("http") ? m[1] : "https://blogs.worldbank.org" + m[1];
      push(href, m[2], m[3]);
    }
  } else if (panel.id === "ideasforindia") {
    // The site's on-page titles are unreliably paired with their links (a card's
    // label sometimes belongs to a different article), so derive the title from
    // the article's own slug — always correct, just sentence-cased. Dedupe by slug
    // since /topics/… and /featured-articles/… can point to the same article.
    const re = /href="(\/(?:topics\/[a-z-]+|featured-articles)\/([a-z0-9-]{12,}))"/gi;
    const seenSlug = new Set();
    let m;
    while ((m = re.exec(html))) {
      if (seenSlug.has(m[2])) continue;
      seenSlug.add(m[2]);
      push("https://www.ideasforindia.in" + m[1], slugToTitle(m[2]), null);
    }
  }

  // dedupe by url (listings often repeat a card for mobile/desktop), newest first
  const seen = new Set();
  const unique = items.filter((it) => (seen.has(it.url) ? false : seen.add(it.url)));
  unique.sort((a, b) => (b.date ? Date.parse(b.date) : 0) - (a.date ? Date.parse(a.date) : 0));
  return unique.slice(0, ITEMS_PER_PANEL);
}

// ---- fetching --------------------------------------------------------------

async function fetchPanel(panel) {
  const out = { ...panel, items: [], error: null };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(panel.url, { signal: ctrl.signal, headers: { "User-Agent": UA } });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    out.items = panel.kind === "scrape" ? scrapeSite(text, panel) : parseFeed(text, panel);
    if (out.items.length === 0) out.error = "No articles found";
  } catch (e) {
    out.error = e.name === "AbortError" ? "Timed out" : e.message;
  }
  // strip fields the client doesn't need
  delete out.url;
  delete out.kind;
  delete out.undated;
  return out;
}

// Fetch every source and assemble the dashboard payload.
export async function buildPayload() {
  const sections = await Promise.all(
    SECTIONS.map(async (section) => ({
      id: section.id,
      title: section.title,
      panels: await Promise.all(section.panels.map(fetchPanel)),
    }))
  );
  const totalItems = sections.reduce(
    (n, s) => n + s.panels.reduce((m, p) => m + p.items.length, 0), 0);
  return { updatedAt: new Date().toISOString(), totalItems, sections };
}

// Fetch and write the cache file. Returns the payload.
export async function refreshAndCache() {
  const payload = await buildPayload();
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

// Read the cache if present, else null.
export async function readCache() {
  try {
    return JSON.parse(await fs.readFile(CACHE_FILE, "utf8"));
  } catch {
    return null;
  }
}
