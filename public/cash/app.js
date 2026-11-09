'use strict';
const $ = id => document.getElementById(id);
let state = null;
let receiptTargetId = null;

function money(cents) {
  const n = Number(cents) || 0;
  const sign = n < 0 ? '-' : '';
  return sign + '$' + (Math.abs(n) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function todayStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
async function api(path, body) {
  const opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
  const r = await fetch(path, opts);
  if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }
  return r.json();
}
async function load() {
  state = await api('/cash/api/state');
  $('fundName').textContent = state.fund.name;
  $('tileBalance').textContent = money(state.balanceCents);
  $('tileAdded').textContent = money(state.totalAddedCents);
  $('tileSpent').textContent = money(state.totalSpentCents);
  renderCards(); renderAudits();
}
function receiptLine(t) {
  if (!t.hasReceipt) return `<div class="receipt"><button class="editbtn" data-receipt="${t.id}" type="button">Attach receipt photo</button></div>`;
  if (t.hasReceiptBytes) return `<div class="receipt">Receipt: <a href="/cash/receipt/${t.id}" target="_blank" rel="noopener">view photo</a> · <button class="editbtn" data-receipt="${t.id}" type="button">Replace</button></div>`;
  return `<div class="receipt" style="color:#7a5b00">Receipt on file (photo in previous app) · <button class="editbtn" data-receipt="${t.id}" type="button">Add photo here</button></div>`;
}
function renderCards() {
  const wrap = $('cards');
  wrap.innerHTML = '';
  if (!state.transactions.length) { wrap.innerHTML = '<div class="empty">No entries yet.</div>'; return; }
  for (const t of state.transactions) {
    const card = document.createElement('div');
    card.className = 'card';
    const sign = t.kind === 'addition' ? '+' : '-';
    card.innerHTML = `
      <div class="top">
        <span class="desc">${escapeHtml(t.description || '(no description)')}</span>
        <span class="amt ${t.kind}">${sign}${money(t.amountCents)}</span>
      </div>
      <div class="meta">${escapeHtml(t.txnDate)} · ${escapeHtml(t.category || 'General')}${t.spentBy ? ' · ' + escapeHtml(t.spentBy) : ''}</div>
      ${receiptLine(t)}
      <div class="row">
        <span class="chip ${t.kind}">${t.kind === 'addition' ? 'Cash in' : 'Expense'}</span>
        <button class="editbtn" type="button">Edit</button>
      </div>`;
    card.querySelectorAll('.editbtn').forEach(b => {
      if (b.dataset.receipt) b.onclick = () => { receiptTargetId = Number(b.dataset.receipt); $('receiptFile').click(); };
      else b.onclick = () => openEditor(t);
    });
    wrap.appendChild(card);
  }
}
function renderAudits() {
  const wrap = $('audits');
  wrap.innerHTML = '';
  if (!state.audits.length) { wrap.innerHTML = '<div class="empty">No audits yet.</div>'; return; }
  for (const a of state.audits) {
    const when = new Date(a.createdAt).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    const diffText = a.differenceCents === 0 ? 'exact match' : (a.status + ' by ' + money(Math.abs(a.differenceCents)));
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = `
      <div class="top"><span class="desc">${when}</span><span class="chip ${a.status}">${escapeHtml(a.status)}</span></div>
      <div class="meta">Counted ${money(a.countedCents)} vs book ${money(a.expectedCents)}: ${diffText}${a.countedBy ? ' · Counted by ' + escapeHtml(a.countedBy) : ''}${a.note ? ' · ' + escapeHtml(a.note) : ''}</div>`;
    wrap.appendChild(div);
  }
}
// ---- tabs ----
function showTab(statement) {
  $('tabEntries').classList.toggle('on', !statement);
  $('tabStatement').classList.toggle('on', statement);
  $('viewEntries').style.display = statement ? 'none' : '';
  $('viewStatement').style.display = statement ? '' : 'none';
  if (statement) { initStatementDates(); loadStatement(); window.scrollTo(0, 0); }
}
$('tabEntries').onclick = () => showTab(false);
$('tabStatement').onclick = () => showTab(true);
// ---- transaction editor ----
function openEditor(t, kind) {
  const isNew = !t;
  $('dlgTitle').textContent = isNew ? (kind === 'addition' ? 'Add cash' : 'Add expense') : 'Edit entry';
  $('f_id').value = t ? t.id : '';
  $('f_kind').value = t ? t.kind : kind;
  $('f_date').value = t ? t.txnDate : todayStr();
  $('f_amount').value = t ? (t.amountCents / 100).toFixed(2) : '';
  $('f_desc').value = t ? t.description : '';
  $('f_category').value = t ? (t.category || 'General') : 'General';
  $('f_spentby').value = t ? (t.spentBy || '') : '';
  $('deleteTxnBtn').style.display = t ? '' : 'none';
  $('txnDlg').showModal();
}
$('addExpenseBtn').onclick = () => openEditor(null, 'expense');
$('addCashBtn').onclick = () => openEditor(null, 'addition');
$('cancelTxnBtn').onclick = () => $('txnDlg').close();
$('txnForm').addEventListener('submit', async e => {
  e.preventDefault();
  const body = {
    id: $('f_id').value ? Number($('f_id').value) : undefined,
    kind: $('f_kind').value,
    txnDate: $('f_date').value,
    amount: $('f_amount').value,
    description: $('f_desc').value,
    category: $('f_category').value,
    spentBy: $('f_spentby').value,
  };
  await api('/cash/api/transaction', body);
  $('txnDlg').close();
  await load();
});
$('deleteTxnBtn').onclick = async () => {
  const id = Number($('f_id').value);
  if (id && confirm('Delete this entry? This changes the balance.')) {
    await api('/cash/api/transaction/delete', { id });
    $('txnDlg').close();
    await load();
  }
};
// ---- receipt upload ----
$('receiptFile').addEventListener('change', async () => {
  const file = $('receiptFile').files[0];
  $('receiptFile').value = '';
  if (!file || !receiptTargetId) return;
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  await api('/cash/api/receipt', { id: receiptTargetId, dataUrl });
  receiptTargetId = null;
  await load();
});
// ---- audit ----
$('auditBtn').onclick = () => {
  $('auditExpected').textContent = money(state.balanceCents);
  $('a_counted').value = '';
  $('a_by').value = '';
  $('a_note').value = '';
  $('auditResult').textContent = '';
  $('auditDlg').showModal();
};
$('cancelAuditBtn').onclick = () => $('auditDlg').close();
$('auditForm').addEventListener('submit', async e => {
  e.preventDefault();
  const res = await api('/cash/api/audit', { countedAmount: $('a_counted').value, countedBy: $('a_by').value, note: $('a_note').value });
  const a = res.audit;
  $('auditResult').textContent = a.differenceCents === 0
    ? 'Balanced. Counted cash matches the book balance exactly.'
    : a.status + ' by ' + money(Math.abs(a.differenceCents)) + '. Counted ' + money(a.countedCents) + ', book balance ' + money(a.expectedCents) + '.';
  await load();
});
// ---- statement ----
function initStatementDates() {
  if (!$('stFrom').value) {
    const dates = state.transactions.map(t => t.txnDate).sort();
    $('stFrom').value = dates.length ? dates[0] : todayStr();
  }
  if (!$('stTo').value) $('stTo').value = todayStr();
}
async function loadStatement() {
  const from = $('stFrom').value, to = $('stTo').value;
  const st = await api(`/cash/api/statement?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  const body = $('statementBody');
  let html = `<div class="totals">
    <div>Period: <strong>${escapeHtml(st.from)} to ${escapeHtml(st.to)}</strong></div>
    <div>Opening balance: <strong>${money(st.openingBalanceCents)}</strong></div>
    <div>Total added: <strong>${money(st.totalAddedCents)}</strong></div>
    <div>Total spent: <strong>${money(st.totalSpentCents)}</strong></div>
    <div>Closing balance: <strong>${money(st.closingBalanceCents)}</strong></div>
  </div>`;
  if (st.standingStatementNote) html += `<div class="note-box">${escapeHtml(st.standingStatementNote)}</div>`;
  if (!st.transactions.length) html += '<div class="empty">No entries in this period.</div>';
  for (const t of st.transactions) {
    const sign = t.kind === 'addition' ? '+' : '-';
    html += `<div class="card">
      <div class="top"><span class="desc">${escapeHtml(t.description || '(no description)')}</span><span class="amt ${t.kind}">${sign}${money(t.amountCents)}</span></div>
      <div class="meta">${escapeHtml(t.txnDate)} · ${escapeHtml(t.category || 'General')}${t.spentBy ? ' · ' + escapeHtml(t.spentBy) : ''} · Balance ${money(t.runningBalanceCents)}${t.hasReceipt ? (t.receiptLegacy ? ' · Receipt on file (photo in previous app)' : ' · Receipt attached') : ''}</div>
    </div>`;
  }
  if (st.audits.length) {
    html += '<h3 style="color:#0d2137;margin:16px 0 8px">Cash audits in this period</h3>';
    for (const a of st.audits) {
      html += `<div class="card"><div class="meta" style="font-size:13px;color:#14232f">Counted ${money(a.countedCents)} vs book ${money(a.expectedCents)}: <strong>${escapeHtml(a.status)}</strong>${a.differenceCents !== 0 ? ' by ' + money(Math.abs(a.differenceCents)) : ''}${a.countedBy ? ' · ' + escapeHtml(a.countedBy) : ''}${a.note ? ' · ' + escapeHtml(a.note) : ''}</div></div>`;
    }
  }
  body.innerHTML = html;
}
$('stLoadBtn').onclick = loadStatement;
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
function exportQuery() { return `?from=${encodeURIComponent($('stFrom').value)}&to=${encodeURIComponent($('stTo').value)}`; }
$('pdfBtn').onclick = () => saveFile('/cash/export/statement.pdf' + exportQuery(), 'Petty-Cash-Statement.pdf');
$('xlsxBtn').onclick = () => saveFile('/cash/export/statement.xlsx' + exportQuery(), 'Petty-Cash-Statement.xlsx');
$('csvBtn').onclick = () => saveFile('/cash/export/transactions.csv' + exportQuery(), 'Petty-Cash-Transactions.csv');
load().catch(e => { $('cards').innerHTML = '<div class="empty">Could not load. ' + escapeHtml(e.message) + '</div>'; });
