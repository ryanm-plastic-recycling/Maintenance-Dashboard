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

export async function fetchAllPages(path, limit = 500, headersOverride = null) {
  const defaultHeaders = { Authorization: `Bearer ${LIMBLE_TOKEN}`, Accept: 'application/json' };
  const headers = headersOverride || defaultHeaders;

  let page = 1, out = [];
  for (;;) {
    const url = `${API_V2}${path}${path.includes('?') ? '&' : '?'}limit=${limit}&page=${page}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    const json = await res.json();
    const batch = Array.isArray(json) ? json : (json.data?.tasks ?? json.data?.entries ?? json.data ?? []);
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
        
        const basic = 'Basic ' + Buffer
          .from(`${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`)
          .toString('base64');
        
        // 1) Tasks (OPEN only, newest created first)
        const pathTasks = `/tasks?locations=${encodeURIComponent(process.env.LIMBLE_LOCATION_ID)}&status=0&orderBy=-createdDate`;
        console.log('[limbleSync] tasks path:', pathTasks);
        
        const limbleTasksJson = await fetchAllPages(pathTasks, 500, { Authorization: basic, Accept: 'application/json' });
        let tasksArr = [];
        try {
          tasksArr = JSON.parse(limbleTasksJson);
          console.log('[limbleSync] tasks count:', Array.isArray(tasksArr) ? tasksArr.length : 'not-array');
          console.log('[limbleSync] tasks sample:', (tasksArr || []).slice(0, 3).map(t => ({
            TaskID: t.taskID, createdDate: t.createdDate, status: t.status, assetID: t.assetID
          })));
        } catch { console.log('[limbleSync] tasks parse error'); }
        
        // 2) Upsert TASKS first — even if fields fail, tasks still refresh
        try {
          await pool.request().input('payload', sql.NVarChar(sql.MAX), limbleTasksJson)
            .execute('dbo.Upsert_LimbleKPITasks');
          console.log('[limbleSync] Upsert_LimbleKPITasks OK');
        } catch (e) {
          console.log('[limbleSync] Upsert_LimbleKPITasks ERROR:', e.message);
          throw e;
        }
        
        // 3) Assets — Bearer usually works, but you can also force Basic if needed
        let limbleAssetsJson = '[]';
        try {
          limbleAssetsJson = await fetchAllPages(
            '/assets',
            500,
            { Authorization: `Bearer ${LIMBLE_TOKEN}`, Accept: 'application/json' }
            // If Bearer gives 403, replace with: { Authorization: basic, Accept: 'application/json' }
          );
          console.log('[limbleSync] fetch assets OK');
        } catch (e) {
          console.log('[limbleSync] fetch assets ERROR:', e.message);
          // non-fatal: assets missing won’t block tasks/fields
          // throw e;
        }
        
        // 4) Fields — MUST use Basic and assetIDs (not empty string)
        let limbleFieldsJson = '[]';
        try {
          limbleFieldsJson = await fetchAllPages(
            `/assets/fields/?assets=${encodeURIComponent(assetIDs)}`,
            500,
            { Authorization: basic, Accept: 'application/json' }
          );
          console.log('[limbleSync] fetch fields OK');
        } catch (e) {
          console.log('[limbleSync] fetch fields ERROR:', e.message);
          // non-fatal: fields missing won’t block tasks/assets
          // throw e;
        }
        
        try {
          await pool.request().input('payload', sql.NVarChar(sql.MAX), limbleFieldsJson)
            .execute('dbo.Upsert_LimbleKPIAssetFields');
          console.log('[limbleSync] Upsert_LimbleKPIAssetFields OK');
        } catch (e) {
          console.log('[limbleSync] Upsert_LimbleKPIAssetFields ERROR:', e.message);
          // non-fatal if desired
          // throw e;
        }
        
        // 5) Probe: confirm top task in SQL
        try {
          const { recordset } = await pool.request().query(`
            SELECT TOP (1) TaskID, CreatedDate
            FROM dbo.LimbleKPITasks
            ORDER BY CreatedDate DESC;
          `);
          console.log('[limbleSync] SQL top task after upsert:', recordset?.[0]);
        } catch (e) {
          console.log('[limbleSync] probe error:', e.message);
        }

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
