// server/routes/admin.js (ESM)
import express from 'express';
import { refreshHeaderKpis, refreshByAssetKpis, refreshWorkOrders } from '../jobs/kpiJobs.js';
import { runFullRefresh } from '../jobs/pipeline.js';
import { requireAdmin } from '../lib/adminAuth.js';
import { runProdExcelIngest } from '../jobs/prodExcelIngest.js';

export default function adminRoutes(poolPromise) {
  const r = express.Router();
  
  // POST /api/admin/run-prod-excel  { password }
 r.post('/admin/run-prod-excel', requireAdmin, async (req, res) => {
    try {
      const pool = await poolPromise;
      const dry = String(req.query.dry || '1') === '1';
      const out = await runProdExcelIngest({ pool, dry });
      res.json({ ok:true, dry, ...out });
    } catch (e) {
      res.status(500).json({ ok:false, error:String(e.message || e) });
    }
  });
  
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

  return r;
}
