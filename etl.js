import fetch from 'node-fetch';
import sql   from 'mssql';
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

//— helper to GET JSON from Limble ——————————————————————————
async function limbleGet(path) {
  const url = `${LIMBLE_BASE}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: LIMBLE_AUTH }
  });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Limble ${path} → ${res.status}\n${txt}`);
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


// 1) Fetch & upsert LimbleKPITasks (all columns)
async function loadTasks(pool) {
  // 1️⃣ Read our last run
  const stateRes = await pool.request()
    .query(`SELECT LastTaskTimestamp FROM EtlStateLimbleTables WHERE Id = 0`);
  const lastTaskTimestamp = stateRes.recordset[0].LastTaskTimestamp;

  // 2️⃣ Fetch every page
  const data = await fetchAll('/tasks');

  // We'll track the max createdDate we see this run:
  let maxTs = lastTaskTimestamp;

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
  ps.input('RequestorEmail',    sql.NVarChar(200));
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
      );
    `;
   await ps.prepare(mergeSql);

  // 4️⃣ Loop through tasks, but skip any at-or-before lastTaskTimestamp
  for (let i = 0; i < data.length; i++) {
    const t = data[i];
    // ⬇️ compute this task’s creation date
    const taskDate = new Date(t.createdDate * 1000);

// TEMPORARY _______ADD BACK IN LATER --------------------------------------------------------------------------------------------------
   // ⬇️ once we hit an old task, stop paging/upserting entirely
    //if (taskDate <= lastTaskTimestamp) {
      //console.log(
        //`↳ reached existing tasks (created ${taskDate.toISOString()}), stopping.`
      //);
      //break;
    //}

    // Track the newest timestamp
    if (taskDate > maxTs) maxTs = taskDate;

    try {
      await ps.execute({
        TaskID:            t.taskID,
        Name:              t.name,
        UserID:            t.userID,
        TeamID:            t.teamID,
        LocationID:        t.locationID,
        Template:          t.template ? 1 : 0,
        CreatedDate:       taskDate,
        StartDate:         t.startDate ? new Date(t.startDate * 1000) : null,
        Due:               t.due ? new Date(t.due * 1000) : null,
        Description:       t.description,
        DateCompleted:     t.dateCompleted
                             ? new Date(t.dateCompleted * 1000)
                             : null,
        LastEdited:        t.lastEdited
                             ? new Date(t.lastEdited * 1000)
                             : null,
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
        RequestorEmail:    t.requestorEmail,
        RequestorPhone:    t.requestorPhone,
        RequestTitle:      t.requestTitle,
        StatusID:          t.statusID,
        GeoLocation:       t.geoLocation,
        // 👇 guard against non-numeric types
        Type: t.type != null && !Number.isNaN(Number(t.type))
                ? parseInt(t.type, 10)
                : null,
        AssociatedTaskID:  t.associatedTaskID,
        Status:            t.status
      });
    } catch (rowErr) {
      console.error(`⚠️ TaskID=${t.taskID} failed:`, rowErr.message);
    }

    if (i > 0 && i % 500 === 0) {
      console.log(`  ↳ Upserted ${i} new tasks`);
    }
  }

  await ps.unprepare();

  // 5️⃣ Write back the max timestamp for next run
  await pool.request()
    .input('LastTaskTimestamp', sql.DateTime2, maxTs)
    .query(`
      UPDATE EtlStateLimbleTables
      SET LastTaskTimestamp = @LastTaskTimestamp
      WHERE Id = 0
    `);
}

// 2) Fetch & upsert LimbleKPITasksLabor (all columns)
async function loadLabor(pool) {
  const data = await fetchAll('/tasks/labor');
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
      );
    `;
  await ps.prepare(mergeSql);

  for (let i = 0; i < data.length; i++) {
    const t = data[i];
    if (!existingTasks.has(t.taskID)) {
      console.warn(`Skipping labor for missing TaskID=${t.taskID}`);
      continue;
    }
    try {
      await ps.execute({
      TaskID:        t.taskID,
      UserID:        t.userID,
      TimeSpent:     t.timeSpent,
      UserWage:      t.userWage,
      DateLogged:    new Date(t.dateLogged * 1000),
      Description:   t.description,
      TaskName:      t.taskName,
      TaskPriorityID:t.taskPriorityID,
      BillableTime:  t.billableTime,
      BillableRate:  t.billableRate,
      CategoryID:    t.categoryID
    });
  } catch (rowErr) {
    console.error(`Failed upsert LimbleKPITasks TaskID=${t.taskID}:`, rowErr);
    // optionally write t to a "bad_rows.json" file if you need to retry later
  }
    if (i > 0 && i % 500 === 0) {
      console.log(`  ↳ Upserted ${i} LimbleKPITasksLabor records`);
    }
  }

  await ps.unprepare();
}  


// 3) Fetch & upsert LimbleKPIAssetFields (all columns, incremental)
async function loadAssetFields(pool) {
  // ▶️ 1) Read our last run watermark
  const stateRes = await pool.request()
    .query(`SELECT LastAssetFieldEdited FROM EtlStateLimbleTables WHERE Id = 0`);
  const lastFieldTs = stateRes.recordset[0].LastAssetFieldEdited;

  // ▶️ 2) Full fetch (no pagination on this endpoint)
  const data = await fetchAll('/assets/fields');

  // track the max lastEdited we see
  let maxFieldTs = lastFieldTs;

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
      );
  `;
  await ps.prepare(mergeSql);

  // ▶️ 3) Loop & upsert, breaking on old records
  for (let i = 0; i < data.length; i++) {
    const f = data[i];
    const edited = new Date(f.lastEdited * 1000);

    // stop when we reach already-processed fields
    if (edited <= lastFieldTs) {
      console.log(`↳ reached existing asset-fields (edited ${edited.toISOString()}), stopping.`);
      break;
    }

    // track the newest lastEdited
    if (edited > maxFieldTs) maxFieldTs = edited;

    try {
      await ps.execute({
        AssetID:    f.assetID,
        FieldID:    f.fieldID,
        LocationID: f.locationID,
        FieldName:  f.field,
        ValueText:  f.value,
        ValueID:    f.valueID,
        FieldType:  f.fieldType,
        LastEdited: edited
      });
    } catch (err) {
      console.error(`⚠️ AssetField [${f.assetID},${f.fieldID}] failed:`, err.message);
    }

    if (i > 0 && i % 500 === 0) {
      console.log(`  ↳ Upserted ${i} new asset-fields`);
    }
  }

  await ps.unprepare();

  // ▶️ 4) Write back the new watermark
  await pool.request()
    .input('LastAssetFieldEdited', sql.DateTime2, maxFieldTs)
    .query(`
      UPDATE EtlStateLimbleTables
      SET LastAssetFieldEdited = @LastAssetFieldEdited
      WHERE Id = 0
    `);
}


// 4) Fetch & upsert LimbleKPIAssets (all columns)
async function loadAssets(pool) {
  const data = await fetchAll(`/assets`);

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
  );
`;
  await ps.prepare(mergeSql);

  for (const a of data) {
    await ps.execute({
      AssetID:       a.assetID,
      Name:          a.name,
      StartedOn:     a.startedOn ? new Date(a.startedOn * 1000) : null,
      LastEdited:    a.lastEdited ? new Date(a.lastEdited * 1000) : null,
      ParentAssetID: a.parentAssetID,
      LocationID:    a.locationID,
      HoursPerWeek:  a.hoursPerWeek,
      WorkRequestURL:a.workRequestPortal
    });
  }

  await ps.unprepare();
}

//— 5) Orchestrate all loads —————————————————————————————
async function main() {
  const pool = await sql.connect(sqlConfig);
  try {
    await loadTasks(pool);
    await loadLabor(pool);
    await loadAssetFields(pool);
    await loadAssets(pool);
    console.log('✅ All Limble data loaded');
  } catch (err) {
    console.error('ETL error:', err);
  } finally {
    await pool.close();
  }
}

main();
