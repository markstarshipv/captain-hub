// Starship V Tide Chart, client side.
// All NOAA prediction times are local station time (lst_ldt). Both stations
// are in America/New_York, so every time is handled as an Eastern wall-clock
// time: parse the string as if it were UTC, and compute "now" the same way
// from the Eastern wall clock. Comparisons then work in any viewer timezone.

function wallMs(t) {
  // t: "YYYY-MM-DD HH:mm"
  const [d, hm] = t.split(' ');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  return Date.UTC(y, mo - 1, da, h, mi);
}
function nowWallMs() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = {};
  for (const part of fmt.formatToParts(new Date())) p[part.type] = part.value;
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
}
function fmtTime(ms) {
  const d = new Date(ms);
  let h = d.getUTCHours();
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${mi} ${ap}`;
}
function fmtDay(ms) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const d = new Date(ms);
  return `${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
function fmtCountdown(diffMs) {
  const mins = Math.max(0, Math.round(diffMs / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h <= 0) return `in ${m} min`;
  return `in ${h} hr ${String(m).padStart(2, '0')} min`;
}
function fmtHeight(v) { return `${Number(v).toFixed(2)} ft`; }

function interpolate(preds, t) {
  // preds: [{ms, v, type}] sorted. Cosine interpolation between neighbors.
  if (!preds.length) return null;
  if (t <= preds[0].ms) return preds[0].v;
  if (t >= preds[preds.length - 1].ms) return preds[preds.length - 1].v;
  for (let i = 0; i < preds.length - 1; i++) {
    const a = preds[i], b = preds[i + 1];
    if (t >= a.ms && t <= b.ms) {
      const f = (t - a.ms) / (b.ms - a.ms);
      return a.v + (b.v - a.v) * (1 - Math.cos(Math.PI * f)) / 2;
    }
  }
  return null;
}

function curveSVG(preds, nowMs) {
  const d = new Date(nowMs);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0);
  const end = start + 24 * 3600 * 1000;
  const W = 340, H = 110, padL = 6, padR = 6, padT = 10, padB = 14;
  const vals = preds.map(p => p.v);
  let min = Math.min(...vals, 0), max = Math.max(...vals);
  if (max - min < 1) { max += 0.5; min -= 0.5; }
  const x = t => padL + (t - start) / (end - start) * (W - padL - padR);
  const y = v => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
  let pts = '';
  for (let t = start; t <= end; t += 15 * 60000) {
    const v = interpolate(preds, t);
    if (v === null) continue;
    pts += `${x(t).toFixed(1)},${y(v).toFixed(1)} `;
  }
  const nowV = interpolate(preds, nowMs);
  const nowDot = nowV === null ? '' :
    `<line x1="${x(nowMs)}" y1="${padT}" x2="${x(nowMs)}" y2="${H - padB}" stroke="#d64545" stroke-width="1" stroke-dasharray="3 2"/><circle cx="${x(nowMs)}" cy="${y(nowV)}" r="3.5" fill="#d64545"/>`;
  const marks = preds.filter(p => p.ms >= start && p.ms <= end).map(p =>
    `<circle cx="${x(p.ms)}" cy="${y(p.v)}" r="2.5" fill="#0d2137"/><text x="${x(p.ms)}" y="${p.type === 'H' ? y(p.v) - 4 : y(p.v) + 11}" font-size="8" fill="#14232f" text-anchor="middle">${p.type}</text>`
  ).join('');
  const hours = [0, 6, 12, 18, 24].map(hh => {
    const t = start + hh * 3600 * 1000;
    const label = hh === 0 ? '12 AM' : hh === 6 ? '6 AM' : hh === 12 ? '12 PM' : hh === 18 ? '6 PM' : '12 AM';
    return `<text x="${x(t)}" y="${H - 3}" font-size="8" fill="#5c6b78" text-anchor="middle">${label}</text>`;
  }).join('');
  return `<svg class="curve" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Tide curve for today">
    <polyline points="${pts}" fill="none" stroke="#2b6cb0" stroke-width="2"/>${marks}${nowDot}${hours}</svg>`;
}

function renderStation(st, nowMs) {
  const el = document.createElement('section');
  el.className = 'station';
  const head = `<h2>${st.name}</h2><div class="place">${st.place}</div>`;
  if (st.error || !st.predictions || st.predictions.length === 0) {
    el.innerHTML = head + `<div class="unavail">${st.error || 'Tides unavailable right now. Please check back shortly.'}</div>`;
    return el;
  }
  const preds = st.predictions.map(p => ({ ms: wallMs(p.t), v: p.v, type: p.type }));
  const next = preds.find(p => p.ms > nowMs);
  const prev = [...preds].reverse().find(p => p.ms <= nowMs);
  const cur = interpolate(preds, nowMs);
  const rising = next ? next.type === 'H' : null;

  let html = head;
  if (st.stale) {
    const when = st.fetchedAt ? new Date(st.fetchedAt).toLocaleString('en-US', { timeZone: 'America/New_York' }) : 'an earlier check';
    html += `<div class="stale">Showing the last known predictions from ${when}. NOAA could not be refreshed just now.</div>`;
  }
  html += '<div class="nowbox">';
  if (cur !== null) {
    html += `<div class="nowcell"><div class="n">${cur.toFixed(2)} ft</div><div class="l">Estimated height now${rising === null ? '' : rising ? ', rising' : ', falling'}</div></div>`;
  }
  if (next) {
    html += `<div class="nowcell"><div class="n">${next.type === 'H' ? 'High' : 'Low'} ${fmtTime(next.ms)}</div><div class="l">Next tide ${fmtCountdown(next.ms - nowMs)}, ${fmtHeight(next.v)}</div></div>`;
  }
  html += '</div>';
  html += curveSVG(preds, nowMs);

  // Today's table only (Mark's call, 2026-11-09: today only, no day-ahead table).
  const d = new Date(nowMs);
  const todayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0);
  for (const [label, dayStart] of [['Today', todayStart]]) {
    const rows = preds.filter(p => p.ms >= dayStart && p.ms < dayStart + 24 * 3600 * 1000);
    if (!rows.length) continue;
    html += `<div class="daylabel">${label}, ${fmtDay(dayStart)}</div><table class="tides">`;
    for (const p of rows) {
      const cls = next && p.ms === next.ms ? 'next' : (p.ms <= nowMs ? 'past' : '');
      html += `<tr class="${cls}"><td class="k">${p.type === 'H' ? 'High tide' : 'Low tide'}</td><td>${fmtTime(p.ms)}</td><td class="h">${fmtHeight(p.v)}</td></tr>`;
    }
    html += '</table>';
  }
  el.innerHTML = html;
  return el;
}

async function load() {
  const main = document.getElementById('main');
  try {
    const r = await fetch('/tides/api/tides');
    if (r.status === 401) { window.location = '/login'; return; }
    const data = await r.json();
    const nowMs = nowWallMs();
    main.innerHTML = '';
    for (const st of data.stations) main.appendChild(renderStation(st, nowMs));
  } catch (e) {
    main.innerHTML = '<section class="station"><div class="unavail">Tides unavailable right now. The chart could not load; please check back shortly.</div></section>';
  }
}
load();
setInterval(load, 10 * 60 * 1000);
