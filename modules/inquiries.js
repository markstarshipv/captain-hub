// Legacy Yacht inquiry form module for the Captain Spurling hub.
// The public form on /about-legacy-yacht posts to POST /api/inquiry here
// instead of a third-party form service (FormSubmit's activation and
// delivery mail never reached mark@spurling.net in November 2026).
// Every submission is STORED FIRST (Postgres table hub_inquiries, or a JSON
// file in local mode), then emailed to Mark with Shahzain cc'd through the
// hub's own Gmail SMTP login, so a mail failure can never lose an inquiry.
// Credentials come from the environment only: GMAIL_USER (defaults to
// n4128r@gmail.com) and GMAIL_APP_PASSWORD (a Google App Password Mark sets
// in the Render dashboard; never stored in code or in chat).
// The stored list is readable at GET /api/inquiries.json?token=<REPORT_TOKEN>,
// the same token pattern as the Monday report feeds.
'use strict';
const express = require('express');
const fs = require('fs');

const TO = 'mark@spurling.net';
const CC = 'shahzain@gmail.com';
const SUBJECT = 'Legacy Yacht inquiry from captain.spurling.net';
const TZ = 'America/New_York';

// Header-bound fields get newlines stripped so a visitor cannot inject
// extra mail headers through the name or email they type.
function clean(v, max) {
  return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}
function validEmail(s) { return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s); }
function etStamp(iso) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(iso));
}

function createInquiries({ pool, dataFile, reportToken }) {
  const router = express.Router();
  let fileRows = null;

  async function init() {
    if (pool) {
      await pool.query(`CREATE TABLE IF NOT EXISTS hub_inquiries (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL,
        emailed BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    } else {
      try { fileRows = JSON.parse(fs.readFileSync(dataFile, 'utf8')); }
      catch { fileRows = []; }
      if (!Array.isArray(fileRows)) fileRows = [];
    }
  }
  const ready = init();

  function saveFile() { fs.writeFileSync(dataFile, JSON.stringify(fileRows, null, 2)); }

  async function store(row) {
    if (pool) {
      const { rows } = await pool.query(
        'INSERT INTO hub_inquiries (name, email, phone, message) VALUES ($1,$2,$3,$4) RETURNING id',
        [row.name, row.email, row.phone, row.message]
      );
      return rows[0].id;
    }
    const id = fileRows.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;
    fileRows.push({ id, ...row, emailed: false, created_at: new Date().toISOString() });
    saveFile();
    return id;
  }

  async function markEmailed(id) {
    if (pool) {
      await pool.query('UPDATE hub_inquiries SET emailed = true WHERE id = $1', [id]);
    } else {
      const r = fileRows.find(x => x.id === id);
      if (r) { r.emailed = true; saveFile(); }
    }
  }

  async function list(limit) {
    if (pool) {
      const { rows } = await pool.query(
        'SELECT id, name, email, phone, message, emailed, created_at FROM hub_inquiries ORDER BY id DESC LIMIT $1',
        [limit]
      );
      return rows;
    }
    return [...fileRows].sort((a, b) => b.id - a.id).slice(0, limit);
  }

  // ---- mail: Gmail SMTP with an App Password, created lazily ----
  let transporter = null;
  function mailer() {
    const pass = process.env.GMAIL_APP_PASSWORD || '';
    if (!pass) return null;
    if (!transporter) {
      const user = process.env.GMAIL_USER || 'n4128r@gmail.com';
      const nodemailer = require('nodemailer');
      transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com', port: 465, secure: true,
        auth: { user, pass },
      });
      transporter._fromUser = user;
    }
    return transporter;
  }

  async function sendMail(row) {
    const t = mailer();
    if (!t) { console.log('inquiry stored, mail skipped: GMAIL_APP_PASSWORD not set'); return false; }
    const lines = [
      'New inquiry from the Legacy Yacht page on captain.spurling.net',
      '',
      'Name: ' + row.name,
      'Email: ' + row.email,
      'Phone: ' + (row.phone || '(not given)'),
      'Received: ' + etStamp(row.created_at || new Date().toISOString()),
      '',
      'Message:',
      row.message,
    ];
    await t.sendMail({
      from: '"Legacy Yacht inquiry" <' + t._fromUser + '>',
      replyTo: row.email,
      to: TO,
      cc: CC,
      subject: SUBJECT,
      text: lines.join('\n'),
    });
    return true;
  }

  // ---- tiny in-memory rate limit: 5 submissions per IP per 10 minutes ----
  const hits = new Map();
  function rateLimited(ip) {
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
    arr.push(now);
    hits.set(ip, arr);
    return arr.length > 5;
  }

  router.post('/api/inquiry', async (req, res) => {
    try {
      const b = req.body || {};
      // Honeypot: real visitors never see or fill the "company" field.
      // Bots that fill it get a polite success and nothing is stored.
      if (String(b.company || '').trim() !== '') return res.json({ ok: true });
      if (rateLimited(req.ip || 'unknown')) {
        return res.status(429).json({ ok: false, error: 'Too many submissions. Please wait a few minutes.' });
      }
      const row = {
        name: clean(b.name, 120),
        email: clean(b.email, 254),
        phone: clean(b.phone, 40),
        message: String(b.message == null ? '' : b.message).trim().slice(0, 4000),
        created_at: new Date().toISOString(),
      };
      if (!row.name || !validEmail(row.email) || !row.message) {
        return res.status(400).json({ ok: false, error: 'Please include your name, a valid email, and a message.' });
      }
      let id = null;
      try { id = await store(row); }
      catch (e) { console.error('inquiry store failed', e); }
      let sent = false;
      try { sent = await sendMail(row); } catch (e) { console.error('inquiry mail failed', e); }
      if (sent && id != null) {
        try { await markEmailed(id); } catch (e) { console.error('inquiry markEmailed failed', e); }
      }
      if (id == null && !sent) return res.status(500).json({ ok: false, error: 'Send failed' });
      return res.json({ ok: true });
    } catch (e) {
      console.error('inquiry handler failed', e);
      return res.status(500).json({ ok: false, error: 'Send failed' });
    }
  });

  router.get('/api/inquiries.json', async (req, res) => {
    if (!reportToken || req.query.token !== reportToken) {
      return res.status(401).json({ error: 'Bad token' });
    }
    try { return res.json({ inquiries: await list(100) }); }
    catch (e) { console.error('inquiry list failed', e); return res.status(500).json({ error: 'List failed' }); }
  });

  return { router, ready };
}

module.exports = { createInquiries };
