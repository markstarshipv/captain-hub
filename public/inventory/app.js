'use strict';
const $ = id => document.getElementById(id);
let items = [], activeCat = null, needsAttention = false;

function fmt(n) {
  if (n === null || n === undefined || n === '') return '';
  const v = Number(n);
  return Number.isInteger(v) ? String(v) : String(v);
}
function chipText(s) {
  return { reorder: 'Reorder', top_up: 'Top up', stocked: 'Stocked', not_counted: 'Not counted' }[s] || s;
}
async function api(path, body) {
  const opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
  const r = await fetch(path, opts);
  if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }
  return r.json();
}
async function load() {
  const data = await api('/inventory/api/items');
  items = data.items;
  $('tileCounted').textContent = data.counted + ' of ' + data.total;
  $('tileToOrder').textContent = data.toOrder;
  $('tileReorder').textContent = data.reorderCount;
  renderPills(); renderCards();
}
function categories() {
  const out = [];
  for (const it of items) if (!out.includes(it.category)) out.push(it.category);
  return out;
}
function renderPills() {
  const pills = $('pills');
  pills.innerHTML = '';
  const mk = (label, cat, count) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'pill' + (activeCat === cat ? ' on' : '');
    b.innerHTML = label + '<span class="c">' + count + '</span>';
    b.onclick = () => { activeCat = (activeCat === cat) ? null : cat; renderPills(); renderCards(); window.scrollTo(0, 0); };
    pills.appendChild(b);
  };
  mk('All', null, items.length);
  for (const c of categories()) mk(c, c, items.filter(i => i.category === c).length);
  const attn = items.filter(i => i.status === 'reorder').length;
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'pill' + (needsAttention ? ' on' : '');
  b.innerHTML = 'Needs attention<span class="c">' + attn + '</span>';
  b.onclick = () => { needsAttention = !needsAttention; renderPills(); renderCards(); };
  pills.appendChild(b);
  const banner = $('catBanner');
  if (activeCat) { banner.classList.add('show'); $('catBannerText').textContent = 'Showing only: ' + activeCat; }
  else banner.classList.remove('show');
}
function visibleItems() {
  const q = $('search').value.trim().toLowerCase();
  return items.filter(it => {
    if (activeCat && it.category !== activeCat) return false;
    if (needsAttention && it.status !== 'reorder') return false;
    if (q && !it.name.toLowerCase().includes(q)) return false;
    return true;
  });
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
    const note = it.notes ? `<div class="note">${escapeHtml(it.notes)}</div>` : '';
    const countedAt = it.lastCountedAt ? new Date(it.lastCountedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    card.innerHTML = `
      <div class="nm">${escapeHtml(it.name)}</div>
      <div class="meta">Par ${fmt(it.parQty)} ${escapeHtml(it.unit)} · ${escapeHtml(it.vendor)}${it.reorderText ? ' · ' + escapeHtml(it.reorderText) : ''}</div>
      ${note}
      <div class="row">
        <span class="chip ${it.status}">${chipText(it.status)}</span>
        ${countedAt ? `<span class="meta">${countedAt}</span>` : ''}
        <button class="editbtn" type="button">Edit</button>
        <div class="stepper">
          <button type="button" data-d="-0.25">−</button>
          <input type="number" step="0.25" min="0" inputmode="decimal" value="${it.currentCount === null ? '' : fmt(it.currentCount)}" placeholder="0">
          <button type="button" data-d="0.25">+</button>
        </div>
      </div>`;
    const input = card.querySelector('input');
    const save = async () => {
      const v = input.value === '' ? null : Number(input.value);
      await api('/inventory/api/count', { id: it.id, count: v });
      await load();
    };
    card.querySelectorAll('.stepper button').forEach(btn => {
      btn.onclick = async () => {
        const cur = input.value === '' ? 0 : Number(input.value);
        const nv = Math.max(0, Math.round((cur + Number(btn.dataset.d)) * 100) / 100);
        input.value = fmt(nv);
        await save();
      };
    });
    input.onchange = save;
    card.querySelector('.editbtn').onclick = () => openEditor(it);
    wrap.appendChild(card);
  }
}
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// ---- tabs ----
function showTab(report) {
  $('tabCount').classList.toggle('on', !report);
  $('tabReport').classList.toggle('on', report);
  $('viewCount').style.display = report ? 'none' : '';
  $('viewReport').style.display = report ? '' : 'none';
  if (report) { renderReport(); window.scrollTo(0, 0); }
}
$('tabCount').onclick = () => showTab(false);
$('tabReport').onclick = () => showTab(true);
$('tileOrder').onclick = () => showTab(true);
$('showAll').onclick = () => { activeCat = null; renderPills(); renderCards(); };
$('search').oninput = renderCards;
$('newCountBtn').onclick = async () => {
  if (confirm('Start a new count? This clears every count entered so far.')) { await api('/inventory/api/newcount', {}); await load(); }
};
// ---- order report ----
let lastReport = null;
async function renderReport() {
  const report = await api('/inventory/api/report');
  lastReport = report;
  $('reportSummary').innerHTML = `<p><strong>${report.toOrder} items to order</strong>, ${report.reorderCount} at or below the reorder point. Counted ${report.counted} of ${report.total} items.</p>`;
  const body = $('reportBody');
  body.innerHTML = '';
  const vendors = Object.keys(report.byVendor);
  if (!vendors.length) { body.innerHTML = '<div class="empty">Nothing to order. Everything counted is at or above par.</div>'; return; }
  for (const v of vendors) {
    const div = document.createElement('div');
    div.className = 'vendor';
    let lines = `<h3>${escapeHtml(v)}</h3>`;
    for (const l of report.byVendor[v]) {
      lines += `<div class="oline"><span class="flag ${l.flag.replace(' ', '')}">${l.flag.toUpperCase()}</span> <strong>${escapeHtml(l.name)}</strong>: order ${fmt(l.order)} ${escapeHtml(l.unit)} (have ${fmt(l.have)} of par ${fmt(l.par)})${l.notes ? `<div class="meta" style="color:#7a5b00">${escapeHtml(l.notes)}</div>` : ''}</div>`;
    }
    lines += `<div class="btnrow"><button class="btn alt" data-copy="${escapeHtml(v)}" type="button">Copy ${escapeHtml(v)} list</button><button class="btn" data-restock="${escapeHtml(v)}" type="button">Received: restock ${escapeHtml(v)}</button></div>`;
    div.innerHTML = lines;
    body.appendChild(div);
  }
  body.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => copyText(vendorText(b.dataset.copy)));
  body.querySelectorAll('[data-restock]').forEach(b => b.onclick = async () => {
    if (confirm('Mark everything ordered from ' + b.dataset.restock + ' as received and restocked to par?')) {
      await api('/inventory/api/restock', { vendor: b.dataset.restock });
      await load(); await renderReport();
    }
  });
}
function vendorText(v) {
  if (!lastReport) return '';
  return (lastReport.byVendor[v] || []).map(l => `${l.name}: order ${fmt(l.order)} ${l.unit} (have ${fmt(l.have)}, par ${fmt(l.par)})${l.notes ? ' Note: ' + l.notes : ''}`).join('\n');
}
function fullText() {
  if (!lastReport) return '';
  return Object.keys(lastReport.byVendor).map(v => v + '\n' + vendorText(v)).join('\n\n');
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); alert('Copied.'); }
  catch (e) { prompt('Copy this list:', t); }
}
$('copyAllBtn').onclick = () => copyText(fullText());
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
$('pdfBtn').onclick = () => saveFile('/inventory/export/order.pdf', 'Starship-V-Order-Report.pdf');
$('xlsxBtn').onclick = () => saveFile('/inventory/export/order.xlsx', 'Starship-V-Order-Report.xlsx');
// ---- item editor ----
function openEditor(it) {
  $('dlgTitle').textContent = it ? 'Edit item' : 'Add item';
  $('f_id').value = it ? it.id : '';
  $('f_name').value = it ? it.name : '';
  $('f_category').value = it ? it.category : '';
  $('f_par').value = it ? it.parQty : '';
  $('f_reorder').value = it && it.reorderQty !== null ? it.reorderQty : '';
  $('f_unit').value = it ? it.unit : '';
  $('f_vendor').value = it ? it.vendor : '';
  $('f_reorderText').value = it ? it.reorderText : '';
  $('f_notes').value = it ? it.notes : '';
  $('deleteItemBtn').style.display = it ? '' : 'none';
  $('itemDlg').showModal();
}
$('addItemBtn').onclick = () => openEditor(null);
$('cancelItemBtn').onclick = () => $('itemDlg').close();
$('itemForm').addEventListener('submit', async e => {
  e.preventDefault();
  const body = {
    id: $('f_id').value ? Number($('f_id').value) : undefined,
    name: $('f_name').value, category: $('f_category').value,
    parQty: Number($('f_par').value), reorderQty: $('f_reorder').value === '' ? null : Number($('f_reorder').value),
    unit: $('f_unit').value, vendor: $('f_vendor').value,
    reorderText: $('f_reorderText').value, notes: $('f_notes').value,
  };
  const cur = items.find(i => i.id === body.id);
  body.sortOrder = cur ? cur.sortOrder : items.length;
  body.cadence = cur ? cur.cadence : 'monitor';
  await api('/inventory/api/item', body);
  $('itemDlg').close();
  await load();
});
$('deleteItemBtn').onclick = async () => {
  const id = Number($('f_id').value);
  if (id && confirm('Delete this item from the inventory list?')) {
    await api('/inventory/api/item/delete', { id });
    $('itemDlg').close();
    await load();
  }
};
load().catch(e => { $('cards').innerHTML = '<div class="empty">Could not load. ' + escapeHtml(e.message) + '</div>'; });
