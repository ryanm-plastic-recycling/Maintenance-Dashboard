import sql from 'mssql';
import { refreshHeaderKpis, refreshByAssetKpis, refreshWorkOrders } from '../server/jobs/kpiJobs.js';

const cfg = {
  server: process.env.AZURE_SQL_SERVER,
  database: process.env.AZURE_SQL_DB,
  user: process.env.AZURE_SQL_USER,
  password: process.env.AZURE_SQL_PASS,
  options: { encrypt: true }
};

async function main() {
  const pool = await new sql.ConnectionPool(cfg).connect();
  const arg = process.argv[2] || '--all';
  if (arg === '--header' || arg === '--all') await refreshHeaderKpis(pool);
  if (arg === '--by-asset' || arg === '--all') await refreshByAssetKpis(pool);
  if (arg === '--wo-index' || arg === '--all') await refreshWorkOrders(pool, 'index');
  if (arg === '--wo-pm' || arg === '--all') await refreshWorkOrders(pool, 'pm');
  if (arg === '--wo-status' || arg === '--all') await refreshWorkOrders(pool, 'prodstatus');
  await pool.close();
  console.log('Done:', arg);
}
main().catch(e => { console.error(e); process.exit(1); });

