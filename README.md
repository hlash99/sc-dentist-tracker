# San Carlos GP Dentist Review Tracker

A tiny static site that ranks general-practice dentists in San Carlos, CA by their
Google review count (most → least), highlights **Edgewood Dental**,
and throws a bigger celebration the closer we get to #1.

## Files
- `index.html` — the whole site (no build step, no dependencies).
- `data.json` — the dataset. Each dated entry under `snapshots` is one day's pull.
- `record.mjs` — merges a fresh pull into `data.json` as a new dated snapshot.
- `fetch.mjs` — server-side daily refresh (GitHub Actions): auto-discovers GP
  dentists in town and updates every tracked practice's review count.
- `reviews.mjs` / `reviews.json` — per-review ledger for our own practice (author,
  stars, review date, first 160 chars, first/last seen). A full sweep (~11 SerpApi
  searches) runs weekly, or right away when our count drops, and flags any review
  that vanished under `missing` and in `events` (type `removed`, or `restored` if it
  comes back). Other days it does a 1-search check for new reviews. It checks
  SerpApi's free account endpoint first and skips the sweep if quota is low.
  A drop triggers one sweep, not one per run that day. Each completed sweep adds a line
  to `sweeps` (reviews fetched vs Google's count), and a known review whose stars change
  or that Google re-dates is logged as an `edited` event (original fields are kept; the
  change is appended to that review's `edits`). Note Google dates an edited review by
  its last edit, so `date` is not always the original posting date.
- `summary.mjs` — no network. Writes `data.json → summary`: our rank, count, 7/30-day
  gain, next rival, every count drop, ledger totals, and `summary.alerts` (count drop,
  reviews missing/restored, star rating changed, new ≤3★ review, rank change, sweep
  overdue). Meant for the hub page or any other reader; `snapshots` is never touched.

## Server-side daily refresh (no computer needed)
`.github/workflows/update.yml` runs `fetch.mjs` twice daily (~7:37am and ~7:37pm PT),
so reviews posted during the day land the same evening. It needs **one** of these
repo secrets (Actions → Secrets); with neither, the run is a clean no-op:

| Secret | Backend | Cost |
|---|---|---|
| `SERPAPI_KEY` | [SerpApi](https://serpapi.com) `google_maps` engine | Free plan (no credit card) — ~2–3 searches/day (each run logs `searches used`); practices missed by discovery are only re-queried every 3 days to keep usage flat |
| `GOOGLE_PLACES_API_KEY` | Google Places API (Text Search New) | Free tier, but requires a Google Cloud project with billing attached |

`fetch.mjs` prefers Google Places when both are set. Either backend feeds the same
logic: one area-wide discovery search (which also picks up newly opened practices),
plus individual lookups for any tracked practice the discovery missed. Specialty-only,
out-of-town, and permanently closed offices are filtered out automatically.

## View locally
```bash
cd sc-dentist-tracker
python3 -m http.server 8731
# open http://localhost:8731
```

## Publish free on GitHub Pages
1. Create a new repo on github.com (e.g. `sc-dentist-tracker`).
2. From this folder:
   ```bash
   git add -A && git commit -m "Initial dentist tracker"
   git branch -M main
   git remote add origin https://github.com/<you>/sc-dentist-tracker.git
   git push -u origin main
   ```
3. Repo **Settings → Pages → Source: Deploy from a branch → main / root**.
4. Site goes live at `https://<you>.github.io/sc-dentist-tracker/`.

> Publishing the site publicly is your call to make — these steps are for you to run.

## Daily refresh (this Mac)
A scheduled Claude Code task re-runs the same Google Maps pull each day, then:
```bash
cat today.json | node record.mjs   # appends/overwrites today's snapshot
```
Re-running on the same day overwrites that day's entry, so it's safe to run repeatedly.
Once the repo is on GitHub, the task can also `git commit && git push` to update the live site.

## When a practice renames its Google listing
A rename would otherwise split one practice into two rows: discovery returns the new
name as a brand-new entry while the old name stays in the roster and keeps resolving to
the same office. Both `fetch.mjs` and `index.html` keep an `ALIASES` map of retired
names → current name; add the old **normalized** name (lowercased, whitespace collapsed)
to both maps and the history stays one continuous line. We renamed from
*Loomis & McFarlane Dental Care* to **Edgewood Dental** in August 2026 — those entries
are the worked example.

## What the page derives
- **Pass dates** use each practice's 14-day pace. The "realistic range" replays that same
  pace over the stored history (weekly checkpoints, 28 days ahead, every practice above
  us) and applies its average miss. A 28-day pace and a Poisson error bar were tried and
  did not do better on our own gap, so the method was left alone.
- **Review ledger panel** reads `reviews.json`: missing reviews, the removed / restored /
  edited log, and every day our Google count fell (from the snapshots, so it also covers
  the time before the ledger began on 2026-11-07).

## Data notes
- Source: Google Maps search "dentist San Carlos CA", filtered to the **Dentist**
  (general practice) category. Specialty-only offices (orthodontics, endodontics,
  periodontics, pediatric) are excluded.
- Review counts change over time; the trend chart fills in as snapshots accumulate.
