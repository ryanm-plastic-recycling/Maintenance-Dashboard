// server/jobs/limbleSync.js
import { exec } from 'child_process';
import util from 'util';
import sql from 'mssql';
import fetch from 'node-fetch'; // you already use this in server.js

const execAsync = util.promisify(exec);

const WAIT_MS = 3000;
const TIMEOUT_MS = 5 * 60 * 1000;

const API_V2 = `${process.env.API_BASE_URL}/v2`;
const LIMBLE_TOKEN = process.env.LIMBLE_TOKEN || process.env.LIMBLE_BEARER; // whatever you use today

export async function fetchAllPages(path, limit = 500) {
  let page = 1, out = [];
  for (;;) {
    const url = `${API_V2}${path}${path.includes('?') ? '&' : '?'}limit=${limit}&page=${page}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${LIMBLE_TOKEN}`, Accept: 'application/json' }
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    const json = await res.json();

    // adjust container per endpoint
    const batch = Array.isArray(json) ? json
                : (json.data?.tasks ?? json.data?.entries ?? json.data ?? []);
    if (!Array.isArray(batch) || batch.length === 0) break;

    out.push(...batch);
    page++;
  }
  return JSON.stringify(out);
}

async function fetchLimble(path) {
  const res = await fetch(`${API_V2}${path}`, {
    headers: {
      'Authorization': `Bearer ${LIMBLE_TOKEN}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  });
  if (!res.ok) throw new Error(`Limble ${path} -> ${res.status}`);
  // If Limble returns an array of objects, we can pass a stringified array directly to your proc.
  const data = await res.json();
  return JSON.stringify(Array.isArray(data) ? data : (data.data ?? data)); 
}

export async function syncLimbleToSql(pool) {
  // 1) Snapshot watermarks BEFORE
  const before = await getWatermarks(pool);

  // 2) Kick off ETL via one of the knobs
  const task = process.env.LIMBLE_ETL_TASK;
  const cmd  = process.env.LIMBLE_ETL_CMD;
  const proc = process.env.LIMBLE_SYNC_PROC;

  let mode = null;
    try {
      if (proc) {
        mode = 'proc';
        console.log('[limbleSync] mode:', mode);
    
        const limbleTasksJson  = await fetchAllPages('/tasks');
        const limbleAssetsJson = await fetchAllPages('/assets');
        const limbleFieldsJson = await fetchAllPages('/assets/fields/');
    
        await pool.request().input('payload', sql.NVarChar(sql.MAX), limbleTasksJson)
          .execute('dbo.Upsert_LimbleKPITasks');
        await pool.request().input('payload', sql.NVarChar(sql.MAX), limbleAssetsJson)
          .execute('dbo.Upsert_LimbleKPIAssets');
        await pool.request().input('payload', sql.NVarChar(sql.MAX), limbleFieldsJson)
          .execute('dbo.Upsert_LimbleKPIAssetFields');
    
      } else if (task) {
        mode = 'task';
        console.log('[limbleSync] mode:', mode);
        await execAsync(`schtasks /Run /TN "${task}"`);
    
      } else if (cmd) {
        mode = 'cmd';
        console.log('[limbleSync] mode:', mode);
        await execAsync(cmd, { shell: true });
    
      } else {
        return { ok: true, skipped: true, note: 'No LIMBLE_* set' };
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

// limbleSync.js
async function getWatermarks(pool) {
  try {
    const rs = await pool.request().query(`
      SELECT TableName, LastPulledUtc
      FROM dbo.EtlStateLimbleTables
      WHERE TableName IN (
        'LimbleKPIAssets',
        'LimbleKPIAssetFields',
        'LimbleKPITasks'
      )
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
  const keys = [
    'LimbleKPIAssets',
    'LimbleKPIAssetFields',
    'LimbleKPITasks'
  ];
  return keys.some(k => (after?.[k] || '') > (before?.[k] || ''));
}
