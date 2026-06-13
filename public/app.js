// app.js — render the dashboard, handle save/refresh/search. All feed text is
// inserted via textContent / element APIs (never innerHTML), so hostile markup
// in a feed cannot inject script.
"use strict";

const $ = (sel) => document.querySelector(sel);
const state = {
  payload: null,
  saved: new Map(), // url -> bookmark
  query: "",
  view: "feed",
};

// STATIC mode: the standalone shareable file inlines its data as window.__FEEDS__
// and has no server, so bookmarks live in localStorage and there's no live refresh.
const STATIC = typeof window !== "undefined" && !!window.__FEEDS__;
const CONFIG = (typeof window !== "undefined" && window.__CONFIG__) || {};
const BM_KEY = "reading-dashboard-bookmarks";

// Use browser-local bookmarks when standalone, OR when the server says so
// (CONFIG.bookmarks === "local") — e.g. on hosts with an ephemeral filesystem
// like Render free tier, where a server-side bookmarks file wouldn't survive.
const useLocalBookmarks = STATIC || CONFIG.bookmarks === "local";

const store = useLocalBookmarks
  ? {
      async list() { try { return JSON.parse(localStorage.getItem(BM_KEY)) || []; } catch { return []; } },
      async add(a) {
        const list = await this.list();
        if (!list.some((b) => b.url === a.url)) {
          list.unshift({ url: a.url, title: a.title, source: a.source || "", savedAt: new Date().toISOString() });
        }
        localStorage.setItem(BM_KEY, JSON.stringify(list));
        return list;
      },
      async remove(url) {
        const list = (await this.list()).filter((b) => b.url !== url);
        localStorage.setItem(BM_KEY, JSON.stringify(list));
        return list;
      },
    }
  : {
      async list() { return (await fetch("./api/bookmarks")).json(); },
      async add(a) {
        return (await fetch("./api/bookmarks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(a) })).json();
      },
      async remove(url) {
        return (await fetch("./api/bookmarks", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) })).json();
      },
    };

// ---- small DOM helpers ----
function safeHttpUrl(value) {
  try {
    const u = new URL(value, location.origin);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : "";
  } catch {
    return "";
  }
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "href" || k === "src") {
      // never let a non-http(s) URL (e.g. javascript:) become a live attribute
      const safe = safeHttpUrl(v);
      if (safe) node.setAttribute(k, safe);
    } else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const now = new Date();
  const mins = Math.round((now - d) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

// ---- data ----
async function loadFeeds() {
  if (STATIC) { state.payload = window.__FEEDS__; return; }
  const res = await fetch("./api/feeds");
  state.payload = await res.json();
}
async function loadSaved() {
  try {
    const list = await store.list();
    state.saved = new Map((Array.isArray(list) ? list : []).map((b) => [b.url, b]));
  } catch { /* keep whatever we have */ }
  updateSavedCount();
}

async function toggleSave(article, btn) {
  const isSaved = state.saved.has(article.url);
  try {
    const list = isSaved ? await store.remove(article.url) : await store.add(article);
    if (!Array.isArray(list)) throw new Error(list.error || "save failed");
    state.saved = new Map(list.map((b) => [b.url, b]));
  } catch (e) {
    console.error(e);
    return;
  }
  const nowSaved = state.saved.has(article.url);
  if (btn) {
    btn.classList.toggle("is-saved", nowSaved);
    btn.textContent = nowSaved ? "★" : "☆";
    btn.title = nowSaved ? "Saved — click to remove" : "Save article";
    btn.setAttribute("aria-pressed", String(nowSaved));
    btn.setAttribute("aria-label", (nowSaved ? "Remove from saved: " : "Save article: ") + (article.title || ""));
  }
  updateSavedCount();
  if (state.view === "saved") renderSaved();
}

function updateSavedCount() {
  const n = state.saved.size;
  const badge = $("#saved-count");
  badge.textContent = String(n);
  badge.hidden = n === 0;
}

// ---- rendering: feed ----
function tileMatches(item, panelLabel) {
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  return (
    item.title.toLowerCase().includes(q) ||
    (item.summary || "").toLowerCase().includes(q) ||
    (item.author || "").toLowerCase().includes(q) ||
    panelLabel.toLowerCase().includes(q)
  );
}

function makeTile(item, panel) {
  const isSaved = state.saved.has(item.url);
  const saveBtn = el("button", {
    class: "tile-save" + (isSaved ? " is-saved" : ""),
    type: "button",
    "aria-pressed": String(isSaved),
    "aria-label": (isSaved ? "Remove from saved: " : "Save article: ") + item.title,
    title: isSaved ? "Saved — click to remove" : "Save article",
    text: isSaved ? "★" : "☆",
  });
  saveBtn.addEventListener("click", () =>
    toggleSave({ url: item.url, title: item.title, source: panel.label }, saveBtn));

  const metaBits = [fmtDate(item.date), item.author].filter(Boolean).join(" · ");
  const body = el("div", { class: "tile-body" }, [
    el("p", { class: "tile-title" }, [
      el("a", { href: item.url, target: "_blank", rel: "noopener noreferrer", text: item.title }),
    ]),
    metaBits ? el("p", { class: "tile-meta", text: metaBits }) : null,
    item.summary ? el("p", { class: "tile-summary", text: item.summary }) : null,
  ]);

  const children = [body];
  if (item.image) {
    const img = el("img", {
      class: "tile-thumb", src: item.image, alt: "", loading: "lazy", referrerpolicy: "no-referrer",
    });
    img.addEventListener("error", () => img.remove());
    children.push(img);
  }
  children.push(saveBtn);
  return el("div", { class: "tile" + (item.image ? " has-thumb" : ""), "data-url": item.url }, children);
}

function makePanel(panel) {
  const head = el("div", { class: "panel-head" }, [
    el("div", {}, [
      el("h3", { text: panel.label }),
      panel.note ? el("span", { class: "panel-note", text: panel.note }) : null,
    ]),
    panel.home ? el("a", { class: "source-link", href: panel.home, target: "_blank", rel: "noopener noreferrer", text: "site ↗" }) : null,
  ]);

  const list = el("div", { class: "panel-list" });
  const items = (panel.items || []).filter((it) => tileMatches(it, panel.label));
  if (panel.error && items.length === 0) {
    list.append(el("p", { class: "panel-empty", text: `Couldn’t load — ${panel.error}` }));
  } else if (items.length === 0) {
    list.append(el("p", { class: "panel-empty", text: state.query ? "No matches in this panel." : "No articles." }));
  } else {
    for (const it of items) list.append(makeTile(it, panel));
  }
  return { node: el("section", { class: "panel" }, [head, list]), count: items.length };
}

function renderFeed() {
  const root = $("#feed-view");
  root.replaceChildren();
  if (!state.payload || !state.payload.sections) {
    root.append(el("p", { class: "empty-note", text: "No data yet — try Refresh." }));
    return;
  }
  for (const section of state.payload.sections) {
    const built = section.panels.map(makePanel);   // filter once, here
    const shown = built.reduce((n, p) => n + p.count, 0);
    const head = el("div", { class: "section-head" }, [
      el("h2", { text: section.title }),
      el("span", { class: "count", text: `${shown} article${shown === 1 ? "" : "s"}` }),
    ]);
    root.append(el("section", { class: "dash-section" }, [head, el("div", { class: "panels" }, built.map((b) => b.node))]));
  }
}

// ---- rendering: saved ----
function renderSaved() {
  const root = $("#saved-list");
  root.replaceChildren();
  const list = [...state.saved.values()];
  if (list.length === 0) {
    root.append(el("p", { class: "empty-note", text: "No saved articles yet. Hover any tile and tap ☆ to save it." }));
    return;
  }
  for (const b of list) {
    const removeBtn = el("button", { class: "saved-remove", type: "button", title: "Remove", "aria-label": "Remove from saved: " + b.title, text: "×" });
    removeBtn.addEventListener("click", () => toggleSave({ url: b.url, title: b.title }, null));
    const meta = [b.source, fmtDate(b.savedAt) ? `saved ${fmtDate(b.savedAt)}` : "", hostOf(b.url)]
      .filter(Boolean).join(" · ");
    root.append(el("div", { class: "saved-card" }, [
      removeBtn,
      el("h3", {}, [el("a", { href: b.url, target: "_blank", rel: "noopener noreferrer", text: b.title })]),
      el("p", { class: "tile-meta", text: meta }),
    ]));
  }
}

// ---- view switching + status ----
function setView(view) {
  state.view = view;
  $("#feed-view").hidden = view !== "feed";
  $("#saved-view").hidden = view !== "saved";
  $("#tab-feed").classList.toggle("is-active", view === "feed");
  $("#tab-feed").setAttribute("aria-selected", String(view === "feed"));
  $("#tab-saved").classList.toggle("is-active", view === "saved");
  $("#tab-saved").setAttribute("aria-selected", String(view === "saved"));
  $("#search").style.visibility = view === "feed" ? "visible" : "hidden";
  if (view === "saved") renderSaved();
}

function setUpdated() {
  const u = $("#updated");
  if (state.payload?.updatedAt) {
    const d = new Date(state.payload.updatedAt);
    const when = d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    const label = STATIC ? "Snapshot from" : "Last updated";
    u.textContent = `${label} ${when} · ${state.payload.totalItems || 0} articles`;
  } else u.textContent = "";
}

async function doRefresh() {
  const btn = $("#refresh");
  const status = $("#status");
  btn.disabled = true; btn.classList.add("is-busy");
  status.hidden = false; status.textContent = "Fetching the latest…";
  let ok = true;
  try {
    const res = await fetch("./api/refresh", { method: "POST" });
    const data = await res.json();
    if (!res.ok || data?.error) throw new Error(data?.error || `HTTP ${res.status}`);
    state.payload = data;
  } catch (e) {
    ok = false;
    console.error(e);
  }
  if (ok) {
    status.hidden = true;
  } else {
    // keep the failure visible for a few seconds — old data stays on screen
    status.textContent = "Couldn’t refresh just now — showing the last load.";
    setTimeout(() => { status.hidden = true; }, 5000);
  }
  setUpdated(); renderFeed();
  btn.disabled = false; btn.classList.remove("is-busy");
}

// ---- init ----
async function init() {
  $("#tab-feed").addEventListener("click", () => setView("feed"));
  $("#tab-saved").addEventListener("click", () => setView("saved"));
  if (STATIC) $("#refresh").remove();            // no server to refresh against
  else $("#refresh").addEventListener("click", doRefresh);
  let t;
  $("#search").addEventListener("input", (e) => {
    clearTimeout(t);
    t = setTimeout(() => { state.query = e.target.value.trim(); renderFeed(); }, 120);
  });

  try {
    await Promise.all([loadFeeds(), loadSaved()]);
    $("#status").hidden = true;
    setUpdated();
    renderFeed();
  } catch (e) {
    $("#status").textContent = "Couldn’t reach the server. Is it running?";
    console.error(e);
  }
}

document.addEventListener("DOMContentLoaded", init);
