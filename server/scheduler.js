import cron from 'node-cron';
import sql from 'mssql';

let tasks = {};

async function withAppLock(pool, name, fn) {
  const req = pool.request();
  await req.query(`EXEC sp_getapplock @Resource='${name}', @LockMode='Exclusive', @LockTimeout=0;`);
  try { return await fn(); }
  finally { await pool.request().query(`EXEC sp_releaseapplock @Resource='${name}';`); }
}

async function loadSchedules(pool) {
  const { recordset } = await pool.request().query(`SELECT Name,Cron,Enabled FROM dbo.UpdateSchedules`);
  return recordset;
}

function schedule(name, cronExpr, handler) {
  if (tasks[name]) { tasks[name].stop(); delete tasks[name]; }
  tasks[name] = cron.schedule(cronExpr, handler, {
   scheduled: true,
   timezone: 'America/Indiana/Indianapolis'
  });
}

export async function start(pool, jobs) {
  const rows = await loadSchedules(pool);
  for (const r of rows) {
    const handler = async () => withAppLock(pool, r.Name, async () => {
      await jobs[r.Name]();
      await pool.request()
        .input('n', sql.NVarChar, r.Name)
        .query(`UPDATE dbo.UpdateSchedules SET LastRun = SYSUTCDATETIME() WHERE Name = @n`);
    });
    if (r.Enabled) schedule(r.Name, r.Cron, handler);
  }

  // Weekly index maintenance: Sun @ 02:00
  cron.schedule('0 2 * * 0', async () => {
    try {
      console.log('[scheduler] index_maintenance starting');
      await jobs.index_maintenance();
      console.log('[scheduler] index_maintenance done');
    } catch (e) {
      console.error('[scheduler] index_maintenance failed', e);
    }
  });
}

export async function reload(pool, jobs) {
  for (const k of Object.keys(tasks)) { tasks[k].stop(); delete tasks[k]; }
  return start(pool, jobs);
}

