// Before We Leave module for the Captain Spurling hub.
// One screen answering "What still needs attention before we leave, and
// who owns it?" Two read-only sections are pulled from the other modules'
// own stores (the maintenance tracker's tables / data file, and the
// Departure checklist's tables / data file); the manual attention list
// lives in this module's own bw_items table (Postgres) or
// data/attention.json, following the same dual-store pattern as the
// other hub modules. Nothing here writes to another module's data.
'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');

const CATEGORIES = ['Trip', 'Crew Arrival', 'Washdown', 'Food Prep', 'Delivery', 'Marina', 'Maintenance', 'Vendor'];

// ---------------- date helpers (America/New_York), as in maintenance.js --
function todayNY() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
}

function createAttention({ pool, dataFile, requireAuth, reportToken }) {
  const router = express.Router();
  let store;

  async function init() {
    if (pool) {
      await pool.query(`CREATE TABLE IF NOT EXISTS bw_items (
        id SERIAL PRIMARY KEY,
        text TEXT NOT NULL,
        category TEXT NOT NULL,
        owner TEXT DEFAULT '',
        done BOOLEAN NOT NULL DEFAULT false,
        done_by TEXT DEFAULT '',
        done_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      store = { mode: 'pg', pool };
    } else {
      let data;
      if (fs.existsSync(dataFile)) {
        data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      } else {
        data = { nextId: 1, items: [] };
        fs.writeFileSync(dataFile, JSON.stringify(data, null, 1));
      }
      store = { mode: 'file', file: dataFile, data };
    }
  }

  function saveFile() {
    if (store.mode === 'file') fs.writeFileSync(store.file, JSON.stringify(store.data, null, 1));
  }

  function pgItem(r) {
    return {
      id: r.id, text: r.text, category: r.category, owner: r.owner || '',
      done: !!r.done, doneBy: r.done_by || '',
      doneAt: r.done_at ? (r.done_at instanceof Date ? r.done_at.toISOString() : r.done_at) : null,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    };
  }

  async function listItems() {
    if (store.mode === 'pg') {
      const { rows } = await store.pool.query('SELECT * FROM bw_items ORDER BY id');
      return rows.map(pgItem);
    }
    return [...store.data.items].sort((a, b) => a.id - b.id);
  }

  async function upsertItem(body, id) {
    const text = String(body.text || '').trim().slice(0, 500);
    if (!text) throw new Error('Item text is required');
    const category = CATEGORIES.includes(body.category) ? body.category : 'Trip';
    const owner = String(body.owner || '').trim().slice(0, 80);
    if (store.mode === 'pg') {
      if (id) {
        const { rows } = await store.pool.query('SELECT id FROM bw_items WHERE id=$1', [id]);
        if (!rows.length) throw new Error('Item not found');
        await store.pool.query('UPDATE bw_items SET text=$1, category=$2, owner=$3 WHERE id=$4', [text, category, owner, id]);
        return id;
      }
      const { rows } = await store.pool.query(
        'INSERT INTO bw_items (text, category, owner) VALUES ($1,$2,$3) RETURNING id', [text, category, owner]);
      return rows[0].id;
    }
    if (id) {
      const it = store.data.items.find(x => x.id === id);
      if (!it) throw new Error('Item not found');
      it.text = text; it.category = category; it.owner = owner;
      saveFile();
      return id;
    }
    const nid = store.data.nextId++;
    store.data.items.push({
      id: nid, text, category, owner,
      done: false, doneBy: '', doneAt: null, createdAt: new Date().toISOString(),
    });
    saveFile();
    return nid;
  }

  async function toggleItem(id, by) {
    if (store.mode === 'pg') {
      const { rows } = await store.pool.query('SELECT done FROM bw_items WHERE id=$1', [id]);
      if (!rows.length) throw new Error('Item not found');
      if (rows[0].done) {
        await store.pool.query(`UPDATE bw_items SET done=false, done_by='', done_at=NULL WHERE id=$1`, [id]);
        return false;
      }
      await store.pool.query('UPDATE bw_items SET done=true, done_by=$1, done_at=now() WHERE id=$2', [String(by || '').trim(), id]);
      return true;
    }
    const it = store.data.items.find(x => x.id === id);
    if (!it) throw new Error('Item not found');
    if (it.done) { it.done = false; it.doneBy = ''; it.doneAt = null; }
    else { it.done = true; it.doneBy = String(by || '').trim(); it.doneAt = new Date().toISOString(); }
    saveFile();
    return it.done;
  }

  async function deleteItem(id) {
    if (store.mode === 'pg') {
      await store.pool.query('DELETE FROM bw_items WHERE id=$1', [id]);
    } else {
      store.data.items = store.data.items.filter(x => x.id !== id);
      saveFile();
    }
  }

  // ------------- auto-pulled sections (read-only, other modules' data) ---
  // Maintenance: every Repairs item, plus anything overdue or due within
  // 7 days, with the same status math the tracker itself uses.
  async function maintenanceAttention() {
    const today = todayNY();
    let raw = [];
    if (pool) {
      const { rows } = await pool.query(
        `SELECT i.name, i.category, i.interval_days,
                (SELECT MAX(l.serviced_on)::text FROM mt_logs l WHERE l.item_id = i.id) AS last_on
         FROM mt_items i WHERE NOT i.archived ORDER BY i.sort_order, i.id`);
      raw = rows.map(r => ({
        name: r.name, category: r.category,
        intervalDays: r.interval_days === null ? null : Number(r.interval_days),
        lastServicedOn: r.last_on,
      }));
    } else {
      const f = path.join(path.dirname(dataFile), 'maintenance.json');
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      const lastBy = {};
      for (const l of data.logs || []) {
        if (!lastBy[l.itemId] || l.servicedOn > lastBy[l.itemId]) lastBy[l.itemId] = l.servicedOn;
      }
      raw = (data.items || []).filter(i => !i.archived).map(i => ({
        name: i.name, category: i.category, intervalDays: i.intervalDays,
        lastServicedOn: lastBy[i.id] || null,
      }));
    }
    const out = [];
    for (const it of raw) {
      let status = 'no_interval', nextDue = null, daysUntil = null;
      if (it.intervalDays !== null && it.intervalDays !== undefined) {
        if (!it.lastServicedOn) status = 'not_logged';
        else {
          nextDue = addDays(it.lastServicedOn, it.intervalDays);
          daysUntil = daysBetween(today, nextDue);
          status = daysUntil < 0 ? 'overdue' : daysUntil <= 7 ? 'due_soon' : 'on_schedule';
        }
      }
      if (it.category === 'Repairs' || status === 'overdue' || status === 'due_soon') {
        out.push({ name: it.name, category: it.category, status, nextDue, daysUntil, lastServicedOn: it.lastServicedOn });
      }
    }
    const rank = s => (s === 'overdue' ? 0 : s === 'due_soon' ? 1 : 2);
    out.sort((a, b) => (rank(a.status) - rank(b.status)) ||
      ((a.daysUntil === null ? 9999 : a.daysUntil) - (b.daysUntil === null ? 9999 : b.daysUntil)));
    return out;
  }

  // Departure checklist: progress of the open run, if one is open.
  async function departureProgress() {
    if (pool) {
      const t = await pool.query('SELECT COUNT(*)::int AS n FROM ck_dep_tasks');
      const total = t.rows[0].n;
      const { rows } = await pool.query(
        'SELECT started_at, checked_ids FROM ck_dep_runs WHERE finished_at IS NULL ORDER BY id DESC LIMIT 1');
      if (!rows.length) return { open: false, total, done: 0, startedAt: null };
      let ids = [];
      try { ids = JSON.parse(rows[0].checked_ids || '[]'); } catch (e) { ids = []; }
      return {
        open: true, total, done: ids.length,
        startedAt: rows[0].started_at instanceof Date ? rows[0].started_at.toISOString() : rows[0].started_at,
      };
    }
    const f = path.join(path.dirname(dataFile), 'checklist-departure.json');
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    const total = (data.tasks || []).length;
    const open = (data.runs || []).filter(r => !r.finishedAt).sort((a, b) => b.id - a.id)[0];
    if (!open) return { open: false, total, done: 0, startedAt: null };
    return { open: true, total, done: (open.checkedTaskIds || []).length, startedAt: open.startedAt };
  }

  async function buildBoard() {
    let maintenance = [], departure = null;
    try { maintenance = await maintenanceAttention(); } catch (e) { maintenance = []; }
    try { departure = await departureProgress(); } catch (e) { departure = null; }
    return {
      today: todayNY(),
      categories: CATEGORIES,
      maintenance,
      departure,
      items: await listItems(),
    };
  }

  router.use(requireAuth);

  // ---------------- api ----------------
  router.get('/api/board', async (req, res) => res.json(await buildBoard()));
  router.post('/api/item', async (req, res) => {
    try {
      const id = await upsertItem(req.body, req.body.id ? Number(req.body.id) : null);
      res.json({ ok: true, id });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.post('/api/item/toggle', async (req, res) => {
    try {
      const done = await toggleItem(Number(req.body.id), req.body.by);
      res.json({ ok: true, done });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.post('/api/item/delete', async (req, res) => {
    await deleteItem(Number(req.body.id));
    res.json({ ok: true });
  });

  // ---------------- app shell ----------------
  router.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'before-we-leave', 'index.html')));
  router.use(express.static(path.join(__dirname, '..', 'public', 'before-we-leave')));

  return { router, ready: init() };
}

module.exports = { createAttention };
