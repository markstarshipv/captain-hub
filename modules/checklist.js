// Checklist module for the Captain Spurling hub.
// One factory builds each of the boat's checklists: the Post-Trip
// Checklist at /posttrip (ported 2026-11-13 from the Muse app at Mark's
// direction), plus the Departure Checklist at /departure and the Fuelling
// Checklist at /fuelling (added 2026-11-13 from the paper lists kept
// aboard, split from the close-out list at Mark's direction: Shutdown and
// Bathrooms folded into /posttrip, Departure and Fuelling stand alone).
// Behavior: an editable task list grouped in sections, one open run at a
// time, finished runs kept as history with the count of tasks checked.
// Postgres tables are prefixed per checklist (ck_ for posttrip, keeping
// the original tables; ck_dep_ and ck_fuel_ for the new ones); with no
// pool each instance falls back to its own JSON file under data/.
// Seeds are versioned: when a seed's version rises, init reconciles the
// stored list to it, adding new tasks by title, retiring the titles the
// seed names, refreshing notes, and re-applying the seed's section and
// task order. Runs and history are never touched by a reconcile, and
// tasks added by hand in the app survive it (they sort after the seeded
// tasks in their section).
'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');

function createChecklist({ pool, dataFile, requireAuth, reportToken }, cfg) {
  const seed = cfg.seed;
  const META = cfg.tablePrefix + 'meta';
  const TASKS = cfg.tablePrefix + 'tasks';
  const RUNS = cfg.tablePrefix + 'runs';
  const router = express.Router();
  let store;

  async function pgGetMeta(key) {
    const { rows } = await pool.query(`SELECT value FROM ${META} WHERE key=$1`, [key]);
    return rows.length ? rows[0].value : null;
  }
  async function pgSetMeta(key, value) {
    await pool.query(
      `INSERT INTO ${META} (key, value) VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [key, value]);
  }

  async function seedFresh() {
    if (pool) {
      await pgSetMeta('section_order', JSON.stringify(seed.sections));
      let pos = {};
      for (const t of seed.tasks) {
        const position = (pos[t.section] = (pos[t.section] || 0) + 1) - 1;
        await pool.query(
          `INSERT INTO ${TASKS} (section, title, note, position) VALUES ($1,$2,$3,$4)`,
          [t.section, t.title, t.note || '', position]);
      }
      await pgSetMeta('seeded', 'true');
      await pgSetMeta('seed_version', String(seed.version || 1));
      return;
    }
    let pos = {};
    store.data = {
      sectionOrder: [...seed.sections],
      seedVersion: seed.version || 1,
      nextTaskId: seed.tasks.length + 1,
      nextRunId: 1,
      tasks: seed.tasks.map((t, i) => ({
        id: i + 1, section: t.section, title: t.title, note: t.note || '',
        position: (pos[t.section] = (pos[t.section] || 0) + 1) - 1,
      })),
      runs: [],
    };
    saveFile();
  }

  // Raw task writes used by the seed reconcile (the API layer below has
  // its own user-facing versions).
  async function insertTaskRaw(t, position) {
    if (store.mode === 'pg') {
      const { rows } = await store.pool.query(
        `INSERT INTO ${TASKS} (section, title, note, position) VALUES ($1,$2,$3,$4) RETURNING id`,
        [t.section, t.title, t.note || '', position]);
      return rows[0].id;
    }
    const id = store.data.nextTaskId++;
    store.data.tasks.push({ id, section: t.section, title: t.title, note: t.note || '', position });
    saveFile();
    return id;
  }
  async function updateTaskRaw(id, t) {
    if (store.mode === 'pg') {
      await store.pool.query(
        `UPDATE ${TASKS} SET section=$1, title=$2, note=$3 WHERE id=$4`,
        [t.section, t.title, t.note || '', id]);
      return;
    }
    const x = store.data.tasks.find(y => y.id === id);
    if (x) { x.section = t.section; x.title = t.title; x.note = t.note || ''; saveFile(); }
  }
  async function setPositionRaw(id, position) {
    if (store.mode === 'pg') {
      await store.pool.query(`UPDATE ${TASKS} SET position=$1 WHERE id=$2`, [position, id]);
      return;
    }
    const x = store.data.tasks.find(y => y.id === id);
    if (x) { x.position = position; saveFile(); }
  }

  async function reconcile() {
    const order = await getSectionOrder();
    await setSectionOrder([...seed.sections, ...order.filter(s => !seed.sections.includes(s))]);
    let tasks = await listTasks();
    for (const title of seed.retire || []) {
      const t = tasks.find(x => x.title === title);
      if (t) {
        await deleteTask(t.id);
        tasks = tasks.filter(x => x.id !== t.id);
      }
    }
    for (const st of seed.tasks) {
      const ex = tasks.find(x => x.title === st.title);
      if (ex) {
        if (ex.section !== st.section || (ex.note || '') !== (st.note || '')) {
          await updateTaskRaw(ex.id, st);
          ex.section = st.section;
          ex.note = st.note || '';
        }
      } else {
        const id = await insertTaskRaw(st, 0);
        tasks.push({ id, section: st.section, title: st.title, note: st.note || '', position: 0 });
      }
    }
    const seedTitles = new Set(seed.tasks.map(t => t.title));
    const sections = new Set(tasks.map(t => t.section));
    for (const s of sections) {
      const inSection = tasks.filter(t => t.section === s);
      const seeded = seed.tasks.filter(t => t.section === s)
        .map(st => inSection.find(t => t.title === st.title)).filter(Boolean);
      const extra = inSection.filter(t => !seedTitles.has(t.title))
        .sort((a, b) => (a.position - b.position) || (a.id - b.id));
      const ordered = [...seeded, ...extra];
      for (let i = 0; i < ordered.length; i++) {
        if (ordered[i].position !== i) await setPositionRaw(ordered[i].id, i);
      }
    }
    if (store.mode === 'pg') await pgSetMeta('seed_version', String(seed.version || 1));
    else { store.data.seedVersion = seed.version || 1; saveFile(); }
  }

  async function init() {
    if (pool) {
      await pool.query(`CREATE TABLE IF NOT EXISTS ${META} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS ${TASKS} (
        id SERIAL PRIMARY KEY,
        section TEXT NOT NULL,
        title TEXT NOT NULL,
        note TEXT DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS ${RUNS} (
        id SERIAL PRIMARY KEY,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at TIMESTAMPTZ,
        closed_by TEXT DEFAULT '',
        note TEXT DEFAULT '',
        checked_ids TEXT DEFAULT '[]',
        total_count INTEGER
      )`);
      store = { mode: 'pg', pool };
      if (!(await pgGetMeta('seeded'))) await seedFresh();
      else if (Number((await pgGetMeta('seed_version')) || 1) < (seed.version || 1)) await reconcile();
    } else {
      store = { mode: 'file', file: dataFile, data: null };
      if (fs.existsSync(dataFile)) {
        store.data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
        if (Number(store.data.seedVersion || 1) < (seed.version || 1)) await reconcile();
      } else {
        await seedFresh();
      }
    }
  }

  function saveFile() {
    if (store.mode === 'file') fs.writeFileSync(store.file, JSON.stringify(store.data, null, 1));
  }

  async function getSectionOrder() {
    if (store.mode === 'pg') {
      const v = await pgGetMeta('section_order');
      return v ? JSON.parse(v) : [...seed.sections];
    }
    return [...store.data.sectionOrder];
  }
  async function setSectionOrder(order) {
    if (store.mode === 'pg') {
      await pgSetMeta('section_order', JSON.stringify(order));
    } else {
      store.data.sectionOrder = order;
      saveFile();
    }
  }

  function rowToTask(r) {
    return {
      id: r.id,
      section: r.section,
      title: r.title,
      note: r.note || '',
      position: Number(r.position),
    };
  }
  function rowToRun(r) {
    const checked = JSON.parse(r.checked_ids || '[]');
    return {
      id: r.id,
      startedAt: r.started_at instanceof Date ? r.started_at.toISOString() : r.started_at,
      finishedAt: r.finished_at ? (r.finished_at instanceof Date ? r.finished_at.toISOString() : r.finished_at) : null,
      closedBy: r.closed_by || '',
      note: r.note || '',
      checkedTaskIds: checked,
      checkedCount: checked.length,
      totalCount: r.total_count === null || r.total_count === undefined ? null : Number(r.total_count),
    };
  }

  async function listTasks() {
    if (store.mode === 'pg') {
      const { rows } = await store.pool.query(`SELECT * FROM ${TASKS} ORDER BY id ASC`);
      return rows.map(rowToTask);
    }
    return [...store.data.tasks].map(rowToTask);
  }
  async function listRuns() {
    if (store.mode === 'pg') {
      const { rows } = await store.pool.query(`SELECT * FROM ${RUNS} ORDER BY id ASC`);
      return rows.map(rowToRun);
    }
    return [...store.data.runs].map(r => ({ ...r }));
  }

  function sortTasks(tasks, sectionOrder) {
    const orderIdx = s => {
      const i = sectionOrder.indexOf(s);
      return i === -1 ? sectionOrder.length + 1 : i;
    };
    return [...tasks].sort((a, b) =>
      (orderIdx(a.section) - orderIdx(b.section)) ||
      (a.position - b.position) || (a.id - b.id));
  }

  async function getState() {
    const sectionOrder = await getSectionOrder();
    const tasks = sortTasks(await listTasks(), sectionOrder);
    const runs = await listRuns();
    const open = runs.filter(r => !r.finishedAt).sort((a, b) => b.id - a.id)[0] || null;
    const history = runs.filter(r => r.finishedAt)
      .sort((a, b) => new Date(b.finishedAt) - new Date(a.finishedAt))
      .slice(0, 30)
      .map(r => ({
        id: r.id, finishedAt: r.finishedAt, closedBy: r.closedBy, note: r.note,
        checkedCount: (r.checkedTaskIds || []).length, totalCount: r.totalCount,
      }));
    return {
      sections: sectionOrder,
      tasks,
      openRun: open ? { id: open.id, startedAt: open.startedAt, checkedTaskIds: open.checkedTaskIds } : null,
      history,
    };
  }

  async function upsertTask(body, id) {
    const section = String(body.section || '').trim();
    const title = String(body.title || '').trim();
    if (!section) throw new Error('Section is required');
    if (!title) throw new Error('Task title is required');
    const note = String(body.note || '').trim();
    const order = await getSectionOrder();
    if (!order.includes(section)) {
      order.push(section);
      await setSectionOrder(order);
    }
    if (store.mode === 'pg') {
      if (id) {
        const { rows } = await store.pool.query(`SELECT section FROM ${TASKS} WHERE id=$1`, [id]);
        if (!rows.length) throw new Error('Task not found');
        if (rows[0].section !== section) {
          const { rows: m } = await store.pool.query(
            `SELECT COALESCE(MAX(position),-1) AS mp FROM ${TASKS} WHERE section=$1`, [section]);
          await store.pool.query(
            `UPDATE ${TASKS} SET section=$1, title=$2, note=$3, position=$4 WHERE id=$5`,
            [section, title, note, m[0].mp + 1, id]);
        } else {
          await store.pool.query(
            `UPDATE ${TASKS} SET section=$1, title=$2, note=$3 WHERE id=$4`,
            [section, title, note, id]);
        }
        return id;
      }
      const { rows: m } = await store.pool.query(
        `SELECT COALESCE(MAX(position),-1) AS mp FROM ${TASKS} WHERE section=$1`, [section]);
      const { rows } = await store.pool.query(
        `INSERT INTO ${TASKS} (section, title, note, position) VALUES ($1,$2,$3,$4) RETURNING id`,
        [section, title, note, m[0].mp + 1]);
      return rows[0].id;
    }
    if (id) {
      const t = store.data.tasks.find(x => x.id === id);
      if (!t) throw new Error('Task not found');
      if (t.section !== section) {
        t.position = Math.max(-1, ...store.data.tasks.filter(x => x.section === section).map(x => x.position)) + 1;
        t.section = section;
      }
      t.title = title;
      t.note = note;
      saveFile();
      return id;
    }
    const nid = store.data.nextTaskId++;
    const position = Math.max(-1, ...store.data.tasks.filter(x => x.section === section).map(x => x.position)) + 1;
    store.data.tasks.push({ id: nid, section, title, note, position });
    saveFile();
    return nid;
  }

  async function deleteTask(id) {
    if (store.mode === 'pg') {
      await store.pool.query(`DELETE FROM ${TASKS} WHERE id=$1`, [id]);
      const st = await getState();
      if (st.openRun && st.openRun.checkedTaskIds.includes(id)) {
        const ids = st.openRun.checkedTaskIds.filter(x => x !== id);
        await store.pool.query(`UPDATE ${RUNS} SET checked_ids=$1 WHERE id=$2`,
          [JSON.stringify(ids), st.openRun.id]);
      }
      return;
    }
    store.data.tasks = store.data.tasks.filter(t => t.id !== id);
    const open = store.data.runs.find(r => !r.finishedAt);
    if (open) open.checkedTaskIds = open.checkedTaskIds.filter(x => x !== id);
    saveFile();
  }

  async function moveTask(id, dir) {
    const sectionOrder = await getSectionOrder();
    const tasks = sortTasks(await listTasks(), sectionOrder);
    const t = tasks.find(x => x.id === id);
    if (!t) throw new Error('Task not found');
    const sibs = tasks.filter(x => x.section === t.section);
    const i = sibs.findIndex(x => x.id === id);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= sibs.length) return;
    const a = sibs[i], b = sibs[j];
    if (store.mode === 'pg') {
      await store.pool.query(`UPDATE ${TASKS} SET position=$1 WHERE id=$2`, [b.position, a.id]);
      await store.pool.query(`UPDATE ${TASKS} SET position=$1 WHERE id=$2`, [a.position, b.id]);
    } else {
      const ta = store.data.tasks.find(x => x.id === a.id);
      const tb = store.data.tasks.find(x => x.id === b.id);
      const p = ta.position; ta.position = tb.position; tb.position = p;
      saveFile();
    }
  }

  async function startRun() {
    const now = new Date().toISOString();
    if (store.mode === 'pg') {
      await store.pool.query(`DELETE FROM ${RUNS} WHERE finished_at IS NULL`);
      const { rows } = await store.pool.query(
        `INSERT INTO ${RUNS} (started_at) VALUES ($1) RETURNING id`, [now]);
      return rows[0].id;
    }
    store.data.runs = store.data.runs.filter(r => r.finishedAt);
    const id = store.data.nextRunId++;
    store.data.runs.push({
      id, startedAt: now, finishedAt: null, closedBy: '', note: '',
      checkedTaskIds: [], totalCount: null,
    });
    saveFile();
    return id;
  }

  async function toggleTask(taskId) {
    const st = await getState();
    if (!st.openRun) throw new Error('No run is open');
    let ids = [...st.openRun.checkedTaskIds];
    ids = ids.includes(taskId) ? ids.filter(x => x !== taskId) : [...ids, taskId];
    if (store.mode === 'pg') {
      await store.pool.query(`UPDATE ${RUNS} SET checked_ids=$1 WHERE id=$2`,
        [JSON.stringify(ids), st.openRun.id]);
    } else {
      const run = store.data.runs.find(r => r.id === st.openRun.id);
      run.checkedTaskIds = ids;
      saveFile();
    }
    return ids;
  }

  async function finishRun(body) {
    const st = await getState();
    if (!st.openRun) throw new Error('No run is open');
    const closedBy = String(body.closedBy || '').trim();
    const note = String(body.note || '').trim();
    const now = new Date().toISOString();
    const total = st.tasks.length;
    if (store.mode === 'pg') {
      await store.pool.query(
        `UPDATE ${RUNS} SET finished_at=$1, closed_by=$2, note=$3, total_count=$4 WHERE id=$5`,
        [now, closedBy, note, total, st.openRun.id]);
    } else {
      const run = store.data.runs.find(r => r.id === st.openRun.id);
      run.finishedAt = now;
      run.closedBy = closedBy;
      run.note = note;
      run.totalCount = total;
      saveFile();
    }
    return st.openRun.id;
  }

  async function cancelRun() {
    if (store.mode === 'pg') {
      await store.pool.query(`DELETE FROM ${RUNS} WHERE finished_at IS NULL`);
    } else {
      store.data.runs = store.data.runs.filter(r => r.finishedAt);
      saveFile();
    }
  }

  // Token-protected run feed (the Monday maintenance report reads the
  // post-trip instance's feed). Registered before the hub auth
  // middleware, like the other modules: it answers to the token, not
  // the sign-in cookie.
  router.get('/api/report.json', async (req, res) => {
    if (!reportToken || req.query.token !== reportToken) return res.status(403).json({ error: 'Forbidden' });
    const st = await getState();
    res.json({ generatedAt: new Date().toISOString(), closeouts: st.history });
  });

  router.use(requireAuth);

  // ---------------- api ----------------
  router.get('/api/state', async (req, res) => res.json(await getState()));
  router.post('/api/task', async (req, res) => {
    try {
      const id = await upsertTask(req.body, req.body.id ? Number(req.body.id) : null);
      res.json({ ok: true, id });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.post('/api/task/delete', async (req, res) => {
    await deleteTask(Number(req.body.id));
    res.json({ ok: true });
  });
  router.post('/api/task/move', async (req, res) => {
    try {
      await moveTask(Number(req.body.id), req.body.dir === 'up' ? 'up' : 'down');
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.post('/api/run/start', async (req, res) => {
    const id = await startRun();
    res.json({ ok: true, id });
  });
  router.post('/api/run/toggle', async (req, res) => {
    try {
      const checkedTaskIds = await toggleTask(Number(req.body.taskId));
      res.json({ ok: true, checkedTaskIds });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.post('/api/run/finish', async (req, res) => {
    try {
      const id = await finishRun(req.body);
      res.json({ ok: true, id });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.post('/api/run/cancel', async (req, res) => {
    await cancelRun();
    res.json({ ok: true });
  });

  // ---------------- app shell ----------------
  router.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', cfg.page, 'index.html')));
  router.use(express.static(path.join(__dirname, '..', 'public', cfg.page)));

  return { router, ready: init() };
}

module.exports = { createChecklist };
