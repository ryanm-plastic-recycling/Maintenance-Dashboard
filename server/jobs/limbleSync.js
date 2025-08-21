// server/jobs/limbleSync.js
import { exec } from 'child_process';
import util from 'util';
const execAsync = util.promisify(exec);

const WAIT_MS = 3000;
const TIMEOUT_MS = 5 * 60 * 1000;

export async function syncLimbleToSql(pool) {
  // 1) Snapshot watermarks BEFORE
  const before = await getWatermarks(pool);

  // 2) Kick off ETL via one of the knobs
  const task = process.env.LIMBLE_ETL_TASK;
  const cmd  = process.env.LIMBLE_ETL_CMD;
  const proc = process.env.LIMBLE_SYNC_PROC;

  let mode = null;
  try {
    if (task) {
      mode = 'task';
      await execAsync(`schtasks /Run /TN "${task}"`);
    } else if (cmd) {
      mode = 'cmd';
      await execAsync(cmd, { shell: true });
    } else if (proc) {
      mode = 'proc';
      await pool.request().execute(proc); // works only if your SQL has the proc
    } else {
      return { ok: true, skipped: true, note: 'No LIMBLE_ETL_TASK/LIMBLE_ETL_CMD/LIMBLE_SYNC_PROC set' };
    }
  } catch (e) {
    return { ok: false, error: `Failed to start ETL (${mode || 'none'}): ${e.message}` };
  }

  // 3) Poll for completion (watermarks change)
  const t0 = Date.now();
  while (Date.now() - t0 < TIMEOUT_MS) {
    const after = await getWatermarks(pool);
    if (advanced(after, before)) {
      return { ok: true, mode, before, after };
    }
    await sleep(WAIT_MS);
  }
  return { ok: false, error: 'ETL timeout waiting for watermarks to advance', mode, before, after: await getWatermarks(pool) };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getWatermarks(pool) {
  try {
    const rs = await pool.request().query(`
      SELECT TableName, LastPulledUtc
      FROM dbo.EtlStateLimbleTables
      WHERE TableName IN ('Assets','AssetFields','Tasks','Heartbeat')
    `);
    const m = {};
    for (const r of rs.recordset || []) {
      m[r.TableName] = r.LastPulledUtc && new Date(r.LastPulledUtc).toISOString();
    }
    return m;
  } catch (e) {
    return { error: e.message };
  }
}

function advanced(after, before) {
  // true if any watermark is newer than before (simple ISO string comparison)
  const keys = ['Assets','AssetFields','Tasks','Heartbeat'];
  return keys.some(k => (after?.[k] || '') > (before?.[k] || ''));
}
