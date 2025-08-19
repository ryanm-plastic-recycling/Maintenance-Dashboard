// public/js/header-kpis.js
console.log('[header-kpis.js] module loaded');

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return '--%';
  return `${Number(n).toFixed(1)}%`;
}
function fmtHrs(n) {
  if (n == null || isNaN(n)) return '--h';
  return `${Number(n).toFixed(1)}h`;
}

async function fetchJsonNo304(url) {
  const u = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
  const res = await fetch(u, { cache: 'no-store' });
  if (!res.ok) {
    const res2 = await fetch(u, { cache: 'reload' });
    if (!res2.ok) throw new Error(`HTTP ${res.status} then ${res2.status}`);
    return res2.json();
  }
  return res.json();
}

// Fetch consolidated header KPIs
async function fetchHeader() {
  return await fetchJsonNo304('/api/kpis/header');
}

export async function loadHeaderKpis() {
  try {
    const header = await fetchHeader();
    const weekly  = header?.weekly  || {};
    const monthly = header?.monthly || {};

    // Downtime percentage is derived from UptimePct
    const downtime = (typeof weekly.UptimePct === 'number') ? (100 - Number(weekly.UptimePct)) : null;
    setText('downtime-value', fmtPct(downtime));

    // MTTR / MTBF
    const mttr = typeof monthly.MttrHrs === 'number' ? monthly.MttrHrs : null;
    const mtbf = typeof monthly.MtbfHrs === 'number' ? monthly.MtbfHrs : null;
    setText('mttr-value', fmtHrs(mttr));
    setText('mtbf-value', fmtHrs(mtbf));

    // Planned vs Unplanned percentages from counts
    const pCount = Number(weekly.PlannedCount) || 0;
    const uCount = Number(weekly.UnplannedCount) || 0;
    const denom = pCount + uCount;
    const plannedPct = denom ? (pCount / denom) * 100 : null;
    const unplannedPct = denom ? (uCount / denom) * 100 : null;
    const pvup = document.getElementById('planned-vs-unplanned');
    if (pvup) {
      const pText = plannedPct == null ? '--' : plannedPct.toFixed(0);
      const uText = unplannedPct == null ? '--' : unplannedPct.toFixed(0);
      pvup.textContent = `${pText}% vs ${uText}%`;
    }

    // Expose last refresh if needed
    window.__headerLastRefreshUtc = header?.lastRefreshUtc || null;
  } catch (err) {
    console.error('Header KPI load error:', err);
    setText('downtime-value', '--%');
    setText('mttr-value', '--h');
    setText('mtbf-value', '--h');
    setText('planned-vs-unplanned', '--% vs --%');
  }

  // refresh every 15 minutes
  setTimeout(loadHeaderKpis, 15 * 60 * 1000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadHeaderKpis);
} else {
  loadHeaderKpis();
}

