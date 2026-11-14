'use strict';
const $ = id => document.getElementById(id);
let state = null;
let editing = false;

async function api(path, body) {
  const opts = { headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) { opts.method = 'POST'; opts.body = JSON.stringify(body); }
  const r = await fetch(path, opts);
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

async function load() {
  state = await api('/posttrip/api/state');
  render();
}

function groupedTasks() {
  const groups = [];
  const bySection = new Map();
  for (const t of state.tasks) {
    if (!bySection.has(t.section)) { bySection.set(t.section, []); groups.push(t.section); }
    bySection.get(t.section).push(t);
  }
  return groups.map(name => ({ name, tasks: bySection.get(name) }));
}

function renderRunPanel() {
  const panel = $('runPanel');
  const total = state.tasks.length;
  if (!state.openRun) {
    panel.innerHTML = `
      <div style="font-size:15px;margin-bottom:10px">No closeout is open right now. When the boat comes back in, start one and work down the list.</div>
      <button class="btn gold big" id="startBtn" type="button">Start closeout</button>`;
    $('startBtn').onclick = async () => { await api('/posttrip/api/run/start', {}); await load(); };
    return;
  }
  const checked = new Set(state.openRun.checkedTaskIds);
  const pct = total ? Math.round(checked.size * 100 / total) : 0;
  panel.innerHTML = `
    <div style="font-weight:700;font-size:16px">Closeout in progress</div>
    <div class="progress"><div class="fill" style="width:${pct}%"></div></div>
    <div class="progress-label">${checked.size} of ${total} tasks checked · started ${escapeHtml(fmtDateTime(state.openRun.startedAt))}</div>
    <label class="flabel">Closed out by<input class="finput" id="finishBy" placeholder="Your name"></label>
    <label class="flabel">Close-out note (optional)<input class="finput" id="finishNote" placeholder="Anything used up, running low, or worth flagging"></label>
    <div class="btnrow">
      <button class="btn green" id="finishBtn" type="button">Finish closeout</button>
      <button class="btn alt" id="cancelRunBtn" type="button">Discard</button>
    </div>`;
  $('finishBtn').onclick = async () => {
    await api('/posttrip/api/run/finish', { closedBy: $('finishBy').value, note: $('finishNote').value });
    await load();
  };
  $('cancelRunBtn').onclick = async () => {
    if (!confirm('Discard this closeout without saving it?')) return;
    await api('/posttrip/api/run/cancel', {});
    await load();
  };
}

function renderTasks() {
  const list = $('taskList');
  const checked = state.openRun ? new Set(state.openRun.checkedTaskIds) : new Set();
  const inRun = !!state.openRun;
  let html = '';
  for (const g of groupedTasks()) {
    html += `<h2 class="section">${escapeHtml(g.name)}</h2>`;
    for (const t of g.tasks) {
      const done = checked.has(t.id);
      html += `<div class="task ${inRun ? 'tappable' : ''} ${done ? 'done' : ''}" data-id="${t.id}">
        ${inRun ? `<div class="box">${done ? '&#10003;' : ''}</div>` : ''}
        <div>
          <div class="title">${escapeHtml(t.title)}</div>
          ${t.note ? `<div class="note">${escapeHtml(t.note)}</div>` : ''}
        </div>
        ${editing ? `<div class="tools">
          <button class="toolbtn" data-act="up" data-id="${t.id}" type="button">Up</button>
          <button class="toolbtn" data-act="down" data-id="${t.id}" type="button">Down</button>
          <button class="toolbtn" data-act="edit" data-id="${t.id}" type="button">Edit</button>
        </div>` : ''}
      </div>`;
    }
  }
  if (!state.tasks.length) html = '<div class="empty">The list is empty. Use Edit list, then Add task, to build it.</div>';
  list.innerHTML = html;
  list.querySelectorAll('.task.tappable').forEach(el => {
    el.addEventListener('click', async e => {
      if (e.target.closest('.tools')) return;
      await api('/posttrip/api/run/toggle', { taskId: Number(el.dataset.id) });
      await load();
    });
  });
  list.querySelectorAll('.toolbtn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = Number(btn.dataset.id);
      if (btn.dataset.act === 'edit') return openTaskDialog(id);
      await api('/posttrip/api/task/move', { id, dir: btn.dataset.act });
      await load();
    });
  });
}

function renderHistory() {
  const el = $('historyList');
  if (!state.history.length) {
    el.innerHTML = '<div class="empty">No finished closeouts yet.</div>';
    return;
  }
  el.innerHTML = state.history.map(h => {
    const pct = h.totalCount ? Math.round(h.checkedCount * 100 / h.totalCount) : 0;
    return `<div class="card">
      <div class="desc">${escapeHtml(fmtDateTime(h.finishedAt))}</div>
      <div class="meta">${h.checkedCount} of ${h.totalCount} tasks (${pct}%)${h.closedBy ? ' · Closed out by ' + escapeHtml(h.closedBy) : ''}${h.note ? '<br>' + escapeHtml(h.note) : ''}</div>
    </div>`;
  }).join('');
}

function render() {
  renderRunPanel();
  renderTasks();
  renderHistory();
  $('sectionNames').innerHTML = state.sections.map(s => `<option value="${escapeHtml(s)}">`).join('');
}

// ---- task editing ----
function openTaskDialog(id) {
  const t = id ? state.tasks.find(x => x.id === id) : null;
  $('taskDlgTitle').textContent = t ? 'Edit task' : 'Add task';
  $('t_id').value = t ? t.id : '';
  $('t_section').value = t ? t.section : '';
  $('t_title').value = t ? t.title : '';
  $('t_note').value = t ? (t.note || '') : '';
  $('taskDeleteBtn').style.display = t ? '' : 'none';
  $('taskDlg').showModal();
}
$('addTaskBtn').onclick = () => openTaskDialog(null);
$('taskCancelBtn').onclick = () => $('taskDlg').close();
$('taskDeleteBtn').onclick = async () => {
  const id = Number($('t_id').value);
  if (!id || !confirm('Delete this task from the list? Past closeouts keep their record.')) return;
  await api('/posttrip/api/task/delete', { id });
  $('taskDlg').close();
  await load();
};
$('taskForm').addEventListener('submit', async e => {
  e.preventDefault();
  const body = {
    section: $('t_section').value,
    title: $('t_title').value,
    note: $('t_note').value,
  };
  if ($('t_id').value) body.id = Number($('t_id').value);
  await api('/posttrip/api/task', body);
  $('taskDlg').close();
  await load();
});
$('editToggleBtn').onclick = () => {
  editing = !editing;
  $('editToggleBtn').textContent = editing ? 'Done editing' : 'Edit list';
  $('addTaskBtn').style.display = editing ? '' : 'none';
  renderTasks();
};

load().catch(e => {
  $('runPanel').innerHTML = '<div class="empty">Could not load. ' + escapeHtml(e.message) + '</div>';
});
