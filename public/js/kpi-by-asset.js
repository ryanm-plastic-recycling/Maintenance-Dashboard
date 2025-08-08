import { computeTrueOverall } from './compute-true-overall.js';
import { headerKpisReady } from './header-kpis.js';

let mappings;
await fetch('/mappings.json')
  .then(r => r.json())
  .then(m => mappings = m)
  .catch(err => console.error('Failed to load mappings', err));

const timeframeSelect = document.getElementById('timeframe-select');
const tbody     = document.querySelector('#kpi-by-asset tbody');

console.log('[kpi-by-asset.js] module loaded');

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
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
  // Prefer explicit aggregated field if present
  if (Number.isFinite(row?.failureEventCount)) return row.failureEventCount;

  // Derive from event list, if available
  if (Array.isArray(row?.events)) {
    const cnt = row.events.filter(e =>
      (e?.type === 'workRequest' || e?.type === 'unplanned') &&
      Number(e?.downtimeHours) > 0
    ).length;
    return cnt > 0 ? cnt : null;
  }

  // Fallback: if server exposes pre-sliced counts
  if (Number.isFinite(row?.unplannedWithDowntimeCount)) return row.unplannedWithDowntimeCount;

  return null; // TODO: replace with direct API field when available
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
  await headerKpisReady();
  const tf = timeframeSelect?.value || 'lastMonth';
  const loadingEl = document.getElementById('loading');
  const errorEl   = document.getElementById('error-banner');

  if (loadingEl) loadingEl.style.display = 'flex';
  if (errorEl)   errorEl.style.display = 'none';
  try {
    const res = await fetch(`/api/kpis/by-asset?timeframe=${encodeURIComponent(tf)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
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
    let totalUnplannedDowntime = 0;
    let totalOperational = 0;

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
      const mttr = failures > 0 && unplannedDt != null ? unplannedDt / failures : null;
      const mtbf = failures > 0 && opHours != null ? opHours / failures : null;

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
        <td>${a.uptimePct.toFixed(1)}</td>
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
      if (unplannedDt != null) totalUnplannedDowntime += unplannedDt;
      if (opHours != null) totalOperational += opHours;
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
    setText('avg-downtime', avgDowntime == null ? '—' : avgDowntime.toFixed(1));
    setText('avg-uptime',  avg('uptimePct').toFixed(1) + '%');

    const avgUnplannedCount = unplannedCounts.length
      ? unplannedCounts.reduce((s,v) => s + v, 0) / unplannedCounts.length
      : null;
    setText('avg-unplanned-count', avgUnplannedCount == null ? '—' : avgUnplannedCount.toFixed(1));

    const avgFailureEvents = failureCounts.length
      ? failureCounts.reduce((s,v) => s + v, 0) / failureCounts.length
      : null;
    setText('avg-failure-events', avgFailureEvents == null ? '—' : avgFailureEvents.toFixed(1));

    const avgMTTR = mttrValues.length
      ? mttrValues.reduce((s,v) => s + v, 0) / mttrValues.length
      : null;
    setText('avg-mttr', avgMTTR == null ? '—' : avgMTTR.toFixed(1));

    const avgMTBF = mtbfValues.length
      ? mtbfValues.reduce((s,v) => s + v, 0) / mtbfValues.length
      : null;
    setText('avg-mtbf', avgMTBF == null ? '—' : avgMTBF.toFixed(1));

    const totalPlanned = plannedCounts.reduce((s,v) => s + v, 0);
    const totalUnplanned = unplannedCounts.reduce((s,v) => s + v, 0);
    const plannedPctAvg = (totalPlanned + totalUnplanned) > 0
      ? (totalPlanned / (totalPlanned + totalUnplanned)) * 100
      : null;
    const unplannedPctAvg = (totalPlanned + totalUnplanned) > 0
      ? (totalUnplanned / (totalPlanned + totalUnplanned)) * 100
      : null;
    setText('avg-planned', plannedPctAvg == null ? '—' : plannedPctAvg.toFixed(1) + '%');
    setText('avg-unplanned', unplannedPctAvg == null ? '—' : unplannedPctAvg.toFixed(1) + '%');

    // render true overall tiles using failure events
    const overall = computeTrueOverall(data);
    const totalFailureEvents = Number.isFinite(data?.totals?.failureEventCount)
      ? data.totals.failureEventCount
      : failureCounts.reduce((s,v) => s + v, 0);
    const totalFailureDowntime = Number.isFinite(data?.totals?.downtimeHoursUnplanned)
      ? data.totals.downtimeHoursUnplanned
      : totalUnplannedDowntime;
    const totalOperationalHours = Number.isFinite(data?.totals?.operationalHours)
      ? data.totals.operationalHours
      : Number.isFinite(data?.totals?.runtimeHours)
        ? data.totals.runtimeHours
        : totalOperational;
    overall.mttrHrs = totalFailureEvents > 0 ? totalFailureDowntime / totalFailureEvents : null;
    overall.mtbfHrs = totalFailureEvents > 0 ? totalOperationalHours / totalFailureEvents : null;
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
  const setTile = (testId, val, suffix) => {
    const el = document.querySelector(`[data-testid="${testId}"]`);
    if (!el) return;
    if (val == null || isNaN(val)) {
      el.textContent = '—';
      el.title = 'No data';
    } else {
      const formatted = suffix === '%'
        ? `${val.toFixed(1)}%`
        : `${val.toFixed(1)} h`;
      el.textContent = formatted;
      el.removeAttribute('title');
    }
  };

  setTile('true-overall-uptime', kpis.uptimePct, '%');
  setTile('true-overall-mttr', kpis.mttrHrs, 'h');
  setTile('true-overall-mtbf', kpis.mtbfHrs, 'h');
  setTile('true-overall-planned', kpis.plannedPct, '%');
  setTile('true-overall-unplanned', kpis.unplannedPct, '%');
}

