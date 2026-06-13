# Reading Dashboard — Roadmap (v1 → fleshed-out service)

*Produced from a multi-agent analysis of the actual v1 code (architecture, product/customization,
theming, and platform/ops), synthesized into a phased plan. Phase 0 is what's already shipped.*

## Vision

The same fast, framework-free, XSS-safe dashboard it is today — but the 9 hardcoded sources become
a **user-editable library** (pick, reorder, rename sections, add your own RSS/Atom feeds, OPML
in/out), the light-only UI becomes a properly tokenized **light + dark** surface with accent/density
presets, and the rolling 12-item snapshot becomes a **durable article store** powering read/unread,
search over history, and weekly long-read digests. It runs as a single always-on Node/Express
process backed by SQLite (still one file), guarded by a minimal identity boundary, installable as a
PWA. Architected so going multi-user later is *additive*, not a rewrite. **No big-bang rewrite at any
point** — every phase ships on top of the verified v1.

## Guiding principles

1. **No rewrite.** Evolve the existing thin layers (`server.js` routes / `lib/feeds.js` / `lib/bookmarks.js` / `public/*`).
2. **Preserve the security posture that's already correct** — `textContent`-only rendering, the http(s) URL gate (server + client), the 64 KB body cap. Never regress these when adding user feeds.
3. **Lean on the config-agnostic frontend.** `renderFeed`/`makePanel` already render whatever payload arrives, so most customization is *server-side config producing the same shape* — the render path barely changes.
4. **Keep module API signatures stable** when swapping internals (`bookmarks.list/add/remove`, `buildPayload`) so each swap touches one file.
5. **Land the explicit, low-risk asks early** — dark mode + the first customization slice — before heavier persistence/identity work.
6. **Gate every increase in attack surface.** User URLs require SSRF protection + feed validation *before* save. Public exposure requires auth + rate limiting *before* it happens.
7. **Design the data model with a nullable `user_id` from the first SQLite migration** so multi-user is additive.

## Phases at a glance

| Phase | Theme | Effort | Delivers |
|---|---|---|---|
| **0 (done)** | v1 | — | 9-source tiled reader, bookmarks, search, static share-file, Render config |
| **1** | Theming (light+dark, tokens) + test safety net | M | Light/dark/system toggle, no flash; parser & URL-gate regression tests |
| **2** | Config layer: externalize SECTIONS + first customization | L | Reorder/rename/hide sections, toggle sources, per-source counts, accent + density |
| **3** | Add-your-own-feed safely (discovery + validation + SSRF) | L | Paste a URL → validated preview → add; OPML in/out |
| **4** | Durable store (SQLite) + read/unread + tags | L | Concurrency-safe data, "unread only", tagged/searchable saves, polite fetching |
| **5** | Productize: identity, hosting, PWA, digests | L | Reachable always-on service, installable/offline, weekly digest, history search |

---

## Phase 1 — Theming foundation + safety net

**Goal:** ship the most-requested low-risk win (dark mode) on a proper token system, and put a
regression harness around the riskiest existing code *before* any refactor.

- Refactor `styles.css :root` into **two tiers**: a primitive palette (raw values) + a **semantic
  role layer** (`--bg`, `--surface`, `--surface-hover`, `--scrim`, `--text`, `--text-muted`,
  `--text-faint`, `--text-on-accent`, `--border`, `--border-strong`, `--accent`, `--accent-strong`,
  `--on-accent`, `--save`, `--save-bg`, `--danger`, `--shadow`).
- Sweep the **~12 escaped raw literals** into tokens (the `#fff` chips, `#d8d2c7` hover borders,
  `#fcfbf8` tile hover, `#fdf6e9` saved chip, `#b3261e` danger, the `rgba(255,255,255,.92)` thumb
  chip, the colour-baked shadows) so nothing stays light in dark mode.
- Author `[data-theme="dark"]` redefining **only** semantic tokens; **independently AA-verify** every
  pair (light ratios don't transfer — the teal accent `#1f6f6a` and faint-text tiers are the usual
  failures). Re-tune accent for dark.
- Theme-aware `--scrim` for the translucent header + thumb chip; verify header text AA over
  worst-case scrolled content (the documented translucent-header trap).
- Theme infra: inline head script resolving **stored choice → `prefers-color-scheme` → light**,
  setting `html[data-theme]` *before first paint* (no flash; also fixes the static share-file since
  it inlines `index.html` verbatim). Header toggle with `aria-pressed`, persisted; `matchMedia`
  listener that only auto-switches when no explicit choice.
- Add a **`node:test`** suite (built-in, no new framework): saved-XML fixtures for the 9 feeds + malformed/RDF/Atom-edge samples asserting `parseFeed`; unit tests for `decodeEntities`/`stripTags`/`extractLink`/`safeHttpUrl`. Add `/healthz` + per-source latency logging.

**Exit:** toggle works in both modes with zero flash; every text/surface/accent pair passes AA in
both themes (checked, not assumed); test suite green; `/healthz` 200.
**Risks:** assumed-not-measured dark contrast; backdrop-filter header contrast; a missed literal.
**Depends on:** nothing — builds on v1.

## Phase 2 — Config layer + first customization slice

**Goal:** make the hardcoded layout data-driven and give real control over the existing sources, with
**zero changes to the feed render path**.

- Lift the `SECTIONS` literal into `config/default-sections.json` (the 9 become a built-in catalog
  referenced by id). `buildPayload()` takes a resolved `sections` arg instead of closing over the
  const (it reads `SECTIONS` in exactly one place) — behaviour unchanged when seeded.
- Define + enforce a **config schema/validator** (section `{id,title,panels[]}`; panel
  `{id,label,url,kind,home,…,itemCount?}`); reject non-http(s) on write, reusing the existing gate.
- Config CRUD: `GET`/`PUT /api/config` with validation (single global `config.json` this phase).
- **Settings UI** as a third tab (Feed / Saved / **Settings**), built on the existing `el()`/store
  seam (no framework): toggle sources, rename/create/delete/reorder sections, reorder sources
  (up/down buttons first to de-risk; drag later), per-source counts, pick theme/accent/density.
- **Accent presets** (`html[data-accent]`, each shipping pre-verified light + dark values) and a
  **compact/comfortable density** toggle, in one `reading-dashboard-prefs` namespace.
- Make `build-static.mjs` snapshot the *resolved current config* so the share-file matches what you see.

**Exit:** `buildPayload` runs purely from `config.json` with the seeded 9 producing a byte-identical
payload to v1; settings persist and re-render; presets verified AA; static build reflects config.
**Effort:** L. **Depends on:** Phase 1.

## Phase 3 — Add-your-own-feed, safely

**Goal:** let users add arbitrary feeds by URL **without** expanding the attack surface or the
parser's silent-failure surface — the first true "service" capability.

- `POST /api/feeds/validate`: fetch a candidate URL; if a feed, parse it; if an HTML page,
  **autodiscover** `<link rel=alternate type=application/rss+xml|atom+xml>`. Return a parsed sample
  or a friendly "not a usable feed"; require ≥1 parseable item before save; derive label from `<title>`.
- **SSRF + fetch hardening** in `fetchPanel` (the single chokepoint): reject private/loopback/
  link-local IPs and non-http(s) schemes before fetching; cap response size; keep the 20s timeout.
- **Harden the parser** for arbitrary input: feed-type detection (RSS2/Atom/RDF/JSON Feed). Keep the
  tuned regex as the fast path for the verified 9; route user feeds through a hardened XML parser
  (e.g. `fast-xml-parser`) behind the same `normalize()` shape.
- Generalize the id-keyed special-cases (NBER author-lift, gnews trimming) into **per-panel transform
  flags** so they don't depend on fixed ids.
- **OPML import/export** (each imported entry runs through the validate path).
- Surface a visible "via Google News — may be unreliable" state on the 3 gnews sources; let users replace them.

**Exit:** adding a known-good feed by homepage URL works end-to-end; a private/loopback/non-feed URL
is rejected and never fetched; OPML round-trips losslessly; the 9 defaults still pass Phase 1 fixtures.
**Effort:** L. **Depends on:** Phase 2 (storage) + Phase 1 (parser tests).

## Phase 4 — Durable store (SQLite) + read/unread + tags

**Goal:** replace lossy flat-JSON and the 12-item window with a real article store — fixing
concurrency and unlocking reader-grade features that all fight the snapshot today.

- **SQLite** (`better-sqlite3`, single file, WAL) for bookmarks, config, read-state, and accumulated
  feed items (with per-source ETag/Last-Modified/last-fetched/last-error). Keep `lib/bookmarks.js`
  signatures and `buildPayload` unchanged — swap the body, not the boundary. Fixes the lost-update
  race in the current full-array rewrite.
- Schema with a **nullable `user_id`** on every per-user table from day one (Phase 5 multi-user
  becomes additive). One-time migration importing `data/bookmarks.json`.
- **Article store accumulates** across refreshes (keyed by the stable `guid|url` id); `/api/feeds`
  still returns the recent slice with the store behind it.
- **Read/unread:** track seen ids; mark read on open; render unread with a dot/bolder title; "unread
  only" toggle. (Server-persisted now.)
- **Polite fetching** using stored ETag/Last-Modified: conditional GET, treat 304 as "reuse cached",
  per-source TTL, stagger/jitter instead of one parallel burst, exponential backoff + circuit-breaker
  per source.
- **Tags + notes** on bookmarks (backward-compatible); tag chips + filter + a search box in Saved
  (currently unsearchable); `PATCH` to update.

**Exit:** all reads/writes through SQLite (WAL); concurrent writes never lose data; `bookmarks.json`
imported intact; unread persists; a 304 reuses cached items; saved-item tag search works.
**Effort:** L. **Depends on:** Phases 2–3. **Risks:** native build on Windows/A:; migration correctness.

## Phase 5 — Productize: identity, hosting, PWA, digests

**Goal:** make it safely reachable beyond localhost as a small always-on product, installable for
mobile morning reading, with the weekly long-read digest the data now supports.

- **Identity boundary** — smallest viable first: a single shared-secret cookie/passphrase protecting
  all `/api` routes (especially the unauthenticated, expensive `POST /api/refresh`). Scope data by
  the nullable `user_id` (defaults to one owner). Defer sign-up/OAuth until there's demand.
- **Public hardening:** `express-rate-limit` (esp. on refresh), `helmet` + a CSP compatible with the
  inline-free render path, graceful read-only-FS behaviour, structured logging.
- **Hosting:** an always-on host with a persistent volume (Fly.io + volume, or Railway, ~$0–5/mo).
  *Not serverless* — the in-process cron + writable SQLite need a long-lived process and disk.
- **PWA:** manifest (icons, theme/background tied to light+dark) + a service worker caching the shell
  and last `/api/feeds` payload for instant/offline open. Real PWA icons replacing the inline favicon.
- **Weekly digest view:** wire up the reserved `weekly` flag — last-7-day long-reads/essays, deduped.
- **Search-over-history:** source/section scoping + date range, querying the store beyond the snapshot.
- *(Optional, last):* **email digest** via an SMTP/provider key with per-user opt-in — the only item
  pulling in deliverability/secret-management concerns.

**Exit:** public URL requires the secret on all `/api` routes; refresh is rate-limited; cron fires
daily and SQLite persists across restarts; installs as a PWA and opens offline; digest lists last-7-day
long reads. **Effort:** L. **Depends on:** Phase 4 (+ 1–3).

---

## The customization ladder

Each tier reuses the one below and never forces a render-path change:

1. **Appearance** (P1): theme light/dark/system.
2. **Layout over the existing 9** (P2): toggle/reorder/rename sections, per-source counts, accent + density. *Keystone — lifting SECTIONS into config makes every later customization a config edit.*
3. **Content** (P3): add your own feeds, replace fragile gnews sources, OPML in/out.
4. **Reading behaviour** (P4): read/unread, "unread only", tags/notes/search on saves.
5. **Cadence & reach** (P5): weekly digest, history search, optional email, per-user scoping.

All preferences share one `reading-dashboard-prefs` namespace from P2 so they migrate cleanly into
per-user config in P4.

## Why this order

Phase 1 ships the explicit dark-mode ask *and* puts tests around the parser/URL gates **before** any
refactor — making everything after it safe. Phase 2 (config) is the keystone that unblocks all
customization and costs nothing on the client (UI is already payload-driven). Phase 3 (user feeds) is
deliberately gated behind config + tests + its own SSRF/validation hardening, because the moment users
supply URLs the app gains an SSRF/DoS surface and the parser meets input it was never verified
against. Phase 4 (SQLite) comes when flat-JSON's race and the 12-item window actually start hurting —
one infra upgrade unlocks read/unread, history search, and digests at once. Phase 5 (public) is last
because exposure must not precede an auth boundary and a store worth scoping; email is sequenced dead
last.

## Decisions you need to make (open questions)

1. **Single-user vs multi-user?** Analyses converge on single-user (or a few invited users behind a shared secret), with a nullable `user_id` designed in now. Confirm before Phase 4 freezes the schema — full sign-up/OAuth is XL and likely premature.
2. **SQLite vs staying flat-JSON?** SQLite recommended at Phase 4 for concurrency + the article store. Confirm the `better-sqlite3` native build is OK on the Windows/A: toolchain — or accept staying single-writer (which blocks read/unread + history + digests).
3. **Hosting target & the ~$0–5/mo?** Always-on (Fly.io + volume, or Railway) is required; serverless free tiers can't run the cron. Or it stays localhost-only and Phase 5 shrinks. *(Note: v1 is going to Render free for the immediate share link — that's a separate, lighter step than this Phase-5 productization.)*
4. **Stay vanilla-JS/no-build, or adopt a small framework?** Recommended: stay vanilla. Re-check at the Phase 2 settings UI with drag-reorder.
5. **Static share-file's future?** Keep `build-static.mjs` as "share my current view" (recommended) or retire it once per-user config lands. Affects Phase 2 scope.
6. **Parser strategy for user feeds?** Dual-path (keep the tuned regex for the 9, hardened library for arbitrary feeds) recommended over migrating everything.
7. **Identity mechanism?** Shared-secret cookie first (recommended) vs a hosted auth provider. Decide before Phase 5.
8. **Email digest in scope at all?** The only feature with deliverability/spam/secret concerns; sequenced last/optional. An in-app digest view may suffice.
