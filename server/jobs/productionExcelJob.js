// server/jobs/productionExcelJob.js
import sql from 'mssql';
import fetch from 'node-fetch';

const S = (v, max) => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\0/g, '').trim();
  if (s === '') return null;
  return max ? s.slice(0, max) : s;
};

const N = (v) => {
  if (v === null || v === undefined || v === '') return null;
  // remove commas/spaces; handle Excel-formatted strings
  const num = Number(String(v).replace(/[, ]+/g, ''));
  return Number.isFinite(num) ? num : null;
};

const D = (v) => {
  if (v === null || v === undefined || v === '') return null;
  // If Graph returns an ISO date, Date(...) works. If it’s like "9/16/2025", also works.
  const d = new Date(v);
  return isNaN(d) ? null : d;
};

const graphToken = async () => {
  const body = new URLSearchParams({
    client_id: process.env.GRAPH_CLIENT_ID,
    client_secret: process.env.GRAPH_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const res = await fetch(`https://login.microsoftonline.com/${process.env.GRAPH_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) throw new Error('Token failed: ' + (await res.text()));
  const j = await res.json();
  return j.access_token;
};

const getTableRows = async (token) => {
  const { SP_SITE_ID, SP_DRIVE_ID, SP_ITEM_ID, SP_SHEET_NAME, SP_TABLE_NAME } = process.env;
  // Read Excel table values (evaluated formulas -> values)
  const url = `https://graph.microsoft.com/v1.0/sites/${SP_SITE_ID}/drives/${SP_DRIVE_ID}/items/${SP_ITEM_ID}/workbook/worksheets('${encodeURIComponent(SP_SHEET_NAME)}')/tables('${encodeURIComponent(SP_TABLE_NAME)}')/rows`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }});
  if (!res.ok) throw new Error('Graph rows failed: ' + (await res.text()));
  const j = await res.json();
  return (j.value || []).map(r => r.values?.[0] || []);  // each row.values is 2D
};

const rows  = await getTableRows(token);
console.log('[prod-excel] rows from Graph:', rows.length);
if (rows[0]) console.log('[prod-excel] sample first row:', rows[0]);

const upsertStaging = async (pool, rows) => {
  if (!rows.length) return 0;

  // Header order per your screenshot/list
  const hdr = ["DATE","Machine","Shift","Source","Source Ref/PO","Lot Number","Note","Type","Color","Format","Options","Down Time","Reason for Downtime","Machine Hours","Standard","Pounds","Manhours","# Per Machine Hour","# Per Manhour2","Cost of Materials","Cost of Processing","Sales Price","Year","Mo#","Mo","Day#","Day","M#","UptimeCalc","ShiftUptime","GW Uptime"];

  // Table starts at row 5; Graph table excludes header if it’s part of the Excel "table"
  // If the first row smells like headers, drop it.
  const looksLikeHeader = (r) => r && r[0] && String(r[0]).toUpperCase() === 'DATE';
  const bodyRows = looksLikeHeader(rows[0]) ? rows.slice(1) : rows;

  const request = new sql.Request(pool);
  // Use TVP (table-valued parameter) or bulk insert; here is a simple row-by-row pattern for clarity.
  // inside upsertStaging(pool, rows)
  console.log('[prod-excel] inserting', bodyRows.length, 'rows into staging');
  for (const r of bodyRows) {
    const rec = Object.fromEntries(hdr.map((k,i)=>[k, r[i]]));
  
    const req = new sql.Request(pool);
    req.input('DATE',         sql.Date,          D(rec["DATE"]));
    req.input('Machine',      sql.NVarChar(64),  S(rec["Machine"], 64));
    req.input('Shift',        sql.NVarChar(8),   S(rec["Shift"], 8));          // <- key fix
    req.input('Source',       sql.NVarChar(64),  S(rec["Source"], 64));
    req.input('SourceRefPO',  sql.NVarChar(128), S(rec["Source Ref/PO"], 128));
    req.input('LotNumber',    sql.NVarChar(128), S(rec["Lot Number"], 128));
    req.input('Note',         sql.NVarChar(sql.MAX), S(rec["Note"]));
    req.input('Type',         sql.NVarChar(64),  S(rec["Type"], 64));
    req.input('Color',        sql.NVarChar(64),  S(rec["Color"], 64));
    req.input('Format',       sql.NVarChar(64),  S(rec["Format"], 64));
    req.input('Options',      sql.NVarChar(128), S(rec["Options"], 128));
    
    req.input('DownTime',     sql.Decimal(9,2),  N(rec["Down Time"]));
    req.input('ReasonDT',     sql.NVarChar(512), S(rec["Reason for Downtime"], 512));
    req.input('MachineHours', sql.Decimal(9,2),  N(rec["Machine Hours"]));
    req.input('Standard',     sql.Decimal(12,2), N(rec["Standard"]));
    req.input('Pounds',       sql.Decimal(18,2), N(rec["Pounds"]));
    req.input('Manhours',     sql.Decimal(9,2),  N(rec["Manhours"]));
    req.input('PerMachHr',    sql.Decimal(12,4), N(rec["# Per Machine Hour"]));
    req.input('PerManHr2',    sql.Decimal(12,4), N(rec["# Per Manhour2"]));
    req.input('CostMaterials',sql.Decimal(18,2), N(rec["Cost of Materials"]));
    req.input('CostProcessing',sql.Decimal(18,2),N(rec["Cost of Processing"]));
    req.input('SalesPrice',   sql.Decimal(18,2), N(rec["Sales Price"]));
    req.input('YearNum',      sql.Int,           N(rec["Year"]));
    req.input('MonthNum',     sql.Int,           N(rec["Mo#"]));
    req.input('MonthName',    sql.NVarChar(16),  S(rec["Mo"], 16));
    req.input('DayNum',       sql.Int,           N(rec["Day#"]));
    req.input('DayName',      sql.NVarChar(16),  S(rec["Day"], 16));
    req.input('MNum',         sql.Int,           N(rec["M#"]));
    req.input('UptimeCalc',   sql.Decimal(12,4), N(rec["UptimeCalc"]));
    req.input('ShiftUptime',  sql.Decimal(12,4), N(rec["ShiftUptime"]));
    req.input('GWUptime',     sql.Decimal(12,4), N(rec["GW Uptime"]));
  
    await req.query(`
      MERGE dbo.production_staging AS tgt
      USING (SELECT
        @DATE AS src_date, @Machine AS machine, @Shift AS shift, @Source AS source, @SourceRefPO AS source_ref_po,
        @LotNumber AS lot_number, @Note AS note, @Type AS type, @Color AS color, @Format AS format, @Options AS options,
        @DownTime AS down_time_hours, @ReasonDT AS reason_downtime, @MachineHours AS machine_hours, @Standard AS standard,
        @Pounds AS pounds, @Manhours AS manhours, @PerMachHr AS per_machine_hour, @PerManHr2 AS per_manhour2,
        @CostMaterials AS cost_materials, @CostProcessing AS cost_processing, @SalesPrice AS sales_price,
        @YearNum AS year_num, @MonthNum AS month_num, @MonthName AS month_name, @DayNum AS day_num, @DayName AS day_name,
        @MNum AS m_num, @UptimeCalc AS uptime_calc, @ShiftUptime AS shift_uptime, @GWUptime AS gw_uptime
      ) AS src
      ON (tgt.src_date = src.src_date
          AND tgt.machine = src.machine
          AND ISNULL(tgt.shift,'') = ISNULL(src.shift,'')
          AND ISNULL(tgt.lot_number,'') = ISNULL(src.lot_number,'')
          AND ISNULL(tgt.source_ref_po,'') = ISNULL(src.source_ref_po,''))
      WHEN MATCHED THEN UPDATE SET
        source = src.source, note = src.note, type = src.type, color = src.color, format = src.format, options = src.options,
        down_time_hours = src.down_time_hours, reason_downtime = src.reason_downtime, machine_hours = src.machine_hours,
        standard = src.standard, pounds = src.pounds, manhours = src.manhours, per_machine_hour = src.per_machine_hour,
        per_manhour2 = src.per_manhour2, cost_materials = src.cost_materials, cost_processing = src.cost_processing,
        sales_price = src.sales_price, year_num = src.year_num, month_num = src.month_num, month_name = src.month_name,
        day_num = src.day_num, day_name = src.day_name, m_num = src.m_num, uptime_calc = src.uptime_calc,
        shift_uptime = src.shift_uptime, gw_uptime = src.gw_uptime, loaded_at_utc = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (
        src_date, machine, shift, source, source_ref_po, lot_number, note, type, color, format, options,
        down_time_hours, reason_downtime, machine_hours, standard, pounds, manhours, per_machine_hour, per_manhour2,
        cost_materials, cost_processing, sales_price, year_num, month_num, month_name, day_num, day_name, m_num,
        uptime_calc, shift_uptime, gw_uptime
      ) VALUES (
        src.src_date, src.machine, src.shift, src.source, src.source_ref_po, src.lot_number, src.note, src.type, src.color,
        src.format, src.options, src.down_time_hours, src.reason_downtime, src.machine_hours, src.standard, src.pounds,
        src.manhours, src.per_machine_hour, src.per_manhour2, src.cost_materials, src.cost_processing, src.sales_price,
        src.year_num, src.month_num, src.month_name, src.day_num, src.day_name, src.m_num, src.uptime_calc,
        src.shift_uptime, src.gw_uptime
      );
    `);
  }
  return bodyRows.length;
};

export async function ingestProductionExcel(pool) {
  const token = await graphToken();
  const rows  = await getTableRows(token);
  const n     = await upsertStaging(pool, rows);
  // Push to fact
  await pool.request().execute('dbo.upsert_production_fact');
  return { rows: n };
}
