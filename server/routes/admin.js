import express from 'express';
import { refreshHeaderKpis, refreshByAssetKpis, refreshWorkOrders } from '../jobs/kpiJobs.js';
import { runFullRefresh } from '../jobs/pipeline.js';

export default function adminRoutes(poolPromise) {
  const r = express.Router();

  // Full pipeline: Limble→SQL→UI caches
  r.post('/admin/full-refresh', async (req, res) => {
    const pool = await poolPromise;
    const result = await runFullRefresh(pool);
    res.json(result);
  });

  // Existing cache-refresh only:
  r.post('/cache/refresh', async (req, res) => {
    const pool = await poolPromise;
    const hdr = await refreshHeaderKpis(pool);
    const byAsset = await refreshByAssetKpis(pool);
    const pages = ['index', 'pm', 'prodstatus'];
    const work = [];
    for (const p of pages) {
      work.push(await refreshWorkOrders(pool, p));
    }
    res.json({ ok: true, header: hdr, byAsset, work });
  });

  return r;
}
