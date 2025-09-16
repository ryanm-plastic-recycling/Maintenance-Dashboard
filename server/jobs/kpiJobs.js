import fs  from 'fs';
import sql from 'mssql';
import path from 'path';
import { fileURLToPath } from 'url';

const cfg = JSON.parse(fs.readFileSync('config.json','utf-8'));
const TF  = cfg.kpiByAssetTimeframes || ["lastMonth"]; // safe default

function tfRange(now, tf) {
  const d = new Date(now);
  const utc = (y, m, day, h = 0, min = 0, s = 0) =>
    new Date(Date.UTC(y, m, day, h, min, s));
  const startOfWeek = (dt) => {
    const day = dt.getUTCDay(); // 0 Sun..6 Sat
    const mondayOffset = (day + 6) % 7;
    const st = new Date(
      Date.UTC(
        dt.getUTCFullYear(),
        dt.getUTCMonth(),
        dt.getUTCDate() - mondayOffset
      )
    );
    return utc(
      st.getUTCFullYear(),
      st.getUTCMonth(),
      st.getUTCDate()
    );
  };
  const startOfMonth = (dt) => utc(dt.getUTCFullYear(), dt.getUTCMonth(), 1);
  const startOfYear = (dt) => utc(dt.getUTCFullYear(), 0, 1);
  const endNow = utc(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    0
  );

  switch (tf) {
    case 'thisWeek':
      return { start: startOfWeek(d), end: endNow };
    case 'lastWeek': {
      const s = startOfWeek(d);
      return { start: new Date(s - 7 * 864e5), end: s };
    }
    case 'last30':
      return { start: new Date(endNow - 30 * 864e5), end: endNow };
    case 'thisMonth':
      return { start: startOfMonth(d), end: endNow };
    case 'lastMonth': {
      const s = startOfMonth(d);
      const ps = utc(s.getUTCFullYear(), s.getUTCMonth() - 1, 1);
      return { start: ps, end: s };
    }
    case 'thisYear':
      return { start: startOfYear(d), end: endNow };
    case 'lastYear': {
      const s = startOfYear(d);
      const ps = utc(s.getUTCFullYear() - 1, 0, 1);
      return { start: ps, end: s };
    }
    default:
      return { start: new Date(endNow - 30 * 864e5), end: endNow };
  }
}

function loadMappingsRaw() {
  // Resolve project root from this file: server/jobs -> <root>
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const ROOT = path.resolve(__dirname, '..', '..');
  const envPath = process.env.MAPPINGS_PATH && process.env.MAPPINGS_PATH.trim();
  const candidates = [
    envPath, // explicit override
    path.join(ROOT, 'mappings.json'), // repo root
    path.join(ROOT, 'public', 'mappings.json'), // public folder (front-end uses this)
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const txt = fs.readFileSync(p, 'utf-8');
        return JSON.parse(txt);
      }
    } catch (e) {
      console.warn('[kpiJobs] failed to read mappings at', p, String(e));
    }
  }
  console.warn('[kpiJobs] mappings.json not found in any known location');
  return null;
}

function normalizeAssets(m) {
  // Accept various shapes and normalize to [{assetID:number, name:string}]
  const out = [];
  const push = (id, name) => {
    const n = Number(id);
    if (!Number.isFinite(n)) return;
    out.push({ assetID: n, name: name || `Asset ${n}` });
  };
  if (!m || typeof m !== 'object') return [];
  // 1) { assets: [{assetID|id, name}] }
  if (Array.isArray(m.assets)) {
    m.assets.forEach((x) =>
      push(
        x.assetID ?? x.id ?? x.AssetID ?? x.AssetId,
        x.name ?? x.Name ?? x.displayName
      )
    );
  }
  // 2) { productionAssets: [{id, name}] }
  if (Array.isArray(m.productionAssets)) {
    m.productionAssets.forEach((x) =>
      push(x.id ?? x.assetID, x.name ?? x.displayName ?? x.title)
    );
  }
  // 3) { assetsById: { "101": { name: "E1" }, ... } }
  if (m.assetsById && typeof m.assetsById === 'object') {
    for (const [k, v] of Object.entries(m.assetsById)) {
      push(k, (v && (v.name ?? v.Name)) || v);
    }
  }
  // 4) { assetMap: { "101": "E1", ... } }
  if (m.assetMap && typeof m.assetMap === 'object') {
    for (const [k, v] of Object.entries(m.assetMap)) push(k, v);
  }
  // Deduplicate by assetID (first wins)
  const dedup = new Map();
  out.forEach((a) => {
    if (!dedup.has(a.assetID)) dedup.set(a.assetID, a);
  });
  return Array.from(dedup.values());
}

export async function refreshHeaderKpis(pool) {
  const DOWNTIME_UNITS = (process.env.DOWNTIME_UNITS || 'minutes').toLowerCase();
  const DT_FACTOR = DOWNTIME_UNITS === 'seconds' ? 1/3600
                   : DOWNTIME_UNITS === 'hours'   ? 1
                   :                                 1/60; // minutes -> hours

  const ranges = [{ tf: 'lastWeek' }, { tf: 'last30' }];

  // pull expected hours (HoursPerWeek) once
  const a = await pool.request().query(`
    SELECT SUM(COALESCE(HoursPerWeek, 0)) AS HrsPerWeek
    FROM dbo.LimbleKPIAssets
  `);
  const hrsPerWeek = Number(a.recordset[0]?.HrsPerWeek || 0);

  let inserted = 0;
  for (const r of ranges) {
    const { start, end } = tfRange(new Date(), r.tf);

    // raw event/downtime rollups
    const q = await pool.request()
      .input('start', sql.DateTime2, start)
      .input('end',   sql.DateTime2, end)
      .input('f',     sql.Float,     DT_FACTOR)
      .query(`
        WITH window AS (
          SELECT Type, Downtime, CreatedDate, DateCompleted
          FROM dbo.LimbleKPITasks
          WHERE (DateCompleted BETWEEN @start AND @end)
        )
        SELECT
          SUM(CASE WHEN Type IN (2,6) THEN Downtime * @f ELSE 0 END) AS DowntimeHrs,
          SUM(CASE WHEN Type IN (2,6) THEN 1 ELSE 0 END)            AS UnplannedCount,
          SUM(CASE WHEN Type IN (1,4) THEN 1 ELSE 0 END)            AS PlannedCount
        FROM window;
      `);

    const row = q.recordset[0] || {};
    const downtimeHrs     = Number(row.DowntimeHrs || 0);
    const unplannedCount  = Number(row.UnplannedCount || 0);
    const plannedCount    = Number(row.PlannedCount || 0);

    // scheduled hours over the range (use HoursPerWeek across all assets)
    const weeks = Math.max(0, (end - start) / (7 * 24 * 3600 * 1000));
    const scheduledHrs = hrsPerWeek * weeks;

    // MTTR / MTBF / Uptime / splits
    const mttrHrs   = unplannedCount > 0 ? downtimeHrs / unplannedCount : 0;
    const runHrs    = Math.max(0, scheduledHrs - downtimeHrs);
    const mtbfHrs   = unplannedCount > 0 ? runHrs / unplannedCount : 0;
    const uptimePct = scheduledHrs > 0 ? Math.max(0, Math.min(100, (1 - downtimeHrs / scheduledHrs) * 100)) : 0;

    const totalEvents = plannedCount + unplannedCount;
    const plannedPct   = totalEvents > 0 ? (plannedCount / totalEvents)   * 100 : 0;
    const unplannedPct = totalEvents > 0 ? (unplannedCount / totalEvents) * 100 : 0;

    await pool.request()
  .input('Timeframe',   sql.NVarChar, r.tf)
  .input('RangeStart',  sql.DateTime2, start)
  .input('RangeEnd',    sql.DateTime2, end)
  .input('UptimePct',   sql.Decimal(5,1), uptimePct)
  .input('DowntimeHrs', sql.Decimal(10,2), downtimeHrs)
  .input('MttrHrs',     sql.Decimal(10,2), mttrHrs)
  .input('MtbfHrs',     sql.Decimal(10,2), mtbfHrs)
  .input('PlannedCount',   sql.Int, plannedCount)
  .input('UnplannedCount', sql.Int, unplannedCount)
  .query(`
    DELETE FROM dbo.KpiHeaderCache WHERE Timeframe = @Timeframe;
    INSERT INTO dbo.KpiHeaderCache
      (Timeframe, RangeStart, RangeEnd, UptimePct, DowntimeHrs, MttrHrs, MtbfHrs, PlannedCount, UnplannedCount)
    VALUES
      (@Timeframe, @RangeStart, @RangeEnd, @UptimePct, @DowntimeHrs, @MttrHrs, @MtbfHrs, @PlannedCount, @UnplannedCount);
  `);

    inserted++;
  }
  return { inserted, ranges: ranges.length };
}

// server/jobs/kpiJobs.js (or wherever it lives)
export async function refreshWorkOrders(pool, page) {
  const loc = Number(process.env.LIMBLE_LOCATION_ID || 13425);

  let rows = [];
  let error = null;

  try {
    if (page === 'index') {
      // General WOs: open or in-progress, last 14 days, newest first
      const rs = await pool.request()
        .input('loc', sql.Int, loc)
        .query(`
          SELECT TOP (200)
            t.TaskID       AS taskID,
            t.AssetID      AS assetID,
            t.Priority     AS priority,
            t.Name         AS name,
            t.Description  AS description,
            t.[Type]       AS [type],
            t.CreatedDate  AS createdDate,
            t.StatusID     AS statusID
          FROM dbo.LimbleKPITasks t
          WHERE t.StatusID IN (0,1)                              -- open/in-progress
            AND t.CreatedDate >= DATEADD(day, -14, SYSUTCDATETIME())
            AND (@loc IS NULL OR t.LocationID = @loc)             -- keep or drop as needed
            AND t.[Type] IN (2,6)                                -- Unplanned & Work requester
          ORDER BY t.CreatedDate DESC;
        `);
      rows = (rs.recordset || []).map(r => ({
        ...r,
        createdDate: r.createdDate ? new Date(r.createdDate).toISOString() : null
      }));

    } else if (page === 'pm') {
      // PM page: PM types, open/in-progress, last 30 days
      const rs = await pool.request()
        .input('loc', sql.Int, loc)
        .query(`
          SELECT TOP (200)
            t.TaskID       AS taskID,
            t.AssetID      AS assetID,
            t.Priority     AS priority,
            t.Name         AS name,
            t.Description  AS description,
            t.[Type]       AS [type],
            t.CreatedDate  AS createdDate,
            t.[Due]        AS [due],
            t.StatusID     AS statusID
          FROM dbo.LimbleKPITasks t
          WHERE t.[Type] IN (1,4)                                -- PM types
            AND t.StatusID IN (0,1)
            AND t.CreatedDate >= DATEADD(day, -30, SYSUTCDATETIME())
            AND (@loc IS NULL OR t.LocationID = @loc)
          ORDER BY t.CreatedDate DESC;
        `);
      rows = (rs.recordset || []).map(r => ({
        ...r,
        createdDate: r.createdDate ? new Date(r.createdDate).toISOString() : null,
        due:         r.due         ? new Date(r.due).toISOString()         : null
      }));

    } else if (page === 'prodstatus') {
      // Production status from latest field 95 per asset
      const rs = await pool.request().query(`
        ;WITH s AS (
          SELECT
            af.AssetID     AS assetID,
            a.Name         AS assetName,
            af.ValueText   AS assetStatus,
            af.LastEdited  AS lastChangeUTC,
            ROW_NUMBER() OVER (PARTITION BY af.AssetID ORDER BY af.LastEdited DESC) AS rn
          FROM dbo.LimbleKPIAssetFields af
          INNER JOIN dbo.LimbleKPIAssets a ON a.AssetID = af.AssetID
          WHERE af.FieldID = 95
        )
        SELECT assetID, assetName, assetStatus, lastChangeUTC
        FROM s
        WHERE rn = 1
        ORDER BY assetName;
      `);
      rows = (rs.recordset || []).map(r => ({
        ...r,
        lastChangeUTC: r.lastChangeUTC ? new Date(r.lastChangeUTC).toISOString() : null
      }));

    } else {
      throw new Error(`Unknown page '${page}'`);
    }
  } catch (e) {
    error = e?.message || String(e);
    console.warn('[refreshWorkOrders]', page, error);
    rows = [];
  }

  // sanity log
  if (rows.length) {
    const maxCreated = rows[0].createdDate || rows[0].lastChangeUTC || null;
    const minCreated = rows[rows.length - 1].createdDate || rows[rows.length - 1].lastChangeUTC || null;
    console.log(`[refreshWorkOrders] ${page}: rows=${rows.length} window=${minCreated}..${maxCreated}`);
  } else {
    console.log(`[refreshWorkOrders] ${page}: rows=0`);
  }

  // write cache (once)
  const payload = JSON.stringify(rows);
  await pool.request()
    .input('Page',       sql.NVarChar(64), page)   // 'index' | 'pm' | 'prodstatus'
    .input('SnapshotAt', sql.DateTime2,     new Date())
    .input('Data',       sql.NVarChar(sql.MAX), payload)
    .execute('dbo.UpsertWorkOrdersCache');

  return { page, rows: rows.length, error };
}

export async function refreshByAssetKpis(pool) {
  const DOWNTIME_UNITS = (process.env.DOWNTIME_UNITS || 'minutes').toLowerCase();
  const DT_FACTOR = DOWNTIME_UNITS === 'seconds' ? 1/3600
                   : DOWNTIME_UNITS === 'hours'   ? 1
                   :                                 1/60;

  const mappings = loadMappingsRaw();
  const assets = normalizeAssets(mappings);
  const TF = cfg.kpiByAssetTimeframes || ['lastMonth'];

  let inserted = 0, tfCount = 0;

  for (const tf of TF) {
    tfCount++;

    // one snapshot for the ENTIRE timeframe batch
    const snap = new Date();

    const { start, end } = tfRange(new Date(), tf);

    // scheduled hours per asset
    const sched = await pool.request()
      .input('start', sql.DateTime2, start)
      .input('end',   sql.DateTime2, end)
      .query(`
        SELECT a.AssetID,
               COALESCE(a.HoursPerWeek, 0) * DATEDIFF(second, @start, @end) / (7.0 * 24.0 * 3600.0) AS ScheduledHrs
        FROM dbo.LimbleKPIAssets a
      `);
    const schedMap = new Map(sched.recordset.map(r => [Number(r.AssetID), Number(r.ScheduledHrs || 0)]));

    // aggregate window (completed events)
    const rs = await pool.request()
      .input('start', sql.DateTime2, start)
      .input('end',   sql.DateTime2, end)
      .input('f',     sql.Float,     DT_FACTOR)
      .query(`
        SELECT
          t.AssetID,
          SUM(CASE WHEN t.Type IN (2,6) THEN t.Downtime * @f ELSE 0 END) AS DowntimeHrs,
          SUM(CASE WHEN t.Type IN (2,6) THEN 1 ELSE 0 END)                AS UnplannedCount,
          SUM(CASE WHEN t.Type IN (1,4) THEN 1 ELSE 0 END)                AS PlannedCount,
          SUM(CASE WHEN t.Type IN (2,6) AND t.Downtime * @f > 0 THEN 1 ELSE 0 END) AS FailureEvents
        FROM dbo.LimbleKPITasks t
        WHERE (t.DateCompleted BETWEEN @start AND @end)
        GROUP BY t.AssetID
      `);

    // purge prior rows for this timeframe
    await pool.request().input('tf', sql.NVarChar, tf)
      .query(`DELETE FROM dbo.KpiByAssetCache WHERE Timeframe=@tf;`);

    const aggMap = new Map(rs.recordset.map(r => [Number(r.AssetID), r]));
    const targetAssets = assets.length
      ? assets.map(a => ({ assetID: a.assetID, name: a.name }))
      : sched.recordset.map(r => ({ assetID: Number(r.AssetID), name: null }));

    for (const a of targetAssets) {
      const assetID = a.assetID;
      const name = a.name || null;
      const agg  = aggMap.get(assetID) || { DowntimeHrs: 0, UnplannedCount: 0, PlannedCount: 0, FailureEvents: 0 };

      const downtimeHrs   = Number(agg.DowntimeHrs || 0);
      const unplanned     = Number(agg.UnplannedCount || 0);
      const planned       = Number(agg.PlannedCount || 0);
      const failureEvents = Number(agg.FailureEvents || 0);
      const totalEv       = planned + unplanned;

      const scheduledHrs  = schedMap.get(assetID) || 0;
      const runHrs        = Math.max(0, scheduledHrs - downtimeHrs);
      const mttrHrs       = unplanned > 0 ? downtimeHrs / unplanned : 0;
      const mtbfHrs       = unplanned > 0 ? runHrs       / unplanned : 0;
      const uptimePct     = scheduledHrs > 0 ? Math.max(0, Math.min(100, (1 - downtimeHrs / scheduledHrs) * 100)) : 100;
      const plannedPct    = totalEv > 0 ? (planned   / totalEv) * 100 : 0;
      const unplannedPct  = totalEv > 0 ? (unplanned / totalEv) * 100 : 0;

      await pool.request()
        .input('Timeframe',    sql.NVarChar, tf)
        .input('AssetID',      sql.Int,      assetID)
        .input('Name',         sql.NVarChar, name)
        .input('RangeStart',   sql.DateTime2, start)
        .input('RangeEnd',     sql.DateTime2, end)
        .input('UptimePct',    sql.Decimal(5,1),  uptimePct)
        .input('DowntimeHrs',  sql.Decimal(10,2), downtimeHrs)
        .input('MttrHrs',      sql.Decimal(10,2), mttrHrs)
        .input('MtbfHrs',      sql.Decimal(10,2), mtbfHrs)
        .input('PlannedPct',   sql.Decimal(5,1),  plannedPct)
        .input('UnplannedPct', sql.Decimal(5,1),  unplannedPct)
        .input('UnplannedCount', sql.Int, unplanned)
        .input('FailureEvents',  sql.Int, failureEvents)
        .input('ScheduledHrs',   sql.Decimal(12,2), scheduledHrs)
        .input('SnapshotAt',     sql.DateTime2, snap)               // ← NEW: one shared snapshot
        .query(`
          INSERT INTO dbo.KpiByAssetCache
            (Timeframe, AssetID, Name, RangeStart, RangeEnd,
             UptimePct, DowntimeHrs, MttrHrs, MtbfHrs, PlannedPct, UnplannedPct,
             UnplannedCount, FailureEvents, ScheduledHrs, SnapshotAt)
          VALUES
            (@Timeframe,@AssetID,@Name,@RangeStart,@RangeEnd,
             @UptimePct,@DowntimeHrs,@MttrHrs,@MtbfHrs,@PlannedPct,@UnplannedPct,
             @UnplannedCount,@FailureEvents,@ScheduledHrs,@SnapshotAt)
        `);
      inserted++;
    }
  }
  return { inserted, assets: 'computed', timeframes: TF.length };
}

