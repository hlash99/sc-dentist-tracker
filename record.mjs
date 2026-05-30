#!/usr/bin/env node
/*
 * Records a fresh Google Maps pull into data.json as a dated snapshot.
 * Usage:  cat today.json | node record.mjs
 * stdin must be a JSON array: [{ "name": "...", "reviews": 123, "rating": 4.9 }, ...]
 * - Uses today's date (local). Re-running on the same day overwrites that day's snapshot.
 * - Keeps history ordered by date.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const DATA = new URL('./data.json', import.meta.url);

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const raw = readFileSync(0, 'utf8').trim();
if (!raw) { console.error('No input on stdin.'); process.exit(1); }

let dentists = JSON.parse(raw);
if (!Array.isArray(dentists) || !dentists.length) { console.error('Input must be a non-empty JSON array.'); process.exit(1); }

dentists = dentists
  .filter(d => d && d.name && Number.isFinite(d.reviews))
  .map(d => ({ name: String(d.name).trim(), reviews: Number(d.reviews), rating: Number(d.rating) }))
  .sort((a, b) => b.reviews - a.reviews);

const data = JSON.parse(readFileSync(DATA, 'utf8'));
const date = todayISO();
data.snapshots = (data.snapshots || []).filter(s => s.date !== date);
data.snapshots.push({ date, dentists });
data.snapshots.sort((a, b) => (a.date < b.date ? -1 : 1));

writeFileSync(DATA, JSON.stringify(data, null, 2) + '\n');

const us = dentists.find(d => d.name === data.ourPractice);
const rank = us ? dentists.findIndex(d => d.name === data.ourPractice) + 1 : '?';
console.log(`Recorded ${date}: ${dentists.length} practices. ${data.ourPractice} = #${rank} (${us ? us.reviews : '?'} reviews).`);
