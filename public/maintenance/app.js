'use strict';
const $ = id => document.getElementById(id);
let items = [], counts = null, pumps = null, hours = {}, meters = [], pumpNames = [];
let activeCat = null, attentionOnly = false;

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtNum(n) {
  if (n === null || n === undefined || n === '') return '';
  const v = Number(n);
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
}
function fmtDate(d) {
  if (!d) return 'never';
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function chipText(s) {
  return { overdue: 'Overdue', due_soon: 'Due soon', on_schedule: 'On schedule', not_logged: 'Not yet logged', no_interval: 'No interval' }[s] || s;
}
async function api(path, body) {
  const opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
  const r = await fetch(path, opts);
  if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}
async function load() {
  const data = await api('/maintenance/api/board');
  items = data.items; counts = data.counts; pumps = data.pumps;
  hours = data.hours; meters = data.meters; pumpNames = data.pumpNames || [];
  $('tileOverdue').textContent = counts.overdue;
  $('tileDueSoon').textContent = counts.dueSoon;
  $('tilePumps').textContent = pumps.checked + ' of ' + pumps.total;
  $('tileTotal').textContent = counts.total;
  renderPumpLine(); renderPills(); renderCards(); renderHours();
}
function categories() {
  const out = [];
  for (const it of items) if (!it.archived && !out.includes(it.category)) out.push(it.category);
  return out;
}
function renderPills() {
  const pills = $('pills');
  pills.innerHTML = '';
  const active = items.filter(i => !i.archived);
  const mk = (label, cat, count) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'pill' + (activeCat === cat ? ' on' : '');
    b.innerHTML = label + '<span class="c">' + count + '</span>';
    b.onclick = () => { activeCat = (activeCat === cat) ? null : cat; renderPills(); renderCards(); window.scrollTo(0, 0); };
    pills.appendChild(b);
  };
  mk('All', null, active.length);
  for (const c of categories()) mk(c, c, active.filter(i => i.category === c).length);
  const attn = active.filter(i => i.status === 'overdue' || i.status === 'due_soon').length;
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'pill' + (attentionOnly ? ' on' : '');
  b.innerHTML = 'Needs attention<span class="c">' + attn + '</span>';
  b.onclick = () => { attentionOnly = !attentionOnly; renderPills(); renderCards(); };
  pills.appendChild(b);
  const banner = $('catBanner');
  if (activeCat) { banner.classList.add('show'); $('catBannerText').textContent = 'Showing only: ' + activeCat; }
  else banner.classList.remove('show');
}
function visibleItems() {
  const q = $('search').value.trim().toLowerCase();
  const showArch = $('showArchived').checked;
  return items.filter(it => {
    if (it.archived && !showArch) return false;
    if (!it.archived && activeCat && it.category !== activeCat) return false;
    if (attentionOnly && it.status !== 'overdue' && it.status !== 'due_soon') return false;
    if (q && !it.name.toLowerCase().includes(q)) return false;
    return true;
  });
}
function renderPumpLine() {
  const wrap = $('pumpLine');
  if (!pumps || !pumps.items.length) { wrap.innerHTML = ''; return; }
  const lines = pumps.items.map(p =>
    `<div class="pump">${p.inCycle ? '&#10003;' : '&#10007;'} ${escapeHtml(p.name)}: last checked ${fmtDate(p.lastServicedOn)}${p.nextDue ? ', next due ' + fmtDate(p.nextDue) : ''}</div>`).join('');
  wrap.innerHTML = `<div class="pumpline"><div class="hd">Bilge and sump pumps: ${pumps.complete ? 'COMPLETE' : 'INCOMPLETE'}, ${pumps.checked} of ${pumps.total} checked this cycle</div>${lines}</div>`;
}
function renderCards() {
  const wrap = $('cards');
  wrap.innerHTML = '';
  const list = visibleItems();
  if (!list.length) { wrap.innerHTML = '<div class="empty">No items match.</div>'; return; }
  let lastCat = null;
  for (const it of list) {
    if (!activeCat && it.category !== lastCat) {
      lastCat = it.category;
      const h = document.createElement('h3');
      h.textContent = lastCat; h.style.cssText = 'margin:16px 0 8px;color:#0d2137;font-size:16px';
      wrap.appendChild(h);
    }
    const card = document.createElement('div');
    card.className = 'card';
    const dueTxt = it.intervalDays === null
      ? 'No set interval'
      : (it.nextDue ? 'Next due ' + fmtDate(it.nextDue) : 'Not yet logged');
    const meterTxt = (it.meters || []).length ? `<div class="meta">Hours meters: ${it.meters.map(m => escapeHtml((meters.find(x => x.key === m) || {}).label || m)).join(', ')}</div>` : '';
    card.innerHTML = `
      <div class="nm">${escapeHtml(it.name)}${it.archived ? ' (archived)' : ''}</div>
      <div class="meta">Last serviced ${fmtDate(it.lastServicedOn)}${it.lastPerformedBy ? ' by ' + escapeHtml(it.lastPerformedBy) : ''} · ${dueTxt}${it.intervalDays ? ' · every ' + it.intervalDays + ' days' : ''}</div>
      ${meterTxt}
      ${it.note ? `<div class="note">${escapeHtml(it.note)}</div>` : ''}
      ${it.lastNote ? `<div class="lastnote">Last entry: ${escapeHtml(it.lastNote)}</div>` : ''}
      <div class="row">
        <span class="chip ${it.status}">${chipText(it.status)}</span>
        <div class="cardbtns">
          <button class="logbtn" type="button" data-act="log">Log service</button>
          <button class="editbtn" type="button" data-act="hist">History</button>
          <button class="editbtn" type="button" data-act="edit">Edit</button>
          <button class="editbtn" type="button" data-act="arch">${it.archived ? 'Unarchive' : 'Archive'}</button>
        </div>
      </div>`;
    card.querySelector('[data-act="log"]').onclick = () => openLog(it);
    card.querySelector('[data-act="hist"]').onclick = () => openHistory(it);
    card.querySelector('[data-act="edit"]').onclick = () => openEditor(it);
    card.querySelector('[data-act="arch"]').onclick = async () => {
      const msg = it.archived ? 'Bring this item back to the active board?' : 'Archive this item? It leaves the due board and the weekly counts, but its history stays.';
      if (confirm(msg)) { await api('/maintenance/api/item/archive', { id: it.id, archived: !it.archived }); await load(); }
    };
    wrap.appendChild(card);
  }
}
// ---- tabs ----
function showTab(which) {
  $('tabBoard').classList.toggle('on', which === 'board');
  $('tabHours').classList.toggle('on', which === 'hours');
  $('tabReport').classList.toggle('on', which === 'report');
  $('viewBoard').style.display = which === 'board' ? '' : 'none';
  $('viewHours').style.display = which === 'hours' ? '' : 'none';
  $('viewReport').style.display = which === 'report' ? '' : 'none';
  if (which === 'report') { renderReport(); window.scrollTo(0, 0); }
}
$('tabBoard').onclick = () => showTab('board');
$('tabHours').onclick = () => showTab('hours');
$('tabReport').onclick = () => showTab('report');
$('showAll').onclick = () => { activeCat = null; renderPills(); renderCards(); };
$('search').oninput = renderCards;
$('showArchived').onchange = renderCards;
// ---- log service ----
function openLog(it) {
  $('logDlgTitle').textContent = 'Log service: ' + it.name;
  $('l_itemId').value = it.id;
  $('l_date').value = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  $('l_by').value = 'MS';
  $('l_note').value = '';
  const wrap = $('l_hoursWrap');
  wrap.innerHTML = '';
  for (const key of (it.meters || [])) {
    const m = meters.find(x => x.key === key);
    const cur = hours[key] && hours[key].value !== null ? hours[key].value : '';
    const label = document.createElement('label');
    label.innerHTML = `${escapeHtml(m ? m.label : key)} hours at service (optional, now ${cur === '' ? 'not logged' : fmtNum(cur)})<input type="number" step="0.1" min="0" data-meter="${key}" placeholder="${cur}">`;
    wrap.appendChild(label);
  }
  $('logDlg').showModal();
}
$('cancelLogBtn').onclick = () => $('logDlg').close();
$('logForm').addEventListener('submit', async e => {
  e.preventDefault();
  const hoursAtService = {};
  $('l_hoursWrap').querySelectorAll('input[data-meter]').forEach(inp => {
    if (inp.value !== '') hoursAtService[inp.dataset.meter] = Number(inp.value);
  });
  try {
    await api('/maintenance/api/log', {
      itemId: Number($('l_itemId').value),
      servicedOn: $('l_date').value,
      performedBy: $('l_by').value,
      note: $('l_note').value,
      hoursAtService,
    });
    $('logDlg').close();
    await load();
  } catch (err) { alert(err.message); }
});
// ---- history ----
async function openHistory(it) {
  $('histTitle').textContent = 'History: ' + it.name;
  const data = await api('/maintenance/api/history?itemId=' + it.id);
  const body = $('histBody');
  if (!data.logs.length) { body.innerHTML = '<div class="empty">No service logged yet.</div>'; }
  else {
    body.innerHTML = data.logs.map(l => {
      const hrs = l.hoursAtService ? Object.entries(l.hoursAtService).map(([k, v]) => {
        const m = meters.find(x => x.key === k);
        return `${m ? m.label : k}: ${fmtNum(v)}`;
      }).join(' · ') : '';
      const stamp = l.createdAt ? new Date(l.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
      return `<div class="histline"><strong>${fmtDate(l.servicedOn)}</strong>, by ${escapeHtml(l.performedBy)}<div>${escapeHtml(l.note || '')}</div>${hrs ? `<div class="meta">${escapeHtml(hrs)}</div>` : ''}<div class="meta">Logged ${escapeHtml(stamp)}</div></div>`;
    }).join('');
  }
  $('histDlg').showModal();
}
$('closeHistBtn').onclick = () => $('histDlg').close();
// ---- item editor ----
function openEditor(it) {
  $('dlgTitle').textContent = it ? 'Edit item' : 'Add item';
  $('f_id').value = it ? it.id : '';
  $('f_name').value = it ? it.name : '';
  $('f_category').value = it ? it.category : '';
  $('f_interval').value = it && it.intervalDays !== null ? it.intervalDays : '';
  $('f_note').value = it ? it.note : '';
  $('archiveItemBtn').style.display = it ? '' : 'none';
  $('archiveItemBtn').textContent = it && it.archived ? 'Unarchive item' : 'Archive item';
  const wrap = $('f_meters');
  wrap.innerHTML = '<label style="font-size:12px;color:#5c6b78">Hours meters recorded with service</label>' + meters.map(m =>
    `<label><input type="checkbox" value="${m.key}" ${it && it.meters.includes(m.key) ? 'checked' : ''}> ${escapeHtml(m.label)}</label>`).join('');
  $('itemDlg').showModal();
}
$('addItemBtn').onclick = () => openEditor(null);
$('cancelItemBtn').onclick = () => $('itemDlg').close();
$('itemForm').addEventListener('submit', async e => {
  e.preventDefault();
  const checked = [...$('f_meters').querySelectorAll('input[type=checkbox]:checked')].map(c => c.value);
  const cur = items.find(i => i.id === Number($('f_id').value));
  try {
    await api('/maintenance/api/item', {
      id: $('f_id').value ? Number($('f_id').value) : undefined,
      name: $('f_name').value, category: $('f_category').value,
      intervalDays: $('f_interval').value === '' ? null : Number($('f_interval').value),
      note: $('f_note').value, meters: checked,
      sortOrder: cur ? cur.sortOrder : items.length + 1,
    });
    $('itemDlg').close();
    await load();
  } catch (err) { alert(err.message); }
});
$('archiveItemBtn').onclick = async () => {
  const id = Number($('f_id').value);
  const cur = items.find(i => i.id === id);
  if (!id || !cur) return;
  await api('/maintenance/api/item/archive', { id, archived: !cur.archived });
  $('itemDlg').close();
  await load();
};
// ---- engine hours ----
function renderHours() {
  const wrap = $('meterCards');
  wrap.innerHTML = meters.map(m => {
    const h = hours[m.key] || {};
    return `<div class="meter"><div class="meta">${escapeHtml(m.label)}</div><div class="mv">${h.value === null || h.value === undefined ? 'Not logged' : fmtNum(h.value)}</div><div class="meta">${h.loggedOn ? 'Logged ' + fmtDate(h.loggedOn) + ' by ' + escapeHtml(h.performedBy || '') : ''}</div></div>`;
  }).join('');
  const form = $('hourForm');
  form.innerHTML = meters.map(m =>
    `<label style="display:block;font-size:12px;color:#5c6b78;margin-top:8px">${escapeHtml(m.label)}<input type="number" step="0.1" min="0" id="h_${m.key}" style="width:100%;padding:9px;border:1px solid #dde4ea;border-radius:8px;font-size:15px" placeholder="${hours[m.key] && hours[m.key].value !== null ? fmtNum(hours[m.key].value) : ''}"></label>`).join('') +
    `<label style="display:block;font-size:12px;color:#5c6b78;margin-top:8px">Performed by<input id="h_by" value="MS" style="width:100%;padding:9px;border:1px solid #dde4ea;border-radius:8px;font-size:15px"></label>
     <div class="btnrow"><button class="btn" type="button" id="saveHoursBtn">Save hours</button></div>`;
  $('saveHoursBtn').onclick = async () => {
    const readings = {};
    for (const m of meters) {
      const v = $('h_' + m.key).value;
      if (v !== '') readings[m.key] = Number(v);
    }
    try {
      await api('/maintenance/api/hours', { performedBy: $('h_by').value, readings });
      await load();
      alert('Hours saved.');
    } catch (err) { alert(err.message); }
  };
  loadHourHistory();
}
async function loadHourHistory() {
  const data = await api('/maintenance/api/hours/history');
  const body = $('hourHistory');
  if (!data.history.length) { body.innerHTML = '<div class="empty">No readings yet.</div>'; return; }
  body.innerHTML = data.history.slice(0, 40).map(h => {
    const m = data.meters.find(x => x.key === h.meter);
    return `<div class="histline"><strong>${escapeHtml(m ? m.label : h.meter)}</strong>: ${fmtNum(h.value)}<div class="meta">${fmtDate(h.loggedOn)}, by ${escapeHtml(h.performedBy)}</div></div>`;
  }).join('');
}
// ---- report ----
async function renderReport() {
  const report = await api('/maintenance/api/report');
  const c = report.counts;
  $('reportSummary').innerHTML = `<p><strong>${c.overdue} overdue</strong>, ${c.dueSoon} due soon, ${c.onSchedule} on schedule, ${c.notLogged} not yet logged, ${c.noInterval} with no interval, out of ${c.total} active items.</p>
  <p>Bilge and sump pump check: <strong>${report.pumps.complete ? 'COMPLETE' : 'INCOMPLETE'}</strong>, ${report.pumps.checked} of ${report.pumps.total} pumps checked this cycle.</p>`;
  const body = $('reportBody');
  let html = '<h3 style="color:#0d2137">Engine hours</h3>';
  html += meters.map(m => {
    const h = report.hours[m.key];
    return `<div class="histline"><strong>${escapeHtml(m.label)}</strong>: ${h.value === null ? 'not logged' : fmtNum(h.value)}${h.loggedOn ? `<div class="meta">Logged ${fmtDate(h.loggedOn)} by ${escapeHtml(h.performedBy || '')}</div>` : ''}</div>`;
  }).join('');
  html += '<h3 style="color:#0d2137">Serviced in the last 7 days</h3>';
  if (!report.servicedLast7Days.length) html += '<div class="empty">Nothing logged in the last 7 days.</div>';
  else html += report.servicedLast7Days.map(l =>
    `<div class="histline"><strong>${escapeHtml(l.item)}</strong>, ${fmtDate(l.servicedOn)}, by ${escapeHtml(l.performedBy)}<div>${escapeHtml(l.note || '')}</div></div>`).join('');
  $('reportBody').innerHTML = html;
}
async function saveFile(url, filename) {
  const r = await fetch(url);
  const blob = await r.blob();
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
$('pdfBtn').onclick = () => saveFile('/maintenance/export/report.pdf', 'Starship-V-Maintenance-Report.pdf');
$('xlsxBtn').onclick = () => saveFile('/maintenance/export/report.xlsx', 'Starship-V-Maintenance-Report.xlsx');
load().catch(e => { $('cards').innerHTML = '<div class="empty">Could not load. ' + escapeHtml(e.message) + '</div>'; });
