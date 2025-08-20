import sql from 'mssql';
import { refreshHeaderKpis, refreshByAssetKpis, refreshWorkOrders } from './kpiJobs.js';
import { syncLimbleToSql } from './limbleSync.js';

let running = false;

export async function runFullRefresh(pool) {
  if (running) return { started: false, reason: 'already running' };
  running = true;
  const out = { steps: [] };
  try {
    // 1) Limble → SQL
    const t0 = Date.now();
    const syncRes = await syncLimbleToSql(pool);
    out.steps.push({ step: 'limble-sync', ms: Date.now() - t0, result: syncRes });

    // 2) Header KPIs
    const t1 = Date.now();
    const hdr = await refreshHeaderKpis(pool);
    out.steps.push({ step: 'header-kpis', ms: Date.now() - t1, result: hdr });

    // 3) By-Asset KPIs
    const t2 = Date.now();
    const byAsset = await refreshByAssetKpis(pool);
    out.steps.push({ step: 'by-asset-kpis', ms: Date.now() - t2, result: byAsset });

    // 4) WorkOrders for each page
    const pages = ['index','pm','prodstatus'];
    for (const p of pages) {
      const t3 = Date.now();
      const res = await refreshWorkOrders(pool, p);
      out.steps.push({ step: `workorders:${p}`, ms: Date.now() - t3, result: res });
    }

    out.ok = true;
  } catch (e) {
    out.ok = false;
    out.error = e.message;
  } finally {
    running = false;
  }
  return out;
}
