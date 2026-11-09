// Tide Chart module for the Captain Spurling hub.
// Adapted from the standalone starship-v-tides app with no behavior changes,
// except: auth comes from the hub, and the hub mounts this program PUBLICLY
// (no sign-in) by Mark's decision, since it only republishes NOAA data.
// No database, nothing is saved. The server fetches NOAA high/low tide
// predictions and caches them in memory for about 6 hours, because browsers
// were blocked from calling NOAA directly in the previous public version.
'use strict';
const express = require('express');
const path = require('path');

// ---------------- stations ----------------
// Order matters: Miami first, Hilton Head second.
const STATIONS = [
  { id: '8723156', name: 'Venetian Marina, Miami', place: 'San Marino Island, NOAA station 8723156' },
  { id: '8669338', name: 'Hilton Head', place: 'Broad Creek, NOAA station 8669338' },
];
const TZ = 'America/New_York';
const CACHE_TTL_MS = 6 * 3600 * 1000;
const cache = {}; // stationId -> { fetchedAt, predictions }

// ---------------- time helpers (all America/New_York) ----------------
function etParts(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return parts;
}
function etDateString(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 24 * 3600 * 1000);
  const p = etParts(d);
  return `${p.year}${p.month}${p.day}`;
}

// ---------------- NOAA fetch ----------------
async function fetchStation(st) {
  const hit = cache[st.id];
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
    return { ...st, predictions: hit.predictions, fetchedAt: new Date(hit.fetchedAt).toISOString(), stale: false, error: null };
  }
  const begin = etDateString(-1); // yesterday
  const end = etDateString(7);    // 7 days ahead
  const url = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter'
    + `?product=predictions&application=StarshipVTides&begin_date=${begin}&end_date=${end}`
    + `&datum=MLLW&station=${st.id}&time_zone=lst_ldt&units=english&interval=hilo&format=json`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'StarshipVTides/1.0' } });
    if (!r.ok) throw new Error(`NOAA HTTP ${r.status}`);
    const data = await r.json();
    if (!data || !Array.isArray(data.predictions) || data.predictions.length === 0) {
      throw new Error('NOAA returned no predictions');
    }
    const predictions = data.predictions.map(p => ({ t: p.t, v: Number(p.v), type: p.type }));
    cache[st.id] = { fetchedAt: Date.now(), predictions };
    return { ...st, predictions, fetchedAt: new Date(cache[st.id].fetchedAt).toISOString(), stale: false, error: null };
  } catch (e) {
    if (hit) {
      // Serve the last good data and say so.
      return { ...st, predictions: hit.predictions, fetchedAt: new Date(hit.fetchedAt).toISOString(), stale: true, error: null };
    }
    return { ...st, predictions: [], fetchedAt: null, stale: false, error: 'Tides unavailable right now. NOAA could not be reached; please check back shortly.' };
  }
}

function createTides({ requireAuth }) {
  const router = express.Router();

  router.get('/healthz', (req, res) => res.json({ ok: true }));

  router.use(requireAuth);

  // ---------------- api ----------------
  router.get('/api/tides', async (req, res) => {
    const stations = [];
    for (const st of STATIONS) stations.push(await fetchStation(st));
    res.json({ generatedAt: new Date().toISOString(), timeZone: TZ, stations });
  });

  // ---------------- app shell ----------------
  router.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'tides', 'index.html')));
  router.use(express.static(path.join(__dirname, '..', 'public', 'tides')));

  return { router, ready: Promise.resolve() };
}

module.exports = { createTides };
