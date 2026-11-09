// Maintenance Tracker module for the Captain Spurling hub.
// Adapted from the standalone starship-v-maintenance app with no behavior
// changes, except: auth is the hub's (the router is mounted behind the hub
// sign-in), Postgres mode uses the hub's shared pool (tables stay prefixed
// mt_), and the file store lives in the hub's data/ directory.
'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');

const seed = require('../seeds/maintenance.json');

// ---------------- constants ----------------
const METERS = [
  { key: 'port_engine', label: 'Port Engine' },
  { key: 'starboard_engine', label: 'Starboard Engine' },
  { key: 'generator', label: 'Generator' },
  { key: 'seakeeper_run', label: 'Seakeeper Run' },
  { key: 'seakeeper_sea', label: 'Seakeeper Sea' },
];
const METER_LABEL = Object.fromEntries(METERS.map(m => [m.key, m.label]));

// ---------------- date helpers (America/New_York) ----------------
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
function validDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T12:00:00Z'));
}

function createMaintenance({ pool, dataFile, requireAuth, reportToken }) {
  const router = express.Router();
  let store;

  async function seedPg(p) {
    for (const s of seed.items) {
      await p.query(
        `INSERT INTO mt_items (id, name, category, interval_days, note, meters, archived, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [s.id, s.name, s.category, s.intervalDays, s.note || '', JSON.stringify(s.meters || []), !!s.archived, s.id]
      );
    }
    await p.query(`SELECT setval('mt_items_id_seq', (SELECT MAX(id) FROM mt_items))`);
    for (const s of seed.items) {
      if (s.lastServicedOn) {
        await p.query(
          `INSERT INTO mt_logs (item_id, serviced_on, performed_by, note, hours_at_service, created_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [s.id, s.lastServicedOn, s.lastPerformedBy || 'MS', s.lastNote || '', null, s.lastServicedOn + 'T17:00:00Z']
        );
      }
    }
    for (const h of seed.hours) {
      await p.query(
        `INSERT INTO mt_hours (meter, value, logged_on, performed_by, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [h.meter, h.value, h.lastLoggedAt, h.lastPerformedBy || 'MS', h.lastLoggedAt + 'T17:00:00Z']
      );
    }
  }

  function seedFileData() {
    const items = seed.items.map(s => ({
      id: s.id, name: s.name, category: s.category, intervalDays: s.intervalDays,
      note: s.note || '', meters: s.meters || [], archived: !!s.archived, sortOrder: s.id,
    }));
    const logs = [];
    let logId = 1;
    for (const s of seed.items) {
      if (s.lastServicedOn) {
        logs.push({
          id: logId++, itemId: s.id, servicedOn: s.lastServicedOn,
          performedBy: s.lastPerformedBy || 'MS', note: s.lastNote || '',
          hoursAtService: null, createdAt: s.lastServicedOn + 'T17:00:00.000Z',
        });
      }
    }
    const hours = seed.hours.map((h, i) => ({
      id: i + 1, meter: h.meter, value: h.value, loggedOn: h.lastLoggedAt,
      performedBy: h.lastPerformedBy || 'MS', createdAt: h.lastLoggedAt + 'T17:00:00.000Z',
    }));
    return {
      nextItemId: Math.max(...items.map(i => i.id)) + 1,
      nextLogId: logId,
      nextHourId: hours.length + 1,
      items, logs, hours,
    };
  }

  async function init() {
    if (pool) {
      await pool.query(`CREATE TABLE IF NOT EXISTS mt_items (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        interval_days INTEGER,
        note TEXT DEFAULT '',
        meters JSONB NOT NULL DEFAULT '[]',
        archived BOOLEAN NOT NULL DEFAULT false,
        sort_order INTEGER DEFAULT 0
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS mt_logs (
        id SERIAL PRIMARY KEY,
        item_id INTEGER NOT NULL REFERENCES mt_items(id) ON DELETE CASCADE,
        serviced_on DATE NOT NULL,
        performed_by TEXT NOT NULL,
        note TEXT DEFAULT '',
        hours_at_service JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS mt_hours (
        id SERIAL PRIMARY KEY,
        meter TEXT NOT NULL,
        value NUMERIC NOT NULL,
        logged_on DATE NOT NULL,
        performed_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM mt_items');
      if (rows[0].n === 0) await seedPg(pool);
      store = { mode: 'pg', pool };
    } else {
      let data;
      if (fs.existsSync(dataFile)) {
        data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      } else {
        data = seedFileData();
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
      id: r.id, name: r.name, category: r.category,
      intervalDays: r.interval_days === null ? null : Number(r.interval_days),
      note: r.note || '', meters: Array.isArray(r.meters) ? r.meters : JSON.parse(r.meters || '[]'),
      archived: !!r.archived, sortOrder: r.sort_order,
    };
  }
  function pgLog(r) {
    return {
      id: r.id, itemId: r.item_id, servicedOn: r.serviced_on,
      performedBy: r.performed_by, note: r.note || '',
      hoursAtService: r.hours_at_service || null,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    };
  }
  function pgHour(r) {
    return {
      id: r.id, meter: r.meter, value: Number(r.value), loggedOn: r.logged_on,
      performedBy: r.performed_by,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    };
  }

  async function listItems() {
    if (store.mode === 'pg') {
      const { rows } = await store.pool.query('SELECT * FROM mt_items ORDER BY sort_order, id');
      return rows.map(pgItem);
    }
    return [...store.data.items].sort((a, b) => (a.sortOrder - b.sortOrder) || (a.id - b.id));
  }
  async function listLogs() {
    if (store.mode === 'pg') {
      const { rows } = await store.pool.query('SELECT id, item_id, serviced_on::text AS serviced_on, performed_by, note, hours_at_service, created_at FROM mt_logs ORDER BY serviced_on DESC, id DESC');
      return rows.map(pgLog);
    }
    return [...store.data.logs].sort((a, b) => (b.servicedOn < a.servicedOn ? -1 : b.servicedOn > a.servicedOn ? 1 : b.id - a.id));
  }
  async function listHours() {
    if (store.mode === 'pg') {
      const { rows } = await store.pool.query('SELECT id, meter, value, logged_on::text AS logged_on, performed_by, created_at FROM mt_hours ORDER BY id');
      return rows.map(pgHour);
    }
    return [...store.data.hours].sort((a, b) => a.id - b.id);
  }

  async function addLog(entry) {
    const createdAt = new Date().toISOString();
    if (store.mode === 'pg') {
      const { rows } = await store.pool.query(
        `INSERT INTO mt_logs (item_id, serviced_on, performed_by, note, hours_at_service) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [entry.itemId, entry.servicedOn, entry.performedBy, entry.note || '', entry.hoursAtService ? JSON.stringify(entry.hoursAtService) : null]
      );
      return rows[0].id;
    }
    const id = store.data.nextLogId++;
    store.data.logs.push({ id, ...entry, note: entry.note || '', createdAt });
    saveFile();
    return id;
  }
  async function addHourReading(reading) {
    if (store.mode === 'pg') {
      await store.pool.query(
        `INSERT INTO mt_hours (meter, value, logged_on, performed_by) VALUES ($1,$2,$3,$4)`,
        [reading.meter, reading.value, reading.loggedOn, reading.performedBy]
      );
      return;
    }
    const id = store.data.nextHourId++;
    store.data.hours.push({ id, ...reading, createdAt: new Date().toISOString() });
    saveFile();
  }
  async function upsertItem(body, id) {
    const vals = {
      name: String(body.name || '').trim(),
      category: String(body.category || '').trim(),
      intervalDays: body.intervalDays === '' || body.intervalDays === null || body.intervalDays === undefined ? null : Number(body.intervalDays),
      note: String(body.note || ''),
      meters: Array.isArray(body.meters) ? body.meters.filter(m => METER_LABEL[m]) : [],
      sortOrder: Number(body.sortOrder || 0),
    };
    if (!vals.name || !vals.category) throw new Error('Missing required item fields');
    if (vals.intervalDays !== null && (isNaN(vals.intervalDays) || vals.intervalDays < 1)) throw new Error('Interval must be a positive number of days, or blank for none');
    if (store.mode === 'pg') {
      if (id) {
        await store.pool.query(
          `UPDATE mt_items SET name=$1, category=$2, interval_days=$3, note=$4, meters=$5, sort_order=$6 WHERE id=$7`,
          [vals.name, vals.category, vals.intervalDays, vals.note, JSON.stringify(vals.meters), vals.sortOrder, id]
        );
        return id;
      }
      const { rows } = await store.pool.query(
        `INSERT INTO mt_items (name, category, interval_days, note, meters, sort_order) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [vals.name, vals.category, vals.intervalDays, vals.note, JSON.stringify(vals.meters), vals.sortOrder]
      );
      return rows[0].id;
    }
    if (id) {
      const it = store.data.items.find(i => i.id === id);
      if (it) Object.assign(it, vals);
      saveFile();
      return id;
    }
    const nid = store.data.nextItemId++;
    store.data.items.push({ id: nid, ...vals, archived: false });
    saveFile();
    return nid;
  }
  async function setArchived(id, archived) {
    if (store.mode === 'pg') {
      await store.pool.query('UPDATE mt_items SET archived=$1 WHERE id=$2', [archived, id]);
    } else {
      const it = store.data.items.find(i => i.id === id);
      if (it) it.archived = archived;
      saveFile();
    }
  }

  // ---------------- status and report ----------------
  function decorateItem(it, lastLog, today) {
    const lastServicedOn = lastLog ? lastLog.servicedOn : null;
    let status, nextDue = null, daysUntil = null;
    if (it.intervalDays === null || it.intervalDays === undefined) {
      status = 'no_interval';
    } else if (!lastServicedOn) {
      status = 'not_logged';
    } else {
      nextDue = addDays(lastServicedOn, it.intervalDays);
      daysUntil = daysBetween(today, nextDue);
      status = daysUntil < 0 ? 'overdue' : daysUntil <= 7 ? 'due_soon' : 'on_schedule';
    }
    return {
      ...it,
      status, nextDue, daysUntil,
      lastServicedOn,
      lastNote: lastLog ? lastLog.note : null,
      lastPerformedBy: lastLog ? lastLog.performedBy : null,
    };
  }

  async function buildState() {
    const today = todayNY();
    const items = await listItems();
    const logs = await listLogs();
    const hours = await listHours();
    const lastByItem = {};
    for (const l of logs) if (!lastByItem[l.itemId]) lastByItem[l.itemId] = l;
    const decorated = items.map(it => decorateItem(it, lastByItem[it.id], today));
    const active = decorated.filter(i => !i.archived);
    const counts = { overdue: 0, dueSoon: 0, onSchedule: 0, notLogged: 0, noInterval: 0, total: active.length };
    for (const it of active) {
      if (it.status === 'overdue') counts.overdue++;
      else if (it.status === 'due_soon') counts.dueSoon++;
      else if (it.status === 'on_schedule') counts.onSchedule++;
      else if (it.status === 'not_logged') counts.notLogged++;
      else if (it.status === 'no_interval') counts.noInterval++;
    }
    const pumpItems = seed.pumpNames
      .map(name => decorated.find(i => i.name === name))
      .filter(Boolean);
    const pumps = {
      total: pumpItems.length,
      checked: 0,
      complete: false,
      items: pumpItems.map(p => {
        const inCycle = !!p.lastServicedOn && (p.nextDue === null || p.daysUntil >= 0);
        return { name: p.name, lastServicedOn: p.lastServicedOn, nextDue: p.nextDue, status: p.status, inCycle };
      }),
    };
    pumps.checked = pumps.items.filter(p => p.inCycle).length;
    pumps.complete = pumps.total > 0 && pumps.checked === pumps.total;
    const currentHours = {};
    for (const m of METERS) {
      const rows = hours.filter(h => h.meter === m.key);
      const last = rows.length ? rows[rows.length - 1] : null;
      currentHours[m.key] = last
        ? { label: m.label, value: last.value, loggedOn: last.loggedOn, performedBy: last.performedBy }
        : { label: m.label, value: null, loggedOn: null, performedBy: null };
    }
    return { today, items: decorated, logs, hours, counts, pumps, currentHours };
  }

  async function buildReport() {
    const st = await buildState();
    const weekStart = addDays(st.today, -7);
    const recent = st.logs
      .filter(l => l.servicedOn >= weekStart && l.servicedOn <= st.today)
      .map(l => {
        const it = st.items.find(i => i.id === l.itemId);
        return {
          item: it ? it.name : 'Unknown item', itemId: l.itemId,
          servicedOn: l.servicedOn, performedBy: l.performedBy, note: l.note,
          hoursAtService: l.hoursAtService,
        };
      });
    return {
      generatedAt: new Date().toISOString(),
      date: st.today,
      counts: st.counts,
      items: st.items.map(i => ({
        id: i.id, name: i.name, category: i.category, intervalDays: i.intervalDays,
        status: i.status, lastServicedOn: i.lastServicedOn, nextDue: i.nextDue,
        lastNote: i.lastNote, lastPerformedBy: i.lastPerformedBy,
        note: i.note, archived: i.archived,
      })),
      pumps: st.pumps,
      servicedLast7Days: recent,
      hours: st.currentHours,
      recipients: seed.recipients,
    };
  }

  // Token-protected report feed for the Monday email job. Registered before
  // the hub auth middleware: it answers to the token, not the sign-in cookie.
  router.get('/api/report.json', async (req, res) => {
    if (!reportToken || req.query.token !== reportToken) return res.status(403).json({ error: 'Forbidden' });
    res.json(await buildReport());
  });

  router.use(requireAuth);

  // ---------------- api ----------------
  router.get('/api/board', async (req, res) => {
    const st = await buildState();
    res.json({
      today: st.today, counts: st.counts, pumps: st.pumps,
      hours: st.currentHours, meters: METERS,
      items: st.items, pumpNames: seed.pumpNames, recipients: seed.recipients,
    });
  });
  router.get('/api/report', async (req, res) => res.json(await buildReport()));
  router.get('/api/history', async (req, res) => {
    const itemId = Number(req.query.itemId);
    if (!itemId) return res.status(400).json({ error: 'itemId required' });
    const logs = (await listLogs()).filter(l => l.itemId === itemId);
    res.json({ logs });
  });
  router.get('/api/hours/history', async (req, res) => {
    const hours = await listHours();
    res.json({ history: [...hours].reverse(), meters: METERS });
  });
  router.post('/api/log', async (req, res) => {
    const itemId = Number(req.body.itemId);
    const performedBy = String(req.body.performedBy || '').trim();
    const servicedOn = req.body.servicedOn ? String(req.body.servicedOn) : todayNY();
    if (!itemId) return res.status(400).json({ error: 'Item is required' });
    if (!performedBy) return res.status(400).json({ error: 'Performed By is required' });
    if (!validDate(servicedOn)) return res.status(400).json({ error: 'Bad service date' });
    const items = await listItems();
    if (!items.find(i => i.id === itemId)) return res.status(400).json({ error: 'Unknown item' });
    let hoursAtService = null;
    if (req.body.hoursAtService && typeof req.body.hoursAtService === 'object') {
      const clean = {};
      for (const [k, v] of Object.entries(req.body.hoursAtService)) {
        if (METER_LABEL[k] && v !== '' && v !== null && v !== undefined && !isNaN(Number(v))) clean[k] = Number(v);
      }
      if (Object.keys(clean).length) hoursAtService = clean;
    }
    const id = await addLog({ itemId, servicedOn, performedBy, note: String(req.body.note || ''), hoursAtService });
    res.json({ ok: true, id });
  });
  router.post('/api/hours', async (req, res) => {
    const performedBy = String(req.body.performedBy || '').trim();
    if (!performedBy) return res.status(400).json({ error: 'Performed By is required' });
    const readings = req.body.readings || {};
    let saved = 0;
    for (const m of METERS) {
      const v = readings[m.key];
      if (v !== '' && v !== null && v !== undefined && !isNaN(Number(v))) {
        await addHourReading({ meter: m.key, value: Number(v), loggedOn: todayNY(), performedBy });
        saved++;
      }
    }
    if (!saved) return res.status(400).json({ error: 'Enter at least one meter reading' });
    res.json({ ok: true, saved });
  });
  router.post('/api/item', async (req, res) => {
    try { const id = await upsertItem(req.body, req.body.id ? Number(req.body.id) : null); res.json({ ok: true, id }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.post('/api/item/archive', async (req, res) => {
    const id = Number(req.body.id);
    if (!id) return res.status(400).json({ error: 'Item is required' });
    await setArchived(id, !!req.body.archived);
    res.json({ ok: true });
  });

  // ---------------- exports ----------------
  function statusLabel(s) {
    return { overdue: 'Overdue', due_soon: 'Due soon', on_schedule: 'On schedule', not_logged: 'Not yet logged', no_interval: 'No interval' }[s] || s;
  }
  function reportDateStr() {
    return new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'long', day: 'numeric' });
  }
  router.get('/export/report.pdf', async (req, res) => {
    const PDFDocument = require('pdfkit');
    const report = await buildReport();
    const doc = new PDFDocument({ margin: 48 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="Starship-V-Maintenance-Report.pdf"');
    doc.pipe(res);
    doc.fontSize(18).font('Helvetica-Bold').text('Starship V, Weekly Maintenance Report');
    doc.fontSize(11).font('Helvetica').text(reportDateStr());
    doc.moveDown(0.5);
    const c = report.counts;
    doc.text(`Status counts: ${c.overdue} overdue, ${c.dueSoon} due soon, ${c.onSchedule} on schedule, ${c.notLogged} not yet logged, ${c.noInterval} with no interval. ${c.total} active items tracked.`);
    doc.moveDown(0.4);
    doc.text(`Bilge and sump pump check: ${report.pumps.complete ? 'COMPLETE' : 'INCOMPLETE'}, ${report.pumps.checked} of ${report.pumps.total} pumps checked this cycle.`);
    for (const p of report.pumps.items) {
      doc.fontSize(10).text(`  ${p.name}: last checked ${p.lastServicedOn || 'never'}${p.nextDue ? ', next due ' + p.nextDue : ''} (${p.inCycle ? 'in cycle' : 'needs check'})`);
    }
    doc.fontSize(11).moveDown(0.6);
    doc.fontSize(14).font('Helvetica-Bold').text('Engine hours');
    doc.fontSize(11).font('Helvetica');
    for (const m of METERS) {
      const h = report.hours[m.key];
      doc.text(`${h.label}: ${h.value === null ? 'not logged' : h.value}${h.loggedOn ? ' (logged ' + h.loggedOn + ' by ' + h.performedBy + ')' : ''}`);
    }
    doc.moveDown(0.6);
    doc.fontSize(14).font('Helvetica-Bold').text('Serviced in the last 7 days');
    doc.fontSize(11).font('Helvetica');
    if (!report.servicedLast7Days.length) doc.text('Nothing logged in the last 7 days.');
    for (const l of report.servicedLast7Days) {
      doc.font('Helvetica-Bold').text(`${l.item}: ${l.servicedOn}, by ${l.performedBy}`, { continued: false });
      if (l.note) doc.font('Helvetica').text(l.note);
      doc.font('Helvetica').moveDown(0.3);
    }
    doc.moveDown(0.6);
    doc.fontSize(14).font('Helvetica-Bold').text('All items');
    doc.fontSize(11).font('Helvetica');
    for (const i of report.items) {
      if (i.archived) continue;
      doc.font('Helvetica-Bold').text(`${i.name} [${statusLabel(i.status)}]`, { continued: false });
      doc.font('Helvetica').text(`Last serviced: ${i.lastServicedOn || 'never'}${i.nextDue ? ' · Next due: ' + i.nextDue : ''}${i.intervalDays ? ' · Every ' + i.intervalDays + ' days' : ''}`);
      doc.moveDown(0.3);
    }
    doc.end();
  });
  router.get('/export/report.xlsx', async (req, res) => {
    const ExcelJS = require('exceljs');
    const report = await buildReport();
    const wb = new ExcelJS.Workbook();
    const summary = wb.addWorksheet('Summary');
    summary.addRow(['Starship V, Weekly Maintenance Report']);
    summary.addRow(['Generated', new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })]);
    summary.addRow(['Active items', report.counts.total]);
    summary.addRow(['Overdue', report.counts.overdue]);
    summary.addRow(['Due soon (within 7 days)', report.counts.dueSoon]);
    summary.addRow(['On schedule', report.counts.onSchedule]);
    summary.addRow(['Not yet logged', report.counts.notLogged]);
    summary.addRow(['No interval', report.counts.noInterval]);
    summary.addRow(['Pump rollup', `${report.pumps.checked} of ${report.pumps.total} checked, ${report.pumps.complete ? 'COMPLETE' : 'INCOMPLETE'}`]);
    summary.addRow([]);
    summary.addRow(['Bilge and Sump Pumps']);
    for (const p of report.pumps.items) summary.addRow([p.name, p.lastServicedOn || 'never', p.nextDue || '', p.inCycle ? 'In cycle' : 'Needs check']);
    const itemsWs = wb.addWorksheet('Items');
    itemsWs.addRow(['Item', 'Category', 'Status', 'Last serviced', 'Next due', 'Interval (days)', 'Last note', 'Performed by', 'Standing note']);
    for (const i of report.items) {
      if (i.archived) continue;
      itemsWs.addRow([i.name, i.category, statusLabel(i.status), i.lastServicedOn || '', i.nextDue || '', i.intervalDays === null ? '' : i.intervalDays, i.lastNote || '', i.lastPerformedBy || '', i.note || '']);
    }
    const svcWs = wb.addWorksheet('Serviced Last 7 Days');
    svcWs.addRow(['Item', 'Serviced on', 'Performed by', 'Note']);
    for (const l of report.servicedLast7Days) svcWs.addRow([l.item, l.servicedOn, l.performedBy, l.note || '']);
    const hrsWs = wb.addWorksheet('Engine Hours');
    hrsWs.addRow(['Meter', 'Hours', 'Last logged', 'Logged by']);
    for (const m of METERS) {
      const h = report.hours[m.key];
      hrsWs.addRow([h.label, h.value === null ? '' : h.value, h.loggedOn || '', h.performedBy || '']);
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Starship-V-Maintenance-Report.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  });
  router.get('/api/report.txt', async (req, res) => {
    const report = await buildReport();
    const c = report.counts;
    let out = `Starship V, Weekly Maintenance Report, ${reportDateStr()}\n`;
    out += `Overdue ${c.overdue}, due soon ${c.dueSoon}, on schedule ${c.onSchedule}, not yet logged ${c.notLogged}, no interval ${c.noInterval}.\n`;
    out += `Pump check: ${report.pumps.checked} of ${report.pumps.total}, ${report.pumps.complete ? 'COMPLETE' : 'INCOMPLETE'}.\n\n`;
    for (const i of report.items) {
      if (i.archived) continue;
      out += `${i.name} [${statusLabel(i.status)}] last ${i.lastServicedOn || 'never'}${i.nextDue ? ', next due ' + i.nextDue : ''}\n`;
    }
    res.type('text/plain').send(out);
  });

  // ---------------- app shell ----------------
  router.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'maintenance', 'index.html')));
  router.use(express.static(path.join(__dirname, '..', 'public', 'maintenance')));

  return { router, ready: init() };
}

module.exports = { createMaintenance };
