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

    // clear table
    tbody.innerHTML = '';

    // each key is an assetID
    Object.values(assets).forEach(a => {
      const tr = document.createElement('tr');
      const d = getDowntimeHours(a);
      const downtimeTd = d == null
        ? `<td class="col-downtime" data-testid="cell-downtime-hrs" title="No downtime data for selected range">—</td>`
        : `<td class="col-downtime" data-testid="cell-downtime-hrs">${d.toFixed(1)}</td>`;
      tr.innerHTML = `
        <td>${a.name}</td>
        ${downtimeTd}
        <td>${a.uptimePct.toFixed(1)}</td>
        <td>${a.mttrHrs.toFixed(1)}</td>
        <td>${a.mtbfHrs.toFixed(1)}</td>
        <td>${((a.plannedCount/(a.plannedCount+a.unplannedCount))*100||0).toFixed(1)}</td>
        <td>${((a.unplannedCount/(a.plannedCount+a.unplannedCount))*100||0).toFixed(1)}</td>
      `;
      tbody.appendChild(tr);
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
    setText('avg-mttr',    avg('mttrHrs').toFixed(1));
    setText('avg-mtbf',    avg('mtbfHrs').toFixed(1));
    setText('avg-planned', ((avg('plannedCount')/(avg('plannedCount')+avg('unplannedCount')))*100||0).toFixed(1)+'%');
    setText('avg-unplanned',((avg('unplannedCount')/(avg('plannedCount')+avg('unplannedCount')))*100||0).toFixed(1)+'%');

    // render true overall tiles
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

