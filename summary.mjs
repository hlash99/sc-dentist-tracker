#!/usr/bin/env node
/*
 * Writes a small `summary` block into data.json: where our practice stands and anything
 * that needs attention (`summary.alerts`), so the hub page or any other reader gets the
 * headline without re-deriving it from 100+ snapshots.
 *
 * Runs last in update.yml. No network and no API calls: it only reads data.json and
 * reviews.json. It never touches `snapshots`, and the output depends only on those two
 * files (no clock), so re-running it changes nothing and causes no extra commits.
 *
 * Every date window is anchored on the latest snapshot's date (`asOf`), not on "now".
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const DATA = new URL("./data.json", import.meta.url);
const LEDGER = new URL("./reviews.json", import.meta.url);

const norm = s => (s || "").toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
// Same retired-name map as fetch.mjs / index.html.
const ALIASES = new Map([
  ["loomis & mcfarlane dental care", "Edgewood Dental"],
  ["edgewood dental - dr. shifteh iranmanesh", "Edgewood Dental"],
]);
const key = name => norm(ALIASES.get(norm(name)) || name);
const dayDiff = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
const SWEEP_OVERDUE_DAYS = 10;   // sweeps are weekly; past this something is stuck (quota, API)

// Most reviews first; ties in a fixed order so equal counts don't swap ranks run to run.
const ranked = dentists => {
  const by = new Map();
  for (const d of dentists || []) {
    const k = key(d.name), seen = by.get(k);
    if (!seen || d.reviews > seen.reviews) by.set(k, { ...d, k });
  }
  return [...by.values()].sort((a, b) => b.reviews - a.reviews || (a.k < b.k ? -1 : 1));
};

export function summarize(data, ledger) {
  const snaps = (data.snapshots || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const latest = snaps[snaps.length - 1];
  if (!latest || !data.ourPractice) return null;
  const us = key(data.ourPractice), asOf = latest.date;
  const list = ranked(latest.dentists);
  const idx = list.findIndex(d => d.k === us);
  if (idx < 0) return { asOf, practice: data.ourPractice, tracked: false, alerts: [] };
  const me = list[idx], above = list[idx - 1] || null, below = list[idx + 1] || null;

  // Snapshot closest to N days before asOf (first one if history is shorter).
  const baseFor = n => snaps.slice().reverse().find(s => dayDiff(s.date, asOf) >= n) || snaps[0];
  const countIn = (snap, k) => ranked(snap.dentists).find(d => d.k === k)?.reviews ?? null;
  const rankIn = snap => { const i = ranked(snap.dentists).findIndex(d => d.k === us); return i < 0 ? null : i + 1; };
  const gain = (k, n) => { const b = countIn(baseFor(n), k); return b == null ? null : countIn(latest, k) - b; };

  // Every day our count went down (the visible trace of removals).
  const drops = [];
  let last = null;
  for (const s of snaps) {
    const c = countIn(s, us);
    if (c == null) continue;
    if (last != null && c < last) drops.push({ date: s.date, from: last, to: c });
    last = c;
  }

  const rank = idx + 1, rank7 = rankIn(baseFor(7));
  const out = {
    asOf, practice: me.name, tracked: true,
    rank, of: list.length, reviews: me.reviews, rating: me.rating ?? null,
    gain7: gain(us, 7), gain30: gain(us, 30), rankChange7: rank7 == null ? null : rank7 - rank,   // + = moved up
    next: above && { name: above.name, reviews: above.reviews, toPass: above.reviews - me.reviews + 1, gain30: gain(above.k, 30) },
    behind: below && { name: below.name, reviews: below.reviews, lead: me.reviews - below.reviews, gain30: gain(below.k, 30) },
    leader: { name: list[0].name, reviews: list[0].reviews, gap: list[0].reviews - me.reviews },
    drops,
  };

  const alerts = [];
  const add = (type, level, date, text) => alerts.push({ type, level, date, text });
  for (const d of drops) {
    if (dayDiff(d.date, asOf) <= 7) add("count_drop", "warn", d.date, `Google count fell ${d.from} → ${d.to} (${d.to - d.from})`);
  }
  if (out.rankChange7 > 0) add("rank_up", "good", asOf, `Up ${out.rankChange7} to #${rank} in the last 7 days`);
  if (out.rankChange7 < 0) add("rank_down", "warn", asOf, `Down ${-out.rankChange7} to #${rank} in the last 7 days`);

  if (ledger && ledger.reviews) {
    const entries = Object.values(ledger.reviews);
    const events = ledger.events || [];
    const within = (e, n) => e.date <= asOf && dayDiff(e.date, asOf) <= n;
    const n30 = t => events.filter(e => e.type === t && within(e, 30)).length;
    const missing = entries.filter(r => r.missingSince);
    const ratingNow = r => (r.edits?.length ? r.edits[r.edits.length - 1].rating : r.rating);
    out.ledger = {
      listed: entries.length - missing.length,
      missing: missing.length,
      lastFullSweep: ledger.lastFullSweep || null,
      lastCheck: ledger.lastIncremental || null,
      removed30: n30("removed"), restored30: n30("restored"), edited30: n30("edited"),
    };
    if (missing.length) {
      const since = missing.map(r => r.missingSince).sort()[0];
      add("reviews_missing", "warn", since, `${missing.length} review${missing.length === 1 ? "" : "s"} no longer listed on Google (since ${since})`);
    }
    for (const e of events) {
      if (e.type === "restored" && within(e, 7)) add("review_restored", "good", e.date, `A removed review is back (${e.rating ?? "?"}★)`);
      if (e.type === "edited" && within(e, 14) && e.rating != null && e.prevRating != null && e.rating !== e.prevRating)
        add("rating_changed", e.rating < e.prevRating ? "warn" : "good", e.date, `A review changed ${e.prevRating}★ → ${e.rating}★`);
    }
    const low = entries.filter(r => !r.missingSince && ratingNow(r) != null && ratingNow(r) <= 3
      && r.firstSeen <= asOf && dayDiff(r.firstSeen, asOf) <= 14 && r.date && dayDiff(r.date, asOf) <= 30);
    for (const r of low) add("low_star_review", "warn", r.firstSeen, `New ${ratingNow(r)}★ review`);
    if (ledger.lastFullSweep && dayDiff(ledger.lastFullSweep, asOf) > SWEEP_OVERDUE_DAYS)
      add("sweep_overdue", "info", ledger.lastFullSweep, `No full review sweep since ${ledger.lastFullSweep} — removals can't be confirmed until one runs`);
  }
  out.alerts = alerts;
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const raw = readFileSync(DATA, "utf8");
  const data = JSON.parse(raw);
  let ledger = null;
  try { if (existsSync(LEDGER)) ledger = JSON.parse(readFileSync(LEDGER, "utf8")); }
  catch (e) { console.warn(`summary: reviews.json unreadable (${e.message}) — summarizing counts only`); }
  const summary = summarize(data, ledger);
  if (!summary) { console.log("summary: nothing to summarize — skipping."); process.exit(0); }
  const { summary: _old, ...rest } = data;
  const next = JSON.stringify({ ...rest, summary }, null, 2) + "\n";   // summary stays the last key
  if (next === raw) console.log("summary: unchanged.");
  else {
    writeFileSync(DATA, next);
    console.log(`summary: ${summary.asOf} #${summary.rank ?? "?"} of ${summary.of ?? "?"}, ${summary.alerts.length} alert(s)`
      + summary.alerts.map(a => `\n  [${a.level}] ${a.type}: ${a.text}`).join(""));
  }
}
