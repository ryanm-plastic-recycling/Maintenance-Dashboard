/** 
 * Pull fresh data from Limble API and write into SQL tables.
 * Replace this stub with your real ETL logic or stored-proc call.
 */
export async function syncLimbleToSql(pool) {
  // e.g. await pool.request().execute('dbo.SyncFromLimble');
  return { ok: true, note: 'stubbed limble→SQL sync' };
}
