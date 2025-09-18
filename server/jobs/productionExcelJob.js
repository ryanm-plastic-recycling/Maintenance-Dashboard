// server/jobs/productionExcelJob.js (ESM)

import sql from 'mssql';
import fetch from 'node-fetch';

// ---------- helpers ----------
const S = (v, max) => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\0/g, '').trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
};
const N = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const num = Number(String(v).replace(/[, ]+/g, ''));
  return Number.isFinite(num) ? num : null;
};
const D = (v) => {
  if (v === null || v === undefined || v === '') return null;

  // Excel serial date (days since 1899-12-30). Graph often returns numbers like 43173.
  if (typeof v === 'number' && Number.isFinite(v)) {
    const base = new Date(Date.UTC(1899, 11, 30)); // 1899-12-30
    const ms = Math.round(v * 86400000);           // days -> ms
    return new Date(base.getTime() + ms);
  }

  // Strings like "3/14/2018" or ISO should still work
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

// ---------- graph auth + fetch ----------
async function graphToken() {
  const body = new URLSearchParams({
    client_id: process.env.GRAPH_CLIENT_ID,
    client_secret: process.env.GRAPH_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const res = await fetch(`https://login.microsoftonline.com/${process.env.GRAPH_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error('Token failed: ' + (await res.text()));
  const j = await res.json();
  return j.access_token;
}

async function getTableRows(token) {
  const { SP_ITEM_ID, SP_SHEET_NAME, SP_TABLE_NAME } = process.env;
  if (!SP_ITEM_ID || !SP_TABLE_NAME) {
    throw new Error('Missing SP_ITEM_ID or SP_TABLE_NAME in .env');
  }
  const url = `https://graph.microsoft.com/v1.0/drives/${process.env.SP_DRIVE_ID}/items/${SP_ITEM_ID}/workbook/tables('${encodeURIComponent(SP_TABLE_NAME)}')/rows`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('Graph rows failed: ' + (await res.text()));
  const j = await res.json();
  // each row.values is a 2D array; we want the first row of values
  return (j.value || []).map(r => r.values?.[0] || []);
}

// ---------- db load ----------
async function upsertStaging(pool, rows) {
  if (!rows.length) return 0;

  const hdr = [
    "DATE","Machine","Shift","Source","Source Ref/PO","Lot Number","Note","Type","Color","Format","Options",
    "Down Time","Reason for Downtime","Machine Hours","Standard","Pounds","Manhours","# Per Machine Hour","# Per Manhour2",
    "Cost of Materials","Cost of Processing","Sales Price","Year","Mo#","Mo","Day#","Day","M#","UptimeCalc","ShiftUptime","GW Uptime"
  ];

  // If header row is present, drop it
  const looksLikeHeader = (r) => r && String(r[0]).toUpperCase() === 'DATE';
  const bodyRows = looksLikeHeader(rows[0]) ? rows.slice(1) : rows;

  for (const r of bodyRows) {
    const rec = Object.fromEntries(hdr.map((k, i) => [k, r[i]]));

    const req = new sql.Request(pool);
    req.input('DATE',          sql.Date,            D(rec["DATE"]));
    req.input('Machine',       sql.NVarChar(64),    S(rec["Machine"], 64));
    req.input('Shift',         sql.NVarChar(8),     S(rec["Shift"], 8));
    req.input('Source',        sql.NVarChar(64),    S(rec["Source"], 64));
    req.input('SourceRefPO',   sql.NVarChar(128),   S(rec["Source Ref/PO"], 128));
    req.input('LotNumber',     sql.NVarChar(128),   S(rec["Lot Number"], 128));
    req.input('Note',          sql.NVarChar(sql.MAX), S(rec["Note"]));
    req.input('Type',          sql.NVarChar(64),    S(rec["Type"], 64));
    req.input('Color',         sql.NVarChar(64),    S(rec["Color"], 64));
    req.input('Format',        sql.NVarChar(64),    S(rec["Format"], 64));
    req.input('Options',       sql.NVarChar(128),   S(rec["Options"], 128));

    req.input('DownTime',      sql.Decimal(9, 2),   N(rec["Down Time"]));
    req.input('ReasonDT',      sql.NVarChar(512),   S(rec["Reason for Downtime"], 512));
    req.input('MachineHours',  sql.Decimal(9, 2),   N(rec["Machine Hours"]));
    req.input('Standard',      sql.Decimal(12, 2),  N(rec["Standard"]));
    req.input('Pounds',        sql.Decimal(18, 2),  N(rec["Pounds"]));
    req.input('Manhours',      sql.Decimal(9, 2),   N(rec["Manhours"]));
    req.input('PerMachHr',     sql.Decimal(12, 4),  N(rec["# Per Machine Hour"]));
    req.input('PerManHr2',     sql.Decimal(12, 4),  N(rec["# Per Manhour2"]));
    req.input('CostMaterials', sql.Decimal(18, 2),  N(rec["Cost of Materials"]));
    req.input('CostProcess',   sql.Decimal(18, 2),  N(rec["Cost of Processing"]));
    req.input('SalesPrice',    sql.Decimal(18, 2),  N(rec["Sales Price"]));
    req.input('YearNum',       sql.Int,             N(rec["Year"]));
    req.input('MonthNum',      sql.Int,             N(rec["Mo#"]));
    req.input('MonthName',     sql.NVarChar(16),    S(rec["Mo"], 16));
    req.input('DayNum',        sql.Int,             N(rec["Day#"]));
    req.input('DayName',       sql.NVarChar(16),    S(rec["Day"], 16));
    req.input('MNum',          sql.Int,             N(rec["M#"]));
    req.input('UptimeCalc',    sql.Decimal(12, 4),  N(rec["UptimeCalc"]));
    req.input('ShiftUptime',   sql.Decimal(12, 4),  N(rec["ShiftUptime"]));
    req.input('GWUptime',      sql.Decimal(12, 4),  N(rec["GW Uptime"]));

    await req.query(`
      MERGE dbo.production_staging AS tgt
      USING (SELECT
        @DATE AS src_date, @Machine AS machine, @Shift AS shift, @Source AS source, @SourceRefPO AS source_ref_po,
        @LotNumber AS lot_number, @Note AS note, @Type AS type, @Color AS color, @Format AS format, @Options AS options,
        @DownTime AS down_time_hours, @ReasonDT AS reason_downtime, @MachineHours AS machine_hours, @Standard AS standard,
        @Pounds AS pounds, @Manhours AS manhours, @PerMachHr AS per_machine_hour, @PerManHr2 AS per_manhour2,
        @CostMaterials AS cost_materials, @CostProcess AS cost_processing, @SalesPrice AS sales_price,
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
}

// ---------- exported job ----------
export async function ingestProductionExcel(pool) {
  const token = await graphToken();                     // <-- define token here
  const rows  = await getTableRows(token);              // <-- use it here
  console.log('[prod-excel] Graph rows:', rows.length);
  if (rows[0]) console.log('[prod-excel] first row sample:', rows[0]);

  const n = await upsertStaging(pool, rows);
  console.log('[prod-excel] inserted/merged into staging:', n);

  await pool.request().execute('dbo.upsert_production_fact');
  return { rows: n };
}
