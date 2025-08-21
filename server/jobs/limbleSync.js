/** 
 * Pull fresh data from Limble API and write into SQL tables.
 * Replace this stub with your real ETL logic or stored-proc call.
 */
export async function syncLimbleToSql(pool) {
  const proc = process.env.LIMBLE_SYNC_PROC;
  if (!proc) {
    return { ok: true, skipped: true, note: 'LIMBLE_SYNC_PROC not set; skipping Limble sync' };
  }
  const rs = await pool.request().execute(proc);
  return { ok: true, proc, rowsAffected: rs?.rowsAffected };
}
