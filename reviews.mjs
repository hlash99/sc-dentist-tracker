#!/usr/bin/env node
/*
 * Per-review ledger for our own practice (data.ourPractice), so a drop in the review count
 * can be traced to the exact reviews Google removed or filtered. Writes reviews.json.
 *
 * Runs after fetch.mjs in update.yml. SerpApi only (google_maps_reviews engine); exits 0
 * without changes when SERPAPI_KEY is missing, and never fails the workflow on API errors.
 *
 * Quota-aware. A full sweep costs about 1 + ceil((count - 8) / 20) searches (~11 at 200
 * reviews), so it runs only when:
 *   - there's no baseline yet, or
 *   - our count dropped since the previous snapshot in data.json, or
 *   - the last full sweep is FULL_SWEEP_DAYS or more old,
 * and only if SerpApi's free account endpoint reports enough searches left.
 * Otherwise it does a cheap incremental check (newest-first, normally 1 search) at most
 * once a day, to log new reviews with their author, rating, date and opening text.
 *
 * Only a completed full sweep can mark a review missing; a missing review that shows up
 * again in a later sweep is marked restored. Both are logged in `events`.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const DATA = new URL("./data.json", import.meta.url);
const LEDGER = new URL("./reviews.json", import.meta.url);
const KEY = process.env.SERPAPI_KEY;
const AREA = process.env.DENTIST_AREA || "San Carlos CA";
const AREA_LL = process.env.DENTIST_LL || "@37.5072,-122.2605,13z";
const FULL_SWEEP_DAYS = 7;
const QUOTA_BUFFER = 15;          // leave this many searches untouched for fetch.mjs
const SNIPPET_CHARS = 160;
const SERP = process.env.SERPAPI_BASE || "https://serpapi.com";

if (!KEY) { console.log("reviews: SERPAPI_KEY not set — skipping (no change)."); process.exit(0); }

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const daysBetween = (a, b) => Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 864e5);
const norm = s => (s || "").toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();

let searchesUsed = 0;
async function serp(params) {
  const qs = new URLSearchParams({ ...params, api_key: KEY });
  searchesUsed++;
  const r = await fetch(`${SERP}/search.json?${qs}`);
  if (!r.ok) throw new Error(`SerpApi ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`SerpApi: ${j.error}`);
  return j;
}

// Free: does not count against the plan's searches.
async function searchesLeft() {
  try {
    const r = await fetch(`${SERP}/account.json?api_key=${encodeURIComponent(KEY)}`);
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j.total_searches_left === "number" ? j.total_searches_left
      : typeof j.plan_searches_left === "number" ? j.plan_searches_left : null;
  } catch { return null; }
}

async function resolveDataId(name) {
  const j = await serp({ engine: "google_maps", type: "search", q: `${name} dentist ${AREA}`, ll: AREA_LL });
  const p = j.place_results || (j.local_results || []).find(x => norm(x.title).includes(norm(name).split(" ")[0]));
  if (!p || !p.data_id) throw new Error(`could not resolve data_id for "${name}"`);
  return { data_id: p.data_id, title: p.title };
}

const toEntry = r => ({
  author: r.user?.name || "(unknown)",
  rating: typeof r.rating === "number" ? r.rating : null,
  date: r.iso_date ? r.iso_date.slice(0, 10) : null,
  relativeDate: r.date || null,
  snippet: (r.extracted_snippet?.original || r.snippet || "").replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS),
});

// Yields pages of reviews, newest first. Page 1 returns 8 (SerpApi disallows `num` there);
// later pages return 20.
async function* reviewPages(data_id) {
  let token = null;
  for (;;) {
    const params = { engine: "google_maps_reviews", data_id, sort_by: "newestFirst", hl: "en" };
    if (token) { params.next_page_token = token; params.num = "20"; }
    const j = await serp(params);
    yield j.reviews || [];
    token = j.serpapi_pagination?.next_page_token;
    if (!token) return;
    await new Promise(r => setTimeout(r, 300));
  }
}

function ourCounts(data, practice) {
  const snaps = data.snapshots || [];
  const pick = s => (s?.dentists || []).find(d => norm(d.name) === norm(practice))?.reviews ?? null;
  return { now: pick(snaps[snaps.length - 1]), prev: pick(snaps[snaps.length - 2]) };
}

async function main() {
  const data = JSON.parse(readFileSync(DATA, "utf8"));
  const practice = data.ourPractice;
  if (!practice) { console.log("reviews: no ourPractice in data.json — skipping."); return; }

  const ledger = existsSync(LEDGER)
    ? JSON.parse(readFileSync(LEDGER, "utf8"))
    : { practice, place: null, lastFullSweep: null, lastIncremental: null, reviews: {}, events: [] };
  const today = todayISO();

  if (!ledger.place?.data_id) ledger.place = await resolveDataId(practice);

  const { now, prev } = ourCounts(data, practice);
  const dropped = now != null && prev != null && now < prev;
  const stale = !ledger.lastFullSweep || daysBetween(ledger.lastFullSweep, today) >= FULL_SWEEP_DAYS;
  const wantFull = !Object.keys(ledger.reviews).length || dropped || stale;

  let mode = null;
  if (wantFull) {
    const cost = 1 + Math.ceil(Math.max(0, (now ?? 200) - 8) / 20) + 1;
    const left = await searchesLeft();
    if (left == null || left >= cost + QUOTA_BUFFER) mode = "full";
    else console.log(`reviews: full sweep wanted (${dropped ? "count dropped" : "scheduled"}) but only ${left} searches left (need ~${cost}+${QUOTA_BUFFER}).`);
  }
  if (!mode && ledger.lastIncremental !== today) mode = "incremental";
  if (!mode) { console.log("reviews: already checked today — skipping."); return; }

  const seen = new Set();
  let added = 0, complete = false;
  for await (const page of reviewPages(ledger.place.data_id)) {
    let allKnown = page.length > 0;
    for (const r of page) {
      if (!r.review_id) continue;
      seen.add(r.review_id);
      const prior = ledger.reviews[r.review_id];
      if (!prior) {
        ledger.reviews[r.review_id] = { ...toEntry(r), firstSeen: today, lastSeen: today };
        added++; allKnown = false;
      } else {
        prior.lastSeen = today;
        if (prior.missingSince) {
          ledger.events.push({ date: today, type: "restored", id: r.review_id, author: prior.author, rating: prior.rating, missingSince: prior.missingSince });
          delete prior.missingSince;
        }
      }
    }
    if (mode === "incremental" && allKnown) break;   // caught up with what we already have
    complete = mode === "full";                       // stays true only if the loop ends naturally
  }

  let removed = 0;
  if (mode === "full" && complete) {
    // Guard against a truncated sweep marking everything missing.
    const expected = now ?? seen.size;
    if (seen.size >= Math.min(expected, Object.keys(ledger.reviews).length) * 0.8) {
      for (const [id, r] of Object.entries(ledger.reviews)) {
        if (!seen.has(id) && !r.missingSince) {
          r.missingSince = today;
          ledger.events.push({ date: today, type: "removed", id, author: r.author, rating: r.rating, reviewDate: r.date, lastSeen: r.lastSeen });
          removed++;
        }
      }
      ledger.lastFullSweep = today;
    } else {
      console.warn(`reviews: sweep returned only ${seen.size} reviews (expected ~${expected}) — not marking any missing.`);
    }
  }
  ledger.lastIncremental = today;   // a full sweep also covers today's incremental check

  ledger.practice = practice;
  ledger.missing = Object.entries(ledger.reviews)
    .filter(([, r]) => r.missingSince)
    .map(([id, r]) => ({ id, author: r.author, rating: r.rating, date: r.date, missingSince: r.missingSince }));
  writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + "\n");

  console.log(`reviews: ${mode} via serpapi — ${seen.size} fetched, +${added} new, ${removed} newly missing, `
    + `${ledger.missing.length} missing total, ${Object.keys(ledger.reviews).length} in ledger. searches used: ${searchesUsed}`);
}

main().catch(e => { console.warn(`reviews: skipped — ${e.message}`); process.exit(0); });
