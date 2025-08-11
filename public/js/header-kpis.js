// public/js/header-kpis.js
import { computeTrueOverall } from './compute-true-overall.js';

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
    // graceful retry if somehow 304 or other caching weirdness
    const res2 = await fetch(u, { cache: 'reload' });
    if (!res2.ok) throw new Error(`HTTP ${res.status} then ${res2.status}`);
    return res2.json();
  }
  return res.json();
}

// Try last30d first (backwards-compat), then trailing30Days
async function fetchThirtyDayWindow() {
  try {
    return await fetchJsonNo304('/api/kpis/by-asset?timeframe=last30d');
  } catch (e) {
    return await fetchJsonNo304('/api/kpis/by-asset?timeframe=trailing30Days');
  }
}

function computePlannedUnplannedPct(src) {
  // Prefer server/compute-true-overall if it provides plannedPct/unplannedPct
  const o = computeTrueOverall(src) || {};
  if (o.plannedPct != null && o.unplannedPct != null) return { p: o.plannedPct, u: o.unplannedPct };

  // Fallback: derive from counts
  const p = Number(src?.totals?.plannedCount || 0);
  const u = Number(src?.totals?.unplannedCount || 0);
  const denom = p + u;
  if (!denom) return { p: null, u: null };
  const plannedPct = (100 * p) / denom;
  return { p: plannedPct, u: 100 - plannedPct };
}

export async function initHeaderKPIs() {
  try {
    // parallel fetch (week + 30d) with cache-busting
    const [weekData, monthData] = await Promise.all([
      fetchJsonNo304('/api/kpis/by-asset?timeframe=lastWeek'),
      fetchThirtyDayWindow()
    ]);

    // Overall aggregates (prefer computeTrueOverall but tolerate missing fields)
    const weekOverall  = computeTrueOverall(weekData)  || {};
    const monthOverall = computeTrueOverall(monthData) || {};

    // Uptime (last week)
    const uptime = weekOverall.uptimePct ?? weekData?.totals?.uptimePct ?? null;
    setText('uptime-value', fmtPct(uptime));

    // MTTR / MTBF (last 30 days)
    const mttr = monthOverall.mttrHrs ?? monthData?.totals?.mttrHrs ?? null;
    const mtbf = monthOverall.mtbfHrs ?? monthData?.totals?.mtbfHrs ?? null;
    setText('mttr-value', fmtHrs(mttr));
    setText('mtbf-value', fmtHrs(mtbf));

    // Planned vs Unplanned (last week)
    const { p, u } = computePlannedUnplannedPct(weekData);
    const pvup = document.getElementById('planned-vs-unplanned');
    if (pvup) {
      const pText = p == null ? '--' : p.toFixed(0);
      const uText = u == null ? '--' : u.toFixed(0);
      pvup.textContent = `${pText}% vs ${uText}%`;
    }

  } catch (err) {
    console.error('Header KPI load error:', err);
    setText('uptime-value', '--%');
    setText('mttr-value', '--h');
    setText('mtbf-value', '--h');
    setText('planned-vs-unplanned', '--% vs --%');
  }

  // refresh every 15 minutes
  setTimeout(initHeaderKPIs, 15 * 60 * 1000);
}

// Ensure DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initHeaderKPIs);
} else {
  initHeaderKPIs();
}
