#!/usr/bin/env node
/*
 * Server-side refresh of the tracked San Carlos dentists' Google review counts,
 * recorded as today's snapshot in data.json. Runs on GitHub Actions (update.yml).
 *
 * Two interchangeable backends, picked by whichever repo secret is present:
 *   - GOOGLE_PLACES_API_KEY : Google Places API, Text Search New (preferred if set;
 *                             needs a Google Cloud project with billing attached)
 *   - SERPAPI_KEY           : SerpApi google_maps engine (free plan, no card;
 *                             ~1 search/day here, well inside the free quota)
 * If neither is set the script exits 0 without changes, so the workflow degrades
 * gracefully (keep recording manually via record.mjs until a key is added).
 *
 * Auto-discovers general-practice dentists in the area and re-queries any tracked
 * practice discovery misses; one that can't be resolved keeps its last-known numbers.
 */
import { readFileSync, writeFileSync } from "node:fs";

const DATA = new URL("./data.json", import.meta.url);
const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY;
const SERP_KEY = process.env.SERPAPI_KEY;
const AREA = process.env.DENTIST_AREA || "San Carlos CA";
const AREA_LL = process.env.DENTIST_LL || "@37.5072,-122.2605,13z";   // centers SerpApi maps queries on San Carlos

if (!PLACES_KEY && !SERP_KEY) {
  console.log("Neither GOOGLE_PLACES_API_KEY nor SERPAPI_KEY is set — skipping server-side "
    + "refresh (no change). Add one of the secrets to enable it, or keep using record.mjs manually.");
  process.exit(0);
}
const BACKEND = PLACES_KEY ? "places" : "serpapi";

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/* ── Google Places backend ─────────────────────────────────────────── */

async function placesLookup(name) {
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": PLACES_KEY,
      "X-Goog-FieldMask": "places.displayName,places.userRatingCount,places.rating",
    },
    body: JSON.stringify({ textQuery: `${name} dentist ${AREA}`, maxResultCount: 1 }),
  });
  if (!r.ok) throw new Error(`Places API ${r.status} for "${name}"`);
  const j = await r.json();
  const p = (j.places || [])[0];
  if (!p || typeof p.userRatingCount !== "number") return null;
  return { reviews: p.userRatingCount, rating: typeof p.rating === "number" ? p.rating : null };
}

/* ── SerpApi backend (free plan) ───────────────────────────────────── */

let searchesUsed = 0;   // logged at the end so free-tier quota burn is visible in Actions logs

async function serpSearch(q) {
  const url = "https://serpapi.com/search.json?engine=google_maps&type=search"
    + `&q=${encodeURIComponent(q)}&ll=${encodeURIComponent(AREA_LL)}&api_key=${SERP_KEY}`;
  searchesUsed++;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`SerpApi ${r.status} for "${q}"`);
  const j = await r.json();
  if (j.error) throw new Error(`SerpApi: ${j.error}`);
  // Specific queries return a single place_results object; broad ones local_results[].
  return j.place_results ? [j.place_results] : (j.local_results || []);
}

const serpPlace = p => {
  const name = (p.title || "").trim();
  if (!name || typeof p.reviews !== "number") return null;
  return {
    name,
    reviews: p.reviews,
    rating: typeof p.rating === "number" ? p.rating : null,
    address: p.address || "",
    closed: /permanently closed/i.test(p.open_state || p.description || ""),
  };
};

async function serpLookup(name) {
  const hits = (await serpSearch(`${name} dentist ${AREA}`)).map(serpPlace).filter(Boolean);
  return hits[0] ? { reviews: hits[0].reviews, rating: hits[0].rating } : null;
}

const lookup = BACKEND === "places" ? placesLookup : serpLookup;

// Practices we don't track: specialty-only offices (the site tracks general-practice dentists).
const SPECIALTY = /orthodont|endodont|periodont|pediatric|pedodont|prosthodont|\bkids?\b|children|\bbraces\b|oral (and maxillofacial )?surg|maxillofacial/i;
const norm = s => s.toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();

// Discover general-practice dentists in the area so the roster maintains itself — new offices
// that open (or that we hadn't tracked) get picked up automatically instead of by hand.
// Both backends produce candidates in one shape; the GP/in-town/open filters are shared.
const gpFilter = c => c && !c.closed && !SPECIALTY.test(c.name)
  && (!c.address || /san carlos/i.test(c.address));

async function placesDiscover() {
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": PLACES_KEY,
      "X-Goog-FieldMask": "places.displayName,places.userRatingCount,places.rating,places.formattedAddress,places.businessStatus,places.types",
    },
    body: JSON.stringify({ textQuery: `dentist in ${AREA}`, maxResultCount: 20 }),
  });
  if (!r.ok) throw new Error(`Places discovery ${r.status}`);
  const j = await r.json();
  return (j.places || []).map(p => {
    const name = p.displayName?.text?.trim();
    if (!name || typeof p.userRatingCount !== "number") return null;
    return {
      name,
      reviews: p.userRatingCount,
      rating: typeof p.rating === "number" ? p.rating : null,
      address: p.formattedAddress || "",
      closed: !!(p.businessStatus && p.businessStatus !== "OPERATIONAL"),
    };
  });
}

async function serpDiscover() {
  return (await serpSearch(`dentist in ${AREA}`)).map(serpPlace);
}

async function discover() {
  const raw = BACKEND === "places" ? await placesDiscover() : await serpDiscover();
  return raw.filter(gpFilter).map(({ name, reviews, rating }) => ({ name, reviews, rating }));
}

async function main() {
  const data = JSON.parse(readFileSync(DATA, "utf8"));
  const prev = (data.snapshots && data.snapshots[data.snapshots.length - 1]) || { dentists: [] };
  const roster = prev.dentists.map(d => d.name);
  if (!roster.length) { console.error("No tracked practices in data.json."); process.exit(1); }

  // Canonical name per normalized key, so discovery's spelling doesn't fork a practice's history.
  const canonical = new Map(roster.map(n => [norm(n), n]));
  const byKey = new Map();   // normKey -> { name, reviews, rating }
  let okCount = 0, discovered = 0;

  // 1) auto-discover current GP dentists in town (non-fatal if it fails)
  try {
    const date = todayISO();
    for (const d of await discover()) {
      const k = norm(d.name);
      if (!canonical.has(k)) discovered++;
      const name = canonical.get(k) || d.name;
      byKey.set(k, { name, reviews: d.reviews, rating: d.rating ?? prevRating(prev, name), checked: date });
      okCount++;
    }
  } catch (e) {
    console.warn(`  ! discovery skipped: ${e.message}`);
  }

  // 2) refresh any tracked practice that discovery didn't return (dropped out of the top
  //    results). To keep per-run API usage ~flat now that we run twice a day, a missed
  //    practice is only re-queried when its data is FALLBACK_AFTER_DAYS old — small
  //    offices outside the discovery top-20 still refresh every few days.
  const today = todayISO();
  for (const name of roster) {
    if (byKey.has(norm(name))) continue;
    const last = prev.dentists.find(d => d.name === name);
    if (last && last.checked && daysBetween(last.checked, today) < FALLBACK_AFTER_DAYS) {
      byKey.set(norm(name), keepLast(prev, name));
      continue;
    }
    try {
      const hit = await lookup(name);
      if (hit) { byKey.set(norm(name), { name, reviews: hit.reviews, rating: hit.rating ?? prevRating(prev, name), checked: today }); okCount++; }
      else byKey.set(norm(name), keepLast(prev, name));
    } catch (e) {
      console.warn(`  ! ${name}: ${e.message} — keeping last-known`);
      byKey.set(norm(name), keepLast(prev, name));
    }
    await new Promise(r => setTimeout(r, 200));   // be gentle on the API
  }
  if (!okCount) { console.error("All lookups failed — not writing (likely a key/quota issue)."); process.exit(1); }

  const out = [...byKey.values()].sort((a, b) => b.reviews - a.reviews);
  const date = todayISO();
  data.snapshots = (data.snapshots || []).filter(s => s.date !== date);
  data.snapshots.push({ date, dentists: out });
  data.snapshots.sort((a, b) => (a.date < b.date ? -1 : 1));
  writeFileSync(DATA, JSON.stringify(data, null, 2) + "\n");

  const us = out.find(d => d.name === data.ourPractice);
  const rank = us ? out.findIndex(d => d.name === data.ourPractice) + 1 : "?";
  const newNote = discovered ? ` (+${discovered} newly discovered)` : "";
  console.log(`Recorded ${date} via ${BACKEND}: ${out.length} practices${newNote}. ${data.ourPractice} = #${rank} (${us ? us.reviews : "?"} reviews).`);
  if (BACKEND === "serpapi") console.log(`searches used this run: ${searchesUsed}`);
}
const FALLBACK_AFTER_DAYS = 3;
const daysBetween = (a, b) => Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 864e5);
const prevRating = (prev, name) => (prev.dentists.find(d => d.name === name) || {}).rating ?? null;
const keepLast = (prev, name) => { const d = prev.dentists.find(x => x.name === name); return d ? { ...d } : { name, reviews: 0, rating: null }; };

main().catch(e => { console.error(e); process.exit(1); });
