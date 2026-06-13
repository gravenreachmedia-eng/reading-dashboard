# Reading Dashboard

A simple, light reading desk. The most recent articles from your sources appear as
tiles, grouped into three sections. Click a tile to read it at the publisher; tap the
☆ to save it for later.

## Sections & sources

| Section | Sources |
|---|---|
| **World News** | The Guardian (World), Reuters, The Guardian — The Long Read |
| **Economics Research** | VoxDev, Ideas for India, World Bank Blogs, NBER New Working Papers |
| **Ideas & Essays** | Aeon, Psyche |

## Run it

**Easiest:** double-click **`start-dashboard.bat`**. It installs what it needs on the
first run, starts the server, and opens the dashboard in your browser. Leave that
window open while you read; close it to stop.

**From a terminal:**
```
npm install      # first time only
npm start        # then open http://localhost:4321
```

## Share it (WhatsApp / email)

Run **`npm run build:static`**. It fetches a fresh snapshot and writes a single
self-contained file, **`reading-dashboard.html`** (~95 KB), with the articles, styling,
and code all inlined — no server, no install.

Send that one file over WhatsApp (as a document) or email (as an attachment). The
recipient just double-clicks it; it opens in any browser on phone or desktop, online or
offline. Saved articles are kept in that browser (localStorage). It's a **snapshot**, so
re-run `npm run build:static` and resend whenever you want to refresh it. (For a live,
always-current link instead of a file, the server can be hosted — ask if you want that.)

## How it stays fresh

- Feeds load when the server starts and **auto-refresh every morning at 06:00**.
- The **Refresh** button (top right) fetches the latest at any time.
- **Saved** articles are stored on disk (`data/bookmarks.json`), so they survive
  browser clears and are there every time you open the dashboard.

### Optional: have it ready every morning automatically

To start the dashboard automatically when you log in, put a shortcut to
`start-dashboard.bat` in your Startup folder (press <kbd>Win</kbd>+<kbd>R</kbd>, type
`shell:startup`, press Enter, and drop a shortcut there).

## Notes

- **Reuters, Ideas for India, and World Bank Blogs** no longer publish a public RSS
  feed, so those panels are gathered via **Google News** filtered to each site. Links
  open through Google News and redirect to the article. The other six sources use
  their own native feeds with direct links.
- If a source is temporarily unreachable, its panel shows a short message and the rest
  of the dashboard still loads.

## Project layout

```
server.js            Express server + daily-refresh schedule + bookmarks API
lib/feeds.js         feed list, fetch + tolerant RSS/Google-News parser
lib/bookmarks.js     saved-articles store (data/bookmarks.json)
public/              index.html, styles.css, app.js  (the dashboard UI)
data/                feeds.json cache + bookmarks.json   (created on first run)
```

## Change the sources

Edit the `SECTIONS` array in `lib/feeds.js` — add a panel with an `rss` feed URL, or
use the `gnews('somesite.com')` helper for a site that has no public feed. Restart.
