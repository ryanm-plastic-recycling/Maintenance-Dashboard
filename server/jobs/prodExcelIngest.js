// server/jobs/prodExcelIngest.js
import sql from "mssql";
import { fetchProductionExcelRows } from './productionExcelJob.js';

// ---- helpers ----
function safeNum(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function safeStr(v) { return v == null ? "" : String(v).trim(); }
function monthToInt(m) {
  if (typeof m === "number" && m >= 1 && m <= 12) return m;
  const s = safeStr(m).slice(0, 3).toLowerCase();
  const idx = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].indexOf(s);
  return idx >= 0 ? idx + 1 : NaN;
}
function clampTo24(h) { if (!Number.isFinite(h) || h < 0) return 0; return h > 24 ? 24 : h; }

// VERIFY these indexes against your sheet later
const COL = { id:0, machine:1, shift_n:2, machine_hours:14, maint_dt_h:15, pounds:17, year:22, monthNum:23, monthTxt:24, day:25 };

export function mapRow(row) {
  let m = safeNum(row[COL.monthNum]); if (!m) m = monthToInt(row[COL.monthTxt]);
  const y = safeNum(row[COL.year]); const d = safeNum(row[COL.day]);
  if (!(y && m && d)) { const err = new Error(`Bad date parts y/m/d = ${y}/${m}/${d}`); err.rowSample = row; throw err; }
  const src_date = `${String(y).padStart(4,"0")}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  const machine_hours = clampTo24(safeNum(row[COL.machine_hours]));
  const maint_dt_h    = clampTo24(safeNum(row[COL.maint_dt_h]));
  const pounds        = Math.max(0, safeNum(row[COL.pounds]));
  return {
    fact_source:"prod-excel", src_date,
    machine: safeStr(row[COL.machine]),
    shift_n: safeNum(row[COL.shift_n], null),
    material: null, pounds, machine_hours,
    maint_downtime_h: maint_dt_h, prod_downtime_h: 0, nameplate_lbs_hr: null
  };
}

function toDb(rec){
  return {
    src_date: rec.src_date, machine: rec.machine || null, shift_n: rec.shift_n ?? null,
    pounds: safeNum(rec.pounds,0), machine_hours: safeNum(rec.machine_hours,0),
    maint_downtime_h: safeNum(rec.maint_downtime_h,0), prod_downtime_h: 0,
    nameplate_lbs_hr: rec.nameplate_lbs_hr == null ? null : safeNum(rec.nameplate_lbs_hr),
    material: rec.material || null,
  };
}

async function upsertProductionFacts(pool, records){
  const table = new sql.Table("#prod_stage"); table.create = true;
  table.columns.add("src_date", sql.Date, { nullable:false });
  table.columns.add("machine", sql.NVarChar(64), { nullable:false });
  table.columns.add("shift_n", sql.Int, { nullable:true });
  table.columns.add("pounds", sql.Decimal(18,3), { nullable:false });
  table.columns.add("machine_hours", sql.Decimal(18,3), { nullable:false });
  table.columns.add("maint_downtime_h", sql.Decimal(18,3), { nullable:false });
  table.columns.add("prod_downtime_h", sql.Decimal(18,3), { nullable:false });
  table.columns.add("nameplate_lbs_hr", sql.Decimal(18,3), { nullable:true });
  table.columns.add("material", sql.NVarChar(64), { nullable:true });
  for (const rec of records){ const v = toDb(rec);
    table.rows.add(v.src_date, v.machine, v.shift_n, v.pounds, v.machine_hours, v.maint_downtime_h, v.prod_downtime_h, v.nameplate_lbs_hr, v.material);
  }
  await pool.request().bulk(table);
  const mergeSql =
`MERGE dbo.production_fact AS tgt
USING #prod_stage AS src
  ON tgt.machine = src.machine
 AND CAST(tgt.src_date AS date) = src.src_date
 AND ISNULL(tgt.shift_n,-1) = ISNULL(src.shift_n,-1)
WHEN MATCHED THEN UPDATE SET
  tgt.pounds=src.pounds, tgt.machine_hours=src.machine_hours, tgt.maint_downtime_h=src.maint_downtime_h,
  tgt.prod_downtime_h=src.prod_downtime_h, tgt.nameplate_lbs_hr=src.nameplate_lbs_hr, tgt.material=src.material
WHEN NOT MATCHED THEN INSERT
  (src_date, machine, shift_n, pounds, machine_hours, maint_downtime_h, prod_downtime_h, nameplate_lbs_hr, material)
  VALUES (src.src_date, src.machine, src.shift_n, src.pounds, src.machine_hours, src.maint_downtime_h, src.prod_downtime_h, src.nameplate_lbs_hr, src.material);`;
  await pool.request().query(mergeSql);
}

export async function runProdExcelIngest({ pool, dry=false }={}){
  const rows = await fetchProductionExcelRows(); // [] for now
  const body = rows; // or rows.slice(1) if header
  const mapped = [];
  for (let i=0;i<body.length;i++){
    try{ mapped.push(mapRow(body[i])); }
    catch(e){ e.stage="mapRow"; e.rowIndex=i; e.rowSample=body[i]; throw e; }
  }
  if (dry) return { parsed: mapped.length, sample: mapped.slice(0,5) };
  await upsertProductionFacts(pool, mapped);
  return { parsed: mapped.length, inserted: mapped.length };
}

function logWithIndexes(row) {
  if (!Array.isArray(row)) return;
  const pairs = row.map((v,i) => `[${i}] ${JSON.stringify(v)}`);
  console.log('[prod-excel] indexed row:', pairs.join(' | '));
}

// inside runProdExcelIngest, right after you pick `body`:
if (body.length) logWithIndexes(body[0]);

