import express from 'express';
import { refreshHeaderKpis, refreshByAssetKpis, refreshWorkOrders } from '../jobs/kpiJobs.js';
import { runFullRefresh } from '../jobs/pipeline.js';
import { requireAdmin } from '../lib/adminAuth.js';

export default function adminRoutes(poolPromise) {
  const r = express.Router();

  r.post('/admin/full-refresh', async (req, res) => {
    const pool = await poolPromise;
    const result = await runFullRefresh(pool);
    res.json(result);
  });

  r.post('/cache/refresh', async (req, res) => {
    const pool = await poolPromise;
    const hdr = await refreshHeaderKpis(pool);
    const byAsset = await refreshByAssetKpis(pool);
    await refreshWorkOrders(pool, 'index');
    await refreshWorkOrders(pool, 'pm');
    await refreshWorkOrders(pool, 'prodstatus');
    res.json({ ok: true, header: hdr, byAsset });
  });

  // POST /api/admin/run-prod-excel  { password }
  r.post('/admin/run-prod-excel', requireAdmin, async (req, res) => {
    try {
      const pool = await poolPromise;
      const { runProdExcelIngest } = await import('../jobs/prodExcelIngest.js');
      const { enrichNameplateFromMappings } = await import('../jobs/enrichNameplateJob.js');
  
      const dry = String(req.query.dry || '').toLowerCase() === '1';
      const res1 = await runProdExcelIngest({ pool, dry });
  
      await pool.request().query(`UPDATE dbo.UpdateSchedules SET LastRun = SYSUTCDATETIME() WHERE Name='prod-excel'`);
  
      let enriched = null;
      if (!dry) {
        const res2 = await enrichNameplateFromMappings(pool);
        enriched = res2.updated;
      }
  
      res.json({ ok: true, dry, ...res1, enriched });
    } catch (e) {
      console.error('[prod-excel] failed:', e?.stack || e);
      if (e && typeof e === 'object') {
        console.error('[prod-excel] context:', { stage: e.stage, rowIndex: e.rowIndex, rowSample: e.rowSample });
      }
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  return r;
}

console.log('[adminAuth] basic?', !!ADMIN_USER && !!ADMIN_PASS, 'bearer?', !!ADMIN_TOKEN);
