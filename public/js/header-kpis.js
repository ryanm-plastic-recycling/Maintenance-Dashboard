// public/js/header-kpis.js

import { computeTrueOverall } from './compute-true-overall.js';

let headerKpisCache;
let initialFetchPromise;

function renderHeader(kpis = {}) {
  const uptimeEl = document.getElementById('uptime-value');
  const mttrEl   = document.getElementById('mttr-value');
  const mtbfEl   = document.getElementById('mtbf-value');
  const pvupEl   = document.getElementById('planned-vs-unplanned');

  const uptime = kpis.lastWeek?.uptimePct;
  const mttr   = kpis.trailing30Days?.mttrHrs;
  const mtbf   = kpis.trailing30Days?.mtbfHrs;
  const pPct   = kpis.lastWeek?.plannedPct;
  const uPct   = kpis.lastWeek?.unplannedPct;

  if (uptimeEl) uptimeEl.innerText = uptime != null ? `${uptime.toFixed(1)}%` : '--%';
  if (mttrEl)   mttrEl.innerText   = mttr   != null ? `${mttr.toFixed(1)}h`   : '--h';
  if (mtbfEl)   mtbfEl.innerText   = mtbf   != null ? `${mtbf.toFixed(1)}h`   : '--h';
  if (pvupEl) {
    const p = pPct != null ? pPct.toFixed(0) : '--';
    const u = uPct != null ? uPct.toFixed(0) : '--';
    pvupEl.innerText = `${p}% vs ${u}%`;
  }
}

async function _updateHeader() {
  try {
    const [weekRes, monthRes] = await Promise.all([
      fetch('/api/kpis/by-asset?timeframe=lastWeek'),
      fetch('/api/kpis/by-asset?timeframe=trailing30Days')
    ]);

    if (!weekRes.ok) throw new Error(await weekRes.text());
    if (!monthRes.ok) throw new Error(await monthRes.text());

    const [weekData, monthData] = await Promise.all([
      weekRes.json(),
      monthRes.json()
    ]);

    const lastWeekOverall   = computeTrueOverall(weekData);
    const trailing30Overall = computeTrueOverall(monthData);

    headerKpisCache = {
      lastWeek: lastWeekOverall,
      trailing30Days: trailing30Overall,
      overall: { uptimePct: lastWeekOverall.uptimePct }
    };

    renderHeader({
      lastWeek: lastWeekOverall,
      trailing30Days: trailing30Overall
    });
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
