// Captain Spurling hub: ONE Express service hosting the four Starship V
// programs under paths, with one sign-in for the whole hub.
//   /             landing page (the home screen after sign-in)
//   /inventory    Par Inventory
//   /cash         Petty Cash
//   /maintenance  Maintenance Tracker
//   /tides        Tide Chart
// Storage: ONE DATABASE_URL pointing at the existing shared Postgres
// (starship-v-par-db). The inventory module uses the exact table name and
// schema of the live standalone Par Inventory app ("items"), petty cash
// uses pc_ tables, maintenance uses mt_ tables, tides stores nothing.
// When DATABASE_URL is not set (local testing), each data module falls
// back to its own JSON file under data/: inventory.json, cash.json,
// maintenance.json.
'use strict';
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { createInventory } = require('./modules/inventory');
const { createCash } = require('./modules/cash');
const { createMaintenance } = require('./modules/maintenance');
const { createTides } = require('./modules/tides');
const { createInquiries } = require('./modules/inquiries');

const app = express();
const PORT = process.env.PORT || 8080;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const REPORT_TOKEN = process.env.REPORT_TOKEN || '';
const SECRET = crypto.createHash('sha256').update(APP_PASSWORD + ':captain-hub').digest('hex');
const COOKIE = 'svhub';

app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------------- hub auth ----------------
function sign(v) { return crypto.createHmac('sha256', SECRET).update(v).digest('hex'); }
function authed(req) {
  if (!APP_PASSWORD) return true;
  const c = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
  if (!c) return false;
  const val = c.slice(COOKIE.length + 1);
  const [exp, mac] = val.split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  return sign(exp) === mac;
}
// Used by the program routers: inside a mounted router req.path is relative
// to the mount point, so /api/, /export/ and /receipt/ checks work exactly
// as they did in the standalone apps. Page requests bounce to the sign-in
// page with a next parameter so the user lands in the program they clicked.
function safeNext(v) {
  if (typeof v !== 'string' || v.length > 200) return '';
  if (!v.startsWith('/') || v.startsWith('//')) return '';
  return v;
}
function requireAuth(req, res, next) {
  if (authed(req)) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/export/') || req.path.startsWith('/receipt/')) {
    return res.status(401).json({ error: 'Not signed in' });
  }
  const dest = safeNext(req.originalUrl || '') || '/';
  return res.redirect('/login?next=' + encodeURIComponent(dest));
}
app.get('/login', (req, res) => {
  if (!APP_PASSWORD || authed(req)) return res.redirect(safeNext(req.query.next) || '/');
  const nextField = safeNext(req.query.next)
    ? `<input type="hidden" name="next" value="${safeNext(req.query.next).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}">`
    : '';
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Captain Spurling, Starship V Programs</title><style>body{font-family:-apple-system,system-ui,sans-serif;background:#0d2137;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#12314f;padding:28px;border-radius:14px;width:min(92vw,340px)}h1{font-size:19px;margin:0 0 14px}input{width:100%;padding:12px;border-radius:8px;border:1px solid #3a5a78;background:#0a1a2c;color:#fff;font-size:16px;box-sizing:border-box}
button{width:100%;margin-top:12px;padding:12px;border:0;border-radius:8px;background:#f5b301;color:#14232f;font-weight:700;font-size:16px}</style></head>
<body><form class="card" method="POST" action="/login"><h1>Captain Spurling, Starship V Programs</h1>
${nextField}
<input type="password" name="password" placeholder="Password" autocomplete="current-password" required>
<button type="submit">Sign in</button>
<div style="text-align:center;margin-top:16px;font-size:13.5px"><a style="color:#c8d6e2" href="/about-captain-mark">About Captain Mark</a> &nbsp;·&nbsp; <a style="color:#c8d6e2" href="/about-legacy-yacht">About Legacy Yacht</a></div></form></body></html>`);
});
app.post('/login', (req, res) => {
  if (req.body.password === APP_PASSWORD) {
    const exp = String(Date.now() + 30 * 24 * 3600 * 1000);
    res.setHeader('Set-Cookie', `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
    return res.redirect(safeNext(req.body.next) || '/');
  }
  res.redirect('/login');
});
app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0`);
  res.redirect('/login');
});
app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------------- public about pages (no sign-in required) -----------------
app.get('/about-captain-mark', (req, res) => res.sendFile(path.join(__dirname, 'public', 'about-captain-mark.html')));
app.get('/about-legacy-yacht', (req, res) => res.sendFile(path.join(__dirname, 'public', 'about-legacy-yacht.html')));
app.use('/about', express.static(path.join(__dirname, 'public', 'about'), { maxAge: '1h' }));

// ---------------- supply stock photo map (sign-in required) ----------------
// Static copy of the Starship V supply stock photo map, hosted on the hub
// itself so it does not live on anyone's personal Google Drive (added
// 2026-11-12 at Mark's direction). Gated like the programs, since it shows
// where supplies are stowed aboard.
app.use('/supply-map', requireAuth, express.static(path.join(__dirname, 'public', 'supply-map'), { maxAge: '1h' }));

// ---------------- storage: one shared pool, or per-module files ------------
let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  });
}
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const deps = name => ({
  pool,
  dataFile: path.join(dataDir, name + '.json'),
  requireAuth,
  reportToken: REPORT_TOKEN,
});

// ---------------- programs ----------------
const inventory = createInventory(deps('inventory'));
const cash = createCash(deps('cash'));
const maintenance = createMaintenance(deps('maintenance'));
// Tides is PUBLIC by Mark's decision (2026-11-09): it serves published NOAA
// predictions and stores nothing, so it gets a pass-through instead of the
// hub sign-in. Every other program stays behind the password.
const tides = createTides({ requireAuth: (req, res, next) => next() });
// Legacy Yacht inquiry form: PUBLIC by design (it is the public contact
// form on /about-legacy-yacht). Stores every submission in the hub database
// and emails it to Mark, cc Shahzain, via the hub's own Gmail login.
const inquiries = createInquiries({
  pool,
  dataFile: path.join(dataDir, 'inquiries.json'),
  reportToken: REPORT_TOKEN,
});

app.use('/inventory', inventory.router);
app.use('/cash', cash.router);
app.use('/maintenance', maintenance.router);
app.use('/tides', tides.router);
app.use('/', inquiries.router);

// ---------------- landing page (PUBLIC home screen) ------------------------
// Anyone can land on captain.spurling.net and see the brands and the About
// pages; the password is asked only when a visitor clicks into a program.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

Promise.all([inventory.ready, cash.ready, maintenance.ready, tides.ready, inquiries.ready])
  .then(() => app.listen(PORT, () => console.log(`Captain Hub listening on ${PORT} (store: ${pool ? 'pg' : 'file'})`)))
  .catch(e => { console.error('Store init failed', e); process.exit(1); });
