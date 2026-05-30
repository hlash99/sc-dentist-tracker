# San Carlos GP Dentist Review Tracker

A tiny static site that ranks general-practice dentists in San Carlos, CA by their
Google review count (most → least), highlights **Loomis & McFarlane Dental Care**,
and throws a bigger celebration the closer we get to #1.

## Files
- `index.html` — the whole site (no build step, no dependencies).
- `data.json` — the dataset. Each dated entry under `snapshots` is one day's pull.
- `record.mjs` — merges a fresh pull into `data.json` as a new dated snapshot.

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

## Data notes
- Source: Google Maps search "dentist San Carlos CA", filtered to the **Dentist**
  (general practice) category. Specialty-only offices (orthodontics, endodontics,
  periodontics, pediatric) are excluded.
- Review counts change over time; the trend chart fills in as snapshots accumulate.
