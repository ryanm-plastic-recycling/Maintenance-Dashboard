// public/js/header-kpis.js

let headerKpisCache;
let initialFetchPromise;

function renderHeader(overall = {}) {
  const uptimeEl   = document.getElementById('uptime-value');
  const mttrEl     = document.getElementById('mttr-value');
  const mtbfEl     = document.getElementById('mtbf-value');
  const pvupEl     = document.getElementById('planned-vs-unplanned');

  if (uptimeEl) uptimeEl.innerText = `${overall.uptimePct ?? '--'}%`;
  if (mttrEl)   mttrEl.innerText   = `${overall.mttrHrs ?? '--'}h`;
  if (mtbfEl)   mtbfEl.innerText   = `${overall.mtbfHrs ?? '--'}h`;

  const total = (overall.plannedCount || 0) + (overall.unplannedCount || 0);
  const pPct  = total ? ((overall.plannedCount / total) * 100).toFixed(0)   : '--';
  const uPct  = total ? ((overall.unplannedCount / total) * 100).toFixed(0) : '--';
  if (pvupEl) pvupEl.innerText = `${pPct}% vs ${uPct}%`;
}

async function _updateHeader() {
  try {
    const res = await fetch('/api/kpis');
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    headerKpisCache = data;
    renderHeader(data.overall);
  } catch (err) {
    console.error('Header KPI fetch failed:', err);
  }
}

export function initHeaderKPIs() {
  initialFetchPromise = _updateHeader();
  setInterval(_updateHeader, 15 * 60 * 1000);
}

export function getHeaderKpisCache() {
  return headerKpisCache;
}

export function headerKpisReady() {
  return initialFetchPromise || Promise.resolve();
}

// expose for global use
window.updateKPIs = _updateHeader;
