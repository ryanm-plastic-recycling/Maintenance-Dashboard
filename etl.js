import fetch from 'node-fetch';
import sql   from 'mssql';
import fs    from 'fs';
import dotenv from 'dotenv';
dotenv.config();

//— build Basic auth header once —————————————————————————
const LIMBLE_AUTH = 'Basic '
  + Buffer.from(`${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`)
          .toString('base64');
const LIMBLE_BASE = `${process.env.API_BASE_URL}/v2`;

//— Azure SQL config ————————————————————————————————————————
const sqlConfig = {
  user:     process.env.AZURE_SQL_USER,
  password: process.env.AZURE_SQL_PASS,
  server:   process.env.AZURE_SQL_SERVER,
  database: process.env.AZURE_SQL_DB,
  options: { encrypt: true }
};

// Collect rows that fail during upsert
const badRows = [];

function isAbsolute(u) { return /^https?:\/\//i.test(u || ''); }
function withParam(u, k, v) {
  const re = new RegExp(`[?&]${k}=`, 'i');
  if (re.test(u)) return u;
  return `${u}${u.includes('?') ? '&' : '?'}${k}=${v}`;
}

//— helper to GET JSON from Limble ——————————————————————————
async function limbleGet(pathOrUrl) {
  const url = isAbsolute(pathOrUrl) ? pathOrUrl : `${LIMBLE_BASE}${pathOrUrl}`;
  const res = await fetch(url, { headers: { Authorization: LIMBLE_AUTH } });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Limble ${url} → ${res.status}\n${txt}`);
  }
  return res.json();
}

// Fetch every page for endpoints that support ?limit & ?page,
// but fall back to a single‐call for others.
async function fetchAll(path, limit = 10000) {
  // these endpoints don’t support page
  const noPage = ['/tasks/labor', '/assets/fields'];

  if (noPage.includes(path)) {
    // one shot, no pagination
    const sep = path.includes('?') ? '&' : '?';
    return limbleGet(`${path}${sep}limit=${limit}`);
  }

  // otherwise, page them
  let all  = [];
  let page = 1;
  let batch;
  const sep0 = path.includes('?') ? '&' : '?';

  do {
    batch = await limbleGet(
      `${path}${sep0}limit=${limit}&page=${page}`
    );
    all.push(...batch);
    page++;
  } while (batch.length === limit);

  return all;
}
function isAbsolute(u) { return /^https?:\/\//i.test(u || ''); }

async function fetchTasksIncremental(lastTaskTimestamp) {
  const envUrl = (process.env.TASKS_URL || '').trim();
  const order  = process.env.TASKS_ORDERBY || '-lastEdited';
  const limit  = String(Number(process.env.TASKS_LIMIT || 10000));

  // If TASKS_URL is absolute, DO NOT page; try safe variants in order.
  if (isAbsolute(envUrl)) {
    const variants = [];

    // 1) Keep your URL, just add order/limit if missing
    let v1 = withParam(withParam(envUrl, 'orderby', order), 'limit', limit);
    variants.push(v1);

    // 2) Some tenants use locationIds= instead of locations=
    if (/[?&]locations=/.test(envUrl)) {
      const swapped = envUrl.replace(/([?&])locations=/i, '$1locationIds=');
      let v2 = withParam(withParam(swapped, 'orderby', order), 'limit', limit);
      variants.push(v2);
    }

    // 3) Base path (drop query entirely), add order/limit
    const baseNoQuery = envUrl.split('?')[0];
    variants.push(withParam(withParam(baseNoQuery, 'orderby', order), 'limit', limit));

    // 4) Hard fallback: relative canonical /tasks with order/limit
    variants.push(`/tasks?orderby=${encodeURIComponent(order)}&limit=${limit}`);

    // Try in order; ignore 404 and keep going; rethrow anything else
    for (const u of variants) {
      try {
        const batch = await limbleGet(u);
        if (Array.isArray(batch)) return batch;
      } catch (e) {
        const msg = String(e?.message || '');
        if (msg.includes(' 404')) continue;  // try next variant
        throw e;                              // 401/429/5xx etc → surface it
      }
    }
    throw new Error('All TASKS_URL variants returned 404. Consider using /tasks (relative) and filtering by LocationID in SQL.');
  }

  // Relative path → paging should work; keep watermark stop
  const base = envUrl || `/tasks?locations=${process.env.LIMBLE_LOCATION_ID || ''}&orderby=${order}`;
  const sep  = base.includes('?') ? '&' : '?';
  let all = [], page = 1;

  while (true) {
    const pageUrl = `${base}${sep}limit=${limit}&page=${page}`;
    let batch;
    try {
      batch = await limbleGet(pageUrl);
    } catch (e) {
      // fallback if paging 404s even on relative path
      if (String(e?.message || '').includes(' 404')) {
        const noPage = `${base}${sep}limit=${limit}`;
        batch = await limbleGet(noPage);
      } else {
        throw e;
      }
    }

    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);

    const oldest = batch[batch.length - 1];
    const oldestEdited = new Date(((oldest?.lastEdited) || 0) * 1000);
    if (oldestEdited <= lastTaskTimestamp) break;

    page++;
  }
  return all;
}

// 1) Fetch & upsert LimbleKPITasks (all columns)
async function loadTasks(pool) {
  // 1️⃣ Read our last run (watermark on lastEdited)
  const stateRes = await pool.request()
    .query(`SELECT LastTaskTimestamp FROM EtlStateLimbleTables WHERE Id = 0`);
  const lastTaskTimestamp = stateRes.recordset[0].LastTaskTimestamp || new Date(0);
  
  // 2️⃣ Fetch every page (API already sorted by lastEdited)
  const data = (await fetchTasksIncremental(lastTaskTimestamp))
    .filter(t => new Date(((t?.lastEdited) || 0) * 1000) > lastTaskTimestamp);
  // Track counts and max timestamp
  let maxTs     = lastTaskTimestamp;
  let processed = 0;
  let inserted  = 0;
  let updated   = 0;
  let skipped   = 0;
  let failed    = 0;

  const ps = new sql.PreparedStatement(pool);
  ps.input('TaskID',            sql.Int);
  ps.input('Name',              sql.NVarChar(200));
  ps.input('UserID',            sql.Int);
  ps.input('TeamID',            sql.Int);
  ps.input('LocationID',        sql.Int);
  ps.input('Template',          sql.Bit);
  ps.input('CreatedDate',       sql.DateTime2);
  ps.input('StartDate',         sql.DateTime2);
  ps.input('Due',               sql.DateTime2);
  ps.input('Description',       sql.NVarChar(sql.MAX));
  ps.input('DateCompleted',     sql.DateTime2);
  ps.input('LastEdited',        sql.DateTime2);
  ps.input('LastEditedByUser',  sql.Int);
  ps.input('CompletedByUser',   sql.Int);
  ps.input('AssetID',           sql.Int);
  ps.input('CompletedUserWage', sql.Decimal(9,2));
  ps.input('EstimatedTime',     sql.Int);
  ps.input('Priority',          sql.Int);
  ps.input('PriorityID',        sql.Int);
  ps.input('Downtime',          sql.Int);
  ps.input('CompletionNotes',   sql.NVarChar(sql.MAX));
  ps.input('RequestorName',     sql.NVarChar(100));
  ps.input('RequestorEmail',    sql.NVarChar(256));
  ps.input('RequestorPhone',    sql.NVarChar(50));
  ps.input('RequestTitle',      sql.NVarChar(200));
  ps.input('StatusID',          sql.Int);
  ps.input('GeoLocation',       sql.NVarChar(200));
  ps.input('Type',              sql.Int);
  ps.input('AssociatedTaskID',  sql.Int);
  ps.input('Status',            sql.Int);

  const mergeSql = `
    MERGE INTO LimbleKPITasks AS target
    USING (VALUES (
      @TaskID,@Name,@UserID,@TeamID,@LocationID,@Template,
      @CreatedDate,@StartDate,@Due,@Description,@DateCompleted,
      @LastEdited,@LastEditedByUser,@CompletedByUser,@AssetID,
      @CompletedUserWage,@EstimatedTime,@Priority,@PriorityID,
      @Downtime,@CompletionNotes,@RequestorName,@RequestorEmail,
      @RequestorPhone,@RequestTitle,@StatusID,@GeoLocation,
      @Type,@AssociatedTaskID,@Status
    )) AS src (
      TaskID,Name,UserID,TeamID,LocationID,Template,
      CreatedDate,StartDate,Due,Description,DateCompleted,
      LastEdited,LastEditedByUser,CompletedByUser,AssetID,
      CompletedUserWage,EstimatedTime,Priority,PriorityID,
      Downtime,CompletionNotes,RequestorName,RequestorEmail,
      RequestorPhone,RequestTitle,StatusID,GeoLocation,
      Type,AssociatedTaskID,Status
    )
    ON target.TaskID = src.TaskID
    WHEN MATCHED THEN
      UPDATE SET
        Name             = src.Name,
        UserID           = src.UserID,
        TeamID           = src.TeamID,
        LocationID       = src.LocationID,
        Template         = src.Template,
        CreatedDate      = src.CreatedDate,
        StartDate        = src.StartDate,
        Due              = src.Due,
        Description      = src.Description,
        DateCompleted    = src.DateCompleted,
        LastEdited       = src.LastEdited,
        LastEditedByUser = src.LastEditedByUser,
        CompletedByUser  = src.CompletedByUser,
        AssetID          = src.AssetID,
        CompletedUserWage= src.CompletedUserWage,
        EstimatedTime    = src.EstimatedTime,
        Priority         = src.Priority,
        PriorityID       = src.PriorityID,
        Downtime         = src.Downtime,
        CompletionNotes  = src.CompletionNotes,
        RequestorName    = src.RequestorName,
        RequestorEmail   = src.RequestorEmail,
        RequestorPhone   = src.RequestorPhone,
        RequestTitle     = src.RequestTitle,
        StatusID         = src.StatusID,
        GeoLocation      = src.GeoLocation,
        Type             = src.Type,
        AssociatedTaskID = src.AssociatedTaskID,
        Status           = src.Status
    WHEN NOT MATCHED THEN
      INSERT (
        TaskID,Name,UserID,TeamID,LocationID,Template,
        CreatedDate,StartDate,Due,Description,DateCompleted,
        LastEdited,LastEditedByUser,CompletedByUser,AssetID,
        CompletedUserWage,EstimatedTime,Priority,PriorityID,
        Downtime,CompletionNotes,RequestorName,RequestorEmail,
        RequestorPhone,RequestTitle,StatusID,GeoLocation,
        Type,AssociatedTaskID,Status
      )
      VALUES (
        src.TaskID,src.Name,src.UserID,src.TeamID,src.LocationID,src.Template,
        src.CreatedDate,src.StartDate,src.Due,src.Description,src.DateCompleted,
        src.LastEdited,src.LastEditedByUser,src.CompletedByUser,src.AssetID,
        src.CompletedUserWage,src.EstimatedTime,src.Priority,src.PriorityID,
        src.Downtime,src.CompletionNotes,src.RequestorName,src.RequestorEmail,
        src.RequestorPhone,src.RequestTitle,src.StatusID,src.GeoLocation,
        src.Type,src.AssociatedTaskID,src.Status
      )
      OUTPUT $action AS action;
  `;
  await ps.prepare(mergeSql);

  // 4️⃣ Loop through tasks, but skip any at-or-before lastTaskTimestamp
  for (let i = 0; i < data.length; i++) {
    const t = data[i];
    const taskDate = new Date(t.lastEdited * 1000);
    const rawEmail =
      t.requester?.email ??
      t.requestorEmail ??
      t.requesterEmail ??
      null;
    const email = rawEmail ? String(rawEmail).slice(0, 256) : null;
    if (taskDate <= lastTaskTimestamp) {
      skipped += data.length - i;
      break;
    }

    if (taskDate > maxTs) maxTs = taskDate;

    try {
      const res = await ps.execute({
        TaskID:            t.taskID,
        Name:              t.name,
        UserID:            t.userID,
        TeamID:            t.teamID,
        LocationID:        t.locationID,
        Template:          t.template ? 1 : 0,
        CreatedDate:       new Date(t.createdDate * 1000),
        StartDate:         t.startDate ? new Date(t.startDate * 1000) : null,
        Due:               t.due ? new Date(t.due * 1000) : null,
        Description:       t.description,
        DateCompleted:     t.dateCompleted ? new Date(t.dateCompleted * 1000) : null,
        LastEdited:        taskDate,
        LastEditedByUser:  t.lastEditedByUser,
        CompletedByUser:   t.completedByUser,
        AssetID:           t.assetID,
        CompletedUserWage: t.completedUserWage,
        EstimatedTime:     t.estimatedTime,
        Priority:          t.priority,
        PriorityID:        t.priorityID,
        Downtime:          t.downtime,
        CompletionNotes:   t.completionNotes,
        RequestorName:     t.requestorName,
        RequestorEmail:    email,
        RequestorPhone:    t.requestorPhone,
        RequestTitle:      t.requestTitle,
        StatusID:          t.statusID,
        GeoLocation:       t.geoLocation,
        Type: t.type != null && !Number.isNaN(Number(t.type)) ? parseInt(t.type,10) : null,
        AssociatedTaskID:  t.associatedTaskID,
        Status:            t.status
      });
      const action = res.recordset[0]?.action;
      if (action === 'INSERT') inserted++; else updated++;
      processed++;
    } catch (rowErr) {
      failed++;
      badRows.push({ table: 'LimbleKPITasks', row: t, error: rowErr.message });
      console.error(`⚠️ TaskID=${t.taskID} failed:`, rowErr.message);
    }

    if (i > 0 && i % 500 === 0) {
      console.log(`  ↳ Upserted ${i} new/updated tasks`);
    }
  }

  await ps.unprepare().catch(() => {});

  // 5️⃣ Write back the max timestamp for next run
  await pool.request()
    .input('LastTaskTimestamp', sql.DateTime2, maxTs)
    .query(`
      UPDATE EtlStateLimbleTables
      SET LastTaskTimestamp = @LastTaskTimestamp
      WHERE Id = 0
    `);

  return { processed, inserted, updated, skipped, failed };
}

// Helper for cron: reprocess tasks edited in the last 24 hours
async function backfillRecentEdits(pool) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await pool.request()
    .input('LastTaskTimestamp', sql.DateTime2, since)
    .query(`UPDATE EtlStateLimbleTables SET LastTaskTimestamp=@LastTaskTimestamp WHERE Id = 0`);
  return loadTasks(pool);
}

// 2) Fetch & upsert LimbleKPITasksLabor (all columns)
async function loadLabor(pool) {
  // ▶️ 1) Read last run timestamp
  const stateRes = await pool.request()
    .query(`SELECT LastLaborLogged FROM EtlStateLimbleTables WHERE Id = 0`);
  const lastLaborTs = stateRes.recordset[0].LastLaborLogged;

  const data = await fetchAll('/tasks/labor');
  data.sort((a, b) => b.dateLogged - a.dateLogged);

  const existingTasks = new Set(
    (await pool.request().query('SELECT TaskID FROM LimbleKPITasks'))
        .recordset
        .map(r => r.TaskID)
  );
  const ps = new sql.PreparedStatement(pool);
  ps.input('TaskID',        sql.Int);
  ps.input('UserID',        sql.Int);
  ps.input('TimeSpent',     sql.Int);
  ps.input('UserWage',      sql.Decimal(9,2));
  ps.input('DateLogged',    sql.DateTime2);
  ps.input('Description',   sql.NVarChar(sql.MAX));
  ps.input('TaskName',      sql.NVarChar(200));
  ps.input('TaskPriorityID',sql.Int);
  ps.input('BillableTime',  sql.Int);
  ps.input('BillableRate',  sql.Decimal(9,2));
  ps.input('CategoryID',    sql.Int);

  const mergeSql = `
    MERGE INTO LimbleKPITasksLabor AS target
    USING (VALUES (
      @TaskID,@UserID,@TimeSpent,@UserWage,
      @DateLogged,@Description,@TaskName,@TaskPriorityID,
      @BillableTime,@BillableRate,@CategoryID
    )) AS src (
      TaskID,UserID,TimeSpent,UserWage,
      DateLogged,Description,TaskName,TaskPriorityID,
      BillableTime,BillableRate,CategoryID
    )
    ON
      target.TaskID      = src.TaskID AND
      target.UserID      = src.UserID AND
      target.DateLogged  = src.DateLogged
    WHEN MATCHED THEN
      UPDATE SET
        TimeSpent      = src.TimeSpent,
        UserWage       = src.UserWage,
        Description    = src.Description,
        TaskName       = src.TaskName,
        TaskPriorityID = src.TaskPriorityID,
        BillableTime   = src.BillableTime,
        BillableRate   = src.BillableRate,
        CategoryID     = src.CategoryID
    WHEN NOT MATCHED THEN
      INSERT (
        TaskID,UserID,TimeSpent,UserWage,
        DateLogged,Description,TaskName,TaskPriorityID,
        BillableTime,BillableRate,CategoryID
      )
      VALUES (
        src.TaskID,src.UserID,src.TimeSpent,src.UserWage,
        src.DateLogged,src.Description,src.TaskName,src.TaskPriorityID,
        src.BillableTime,src.BillableRate,src.CategoryID
      )
      OUTPUT $action AS action;
    `;
  await ps.prepare(mergeSql);

  let inserted = 0;
  let skipped  = 0;
  let failed   = 0;
  let maxLaborTs = lastLaborTs;

  for (let i = 0; i < data.length; i++) {
    const t = data[i];
    const logged = new Date(t.dateLogged * 1000);
    if (logged <= lastLaborTs) {
      skipped += data.length - i;
      break;
    }
    if (!existingTasks.has(t.taskID)) {
      console.warn(`Skipping labor for missing TaskID=${t.taskID}`);
      continue;
    }
    if (logged > maxLaborTs) maxLaborTs = logged;
    try {
      const res = await ps.execute({
        TaskID:        t.taskID,
        UserID:        t.userID,
        TimeSpent:     t.timeSpent,
        UserWage:      t.userWage,
        DateLogged:    logged,
        Description:   t.description,
        TaskName:      t.taskName,
        TaskPriorityID:t.taskPriorityID,
        BillableTime:  t.billableTime,
        BillableRate:  t.billableRate,
        CategoryID:    t.categoryID
      });
      if (res.recordset[0]?.action === 'INSERT') inserted++;
    } catch (rowErr) {
      failed++;
      badRows.push({ table: 'LimbleKPITasksLabor', row: t, error: rowErr.message });
      console.error(`Failed upsert LimbleKPITasks TaskID=${t.taskID}:`, rowErr);
    }
    if (i > 0 && i % 500 === 0) {
      console.log(`  ↳ Upserted ${i} LimbleKPITasksLabor records`);
    }
  }

  await ps.unprepare();

  await pool.request()
    .input('LastLaborLogged', sql.DateTime2, maxLaborTs)
    .query(`
      UPDATE EtlStateLimbleTables
      SET LastLaborLogged = @LastLaborLogged
      WHERE Id = 0
    `);

  return { inserted, skipped, failed };
}


// 3) Fetch & upsert LimbleKPIAssetFields (all columns, incremental)
async function loadAssetFields(pool) {
  // 1) Read our last run watermark
  const stateRes = await pool.request()
    .query(`SELECT LastAssetFieldEdited FROM EtlStateLimbleTables WHERE Id = 0`);
  const lastFieldTs = stateRes.recordset[0].LastAssetFieldEdited;

  // 2) Full fetch (no pagination on this endpoint)
  const data = await fetchAll('/assets/fields');
  data.sort((a, b) => b.lastEdited - a.lastEdited);

  // track the max lastEdited we see
  let maxFieldTs = lastFieldTs;
  let inserted = 0;
  let updated  = 0;    // ← new
  let skipped  = 0;
  let failed   = 0;

  const ps = new sql.PreparedStatement(pool);
  ps.input('AssetID',    sql.Int);
  ps.input('FieldID',    sql.Int);
  ps.input('LocationID', sql.Int);
  ps.input('FieldName',  sql.NVarChar(100));
  ps.input('ValueText',  sql.NVarChar(sql.MAX));
  ps.input('ValueID',    sql.Int);
  ps.input('FieldType',  sql.NVarChar(50));
  ps.input('LastEdited', sql.DateTime2);

  const mergeSql = `
    MERGE INTO LimbleKPIAssetFields AS target
    USING (VALUES (
      @AssetID,@FieldID,@LocationID,@FieldName,
      @ValueText,@ValueID,@FieldType,@LastEdited
    )) AS src (
      AssetID,FieldID,LocationID,FieldName,
      ValueText,ValueID,FieldType,LastEdited
    )
    ON target.AssetID = src.AssetID
   AND target.FieldID = src.FieldID
    WHEN MATCHED THEN
      UPDATE SET
        LocationID = src.LocationID,
        FieldName  = src.FieldName,
        ValueText  = src.ValueText,
        ValueID    = src.ValueID,
        FieldType  = src.FieldType,
        LastEdited = src.LastEdited
    WHEN NOT MATCHED THEN
      INSERT (
        AssetID,FieldID,LocationID,FieldName,
        ValueText,ValueID,FieldType,LastEdited
      )
      VALUES (
        src.AssetID,src.FieldID,src.LocationID,src.FieldName,
        src.ValueText,src.ValueID,src.FieldType,src.LastEdited
      )
    OUTPUT $action AS action;
  `;
  await ps.prepare(mergeSql);

  // 3) Loop & upsert, breaking on old records
  for (let i = 0; i < data.length; i++) {
    const f = data[i];
    const edited = new Date(f.lastEdited * 1000);

    // stop when we reach already-processed fields
    if (edited <= lastFieldTs) {
      skipped += data.length - i;
      console.log(`↳ reached existing asset-fields (edited ${edited.toISOString()}), stopping.`);
      break;
    }

    // track the newest lastEdited
    if (edited > maxFieldTs) maxFieldTs = edited;

    try {
      const res = await ps.execute({
        AssetID:    f.assetID,
        FieldID:    f.fieldID,
        LocationID: f.locationID,
        FieldName:  f.field,
        ValueText:  f.value,
        ValueID:    f.valueID,
        FieldType:  f.fieldType,
        LastEdited: edited
      });
      // count each returned action
      res.recordset.forEach(r => {
        if (r.action === 'INSERT') inserted++;
        else if (r.action === 'UPDATE') updated++;
      });
    } catch (err) {
      failed++;
      badRows.push({ table: 'LimbleKPIAssetFields', row: f, error: err.message });
      console.error(`⚠️ AssetField [${f.assetID},${f.fieldID}] failed:`, err.message);
    }

    if (i > 0 && i % 500 === 0) {
      console.log(`  ↳ Processed ${i} asset-fields`);
    }
  }

  await ps.unprepare();

  // 4) Write back the new watermark
  await pool.request()
    .input('LastAssetFieldEdited', sql.DateTime2, maxFieldTs)
    .query(`
      UPDATE EtlStateLimbleTables
      SET LastAssetFieldEdited = @LastAssetFieldEdited
      WHERE Id = 0
    `);

  return { inserted, updated, skipped, failed };
}

// 4) Fetch & upsert LimbleKPIAssets (all columns)
async function loadAssets(pool) {
  const data = await fetchAll('/assets');
  let inserted = 0, updated = 0, failed = 0;

  const ps = new sql.PreparedStatement(pool);
  ps.input('AssetID',       sql.Int);
  ps.input('Name',          sql.NVarChar(200));
  ps.input('StartedOn',     sql.DateTime2);
  ps.input('LastEdited',    sql.DateTime2);
  ps.input('ParentAssetID', sql.Int);
  ps.input('LocationID',    sql.Int);
  ps.input('HoursPerWeek',  sql.Decimal(5,2));
  ps.input('WorkRequestURL',sql.NVarChar(500));

  const mergeSql = `
  MERGE INTO LimbleKPIAssets AS target
  USING (VALUES (
    @AssetID,@Name,@StartedOn,@LastEdited,
    @ParentAssetID,@LocationID,@HoursPerWeek,@WorkRequestURL
  )) AS src (
    AssetID,Name,StartedOn,LastEdited,
    ParentAssetID,LocationID,HoursPerWeek,WorkRequestURL
  )
  ON target.AssetID = src.AssetID
  WHEN MATCHED THEN
    UPDATE SET
      Name           = src.Name,
      StartedOn      = src.StartedOn,
      LastEdited     = src.LastEdited,
      ParentAssetID  = src.ParentAssetID,
      LocationID     = src.LocationID,
      HoursPerWeek   = src.HoursPerWeek,
      WorkRequestURL = src.WorkRequestURL
  WHEN NOT MATCHED THEN
    INSERT (
      AssetID,Name,StartedOn,LastEdited,
      ParentAssetID,LocationID,HoursPerWeek,WorkRequestURL
    )
    VALUES (
      src.AssetID,src.Name,src.StartedOn,src.LastEdited,
      src.ParentAssetID,src.LocationID,src.HoursPerWeek,src.WorkRequestURL
    )
  OUTPUT $action AS action;
  `;

  await ps.prepare(mergeSql);

  for (const a of data) {
    try {
      const result = await ps.execute({
        AssetID:       a.assetID,
        Name:          a.name,
        StartedOn:     a.startedOn ? new Date(a.startedOn * 1000) : null,
        LastEdited:    a.lastEdited ? new Date(a.lastEdited * 1000) : null,
        ParentAssetID: a.parentAssetID,
        LocationID:    a.locationID,
        HoursPerWeek:  a.hoursPerWeek,
        WorkRequestURL:a.workRequestPortal
      });
      const action = result.recordset[0]?.action;
      if (action === 'INSERT') inserted++;
      else if (action === 'UPDATE') updated++;
    } catch (err) {
      failed++;
      console.error(`⚠️ Asset ${a.assetID} failed:`, err.message);
    }
  }
  await ps.unprepare();
  return { inserted, updated, failed };
}

//— 5) Orchestrate all loads —————————————————————————————
async function main() {
  const pool = await sql.connect(sqlConfig);
  try {
    const taskSummary  = await loadTasks(pool);
    const laborSummary = await loadLabor(pool);
    const assetSummary = await loadAssets(pool);
    const fieldSummary = await loadAssetFields(pool);
    console.log('✅ All Limble data loaded');
    console.log('Summary:');
    console.log(`  Tasks processed=${taskSummary.processed}, inserted=${taskSummary.inserted}, updated=${taskSummary.updated}, skipped=${taskSummary.skipped}, failed=${taskSummary.failed}`);
    console.log(`  Labor inserted=${laborSummary.inserted}, skipped=${laborSummary.skipped}, failed=${laborSummary.failed}`);
    console.log(`  Assets      inserted=${assetSummary.inserted}, updated=${assetSummary.updated}, failed=${assetSummary.failed}`);
    console.log(`  AssetFields inserted=${fieldSummary.inserted}, updated=${fieldSummary.updated}, skipped=${fieldSummary.skipped}, failed=${fieldSummary.failed}`);
  } catch (err) {
    console.error('ETL error:', err);
  } finally {
    await pool.close();
    if (badRows.length) {
      fs.writeFileSync('bad_rows.json', JSON.stringify(badRows, null, 2));
      // To retry, fix bad_rows.json then feed the records through a small script
      // that reuses the merge statements above.
    }
    await notifyFailures(badRows);
  }
}

async function notifyFailures(rows) {
  if (rows.length <= 10) return;
  const hook = process.env.TEAMS_WEBHOOK_URL;
  if (!hook) {
    console.warn(`More than 10 rows failed (${rows.length}).`);
    return;
  }
  const sample = rows.slice(0, 5).map(r => `${r.table}: ${r.error}`).join('; ');
  try {
    await fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `ETL encountered ${rows.length} bad rows. Sample: ${sample}` })
    });
  } catch (err) {
    console.error('Failed to send webhook', err);
  }
}

main();
