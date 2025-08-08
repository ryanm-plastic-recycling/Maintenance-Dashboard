import { getHeaderKpisCache } from './header-kpis.js';

/**
 * Compute true overall KPIs for the by-asset payload.
 * Prefers additive totals from payload.totals, falls back to summing per-asset fields.
 * For uptimePct, if we cannot compute due to missing hours, fall back to
 * headerKpisCache.overall.uptimePct so the tile never shows blank.
 * @param {object} data - payload from /api/kpis/by-asset
 * @returns {{uptimePct: number|null, mttrHrs: number|null, mtbfHrs: number|null, plannedPct: number|null, unplannedPct: number|null}}
 */
export function computeTrueOverall(data = {}) {
  const assets = data.assets || {};
  const totals = data.totals || {};

  const sumField = (field) => {
    if (typeof totals[field] === 'number') return totals[field];
    return Object.values(assets).reduce((sum, a) => sum + (a[field] || 0), 0);
  };

  const downtime = sumField('downtimeHrs');
  const scheduled = sumField('scheduledHrs');
  const repair = sumField('repairHrs');
  const runtime = sumField('runtimeHrs');
  const failures = sumField('failureCount') || sumField('unplannedCount');
  const planned = sumField('plannedCount');
  const unplanned = sumField('unplannedCount');

  const totalWo = planned + unplanned;

  let uptimePct = null;
  if (scheduled > 0) {
    uptimePct = (1 - (downtime / scheduled)) * 100;
  } else {
    // Fallback to server computed overall uptime so tile never blank
    const cached = getHeaderKpisCache();
    if (cached && typeof cached.overall?.uptimePct === 'number') {
      uptimePct = cached.overall.uptimePct;
    }
  }

  const mttr = failures > 0 ? (repair / failures) : null;
  const mtbf = failures > 0 ? (runtime / failures) : null;
  const plannedPct = totalWo > 0 ? (planned / totalWo) * 100 : null;
  const unplannedPct = totalWo > 0 ? (unplanned / totalWo) * 100 : null;

  return { uptimePct, mttrHrs: mttr, mtbfHrs: mtbf, plannedPct, unplannedPct };
}
