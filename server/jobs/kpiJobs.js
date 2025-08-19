import fs  from 'fs';
import sql from 'mssql';

const cfg = JSON.parse(fs.readFileSync('config.json','utf-8'));
const TF  = cfg.kpiByAssetTimeframes || ["lastMonth"]; // safe default

function tfRange(now, tf) {
  const d = new Date(now);
  const utc = (y,m,day,h=0,min=0,s=0)=> new Date(Date.UTC(y,m,day,h,min,s));
  const startOfWeek = (dt) => {
    const day = dt.getUTCDay();
    const mondayOffset = (day+6)%7;
    const st = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate() - mondayOffset));
    return utc(st.getUTCFullYear(), st.getUTCMonth(), st.getUTCDate());
  };
  const startOfMonth = (dt)=> utc(dt.getUTCFullYear(), dt.getUTCMonth(), 1);
  const startOfYear  = (dt)=> utc(dt.getUTCFullYear(), 0, 1);
  const endNow = utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), 0);

  switch (tf) {
    case 'thisWeek':  return { start: startOfWeek(d), end: endNow };
    case 'lastWeek':  { const s = startOfWeek(d); return { start: new Date(s-7*864e5), end: s }; }
    case 'last30':    return { start: new Date(endNow-30*864e5), end: endNow };
    case 'thisMonth': return { start: startOfMonth(d), end: endNow };
    case 'lastMonth': { const s = startOfMonth(d); const ps = utc(s.getUTCFullYear(), s.getUTCMonth()-1, 1); return { start: ps, end: s }; }
    case 'thisYear':  return { start: startOfYear(d), end: endNow };
    case 'lastYear':  { const s = startOfYear(d); const ps = utc(s.getUTCFullYear()-1, 0, 1); return { start: ps, end: s }; }
    default:          return { start: new Date(endNow-30*864e5), end: endNow };
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
  const mappings = JSON.parse(fs.readFileSync('mappings.json','utf-8'));
  const assets = mappings.assets || [];

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
  const json = JSON.stringify([{ id: 1, title: "Example WO", status: "Open" }]);
  await pool.request()
    .input('Page', sql.NVarChar, page)
    .input('Data', sql.NVarChar(sql.MAX), json)
    .query(`INSERT INTO dbo.WorkOrdersCache(Page,Data) VALUES(@Page,@Data)`);
}

