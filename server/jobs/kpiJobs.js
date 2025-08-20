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
  const now = new Date();
  const ranges = [
    { tf: 'lastWeek', k: 'UP' },
    { tf: 'last30',   k: 'MT' }
  ];
  let inserted = 0;

  for (const r of ranges) {
    const { start, end } = tfRange(now, r.tf);
    // Placeholder values; replace with real aggregation queries
    const uptimePct      = 99.9;
    const downtimeHrs    = 1.2;
    const mttrHrs        = 3.4;
    const mtbfHrs        = 120.0;
    const plannedCount   = 10;
    const unplannedCount = 6;

    await pool.request()
      .input('Timeframe', sql.NVarChar, r.tf)
      .input('RangeStart', sql.DateTime2, start)
      .input('RangeEnd', sql.DateTime2, end)
      .input('UptimePct', sql.Decimal(5,1), uptimePct)
      .input('DowntimeHrs', sql.Decimal(10,1), downtimeHrs)
      .input('MttrHrs', sql.Decimal(10,1), mttrHrs)
      .input('MtbfHrs', sql.Decimal(10,1), mtbfHrs)
      .input('PlannedCount', sql.Int, plannedCount)
      .input('UnplannedCount', sql.Int, unplannedCount)
      .query(`
        INSERT INTO dbo.KpiHeaderCache(Timeframe,RangeStart,RangeEnd,UptimePct,DowntimeHrs, MttrHrs, MtbfHrs,PlannedCount,UnplannedCount)
        VALUES(@Timeframe,@RangeStart,@RangeEnd,@UptimePct,@DowntimeHrs,@MttrHrs,@MtbfHrs,@PlannedCount,@UnplannedCount)
      `);
    inserted++;
  }
  return { inserted, ranges: ranges.length };
}

export async function refreshByAssetKpis(pool) {
  const now = new Date();
  // Load + normalize asset map from mappings.json
  const mappings = loadMappingsRaw();
  const assets = normalizeAssets(mappings);
  if (!assets.length) {
    console.warn('[kpiJobs] No assets found in mappings.json; by-asset snapshot will be empty.');
  }

  let inserted = 0;
  let tfCount = 0;
  for (const tf of TF) {
    tfCount++;
    const { start, end } = tfRange(now, tf);
    for (const a of assets) {
      const row = {
        UptimePct:    100.0,
        DowntimeHrs:  0.0,
        MttrHrs:      0.0,
        MtbfHrs:      0.0,
        PlannedPct:   60.0,
        UnplannedPct: 40.0
      };
      await pool.request()
        .input('Timeframe', sql.NVarChar, tf)
        .input('AssetID', sql.Int, a.assetID)
        .input('Name', sql.NVarChar, a.name || null)
        .input('RangeStart', sql.DateTime2, start)
        .input('RangeEnd', sql.DateTime2, end)
        .input('UptimePct', sql.Decimal(5,1), row.UptimePct)
        .input('DowntimeHrs', sql.Decimal(10,1), row.DowntimeHrs)
        .input('MttrHrs', sql.Decimal(10,1), row.MttrHrs)
        .input('MtbfHrs', sql.Decimal(10,1), row.MtbfHrs)
        .input('PlannedPct', sql.Decimal(5,1), row.PlannedPct)
        .input('UnplannedPct', sql.Decimal(5,1), row.UnplannedPct)
        .query(`
          INSERT INTO dbo.KpiByAssetCache(Timeframe,AssetID,Name,RangeStart,RangeEnd,UptimePct,DowntimeHrs,MttrHrs,MtbfHrs,PlannedPct,UnplannedPct)
          VALUES(@Timeframe,@AssetID,@Name,@RangeStart,@RangeEnd,@UptimePct,@DowntimeHrs,@MttrHrs,@MtbfHrs,@PlannedPct,@UnplannedPct)
        `);
      inserted++;
    }
  }
  return { inserted, assets: assets.length, timeframes: tfCount };
}

export async function refreshWorkOrders(pool, page) {
  let query;
  switch (page) {
    case 'index': // general work orders
      query = `
        SELECT TOP (200)
          t.taskID,
          t.assetID,
          t.priority,
          t.name,
          t.description,
          t.type,
          t.createdDate,
          t.statusID
        FROM dbo.WorkOrders t
        WHERE t.isActive = 1
        ORDER BY t.createdDate DESC
        FOR JSON PATH
      `;
      break;
    case 'pm': // PM work orders with due date
      query = `
        SELECT TOP (200)
          t.taskID,
          t.assetID,
          t.priority,
          t.name,
          t.description,
          t.type,
          t.createdDate,
          t.due,
          t.statusID
        FROM dbo.WorkOrdersPM t
        WHERE t.isActive = 1
        ORDER BY t.due ASC
        FOR JSON PATH
      `;
      break;
    case 'prodstatus': // production status tiles/list
      query = `
        SELECT TOP (200)
          s.assetID,
          s.assetName,
          s.state,
          s.lastChangeUTC,
          s.note
        FROM dbo.ProductionStatus s
        ORDER BY s.lastChangeUTC DESC
        FOR JSON PATH
      `;
      break;
    default:
      query = `SELECT '[]' AS [data] FOR JSON PATH, WITHOUT_ARRAY_WRAPPER`;
  }
  const rs = await pool.request().query(query);
  const json = rs.recordset?.[0]?.[""] || rs.recordset?.[0]?.data || JSON.stringify([]);
  await pool.request()
    .input('Page', sql.NVarChar, page)
    .input('Data', sql.NVarChar(sql.MAX), json)
    .query(`INSERT INTO dbo.WorkOrdersCache(Page,Data) VALUES(@Page,@Data)`);
  return { inserted: 1, page };
}

