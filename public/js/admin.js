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
    if (!hexRe.test(el.value.trim())) { err.textContent = 'Invalid'; ok = false; }
    else { err.textContent = ''; }
  });
  numInputs.forEach(id => {
    const el = $(id); const err = el.nextElementSibling;
    const v = parseFloat(el.value);
    if (!isFinite(v)) { err.textContent = 'Invalid'; ok = false; }
    else { err.textContent = ''; }
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
