import 'dotenv/config';
import sql from 'mssql';
import { refreshHeaderKpis, refreshByAssetKpis, refreshWorkOrders } from '../server/jobs/kpiJobs.js';
import { ingestProductionExcel } from '../server/jobs/productionExcelJob.js';

const cfg = {
  server: process.env.AZURE_SQL_SERVER,
  database: process.env.AZURE_SQL_DB,
  user: process.env.AZURE_SQL_USER,
  password: process.env.AZURE_SQL_PASS,
  options: { encrypt: true, trustServerCertificate: false }
};

['AZURE_SQL_SERVER','AZURE_SQL_DB','AZURE_SQL_USER','AZURE_SQL_PASS'].forEach(k => {
  if (!process.env[k]) {
    throw new Error(`Missing env: ${k}. Did you load .env (import 'dotenv/config') and run from the repo root?`);
  }
});


async function main() {
  const pool = await new sql.ConnectionPool(cfg).connect();
  const arg = process.argv[2] || '--all';

  if (arg === '--header'     || arg === '--all') await refreshHeaderKpis(pool);
  if (arg === '--by-asset'   || arg === '--all') await refreshByAssetKpis(pool);
  if (arg === '--wo-index'   || arg === '--all') await refreshWorkOrders(pool, 'index');
  if (arg === '--wo-pm'      || arg === '--all') await refreshWorkOrders(pool, 'pm');
  if (arg === '--wo-status'  || arg === '--all') await refreshWorkOrders(pool, 'prodstatus');
  if (arg === '--prod-excel' || arg === '--all') {
    const res = await ingestProductionExcel(pool);
    console.log('Production Excel ingested:', res.rows);
  }

  await pool.close();
  console.log('Done:', arg);
}
main().catch(e => { console.error(e); process.exit(1); });
