// server/jobs/productionExcelJob.js (ESM)

import sql from 'mssql';
import fetch from 'node-fetch';
import { enrichNameplateFromMappings } from './enrichNameplateJob.js';

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
// NEW: fetch-only export so other modules can reuse it safely.
// Example: reuse your existing Graph code
async function fetchFromGraphExcel() {
  // put your real Graph code here and return a 2D array of rows
  // e.g., const rows = await graphClient.api(...).get();
  //       return rows.values;  // or however your code structures it
}

export async function fetchProductionExcelRows() {
  const rows = await fetchFromGraphExcel();   // <-- real call, not a comment
  console.log('[prod-excel] Graph rows:', rows?.length ?? 0);
  return rows;
}

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
  const looksLikeHeader = (r) => r && String(r[0]).toUpperCase() === 'DATE';
  const bodyRows = looksLikeHeader(rows[0]) ? rows.slice(1) : rows;

  // Build TVP
  const tvp = new sql.Table('ProductionStagingTvp'); // TVP name without schema here for mssql
  tvp.columns.add('src_date',           sql.Date);
  tvp.columns.add('machine',            sql.NVarChar(64));
  tvp.columns.add('shift',              sql.NVarChar(8));
  tvp.columns.add('source',             sql.NVarChar(64));
  tvp.columns.add('source_ref_po',      sql.NVarChar(128));
  tvp.columns.add('lot_number',         sql.NVarChar(128));
  tvp.columns.add('note',               sql.NVarChar(sql.MAX));
  tvp.columns.add('type',               sql.NVarChar(64));
  tvp.columns.add('color',              sql.NVarChar(64));
  tvp.columns.add('format',             sql.NVarChar(64));
  tvp.columns.add('options',            sql.NVarChar(128));
  tvp.columns.add('down_time_hours',    sql.Decimal(9,2));
  tvp.columns.add('reason_downtime',    sql.NVarChar(512));
  tvp.columns.add('machine_hours',      sql.Decimal(9,2));
  tvp.columns.add('standard',           sql.Decimal(12,2));
  tvp.columns.add('pounds',             sql.Decimal(18,2));
  tvp.columns.add('manhours',           sql.Decimal(9,2));
  tvp.columns.add('per_machine_hour',   sql.Decimal(12,4));
  tvp.columns.add('per_manhour2',       sql.Decimal(12,4));
  tvp.columns.add('cost_materials',     sql.Decimal(18,2));
  tvp.columns.add('cost_processing',    sql.Decimal(18,2));
  tvp.columns.add('sales_price',        sql.Decimal(18,2));
  tvp.columns.add('year_num',           sql.Int);
  tvp.columns.add('month_num',          sql.Int);
  tvp.columns.add('month_name',         sql.NVarChar(16));
  tvp.columns.add('day_num',            sql.Int);
  tvp.columns.add('day_name',           sql.NVarChar(16));
  tvp.columns.add('m_num',              sql.Int);
  tvp.columns.add('uptime_calc',        sql.Decimal(12,4));
  tvp.columns.add('shift_uptime',       sql.Decimal(12,4));
  tvp.columns.add('gw_uptime',          sql.Decimal(12,4));

  for (const r of bodyRows) {
    const rec = Object.fromEntries(hdr.map((k,i)=>[k, r[i]]));
    tvp.rows.add(
      D(rec["DATE"]),
      S(rec["Machine"],64),
      S(rec["Shift"],8),
      S(rec["Source"],64),
      S(rec["Source Ref/PO"],128),
      S(rec["Lot Number"],128),
      S(rec["Note"]),
      S(rec["Type"],64),
      S(rec["Color"],64),
      S(rec["Format"],64),
      S(rec["Options"],128),
      N(rec["Down Time"]),
      S(rec["Reason for Downtime"],512),
      N(rec["Machine Hours"]),
      N(rec["Standard"]),
      N(rec["Pounds"]),
      N(rec["Manhours"]),
      N(rec["# Per Machine Hour"]),
      N(rec["# Per Manhour2"]),
      N(rec["Cost of Materials"]),
      N(rec["Cost of Processing"]),
      N(rec["Sales Price"]),
      N(rec["Year"]),
      N(rec["Mo#"]),
      S(rec["Mo"],16),
      N(rec["Day#"]),
      S(rec["Day"],16),
      N(rec["M#"]),
      N(rec["UptimeCalc"]),
      N(rec["ShiftUptime"]),
      N(rec["GW Uptime"])
    );
  }

  // Call the proc with TVP
  const req = pool.request();
  req.input('Rows', tvp);
  await req.execute('dbo.upsert_production_staging_tvp');

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
