'use strict';
// Before We Leave: one pre-trip screen. The top panel is read-only and
// auto-pulled (Departure checklist progress, tracker items that affect
// departure); the list below is the manual attention list, grouped by
// category, each item owned by someone and stamped when checked off.
const $ = id => document.getElementById(id);
const BASE = location.pathname.replace(/\/+$/, '');
let state = null;
let showDone = false;

async function api(path, body) {
  const opts = { headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) { opts.method = 'POST'; opts.body = JSON.stringify(body); }
  const r = await fetch(BASE + path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}
function escapeHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtDateTime(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(new Date(iso));
}
function fmtTime(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit',
  }).format(new Date(iso));
}
function fmtDate(dstr) {
  if (!dstr) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric',
  }).format(new Date(dstr + 'T12:00:00Z'));
}
function personName() {
  const el = $('personName');
  const v = el ? el.value.trim() : '';
  return v || (localStorage.getItem('ckPerson') || '');
}

async function load() {
  state = await api('/api/board');
  render();
}

function renderDeparture() {
  const box = $('departureBox');
  const d = state.departure;
  if (!d) {
    box.innerHTML = '<div class="empty">Departure checklist status is not available right now. <a class="golink" href="/departure">Open the Departure Checklist</a></div>';
    return;
  }
  if (!d.open) {
    box.innerHTML = `<div style="font-size:15px"><strong>Departure checklist:</strong> no run open yet, ${d.total} tasks on the list.</div>
      <div style="margin-top:6px"><a class="golink" href="/departure">Open the Departure Checklist &#8250;</a></div>`;
    return;
  }
  const pct = d.total ? Math.round(d.done * 100 / d.total) : 0;
  box.innerHTML = `<div style="font-size:15px"><strong>Departure checklist:</strong> ${d.done} of ${d.total} done, started ${escapeHtml(fmtDateTime(d.startedAt))}</div>
    <div class="progress"><div class="fill" style="width:${pct}%"></div></div>
    <div style="margin-top:6px"><a class="golink" href="/departure">Open the Departure Checklist &#8250;</a></div>`;
}

function statusBadge(it) {
  if (it.status === 'overdue') {
    return `<span class="badge overdue">Overdue${it.daysUntil !== null ? ' by ' + Math.abs(it.daysUntil) + 'd' : ''}</span>`;
  }
  if (it.status === 'due_soon') {
    return `<span class="badge due_soon">Due ${it.daysUntil === 0 ? 'today' : 'in ' + it.daysUntil + 'd'}</span>`;
  }
  if (it.category === 'Repairs') return '<span class="badge repairs">Repairs</span>';
  return '';
}
function statusMeta(it) {
  const bits = [escapeHtml(it.category)];
  if (it.nextDue) bits.push('next due ' + fmtDate(it.nextDue));
  if (it.lastServicedOn) bits.push('last serviced ' + fmtDate(it.lastServicedOn));
  else if (it.status === 'not_logged') bits.push('never logged');
  return bits.join(' · ');
}

function renderMaintenance() {
  const box = $('maintenanceBox');
  const items = state.maintenance || [];
  let html = '<div style="font-size:15px"><strong>Maintenance that affects departure</strong></div>';
  if (!items.length) {
    html += '<div class="empty">Nothing overdue, nothing due this week, and no open repairs on the tracker.</div>';
  } else {
    html += items.map(it => `<div class="mrow">
      <div>
        <div class="mtitle">${escapeHtml(it.name)}${statusBadge(it)}</div>
        <div class="mmeta">${statusMeta(it)}</div>
      </div>
    </div>`).join('');
  }
  html += '<div style="margin-top:8px"><a class="golink" href="/maintenance">Open the Maintenance Tracker &#8250;</a></div>';
  box.innerHTML = html;
}

function itemRow(it) {
  return `<div class="task tappable ${it.done ? 'done' : ''}" data-id="${it.id}">
    <div class="box">${it.done ? '&#10003;' : ''}</div>
    <div>
      <div class="title">${escapeHtml(it.text)}${it.owner ? `<span class="owner">${escapeHtml(it.owner)}</span>` : ''}</div>
      ${it.done && it.doneBy ? `<div class="by">Done by ${escapeHtml(it.doneBy)}${it.doneAt ? ' · ' + escapeHtml(fmtTime(it.doneAt)) : ''}</div>` : ''}
    </div>
    <div class="tools">
      <button class="toolbtn" data-act="edit" data-id="${it.id}" type="button">Edit</button>
    </div>
  </div>`;
}

function renderItems() {
  const list = $('itemList');
  const open = state.items.filter(i => !i.done);
  let html = '';
  for (const cat of state.categories) {
    const inCat = open.filter(i => i.category === cat);
    if (!inCat.length) continue;
    html += `<h2 class="section">${escapeHtml(cat)}</h2>` + inCat.map(itemRow).join('');
  }
  const other = open.filter(i => !state.categories.includes(i.category));
  if (other.length) html += '<h2 class="section">Other</h2>' + other.map(itemRow).join('');
  if (!open.length) html = '<div class="empty">Nothing open. Everything is handled, or nothing has been added yet.</div>';
  list.innerHTML = html;
  list.querySelectorAll('.task.tappable').forEach(el => {
    el.addEventListener('click', async e => {
      if (e.target.closest('.tools')) return;
      const id = Number(el.dataset.id);
      const it = state.items.find(x => x.id === id);
      if (it && !it.done && !personName()) {
        alert('Put your name in "Who is working" at the top first, so we know who handled it.');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        const pn = $('personName');
        if (pn) pn.focus();
        return;
      }
      await api('/api/item/toggle', { id, by: personName() });
      await load();
    });
  });
  list.querySelectorAll('.toolbtn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openItemDialog(Number(btn.dataset.id));
    });
  });
}

function renderDone() {
  const box = $('doneBox');
  const done = state.items.filter(i => i.done)
    .sort((a, b) => new Date(b.doneAt || 0) - new Date(a.doneAt || 0));
  if (!done.length) { box.innerHTML = ''; return; }
  let html = `<button class="donetoggle" id="doneToggleBtn" type="button">${showDone ? 'Hide' : 'Show'} done items (${done.length})</button>`;
  if (showDone) {
    html += done.map(it => `<div class="task done" data-id="${it.id}">
      <div class="box">&#10003;</div>
      <div>
        <div class="title">${escapeHtml(it.text)}${it.owner ? `<span class="owner">${escapeHtml(it.owner)}</span>` : ''}</div>
        <div class="note">${escapeHtml(it.category)}${it.doneBy ? ' · done by ' + escapeHtml(it.doneBy) : ''}${it.doneAt ? ' · ' + escapeHtml(fmtDateTime(it.doneAt)) : ''}</div>
      </div>
      <div class="tools">
        <button class="toolbtn" data-act="reopen" data-id="${it.id}" type="button">Reopen</button>
        <button class="toolbtn" data-act="edit" data-id="${it.id}" type="button">Edit</button>
      </div>
    </div>`).join('');
  }
  box.innerHTML = html;
  const tg = $('doneToggleBtn');
  if (tg) tg.onclick = () => { showDone = !showDone; renderDone(); };
  box.querySelectorAll('.toolbtn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = Number(btn.dataset.id);
      if (btn.dataset.act === 'edit') return openItemDialog(id);
      await api('/api/item/toggle', { id, by: personName() });
      await load();
    });
  });
}

function render() {
  renderDeparture();
  renderMaintenance();
  renderItems();
  renderDone();
}

// ---- add and edit ----
function fillCategorySelects() {
  const opts = state.categories.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  $('newCategory').innerHTML = opts;
  $('i_category').innerHTML = opts;
}
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => { $('newOwner').value = chip.dataset.owner; });
});
$('addBtn').onclick = async () => {
  const text = $('newText').value.trim();
  if (!text) { $('newText').focus(); return; }
  try {
    await api('/api/item', { text, category: $('newCategory').value, owner: $('newOwner').value });
    $('newText').value = '';
    $('newOwner').value = '';
    await load();
  } catch (e) { alert(e.message); }
};
function openItemDialog(id) {
  const it = state.items.find(x => x.id === id);
  if (!it) return;
  $('i_id').value = it.id;
  $('i_text').value = it.text;
  $('i_category').value = it.category;
  $('i_owner').value = it.owner || '';
  $('itemDlg').showModal();
}
$('itemCancelBtn').onclick = () => $('itemDlg').close();
$('itemDeleteBtn').onclick = async () => {
  const id = Number($('i_id').value);
  if (!id || !confirm('Delete this item?')) return;
  await api('/api/item/delete', { id });
  $('itemDlg').close();
  await load();
};
$('itemForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/api/item', {
      id: Number($('i_id').value),
      text: $('i_text').value,
      category: $('i_category').value,
      owner: $('i_owner').value,
    });
    $('itemDlg').close();
    await load();
  } catch (err) { alert(err.message); }
});
$('personName').addEventListener('input', () => {
  localStorage.setItem('ckPerson', $('personName').value.trim());
});

load().then(() => {
  fillCategorySelects();
  const saved = localStorage.getItem('ckPerson') || '';
  if (saved) $('personName').value = saved;
}).catch(e => {
  $('departureBox').innerHTML = '<div class="empty">Could not load. ' + escapeHtml(e.message) + '</div>';
});
