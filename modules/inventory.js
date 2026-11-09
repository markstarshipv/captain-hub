// Par Inventory module for the Captain Spurling hub.
// Adapted from the standalone starship-v-par-inventory app with no behavior
// changes, except: auth is the hub's (the router is mounted behind the hub
// sign-in), and in Postgres mode it uses the hub's shared pool.
// CRITICAL: the Postgres table name and schema (table "items") and the
// seed-only-when-empty behavior are exactly those of the live standalone
// app, because this module reads the same live database.
'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');

const seed = require('../seeds/inventory.json');

function itemStatus(it) {
  if (it.currentCount === null || it.currentCount === undefined) return 'not_counted';
  const c = Number(it.currentCount);
  if (it.reorderQty !== null && it.reorderQty !== undefined && c <= Number(it.reorderQty)) return 'reorder';
  if (c < Number(it.parQty)) return 'top_up';
  return 'stocked';
}
function decorate(it) {
  const status = itemStatus(it);
  const orderQty = (it.currentCount === null || it.currentCount === undefined)
    ? 0 : Math.max(0, Math.round((Number(it.parQty) - Number(it.currentCount)) * 100) / 100);
  return { ...it, status, orderQty, needsOrder: orderQty > 0 };
}
function fmtQty(n) {
  if (n === null || n === undefined) return '';
  return Number.isInteger(Number(n)) ? String(Number(n)) : String(Number(n));
}

function createInventory({ pool, dataFile, requireAuth, reportToken }) {
  const router = express.Router();
  let store;

  async function init() {
    if (pool) {
      await pool.query(`CREATE TABLE IF NOT EXISTS items (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        par_qty NUMERIC NOT NULL,
        reorder_qty NUMERIC,
        unit TEXT NOT NULL,
        vendor TEXT NOT NULL,
        notes TEXT DEFAULT '',
        reorder_text TEXT DEFAULT '',
        cadence TEXT DEFAULT 'monitor',
        sort_order INTEGER DEFAULT 0,
        current_count NUMERIC,
        last_counted_at TIMESTAMPTZ
      )`);
      const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM items');
      if (rows[0].n === 0) {
        for (const s of seed) {
          await pool.query(
            `INSERT INTO items (name, category, par_qty, reorder_qty, unit, vendor, notes, reorder_text, cadence, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [s.name, s.category, s.parQty, s.reorderQty, s.unit, s.vendor, s.notes || '', s.reorderText || '', s.cadence || 'monitor', s.sortOrder || 0]
          );
        }
      }
      store = { mode: 'pg', pool };
    } else {
      let data;
      if (fs.existsSync(dataFile)) {
        data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      } else {
        data = { nextId: seed.length + 1, items: seed.map((s, i) => ({ id: i + 1, ...s, currentCount: null, lastCountedAt: null })) };
        fs.writeFileSync(dataFile, JSON.stringify(data, null, 1));
      }
      store = { mode: 'file', file: dataFile, data };
    }
  }

  function rowToItem(r) {
    return {
      id: r.id, name: r.name, category: r.category,
      parQty: r.par_qty !== undefined ? Number(r.par_qty) : r.parQty,
      reorderQty: (r.reorder_qty !== undefined ? r.reorder_qty : r.reorderQty) === null ? null : Number(r.reorder_qty !== undefined ? r.reorder_qty : r.reorderQty),
      unit: r.unit, vendor: r.vendor, notes: r.notes || '',
      reorderText: r.reorder_text !== undefined ? r.reorder_text : (r.reorderText || ''),
      cadence: r.cadence, sortOrder: r.sort_order !== undefined ? r.sort_order : r.sortOrder,
      currentCount: (r.current_count !== undefined ? r.current_count : r.currentCount) === null ? null : Number(r.current_count !== undefined ? r.current_count : r.currentCount),
      lastCountedAt: (r.last_counted_at !== undefined ? r.last_counted_at : r.lastCountedAt) || null,
    };
  }

  async function listItems() {
    if (store.mode === 'pg') {
      const { rows } = await store.pool.query('SELECT * FROM items ORDER BY sort_order, id');
      return rows.map(rowToItem);
    }
    return [...store.data.items].sort((a, b) => (a.sortOrder - b.sortOrder) || (a.id - b.id));
  }
  function saveFile() {
    if (store.mode === 'file') fs.writeFileSync(store.file, JSON.stringify(store.data, null, 1));
  }
  async function updateCount(id, count) {
    const now = new Date().toISOString();
    if (store.mode === 'pg') {
      await store.pool.query('UPDATE items SET current_count=$1, last_counted_at=$2 WHERE id=$3', [count, now, id]);
    } else {
      const it = store.data.items.find(i => i.id === id);
      if (it) { it.currentCount = count; it.lastCountedAt = now; }
      saveFile();
    }
  }
  async function restockVendor(vendor) {
    const items = await listItems();
    const now = new Date().toISOString();
    for (const it of items) {
      if (it.vendor === vendor && it.currentCount !== null && Number(it.currentCount) < Number(it.parQty)) {
        if (store.mode === 'pg') {
          await store.pool.query('UPDATE items SET current_count=$1, last_counted_at=$2 WHERE id=$3', [it.parQty, now, it.id]);
        } else {
          const f = store.data.items.find(i => i.id === it.id);
          if (f) { f.currentCount = Number(it.parQty); f.lastCountedAt = now; }
        }
      }
    }
    saveFile();
  }
  async function startNewCount() {
    if (store.mode === 'pg') {
      await store.pool.query('UPDATE items SET current_count=NULL, last_counted_at=NULL');
    } else {
      store.data.items.forEach(i => { i.currentCount = null; i.lastCountedAt = null; });
      saveFile();
    }
  }
  async function upsertItem(body, id) {
    const vals = {
      name: String(body.name || '').trim(), category: String(body.category || '').trim(),
      parQty: Number(body.parQty), reorderQty: body.reorderQty === '' || body.reorderQty === null || body.reorderQty === undefined ? null : Number(body.reorderQty),
      unit: String(body.unit || '').trim(), vendor: String(body.vendor || '').trim(),
      notes: String(body.notes || ''), reorderText: String(body.reorderText || ''),
      cadence: String(body.cadence || 'monitor'), sortOrder: Number(body.sortOrder || 0),
    };
    if (!vals.name || !vals.category || !vals.unit || !vals.vendor || isNaN(vals.parQty)) throw new Error('Missing required item fields');
    if (store.mode === 'pg') {
      if (id) {
        await store.pool.query(`UPDATE items SET name=$1, category=$2, par_qty=$3, reorder_qty=$4, unit=$5, vendor=$6, notes=$7, reorder_text=$8, cadence=$9, sort_order=$10 WHERE id=$11`,
          [vals.name, vals.category, vals.parQty, vals.reorderQty, vals.unit, vals.vendor, vals.notes, vals.reorderText, vals.cadence, vals.sortOrder, id]);
        return id;
      }
      const { rows } = await store.pool.query(`INSERT INTO items (name, category, par_qty, reorder_qty, unit, vendor, notes, reorder_text, cadence, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [vals.name, vals.category, vals.parQty, vals.reorderQty, vals.unit, vals.vendor, vals.notes, vals.reorderText, vals.cadence, vals.sortOrder]);
      return rows[0].id;
    }
    if (id) {
      const it = store.data.items.find(i => i.id === id);
      if (it) Object.assign(it, vals);
      saveFile();
      return id;
    }
    const nid = store.data.nextId++;
    store.data.items.push({ id: nid, ...vals, currentCount: null, lastCountedAt: null });
    saveFile();
    return nid;
  }
  async function deleteItem(id) {
    if (store.mode === 'pg') {
      await store.pool.query('DELETE FROM items WHERE id=$1', [id]);
    } else {
      store.data.items = store.data.items.filter(i => i.id !== id);
      saveFile();
    }
  }

  // ---------------- report builder ----------------
  async function buildReport() {
    const items = (await listItems()).map(decorate);
    const byVendor = {};
    let toOrder = 0, reorderCount = 0, counted = 0;
    for (const it of items) {
      if (it.currentCount !== null) counted++;
      if (it.needsOrder) {
        toOrder++;
        if (it.status === 'reorder') reorderCount++;
        (byVendor[it.vendor] = byVendor[it.vendor] || []).push({
          name: it.name, have: it.currentCount, par: it.parQty, order: it.orderQty,
          unit: it.unit, flag: it.status === 'reorder' ? 'REORDER' : 'Below par', notes: it.notes,
        });
      }
    }
    return { generatedAt: new Date().toISOString(), total: items.length, counted, toOrder, reorderCount, byVendor };
  }

  // Token-protected report feed for the Monday email job. Registered before
  // the hub auth middleware: it answers to the token, not the sign-in cookie.
  router.get('/api/report.json', async (req, res) => {
    if (!reportToken || req.query.token !== reportToken) return res.status(403).json({ error: 'Forbidden' });
    res.json(await buildReport());
  });

  router.use(requireAuth);

  // ---------------- api ----------------
  router.get('/api/items', async (req, res) => {
    const items = (await listItems()).map(decorate);
    const counted = items.filter(i => i.currentCount !== null).length;
    res.json({ total: items.length, counted, toOrder: items.filter(i => i.needsOrder).length, reorderCount: items.filter(i => i.status === 'reorder').length, items });
  });
  router.post('/api/count', async (req, res) => {
    const id = Number(req.body.id);
    const count = req.body.count === null || req.body.count === '' ? null : Number(req.body.count);
    if (!id || (count !== null && (isNaN(count) || count < 0))) return res.status(400).json({ error: 'Bad count' });
    await updateCount(id, count);
    res.json({ ok: true });
  });
  router.get('/api/report', async (req, res) => res.json(await buildReport()));
  router.post('/api/restock', async (req, res) => { await restockVendor(String(req.body.vendor || '')); res.json({ ok: true }); });
  router.post('/api/newcount', async (req, res) => { await startNewCount(); res.json({ ok: true }); });
  router.post('/api/item', async (req, res) => {
    try { const id = await upsertItem(req.body, req.body.id ? Number(req.body.id) : null); res.json({ ok: true, id }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.post('/api/item/delete', async (req, res) => { await deleteItem(Number(req.body.id)); res.json({ ok: true }); });

  // ---------------- exports ----------------
  router.get('/export/order.pdf', async (req, res) => {
    const PDFDocument = require('pdfkit');
    const report = await buildReport();
    const dateStr = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'long', day: 'numeric' });
    const doc = new PDFDocument({ margin: 48 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="Starship-V-Order-Report.pdf"');
    doc.pipe(res);
    doc.fontSize(18).font('Helvetica-Bold').text('Starship V, Weekly Order Report');
    doc.fontSize(11).font('Helvetica').text(dateStr);
    doc.moveDown(0.5);
    doc.text(`Items to order: ${report.toOrder} (${report.reorderCount} at or below reorder point). Counted ${report.counted} of ${report.total} items.`);
    doc.moveDown(1);
    const vendors = Object.keys(report.byVendor);
    if (!vendors.length) doc.text('Nothing to order. All counted items are at or above par.');
    for (const v of vendors) {
      doc.fontSize(14).font('Helvetica-Bold').text(v);
      doc.moveDown(0.3);
      for (const line of report.byVendor[v]) {
        doc.fontSize(11).font('Helvetica-Bold').text(`${line.name}: order ${fmtQty(line.order)} ${line.unit}  [${line.flag}]`, { continued: false });
        doc.fontSize(10).font('Helvetica').text(`On hand ${fmtQty(line.have)} of par ${fmtQty(line.par)} ${line.unit}.`);
        if (line.notes) doc.fontSize(10).font('Helvetica-Oblique').text(`Note: ${line.notes}`);
        doc.moveDown(0.4);
      }
      doc.moveDown(0.6);
    }
    doc.end();
  });
  router.get('/export/order.xlsx', async (req, res) => {
    const ExcelJS = require('exceljs');
    const report = await buildReport();
    const wb = new ExcelJS.Workbook();
    const summary = wb.addWorksheet('Summary');
    summary.addRow(['Starship V, Weekly Order Report']);
    summary.addRow(['Generated', new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })]);
    summary.addRow(['Items to order', report.toOrder]);
    summary.addRow(['At or below reorder point', report.reorderCount]);
    summary.addRow(['Counted', `${report.counted} of ${report.total}`]);
    for (const v of Object.keys(report.byVendor)) {
      const ws = wb.addWorksheet(v.replace(/[^\w ]/g, '').slice(0, 28) || 'Vendor');
      ws.addRow(['Item', 'On hand', 'Par', 'Order', 'Unit', 'Flag', 'Notes']);
      for (const line of report.byVendor[v]) ws.addRow([line.name, line.have, line.par, line.order, line.unit, line.flag, line.notes || '']);
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Starship-V-Order-Report.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  });
  router.get('/api/report.txt', async (req, res) => {
    const report = await buildReport();
    let out = '';
    for (const v of Object.keys(report.byVendor)) {
      out += `${v}\n`;
      for (const line of report.byVendor[v]) out += `- ${line.name}: order ${fmtQty(line.order)} ${line.unit} (have ${fmtQty(line.have)}, par ${fmtQty(line.par)}) [${line.flag}]${line.notes ? ' Note: ' + line.notes : ''}\n`;
      out += '\n';
    }
    res.type('text/plain').send(out || 'Nothing to order.');
  });

  // ---------------- app shell ----------------
  router.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'inventory', 'index.html')));
  router.use(express.static(path.join(__dirname, '..', 'public', 'inventory')));

  return { router, ready: init() };
}

module.exports = { createInventory };
