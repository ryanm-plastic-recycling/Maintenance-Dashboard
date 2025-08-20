import fs  from 'fs';
import sql from 'mssql';
import moment from 'moment-timezone';
import path from 'path';
import { fileURLToPath } from 'url';

const cfg = JSON.parse(fs.readFileSync('config.json','utf-8'));
const TF  = cfg.kpiByAssetTimeframes || ["lastMonth"]; // safe default

function loadMappings() {
  // Resolve project root from this file: server/jobs -> <root>
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const ROOT = path.resolve(__dirname, '..', '..');
  const envPath = process.env.MAPPINGS_PATH && process.env.MAPPINGS_PATH.trim();
  const candidates = [
    envPath,                                   // explicit override
    path.join(ROOT, 'mappings.json'),          // repo root
    path.join(ROOT, 'public', 'mappings.json') // public folder (used by front-end)
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const txt = fs.readFileSync(p, 'utf-8');
        const json = JSON.parse(txt);
        if (json && Array.isArray(json.assets)) return json;
      }
    } catch (e) {
      console.warn('[kpiJobs] failed to load mappings at', p, String(e));
    }
  }
  console.warn('[kpiJobs] mappings.json not found in', candidates);
  return { assets: [] };
}

function tfRange(now, tf) {
  const Z = 'America/Indiana/Indianapolis';
  const n = moment.tz(now, Z);
  const startOfWeekMon = n.clone().startOf('week').add(1, 'day'); // ISO Monday
  const startOfMonth   = n.clone().startOf('month');
  const startOfYear    = n.clone().startOf('year');
  const endNowLocal    = n.clone();
  const range = (sLocal, eLocal) => ({
    start: sLocal.clone().utc().toDate(),
    end:   eLocal.clone().utc().toDate()
  });

  switch (tf) {
    case 'thisWeek':  return range(startOfWeekMon, endNowLocal);
    case 'lastWeek':  return range(startOfWeekMon.clone().subtract(1,'week'), startOfWeekMon);
    case 'last30':    return range(endNowLocal.clone().subtract(30,'days'), endNowLocal);
    case 'thisMonth': return range(startOfMonth, endNowLocal);
    case 'lastMonth': return range(startOfMonth.clone().subtract(1,'month'), startOfMonth);
    case 'thisYear':  return range(startOfYear, endNowLocal);
    case 'lastYear':  return range(startOfYear.clone().subtract(1,'year'), startOfYear);
    default:          return range(endNowLocal.clone().subtract(30,'days'), endNowLocal);
  }
}

export async function refreshHeaderKpis(pool) {
  const now = new Date();
  const ranges = [
    { tf: 'lastWeek', k: 'UP' },
    { tf: 'last30',   k: 'MT' }
  ];

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
  }
}

export async function refreshByAssetKpis(pool) {
  const now = new Date();
  const mappings = loadMappings(); // expects { assets: [{assetID, name}, ...] }
  const assets = Array.isArray(mappings.assets) ? mappings.assets : [];
  if (assets.length === 0) {
    console.warn('[kpiJobs] No assets in mappings; by-asset snapshot will be empty (no crash).');
  }

  for (const tf of TF) {
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
    }
  }
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
}

