const DEFAULT_THEME = {
  colors: {
    good: { bg: '#10B981', fg: '#0B1B13' },
    warn: { bg: '#FBBF24', fg: '#1B1403' },
    bad: { bg: '#EF4444', fg: '#1F0D0D' },
    neutral: { bg: '#374151', fg: '#FFFFFF' }
  },
  thresholds: {
    downtimePct: { goodMax: 2.0, warnMax: 5.0 },
    plannedPct:  { goodMin: 70.0, warnMin: 50.0 },
    unplannedPct:{ goodMax: 30.0, warnMax: 50.0 },
    mttrHours:   { goodMax: 1.5,  warnMax: 3.0 },
    mtbfHours:   { goodMin: 72.0, warnMin: 36.0 }
  }
};

const hexInputs = [
  'color-good-bg','color-good-fg','color-warn-bg','color-warn-fg',
  'color-bad-bg','color-bad-fg','color-neutral-bg','color-neutral-fg'
];
const numInputs = [
  'thr-downtimePct-goodMax','thr-downtimePct-warnMax',
  'thr-plannedPct-goodMin','thr-plannedPct-warnMin',
  'thr-unplannedPct-goodMax','thr-unplannedPct-warnMax',
  'thr-mttrHours-goodMax','thr-mttrHours-warnMax',
  'thr-mtbfHours-goodMin','thr-mtbfHours-warnMin'
];
const hexRe = /^#[0-9a-fA-F]{6}$/;
const $ = id => document.getElementById(id);

function populate(theme) {
  $('color-good-bg').value = theme.colors.good.bg;
  $('color-good-fg').value = theme.colors.good.fg;
  $('color-warn-bg').value = theme.colors.warn.bg;
  $('color-warn-fg').value = theme.colors.warn.fg;
  $('color-bad-bg').value = theme.colors.bad.bg;
  $('color-bad-fg').value = theme.colors.bad.fg;
  $('color-neutral-bg').value = theme.colors.neutral.bg;
  $('color-neutral-fg').value = theme.colors.neutral.fg;
  $('thr-downtimePct-goodMax').value = theme.thresholds.downtimePct.goodMax;
  $('thr-downtimePct-warnMax').value = theme.thresholds.downtimePct.warnMax;
  $('thr-plannedPct-goodMin').value = theme.thresholds.plannedPct.goodMin;
  $('thr-plannedPct-warnMin').value = theme.thresholds.plannedPct.warnMin;
  $('thr-unplannedPct-goodMax').value = theme.thresholds.unplannedPct.goodMax;
  $('thr-unplannedPct-warnMax').value = theme.thresholds.unplannedPct.warnMax;
  $('thr-mttrHours-goodMax').value = theme.thresholds.mttrHours.goodMax;
  $('thr-mttrHours-warnMax').value = theme.thresholds.mttrHours.warnMax;
  $('thr-mtbfHours-goodMin').value = theme.thresholds.mtbfHours.goodMin;
  $('thr-mtbfHours-warnMin').value = theme.thresholds.mtbfHours.warnMin;
}

function collect() {
  return {
    colors: {
      good:   { bg: $('color-good-bg').value.trim(),    fg: $('color-good-fg').value.trim() },
      warn:   { bg: $('color-warn-bg').value.trim(),    fg: $('color-warn-fg').value.trim() },
      bad:    { bg: $('color-bad-bg').value.trim(),     fg: $('color-bad-fg').value.trim() },
      neutral:{ bg: $('color-neutral-bg').value.trim(), fg: $('color-neutral-fg').value.trim() }
    },
    thresholds: {
      downtimePct: { goodMax: parseFloat($('thr-downtimePct-goodMax').value), warnMax: parseFloat($('thr-downtimePct-warnMax').value) },
      plannedPct:  { goodMin: parseFloat($('thr-plannedPct-goodMin').value),  warnMin: parseFloat($('thr-plannedPct-warnMin').value) },
      unplannedPct:{ goodMax: parseFloat($('thr-unplannedPct-goodMax').value), warnMax: parseFloat($('thr-unplannedPct-warnMax').value) },
      mttrHours:   { goodMax: parseFloat($('thr-mttrHours-goodMax').value),  warnMax: parseFloat($('thr-mttrHours-warnMax').value) },
      mtbfHours:   { goodMin: parseFloat($('thr-mtbfHours-goodMin').value),  warnMin: parseFloat($('thr-mtbfHours-warnMin').value) }
    }
  };
}

function validate() {
  let ok = true;
  hexInputs.forEach(id => {
    const el = $(id); const err = el.nextElementSibling;
    if (!hexRe.test(el.value.trim())) { if (err) err.textContent = 'Invalid'; ok = false; }
    else { if (err) err.textContent = ''; }
  });
  numInputs.forEach(id => {
    const el = $(id); const err = el.nextElementSibling;
    const v = parseFloat(el.value);
    if (!isFinite(v)) { if (err) err.textContent = 'Invalid'; ok = false; }
    else { if (err) err.textContent = ''; }
  });
  $('save-theme').disabled = !ok;
  return ok;
}

function showToast(msg, isError=false) {
  const el = $('theme-toast');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  el.style.backgroundColor = isError ? '#ffcccc' : '#ccffcc';
  el.style.color = isError ? '#a00' : '#030';
  setTimeout(() => { el.style.display = 'none'; }, 3000);
}

async function loadTheme() {
  try {
    const res = await fetch('/api/settings/kpi-theme');
    if (res.ok) {
      const t = await res.json();
      populate(t);
    } else {
      populate(DEFAULT_THEME);
    }
  } catch {
    populate(DEFAULT_THEME);
  }
  validate();
}

$('save-theme').addEventListener('click', async () => {
  if (!validate()) return;
  const theme = collect();
  try {
    const res = await fetch('/api/settings/kpi-theme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(theme)
    });
    if (!res.ok) throw new Error();
    const saved = await res.json();
    populate(saved);
    showToast('Saved');
  } catch {
    showToast('Save failed', true);
  }
});

$('reset-theme').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/settings/kpi-theme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(DEFAULT_THEME)
    });
    if (!res.ok) throw new Error();
    populate(DEFAULT_THEME);
    showToast('Saved');
  } catch {
    showToast('Reset failed', true);
  }
});

document.querySelectorAll('#theme-section input').forEach(el => el.addEventListener('input', validate));

loadTheme();

async function loadSchedules() {
  try {
    const res = await fetch('/api/admin/schedules');
    if (!res.ok) return;
    const rows = await res.json();
    const tb = document.querySelector('#sched-table tbody');
    if (!tb) return;
    tb.innerHTML = '';
    rows.forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><code>${r.Name}</code></td>
        <td><input data-name="${r.Name}" class="cron" value="${r.Cron}"></td>
        <td><input data-name="${r.Name}" class="enabled" type="checkbox" ${r.Enabled ? 'checked':''}></td>`;
      tb.appendChild(tr);
    });
  } catch { /* ignore */ }
}

async function saveSchedules() {
  const tb = document.querySelector('#sched-table tbody');
  if (!tb) return;
  const rows = [];
  tb.querySelectorAll('tr').forEach(tr => {
    const name = tr.querySelector('code').textContent;
    const cron = tr.querySelector('input.cron').value.trim();
    const enabled = tr.querySelector('input.enabled').checked;
    rows.push({ Name: name, Cron: cron, Enabled: enabled });
  });
  const res = await fetch('/api/admin/schedules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rows)
  });
  const el = document.getElementById('sched-status');
  if (el) el.textContent = res.ok ? 'Saved' : 'Save failed';
}

document.getElementById('sched-save')?.addEventListener('click', saveSchedules);
loadSchedules();

// ---- Run Now wiring (guarded) ----
async function runJob(name) {
  let msg = '';
  try {
    const res = await fetch('/api/admin/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job: name })
    });
    if (res.ok) {
      let body = '';
      try { body = await res.text(); } catch {}
      try {
        const j = JSON.parse(body || '{}');
        const r = j.result || {};
        const extra = Object.keys(r).length ? ` (result: ${JSON.stringify(r)})` : '';
        msg = `Ran ${name}${extra}`;
      } catch {
        msg = `Ran ${name}`;
      }
    } else {
      // Try to parse JSON error, else show raw text
      let body = '';
      try { body = await res.text(); } catch {}
      msg = `Failed ${name}${body ? `: ${body}` : ''}`;
    }
  } catch (e) {
    msg = `Failed ${name}: ${String(e)}`;
  }
  const el = document.getElementById('run-status');
  if (el) el.textContent = msg;
}
(document.getElementById('run-header')   || {}).onclick = ()=>runJob('header_kpis');
(document.getElementById('run-byasset')  || {}).onclick = ()=>runJob('by_asset_kpis');
(document.getElementById('run-wo-index') || {}).onclick = ()=>runJob('work_orders_index');
(document.getElementById('run-wo-pm')    || {}).onclick = ()=>runJob('work_orders_pm');
(document.getElementById('run-wo-status')|| {}).onclick = ()=>runJob('work_orders_status');
(document.getElementById('run-all')      || {}).onclick = async ()=>{
  const res = await fetch('/api/admin/refresh-all', { method: 'POST' });
  const el = document.getElementById('run-status');
  if (el) el.textContent = res.ok ? 'Refreshed all' : 'Refresh all failed';
};
