// scripts/run-jobs-once.mjs
import 'dotenv/config';
import sql from 'mssql';
import { refreshHeaderKpis, refreshByAssetKpis, refreshWorkOrders } from '../server/jobs/kpiJobs.js';
import { ingestProductionExcel } from '../server/jobs/productionExcelJob.js';
import { enrichNameplateFromMappings } from '../server/jobs/enrichNameplateJob.js';

const cfg = {
  server: process.env.AZURE_SQL_SERVER,
  database: process.env.AZURE_SQL_DB,
  user: process.env.AZURE_SQL_USER,
  password: process.env.AZURE_SQL_PASS,
  options: { encrypt: true, trustServerCertificate: false }
};

// sanity: fail fast if DB envs missing
['AZURE_SQL_SERVER','AZURE_SQL_DB','AZURE_SQL_USER','AZURE_SQL_PASS'].forEach(k => {
  if (!process.env[k]) throw new Error(`Missing env: ${k}`);
});

async function main() {
  const pool = await new sql.ConnectionPool(cfg).connect();
  const arg = process.argv[2] || '--all';

  try {
    // KPI refreshers (existing)
    if (arg === '--header'     || arg === '--all') await refreshHeaderKpis(pool);
    if (arg === '--by-asset'   || arg === '--all') await refreshByAssetKpis(pool);
    if (arg === '--wo-index'   || arg === '--all') await refreshWorkOrders(pool, 'index');
    if (arg === '--wo-pm'      || arg === '--all') await refreshWorkOrders(pool, 'pm');
    if (arg === '--wo-status'  || arg === '--all') await refreshWorkOrders(pool, 'prodstatus');

    // Production ingest + enrichment (+ schedule stamp)
    if (arg === '--prod-excel' || arg === '--all') {
      const res = await ingestProductionExcel(pool);
      console.log('Production Excel ingested:', res.rows);
      const enrich = await enrichNameplateFromMappings(pool);
      console.log('Nameplate enrichment updated rows:', enrich?.updated ?? '(n/a)');

      // Track last run
      const up = await pool.request().query(`
        MERGE dbo.UpdateSchedules AS tgt
        USING (SELECT 'prod-excel' AS Name) AS src
        ON (tgt.Name = src.Name)
        WHEN MATCHED THEN UPDATE SET LastRun = SYSUTCDATETIME(), Cron = ISNULL(tgt.Cron, '0 * * * *'), Enabled = ISNULL(tgt.Enabled, 1)
        WHEN NOT MATCHED THEN INSERT (Name, Cron, Enabled, LastRun) VALUES ('prod-excel','0 * * * *',1,SYSUTCDATETIME());
      `);
      console.log('UpdateSchedules stamped for prod-excel.');
    }
  } finally {
    await pool.close();
  }

  console.log('Done:', arg);
}

// run
main().catch(e => { console.error(e); process.exit(1); });
