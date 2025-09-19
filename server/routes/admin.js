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

// POST /api/admin/run-prod-excel  { password }
r.post('/admin/run-prod-excel', async (req, res) => {
  try {
    if ((req.body?.password || '') !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const pool = await poolPromise;
    const { ingestProductionExcel } = await import('../jobs/productionExcelJob.js');
    const { enrichNameplateFromMappings } = await import('../jobs/enrichNameplateJob.js');

    const res1 = await ingestProductionExcel(pool);
    const res2 = await enrichNameplateFromMappings(pool);
    await pool.request().query(`UPDATE dbo.UpdateSchedules SET LastRun = SYSUTCDATETIME() WHERE Name='prod-excel'`);
    res.json({ ok: true, ingested: res1.rows, enriched: res2.updated });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

