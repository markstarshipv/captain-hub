// Petty Cash module for the Captain Spurling hub.
// Adapted from the standalone starship-v-petty-cash app with no behavior
// changes, except: auth is the hub's (the router is mounted behind the hub
// sign-in), Postgres mode uses the hub's shared pool (tables stay prefixed
// pc_), and the file store lives in the hub's data/ directory.
// Money is stored in cents everywhere. Dates are America/New_York.
'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');

const seed = require('../seeds/cash.json');
const TZ = 'America/New_York';

// ---------------- helpers ----------------
function fmtMoney(cents) {
  const n = Number(cents) || 0;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return sign + '$' + (abs / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function toCents(v) {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || isNaN(n) || n < 0) throw new Error('Bad amount');
  return Math.round(n * 100);
}
function todayET() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function etDateStr(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}
function validDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function signed(t) { return t.kind === 'addition' ? Number(t.amountCents) : -Number(t.amountCents); }
function auditStatus(a) {
  const d = Number(a.differenceCents);
  return d === 0 ? 'Balanced' : (d > 0 ? 'Over' : 'Short');
}

function createCash({ pool, dataFile, requireAuth, reportToken }) {
  const router = express.Router();
  let store;

  async function seedPg(p) {
    const { rows } = await p.query("SELECT value FROM pc_meta WHERE key='seeded'");
    if (rows.length) return;
    await p.query('INSERT INTO pc_meta (key, value) VALUES ($1,$2)', ['fund_name', seed.fund.name]);
    await p.query('INSERT INTO pc_meta (key, value) VALUES ($1,$2)', ['starting_balance_cents', String(seed.fund.startingBalanceCents)]);
    await p.query('INSERT INTO pc_meta (key, value) VALUES ($1,$2)', ['is_setup', seed.fund.isSetup ? 'true' : 'false']);
    await p.query('INSERT INTO pc_meta (key, value) VALUES ($1,$2)', ['standing_statement_note', seed.standingStatementNote || '']);
    for (const t of seed.transactions) {
      // Seeded receipts: the photo files live in the previous app and cannot be
      // extracted, so they are flagged present (legacy) with no image bytes.
      await p.query(
        `INSERT INTO pc_transactions (id, txn_date, kind, amount_cents, description, category, spent_by, has_receipt, receipt_legacy, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [t.id, t.txnDate, t.kind, t.amountCents, t.description || '', t.category || 'General', t.spentBy || null,
         t.hasReceipt ? 1 : 0, t.hasReceipt ? 1 : 0, t.createdAt || new Date().toISOString()]
      );
    }
    await p.query("SELECT setval('pc_transactions_id_seq', (SELECT MAX(id) FROM pc_transactions))");
    for (const a of seed.audits) {
      await p.query(
        `INSERT INTO pc_audits (id, counted_cents, expected_cents, difference_cents, counted_by, note, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [a.id, a.countedCents, a.expectedCents, a.differenceCents, a.countedBy || '', a.note || '', a.createdAt || new Date().toISOString()]
      );
    }
    await p.query("SELECT setval('pc_audits_id_seq', (SELECT MAX(id) FROM pc_audits))");
    await p.query('INSERT INTO pc_meta (key, value) VALUES ($1,$2)', ['seeded', 'true']);
  }

  async function init() {
    if (pool) {
      await pool.query(`CREATE TABLE IF NOT EXISTS pc_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS pc_transactions (
        id SERIAL PRIMARY KEY,
        txn_date TEXT NOT NULL,
        kind TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        description TEXT DEFAULT '',
        category TEXT DEFAULT 'General',
        spent_by TEXT,
        has_receipt INTEGER NOT NULL DEFAULT 0,
        receipt_legacy INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS pc_receipts (
        txn_id INTEGER PRIMARY KEY REFERENCES pc_transactions(id) ON DELETE CASCADE,
        mime TEXT NOT NULL,
        data BYTEA NOT NULL
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS pc_audits (
        id SERIAL PRIMARY KEY,
        counted_cents INTEGER NOT NULL,
        expected_cents INTEGER NOT NULL,
        difference_cents INTEGER NOT NULL,
        counted_by TEXT DEFAULT '',
        note TEXT DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      await seedPg(pool);
      store = { mode: 'pg', pool };
    } else {
      let data;
      if (fs.existsSync(dataFile)) {
        data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      } else {
        data = {
          fund: { name: seed.fund.name, startingBalanceCents: seed.fund.startingBalanceCents, isSetup: !!seed.fund.isSetup },
          standingStatementNote: seed.standingStatementNote || '',
          nextTxnId: Math.max(...seed.transactions.map(t => t.id)) + 1,
          nextAuditId: Math.max(...seed.audits.map(a => a.id)) + 1,
          transactions: seed.transactions.map(t => ({
            id: t.id, txnDate: t.txnDate, kind: t.kind, amountCents: t.amountCents,
            description: t.description || '', category: t.category || 'General', spentBy: t.spentBy || null,
            hasReceipt: !!t.hasReceipt, receiptLegacy: !!t.hasReceipt,
            receiptMime: null, receiptData: null,
            createdAt: t.createdAt || new Date().toISOString(),
          })),
          audits: seed.audits.map(a => ({
            id: a.id, countedCents: a.countedCents, expectedCents: a.expectedCents, differenceCents: a.differenceCents,
            countedBy: a.countedBy || '', note: a.note || '', createdAt: a.createdAt || new Date().toISOString(),
          })),
        };
        fs.writeFileSync(dataFile, JSON.stringify(data, null, 1));
      }
      store = { mode: 'file', file: dataFile, data };
    }
  }

  function saveFile() {
    if (store.mode === 'file') fs.writeFileSync(store.file, JSON.stringify(store.data, null, 1));
  }

  function rowToTxn(r, hasBytes) {
    return {
      id: r.id,
      txnDate: r.txn_date !== undefined ? r.txn_date : r.txnDate,
      kind: r.kind,
      amountCents: Number(r.amount_cents !== undefined ? r.amount_cents : r.amountCents),
      description: r.description || '',
      category: r.category || 'General',
      spentBy: (r.spent_by !== undefined ? r.spent_by : r.spentBy) || null,
      hasReceipt: !!(r.has_receipt !== undefined ? r.has_receipt : r.hasReceipt),
      receiptLegacy: !!(r.receipt_legacy !== undefined ? r.receipt_legacy : r.receiptLegacy),
      hasReceiptBytes: !!hasBytes,
      createdAt: (r.created_at !== undefined ? r.created_at : r.createdAt) instanceof Date
        ? (r.created_at !== undefined ? r.created_at : r.createdAt).toISOString()
        : (r.created_at !== undefined ? r.created_at : r.createdAt),
    };
  }
  function rowToAudit(r) {
    return {
      id: r.id,
      countedCents: Number(r.counted_cents !== undefined ? r.counted_cents : r.countedCents),
      expectedCents: Number(r.expected_cents !== undefined ? r.expected_cents : r.expectedCents),
      differenceCents: Number(r.difference_cents !== undefined ? r.difference_cents : r.differenceCents),
      countedBy: (r.counted_by !== undefined ? r.counted_by : r.countedBy) || '',
      note: r.note || '',
      createdAt: (r.created_at !== undefined ? r.created_at : r.createdAt) instanceof Date
        ? (r.created_at !== undefined ? r.created_at : r.createdAt).toISOString()
        : (r.created_at !== undefined ? r.created_at : r.createdAt),
    };
  }

  async function getFund() {
    if (store.mode === 'pg') {
      const { rows } = await store.pool.query("SELECT key, value FROM pc_meta WHERE key IN ('fund_name','starting_balance_cents','is_setup','standing_statement_note')");
      const m = {};
      for (const r of rows) m[r.key] = r.value;
      return {
        fund: { name: m.fund_name, startingBalanceCents: Number(m.starting_balance_cents), isSetup: m.is_setup === 'true' },
        standingStatementNote: m.standing_statement_note || '',
      };
    }
    return { fund: store.data.fund, standingStatementNote: store.data.standingStatementNote || '' };
  }

  async function setStandingNote(note) {
    const value = String(note || '').trim();
    if (store.mode === 'pg') {
      await store.pool.query(
        `INSERT INTO pc_meta (key, value) VALUES ('standing_statement_note',$1)
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [value]);
    } else {
      store.data.standingStatementNote = value;
      saveFile();
    }
    return value;
  }

  async function listTransactions() {
    if (store.mode === 'pg') {
      const { rows } = await store.pool.query(
        `SELECT t.*, (r.txn_id IS NOT NULL) AS has_bytes FROM pc_transactions t
         LEFT JOIN pc_receipts r ON r.txn_id = t.id
         ORDER BY t.txn_date ASC, t.id ASC`
      );
      return rows.map(r => rowToTxn(r, r.has_bytes));
    }
    return [...store.data.transactions]
      .sort((a, b) => (a.txnDate < b.txnDate ? -1 : a.txnDate > b.txnDate ? 1 : a.id - b.id))
      .map(t => rowToTxn(t, !!t.receiptData));
  }

  async function listAudits() {
    if (store.mode === 'pg') {
      const { rows } = await store.pool.query('SELECT * FROM pc_audits ORDER BY id DESC');
      return rows.map(rowToAudit);
    }
    return [...store.data.audits].sort((a, b) => b.id - a.id).map(rowToAudit);
  }

  async function getState() {
    const { fund, standingStatementNote } = await getFund();
    const transactions = await listTransactions();
    const audits = await listAudits();
    let added = 0, spent = 0;
    for (const t of transactions) {
      if (t.kind === 'addition') added += t.amountCents; else spent += t.amountCents;
    }
    const balanceCents = fund.startingBalanceCents + added - spent;
    const desc = [...transactions].reverse();
    return {
      fund, standingStatementNote, balanceCents,
      totalAddedCents: added, totalSpentCents: spent,
      transactions: desc, audits: audits.map(a => ({ ...a, status: auditStatus(a) })),
    };
  }

  async function upsertTransaction(body, id) {
    const kind = body.kind === 'addition' ? 'addition' : 'expense';
    const vals = {
      txnDate: validDate(body.txnDate) ? body.txnDate : todayET(),
      kind,
      amountCents: toCents(body.amount),
      description: String(body.description || '').trim(),
      category: String(body.category || 'General').trim() || 'General',
      spentBy: body.spentBy ? String(body.spentBy).trim() || null : null,
    };
    if (store.mode === 'pg') {
      if (id) {
        await store.pool.query(
          `UPDATE pc_transactions SET txn_date=$1, kind=$2, amount_cents=$3, description=$4, category=$5, spent_by=$6 WHERE id=$7`,
          [vals.txnDate, vals.kind, vals.amountCents, vals.description, vals.category, vals.spentBy, id]);
        return id;
      }
      const { rows } = await store.pool.query(
        `INSERT INTO pc_transactions (txn_date, kind, amount_cents, description, category, spent_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [vals.txnDate, vals.kind, vals.amountCents, vals.description, vals.category, vals.spentBy]);
      return rows[0].id;
    }
    if (id) {
      const t = store.data.transactions.find(x => x.id === id);
      if (t) Object.assign(t, vals);
      saveFile();
      return id;
    }
    const nid = store.data.nextTxnId++;
    store.data.transactions.push({
      id: nid, ...vals, hasReceipt: false, receiptLegacy: false,
      receiptMime: null, receiptData: null, createdAt: new Date().toISOString(),
    });
    saveFile();
    return nid;
  }

  async function deleteTransaction(id) {
    if (store.mode === 'pg') {
      await store.pool.query('DELETE FROM pc_transactions WHERE id=$1', [id]);
    } else {
      store.data.transactions = store.data.transactions.filter(t => t.id !== id);
      saveFile();
    }
  }

  async function saveReceipt(id, mime, buffer) {
    if (store.mode === 'pg') {
      await store.pool.query(
        `INSERT INTO pc_receipts (txn_id, mime, data) VALUES ($1,$2,$3)
         ON CONFLICT (txn_id) DO UPDATE SET mime=EXCLUDED.mime, data=EXCLUDED.data`,
        [id, mime, buffer]);
      await store.pool.query('UPDATE pc_transactions SET has_receipt=1, receipt_legacy=0 WHERE id=$1', [id]);
    } else {
      const t = store.data.transactions.find(x => x.id === id);
      if (!t) throw new Error('Entry not found');
      t.hasReceipt = true; t.receiptLegacy = false;
      t.receiptMime = mime; t.receiptData = buffer.toString('base64');
      saveFile();
    }
  }

  async function getReceipt(id) {
    if (store.mode === 'pg') {
      const { rows } = await store.pool.query('SELECT mime, data FROM pc_receipts WHERE txn_id=$1', [id]);
      if (!rows.length) return null;
      return { mime: rows[0].mime, data: rows[0].data };
    }
    const t = store.data.transactions.find(x => x.id === id);
    if (!t || !t.receiptData) return null;
    return { mime: t.receiptMime || 'image/jpeg', data: Buffer.from(t.receiptData, 'base64') };
  }

  async function recordAudit(body) {
    const countedCents = toCents(body.countedAmount);
    const countedBy = String(body.countedBy || '').trim();
    const note = String(body.note || '').trim();
    const state = await getState();
    const expectedCents = state.balanceCents;
    const differenceCents = countedCents - expectedCents;
    const now = new Date().toISOString();
    let id;
    if (store.mode === 'pg') {
      const { rows } = await store.pool.query(
        `INSERT INTO pc_audits (counted_cents, expected_cents, difference_cents, counted_by, note, created_at)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [countedCents, expectedCents, differenceCents, countedBy, note, now]);
      id = rows[0].id;
    } else {
      id = store.data.nextAuditId++;
      store.data.audits.push({ id, countedCents, expectedCents, differenceCents, countedBy, note, createdAt: now });
      saveFile();
    }
    const audit = { id, countedCents, expectedCents, differenceCents, countedBy, note, createdAt: now };
    return { ...audit, status: auditStatus(audit) };
  }

  // ---------------- statement builder ----------------
  async function buildStatement(from, to) {
    const { fund, standingStatementNote } = await getFund();
    const all = await listTransactions();
    const audits = await listAudits();
    const f = validDate(from) ? from : (all.length ? all[0].txnDate : todayET());
    const t = validDate(to) ? to : todayET();
    let opening = fund.startingBalanceCents;
    for (const x of all) if (x.txnDate < f) opening += signed(x);
    const period = all.filter(x => x.txnDate >= f && x.txnDate <= t);
    let added = 0, spent = 0;
    for (const x of period) {
      if (x.kind === 'addition') added += x.amountCents; else spent += x.amountCents;
    }
    const closing = opening + added - spent;
    let running = opening;
    const lines = period.map(x => { running += signed(x); return { ...x, runningBalanceCents: running }; });
    const auditsInPeriod = audits.filter(a => { const d = etDateStr(a.createdAt); return d >= f && d <= t; })
      .map(a => ({ ...a, status: auditStatus(a) }));
    return {
      fund, standingStatementNote, from: f, to: t,
      openingBalanceCents: opening, closingBalanceCents: closing,
      totalAddedCents: added, totalSpentCents: spent,
      transactions: lines, audits: auditsInPeriod,
    };
  }

  // Token-protected statement feed for the Monday email job. Registered before
  // the hub auth middleware: it answers to the token, not the sign-in cookie.
  router.get('/api/statement.json', async (req, res) => {
    if (!reportToken || req.query.token !== reportToken) return res.status(403).json({ error: 'Forbidden' });
    const state = await getState();
    const period = validDate(req.query.from) || validDate(req.query.to)
      ? await buildStatement(req.query.from, req.query.to) : null;
    res.json({
      generatedAt: new Date().toISOString(),
      fund: state.fund,
      standingStatementNote: state.standingStatementNote,
      balanceCents: state.balanceCents,
      totalAddedCents: state.totalAddedCents,
      totalSpentCents: state.totalSpentCents,
      transactions: state.transactions,
      audits: state.audits,
      statement: period,
    });
  });

  router.use(requireAuth);

  // ---------------- api ----------------
  router.get('/api/state', async (req, res) => res.json(await getState()));
  router.post('/api/note', async (req, res) => {
    try {
      const standingStatementNote = await setStandingNote(req.body.standingStatementNote);
      res.json({ ok: true, standingStatementNote });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.post('/api/transaction', async (req, res) => {
    try {
      const id = await upsertTransaction(req.body, req.body.id ? Number(req.body.id) : null);
      res.json({ ok: true, id });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.post('/api/transaction/delete', async (req, res) => {
    await deleteTransaction(Number(req.body.id));
    res.json({ ok: true });
  });
  router.post('/api/receipt', async (req, res) => {
    try {
      const id = Number(req.body.id);
      const m = /^data:([^;]+);base64,(.+)$/.exec(String(req.body.dataUrl || ''));
      if (!id || !m) return res.status(400).json({ error: 'Bad receipt upload' });
      await saveReceipt(id, m[1], Buffer.from(m[2], 'base64'));
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.get('/receipt/:id', async (req, res) => {
    const r = await getReceipt(Number(req.params.id));
    if (!r) return res.status(404).send('No receipt photo stored for this entry.');
    res.setHeader('Content-Type', r.mime);
    res.send(r.data);
  });
  router.post('/api/audit', async (req, res) => {
    try { res.json({ ok: true, audit: await recordAudit(req.body) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.get('/api/statement', async (req, res) => {
    res.json(await buildStatement(req.query.from, req.query.to));
  });

  // ---------------- exports ----------------
  function csvEscape(v) {
    const s = String(v === null || v === undefined ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  router.get('/export/transactions.csv', async (req, res) => {
    const st = await buildStatement(req.query.from, req.query.to);
    const rows = [['Date', 'Kind', 'Description', 'Category', 'Spent by', 'Amount', 'Running balance', 'Receipt']];
    for (const t of st.transactions) {
      rows.push([
        t.txnDate, t.kind === 'addition' ? 'Addition' : 'Expense', t.description, t.category, t.spentBy || '',
        ((t.kind === 'addition' ? 1 : -1) * t.amountCents / 100).toFixed(2),
        (t.runningBalanceCents / 100).toFixed(2),
        t.hasReceipt ? (t.receiptLegacy ? 'On file (previous app)' : 'Yes') : 'No',
      ]);
    }
    const csv = rows.map(r => r.map(csvEscape).join(',')).join('\n') + '\n';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="Petty-Cash-Transactions.csv"');
    res.send(csv);
  });

  router.get('/export/statement.pdf', async (req, res) => {
    const PDFDocument = require('pdfkit');
    const st = await buildStatement(req.query.from, req.query.to);
    const doc = new PDFDocument({ margin: 48 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="Petty-Cash-Statement.pdf"');
    doc.pipe(res);
    doc.fontSize(18).font('Helvetica-Bold').text(st.fund.name);
    doc.fontSize(13).font('Helvetica-Bold').text('Petty Cash Statement');
    doc.fontSize(11).font('Helvetica').text(`Period: ${st.from} to ${st.to}`);
    doc.moveDown(0.6);
    doc.text(`Opening balance: ${fmtMoney(st.openingBalanceCents)}`);
    doc.text(`Total added: ${fmtMoney(st.totalAddedCents)}`);
    doc.text(`Total spent: ${fmtMoney(st.totalSpentCents)}`);
    doc.text(`Closing balance: ${fmtMoney(st.closingBalanceCents)}`);
    if (st.standingStatementNote) { doc.moveDown(0.4); doc.font('Helvetica-Oblique').text(st.standingStatementNote); doc.font('Helvetica'); }
    doc.moveDown(1);
    for (const t of st.transactions) {
      doc.fontSize(11).font('Helvetica-Bold').text(`${t.txnDate}  ${t.description || '(no description)'}`);
      doc.fontSize(10).font('Helvetica').text(
        `${t.kind === 'addition' ? 'Addition' : 'Expense'} ${fmtMoney(t.amountCents)}` +
        `${t.category ? '  ·  ' + t.category : ''}${t.spentBy ? '  ·  ' + t.spentBy : ''}` +
        `  ·  Balance ${fmtMoney(t.runningBalanceCents)}` +
        `${t.hasReceipt ? (t.receiptLegacy ? '  ·  Receipt on file (photo in previous app)' : '  ·  Receipt attached') : ''}`);
      doc.moveDown(0.4);
    }
    if (!st.transactions.length) doc.fontSize(11).font('Helvetica').text('No entries in this period.');
    if (st.audits.length) {
      doc.moveDown(0.8);
      doc.fontSize(13).font('Helvetica-Bold').text('Cash audits in this period');
      doc.moveDown(0.3);
      for (const a of st.audits) {
        doc.fontSize(10).font('Helvetica').text(
          `${etDateStr(a.createdAt)}: counted ${fmtMoney(a.countedCents)}, expected ${fmtMoney(a.expectedCents)}, ` +
          `${a.status} by ${fmtMoney(Math.abs(a.differenceCents))}${a.countedBy ? '  ·  Counted by ' + a.countedBy : ''}${a.note ? '  ·  ' + a.note : ''}`);
        doc.moveDown(0.3);
      }
    }
    // Append receipt photos stored in this app, labelled by date and amount.
    for (const t of st.transactions) {
      if (!t.hasReceipt || t.receiptLegacy) continue;
      const r = await getReceipt(t.id);
      if (!r || !/^image\/(jpeg|png)$/.test(r.mime)) continue;
      doc.addPage();
      doc.fontSize(12).font('Helvetica-Bold').text(`Receipt: ${t.txnDate}, ${fmtMoney(t.amountCents)}`);
      doc.fontSize(10).font('Helvetica').text(t.description || '');
      doc.moveDown(0.5);
      try { doc.image(r.data, { fit: [450, 560], align: 'center' }); } catch (e) { /* skip unreadable image */ }
    }
    doc.end();
  });

  router.get('/export/statement.xlsx', async (req, res) => {
    const ExcelJS = require('exceljs');
    const st = await buildStatement(req.query.from, req.query.to);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Statement');
    ws.addRow([st.fund.name]);
    ws.addRow(['Petty Cash Statement']);
    ws.addRow(['Period', `${st.from} to ${st.to}`]);
    ws.addRow(['Opening balance', st.openingBalanceCents / 100]);
    ws.addRow(['Total added', st.totalAddedCents / 100]);
    ws.addRow(['Total spent', st.totalSpentCents / 100]);
    ws.addRow(['Closing balance', st.closingBalanceCents / 100]);
    if (st.standingStatementNote) ws.addRow([st.standingStatementNote]);
    ws.addRow([]);
    ws.addRow(['Date', 'Kind', 'Description', 'Category', 'Spent by', 'Amount', 'Running balance', 'Receipt']);
    for (const t of st.transactions) {
      ws.addRow([
        t.txnDate, t.kind === 'addition' ? 'Addition' : 'Expense', t.description, t.category, t.spentBy || '',
        (t.kind === 'addition' ? 1 : -1) * t.amountCents / 100, t.runningBalanceCents / 100,
        t.hasReceipt ? (t.receiptLegacy ? 'On file (previous app)' : 'Yes') : 'No',
      ]);
    }
    if (st.audits.length) {
      ws.addRow([]);
      ws.addRow(['Cash audits']);
      ws.addRow(['Date', 'Counted', 'Expected', 'Difference', 'Result', 'Counted by', 'Note']);
      for (const a of st.audits) {
        ws.addRow([etDateStr(a.createdAt), a.countedCents / 100, a.expectedCents / 100, a.differenceCents / 100, a.status, a.countedBy, a.note]);
      }
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Petty-Cash-Statement.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  });

  // ---------------- app shell ----------------
  router.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'cash', 'index.html')));
  router.use(express.static(path.join(__dirname, '..', 'public', 'cash')));

  return { router, ready: init() };
}

module.exports = { createCash };
