function getFailureEventCount(row) {
  if (Number.isFinite(row?.failureEventCount)) return row.failureEventCount;
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
  if (Number.isFinite(row?.unplannedWithDowntimeCount)) return row.unplannedWithDowntimeCount;
  return 0;
}

/**
 * Compute true overall KPIs for the by-asset payload.
 * Prefers additive totals from payload.totals, falls back to summing per-asset fields.
 * For uptimePct, if we cannot compute due to missing hours the result is null.
 * @param {object} data - payload from /api/kpis/by-asset
 * @returns {{uptimePct: number|null, mttrHrs: number|null, mtbfHrs: number|null, plannedPct: number|null, unplannedPct: number|null}}
 */
export function computeTrueOverall(data = {}) {
  const rows = data.rows || data.byAsset || Object.values(data.assets || {});
  const totals = data.totals || {};

  const getTotal = (field, derive) => {
    if (Number.isFinite(totals[field])) return totals[field];
    if (derive) return derive(rows);
    return rows.reduce((sum, r) => sum + (Number(r[field]) || 0), 0);
  };

  const downtime = getTotal('downtimeHrs');
  const operationalHours = getTotal('operationalHours', rs => rs.reduce((a,r) => a + (Number(r?.operationalHours) || 0), 0));
  const planned = getTotal('plannedCount');
  const unplanned = getTotal('unplannedCount');
  const failures = getTotal('failureEventCount', rs => rs.reduce((a,r) => a + getFailureEventCount(r), 0));
  const unplannedDowntime = getTotal('downtimeHoursUnplanned', rs => rs.reduce((a,r) => a + (Number(r?.downtimeHoursUnplanned) || 0), 0));

  const totalWo = planned + unplanned;

  let uptimePct = null;
  if (operationalHours > 0) {
    uptimePct = (1 - (downtime / operationalHours)) * 100;
  }

  const mttr = failures > 0 ? unplannedDowntime / failures : null;
  const mtbf = failures > 0 ? operationalHours / failures : null;
  const plannedPct = totalWo > 0 ? (planned / totalWo) * 100 : null;
  const unplannedPct = totalWo > 0 ? (unplanned / totalWo) * 100 : null;

  return { uptimePct, mttrHrs: mttr, mtbfHrs: mtbf, plannedPct, unplannedPct };
}
