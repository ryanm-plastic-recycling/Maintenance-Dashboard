import { computeTrueOverall } from './compute-true-overall.js';

let mappings;
await fetch('/mappings.json')
  .then(r => r.json())
  .then(m => mappings = m)
  .catch(err => console.error('Failed to load mappings', err));

// Theme defaults + fetch
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

try {
  const res = await fetch('/api/settings/kpi-theme');
  window.kpiTheme = res.ok ? await res.json() : DEFAULT_THEME;
  if (!res.ok) console.warn('Failed to load KPI theme, using defaults');
} catch (err) {
  console.warn('Failed to load KPI theme, using defaults');
  window.kpiTheme = DEFAULT_THEME;
}

const timeframeSelect = document.getElementById('timeframe-select');
const tbody     = document.querySelector('#kpi-by-asset tbody');

console.log('[kpi-by-asset.js] module loaded');

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function classifyByThreshold(metricKey, value, theme) {
  if (value == null || isNaN(value)) return 'neutral';
  const t = theme?.thresholds?.[metricKey] || {};
  if (typeof t.goodMax === 'number' || typeof t.warnMax === 'number') {
    const goodMax = typeof t.goodMax === 'number' ? t.goodMax : Infinity;
    const warnMax = typeof t.warnMax === 'number' ? t.warnMax : Infinity;
    if (value <= goodMax) return 'good';
    if (value <= warnMax) return 'warn';
    return 'bad';
  }
  if (typeof t.goodMin === 'number' || typeof t.warnMin === 'number') {
    const goodMin = typeof t.goodMin === 'number' ? t.goodMin : -Infinity;
    const warnMin = typeof t.warnMin === 'number' ? t.warnMin : -Infinity;
    if (value >= goodMin) return 'good';
    if (value >= warnMin) return 'warn';
    return 'bad';
  }
  return 'neutral';
}

function applyTileTheme(el, metricKey, value, theme) {
  const cls = classifyByThreshold(metricKey, value, theme);
  const palette = theme?.colors?.[cls] || theme?.colors?.neutral || { bg: '#374151', fg: '#FFFFFF' };
  if (el) {
    el.style.backgroundColor = palette.bg;
    el.style.color = palette.fg;
    el.dataset.severity = cls;
  }
}

// derive downtime hours from possible fields
function getDowntimeHours(row) {
  if (!row) return null;
  const direct = row.downtimeHrs ?? row.downtimeHours
    ?? row.totals?.downtimeHrs ?? row.totals?.downtimeHours;
  if (typeof direct === 'number' && !isNaN(direct)) return direct;
  // fallback to planned + unplanned downtime hours if provided
  const planned = row.plannedDowntimeHours ?? row.plannedDowntimeHrs;
  const unplanned = row.unplannedDowntimeHours ?? row.unplannedDowntimeHrs;
  if (planned != null || unplanned != null) {
    const sum = (Number(planned) || 0) + (Number(unplanned) || 0);
    if (!isNaN(sum)) return sum;
  }
  return null;
}

// count of WR + Unplanned WO in range
function getUnplannedCount(row) {
  // Prefer explicit aggregated field if present
  if (Number.isFinite(row?.unplannedCount)) return row.unplannedCount;

  // Next best: WR + Unplanned WO counts if present
  const wr = Number(row?.workRequestCount) || 0;
  const uw = Number(row?.unplannedWoCount) || 0;
  const combined = wr + uw;
  return combined > 0 ? combined : null; // return null if nothing to show
}

// number of unplanned events that produced downtime > 0
function getFailureEventCount(row) {
  // Primary: new server-side field
  if (Number.isFinite(row?.failureEventCount)) return row.failureEventCount;

  // Fallback: derive from an events array if present
  if (Array.isArray(row?.events)) {
    let n = 0;
    for (const e of row.events) {
      const type = (e.type || e.workOrderType || '').toString().toLowerCase();
      const unplanned = type.includes('unplanned') || type.includes('work request');
      const dh = Number.isFinite(e.downtimeHours) ? e.downtimeHours
              : Number.isFinite(e.downtimeMinutes) ? e.downtimeMinutes / 60
              : Number.isFinite(e.metrics?.downtimeHours) ? e.metrics.downtimeHours
              : 0;
      if (unplanned && dh > 0) n++;
    }
    return n;
  }

  // Fallback field if the server names it differently
  if (Number.isFinite(row?.unplannedWithDowntimeCount)) return row.unplannedWithDowntimeCount;

  // Unknown → null so the cell shows "—"
  return null;
}

// downtime hours attributable to failures (unplanned)
function getUnplannedDowntimeHours(row) {
  // Prefer explicit unplanned downtime hours
  const direct = row?.downtimeHoursUnplanned ?? row?.unplannedDowntimeHours ?? row?.unplannedDowntimeHrs;
  if (Number.isFinite(direct)) return direct;

  // Fallback: if no planned downtime fields exist, treat overall downtime as unplanned
  if (!Number.isFinite(row?.plannedDowntimeHours) && !Number.isFinite(row?.plannedDowntimeHrs)) {
    const d = row?.downtimeHours ?? row?.downtimeHrs;
    if (Number.isFinite(d)) return d;
  }

  return null;
}

// operational/run-time hours
function getOperationalHours(row) {
  const direct = row?.operationalHours ?? row?.runtimeHours ?? row?.runtimeHrs;
  return Number.isFinite(direct) ? direct : null;
}

function toNum(v) { return (v == null || v === '') ? null : Number(v); }

function computeRowMttr(row) {
  const failures = getFailureEventCount(row);
  const unplannedDowntime = toNum(row?.downtimeHoursUnplanned ?? row?.unplannedDowntimeHours ?? row?.downtimeHours);
  if (!failures || failures <= 0 || !Number.isFinite(unplannedDowntime)) return null;
  return unplannedDowntime / failures;
}

function computeRowMtbf(row) {
  const failures = getFailureEventCount(row);
  const runHours = toNum(row?.operationalHours);
  if (!failures || failures <= 0 || !Number.isFinite(runHours)) return null;
  return runHours / failures;
}

function updateDateRangeLabel(tf, meta) {
  const el = document.getElementById('date-range');
  if (!el) return;
  let start, end;
  if (meta && meta.startISO && meta.endISO) {
    start = new Date(meta.startISO);
    end   = new Date(meta.endISO);
  } else {
    const now = new Date();
    switch (tf) {
      case 'lastMonth':
        start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        end   = new Date(now.getFullYear(), now.getMonth(), 0);
        break;
      case 'trailing7Days':
        start = new Date(now);
        start.setDate(start.getDate() - 7);
        end = now;
        break;
      case 'trailing30Days':
        start = new Date(now);
        start.setDate(start.getDate() - 30);
        end = now;
        break;
      case 'trailing12Months':
        start = new Date(now);
        start.setFullYear(start.getFullYear() - 1);
        end = now;
        break;
      default:
        el.textContent = '';
        return;
    }
  }
  const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  el.textContent = `${fmt.format(start)} — ${fmt.format(end)}`;
}

export async function loadAll() {
  const tf = timeframeSelect?.value || 'lastMonth';
  const loadingEl = document.getElementById('loading');
  const errorEl   = document.getElementById('error-banner');

  if (loadingEl) loadingEl.style.display = 'flex';
  if (errorEl)   errorEl.style.display = 'none';
  try {
    const res = await fetch(`/api/kpis/by-asset?timeframe=${encodeURIComponent(tf)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const lr = document.getElementById('last-refresh');
    if (lr && data.lastRefreshUtc) {
      const d = new Date(data.lastRefreshUtc);
      lr.textContent = `· Last refresh: ${d.toLocaleString()}`;
    }
    console.debug('[kpi-by-asset] sample row keys:', Object.keys(data.rows?.[0] || Object.values(data.assets || {})[0] || {}));
    console.debug('[kpi-by-asset] sample row values:', data.rows?.[0] || Object.values(data.assets || {})[0]);
    const assets = data.assets;

    // update displayed date window
    updateDateRangeLabel(tf, data.range);

    // clear table and prepare accumulators
    tbody.innerHTML = '';
    const unplannedCounts = [];
    const failureCounts = [];
    const mttrValues = [];
    const mtbfValues = [];
    const plannedCounts = [];

    // each key is an assetID
    Object.values(assets).forEach(a => {
      const tr = document.createElement('tr');

      const d = getDowntimeHours(a);
      const downtimeTd = d == null
        ? `<td class="col-downtime" data-testid="cell-downtime-hrs" title="No downtime data for selected range">—</td>`
        : `<td class="col-downtime" data-testid="cell-downtime-hrs">${d.toFixed(1)}</td>`;

      const unplanned = getUnplannedCount(a);
      const unplannedTd = unplanned == null
        ? `<td class="col-int" data-testid="cell-unplanned-count" title="No unplanned events for selected range">—</td>`
        : `<td class="col-int" data-testid="cell-unplanned-count">${Math.round(unplanned)}</td>`;

      const failures = getFailureEventCount(a);
      const failureTd = failures == null
        ? `<td class="col-int" data-testid="cell-failure-events" title="No failure events in range">—</td>`
        : `<td class="col-int" data-testid="cell-failure-events">${Math.round(failures)}</td>`;

      const planned = Number(a.plannedCount) || 0;
      const totalWo = planned + (unplanned || 0);
      const plannedPct = totalWo > 0 ? (planned / totalWo) * 100 : null;
      const unplannedPct = totalWo > 0 ? ((unplanned || 0) / totalWo) * 100 : null;

      const unplannedDt = getUnplannedDowntimeHours(a);
      const opHours = getOperationalHours(a);
      const mttr = computeRowMttr(a);
      const mtbf = computeRowMtbf(a);

      const mttrTd = mttr == null
        ? `<td title="No failure events in range">—</td>`
        : `<td>${mttr.toFixed(1)}</td>`;
      const mtbfTd = mtbf == null
        ? `<td title="No failure events in range">—</td>`
        : `<td>${mtbf.toFixed(1)}</td>`;

      tr.innerHTML = `
        <td>${a.name}</td>
        ${downtimeTd}
        ${unplannedTd}
        ${failureTd}
        <td>${a.downtimePct.toFixed(1)}</td>
        ${mttrTd}
        ${mtbfTd}
        <td>${plannedPct == null ? '—' : plannedPct.toFixed(1)}</td>
        <td>${unplannedPct == null ? '—' : unplannedPct.toFixed(1)}</td>
      `;
      tbody.appendChild(tr);

      // accumulate per-row values for footer and overall
      if (unplanned != null) unplannedCounts.push(unplanned);
      if (failures != null) failureCounts.push(failures);
      plannedCounts.push(planned);
      if (mttr != null) mttrValues.push(mttr);
      if (mtbf != null) mtbfValues.push(mtbf);
    });

    // update the card averages
    const rows = Object.values(assets);
    const total = rows.length;
    const avg = key => total
      ? rows.reduce((sum,r) => sum + (r[key]||0), 0)/total
      : 0;
    setText('total-assets', total);
    const downtimeVals = rows.map(getDowntimeHours).filter(v => v != null);
    const avgDowntime = downtimeVals.length
      ? downtimeVals.reduce((sum,v) => sum + v, 0) / downtimeVals.length
      : null;
    const totalDowntime = downtimeVals.reduce((sum,v) => sum + v, 0);
    setText('avg-downtime', avgDowntime == null ? '—' : avgDowntime.toFixed(1));
    setText('total-downtime', downtimeVals.length ? totalDowntime.toFixed(1) : '—');
    setText('avg-downtime-pct', avg('downtimePct').toFixed(1) + '%');

    const avgUnplannedCount = unplannedCounts.length
      ? unplannedCounts.reduce((s,v) => s + v, 0) / unplannedCounts.length
      : null;
    const totalUnplannedCount = unplannedCounts.reduce((s,v) => s + v, 0);
    setText('avg-unplanned-count', avgUnplannedCount == null ? '—' : avgUnplannedCount.toFixed(1));
    setText('total-unplanned-count', unplannedCounts.length ? totalUnplannedCount.toString() : '—');

    const avgFailureEvents = failureCounts.length
      ? failureCounts.reduce((s,v) => s + v, 0) / failureCounts.length
      : null;
    const totalFailureEvents = failureCounts.reduce((s,v) => s + v, 0);
    setText('avg-failure-events', avgFailureEvents == null ? '—' : avgFailureEvents.toFixed(1));
    setText('total-failure-events', failureCounts.length ? totalFailureEvents.toString() : '—');

    const avgMTTR = mttrValues.length
      ? mttrValues.reduce((s,v) => s + v, 0) / mttrValues.length
      : null;
    setText('avg-mttr', avgMTTR == null ? '—' : avgMTTR.toFixed(1));

    const avgMTBF = mtbfValues.length
      ? mtbfValues.reduce((s,v) => s + v, 0) / mtbfValues.length
      : null;
    setText('avg-mtbf', avgMTBF == null ? '—' : avgMTBF.toFixed(1));

    const totalPlanned = plannedCounts.reduce((s,v) => s + v, 0);
    const plannedPctAvg = (totalPlanned + totalUnplannedCount) > 0
      ? (totalPlanned / (totalPlanned + totalUnplannedCount)) * 100
      : null;
    const unplannedPctAvg = (totalPlanned + totalUnplannedCount) > 0
      ? (totalUnplannedCount / (totalPlanned + totalUnplannedCount)) * 100
      : null;
    setText('avg-planned', plannedPctAvg == null ? '—' : plannedPctAvg.toFixed(1) + '%');
    setText('avg-unplanned', unplannedPctAvg == null ? '—' : unplannedPctAvg.toFixed(1) + '%');

    // render true overall tiles using failure events
    const overall = computeTrueOverall(data);
    renderTrueOverall(overall);
  } catch (err) {
    console.error('loadAll failed:', err);
    if (errorEl) errorEl.style.display = 'block';
  } finally {
    if (loadingEl) loadingEl.style.display = 'none';
  }
}

if (timeframeSelect) {
  const saved = localStorage.getItem('kpiTimeframe');
  if (saved && [...timeframeSelect.options].some(o => o.value === saved)) {
    timeframeSelect.value = saved;
  } else {
    timeframeSelect.value = 'lastMonth';
  }
  timeframeSelect.addEventListener('change', () => {
    localStorage.setItem('kpiTimeframe', timeframeSelect.value);
    loadAll();
  });
}

// expose to non-module inline scripts that call loadAll()
window.loadAll = loadAll;
loadAll();

function renderTrueOverall(kpis) {
  const specs = [
    { id: 'tile-downtime',   key: 'downtimePct',  val: kpis.downtimePct, suffix: '%' },
    { id: 'tile-mttr',       key: 'mttrHours',    val: kpis.mttrHrs,     suffix: 'h' },
    { id: 'tile-mtbf',       key: 'mtbfHours',    val: kpis.mtbfHrs,     suffix: 'h' },
    { id: 'tile-planned',    key: 'plannedPct',   val: kpis.plannedPct,  suffix: '%' },
    { id: 'tile-unplanned',  key: 'unplannedPct', val: kpis.unplannedPct, suffix: '%' }
  ];

  for (const t of specs) {
    const tileEl = document.getElementById(t.id);
    const valEl  = tileEl?.querySelector('.value');
    if (!tileEl || !valEl) continue;
    const v = t.val;
    if (v == null || isNaN(v)) {
      valEl.textContent = '—';
      valEl.title = 'No data';
    } else {
      valEl.textContent = t.suffix === '%'
        ? `${v.toFixed(1)}%`
        : `${v.toFixed(1)} h`;
      valEl.removeAttribute('title');
    }
    applyTileTheme(tileEl, t.key, v, window.kpiTheme);
  }
}

