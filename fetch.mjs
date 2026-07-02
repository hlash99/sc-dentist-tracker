#!/usr/bin/env node
/*
 * Server-side refresh of the tracked San Carlos dentists' Google review counts,
 * recorded as today's snapshot in data.json. Runs on GitHub Actions (update.yml).
 *
 * Uses the Google Places API (Text Search New). Requires a free API key in the
 * GOOGLE_PLACES_API_KEY env var / repo secret. If the key is missing it exits 0
 * without changing anything, so the workflow degrades gracefully (keep recording
 * manually via record.mjs until a key is added).
 *
 * Re-queries each currently-tracked practice by name (keeps the existing roster);
 * a practice that can't be resolved keeps its last-known numbers for the day.
 */
import { readFileSync, writeFileSync } from "node:fs";

const DATA = new URL("./data.json", import.meta.url);
const KEY = process.env.GOOGLE_PLACES_API_KEY;
const AREA = process.env.DENTIST_AREA || "San Carlos CA";

if (!KEY) {
  console.log("GOOGLE_PLACES_API_KEY not set — skipping server-side refresh (no change). "
    + "Add the secret to enable it, or keep using record.mjs manually.");
  process.exit(0);
}

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

async function lookup(name) {
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": KEY,
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

// Practices we don't track: specialty-only offices (the site tracks general-practice dentists).
const SPECIALTY = /orthodont|endodont|periodont|pediatric|pedodont|prosthodont|\bkids?\b|children|\bbraces\b|oral (and maxillofacial )?surg|maxillofacial/i;
const norm = s => s.toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();

// Discover general-practice dentists in the area so the roster maintains itself — new offices
// that open (or that we hadn't tracked) get picked up automatically instead of by hand.
async function discover() {
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": KEY,
      "X-Goog-FieldMask": "places.displayName,places.userRatingCount,places.rating,places.formattedAddress,places.businessStatus,places.types",
    },
    body: JSON.stringify({ textQuery: `dentist in ${AREA}`, maxResultCount: 20 }),
  });
  if (!r.ok) throw new Error(`Places discovery ${r.status}`);
  const j = await r.json();
  const found = [];
  for (const p of j.places || []) {
    const name = p.displayName?.text?.trim();
    if (!name || typeof p.userRatingCount !== "number") continue;
    if (p.businessStatus && p.businessStatus !== "OPERATIONAL") continue;   // skip closed
    if (SPECIALTY.test(name)) continue;                                     // GP only
    if (p.formattedAddress && !/san carlos/i.test(p.formattedAddress)) continue; // in-town only
    found.push({ name, reviews: p.userRatingCount, rating: typeof p.rating === "number" ? p.rating : null });
  }
  return found;
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
    for (const d of await discover()) {
      const k = norm(d.name);
      if (!canonical.has(k)) discovered++;
      const name = canonical.get(k) || d.name;
      byKey.set(k, { name, reviews: d.reviews, rating: d.rating ?? prevRating(prev, name) });
      okCount++;
    }
  } catch (e) {
    console.warn(`  ! discovery skipped: ${e.message}`);
  }

  // 2) refresh any tracked practice that discovery didn't return (dropped out of the top results)
  for (const name of roster) {
    if (byKey.has(norm(name))) continue;
    try {
      const hit = await lookup(name);
      if (hit) { byKey.set(norm(name), { name, reviews: hit.reviews, rating: hit.rating ?? prevRating(prev, name) }); okCount++; }
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
  console.log(`Recorded ${date}: ${out.length} practices${newNote}. ${data.ourPractice} = #${rank} (${us ? us.reviews : "?"} reviews).`);
}
const prevRating = (prev, name) => (prev.dentists.find(d => d.name === name) || {}).rating ?? null;
const keepLast = (prev, name) => { const d = prev.dentists.find(x => x.name === name); return d ? { ...d } : { name, reviews: 0, rating: null }; };

main().catch(e => { console.error(e); process.exit(1); });
