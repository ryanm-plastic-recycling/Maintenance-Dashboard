// server/jobs/prodExcelIngest.js
import sql from "mssql";
import { fetchProductionExcelRows } from "./productionExcelJob.js";

// ---------- helpers ----------
function safeNum(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function safeStr(v) { return v == null ? "" : String(v).trim(); }
function monthToInt(m) {
  if (typeof m === "number" && m >= 1 && m <= 12) return m;
  const s = safeStr(m).slice(0,3).toLowerCase();
  const idx = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].indexOf(s);
  return idx >= 0 ? idx + 1 : NaN;
}
function clampTo24(h) { if (!Number.isFinite(h) || h < 0) return 0; return h > 24 ? 24 : h; }
function looksLikeHeader(row){
  if (!Array.isArray(row)) return false;
  const s = row.map(v => String(v ?? "").toLowerCase());
  return s.includes("machine") || s.includes("pounds") || s.includes("shift") || s.includes("date");
}
function logWithIndexes(row){
  if (!Array.isArray(row)) return;
  const pairs = row.map((v,i)=>`[${i}] ${JSON.stringify(v)}`);
  console.log("[prod-excel] indexed row:", pairs.join(" | "));
}

// TODO: update these indexes after you run a dry-run with the index log
const COL = {
  dateSerial:    0,   // Excel serial DATE
  machine:       1,
  shift_n:       2,
  maint_dt_h:    11,  // "Down Time"
  machine_hours: 13,  // "Machine Hours"
  pounds:        15,  // "Pounds"
  year:          22,  // fallback y/m/d
  monthNum:      23,
  monthTxt:      24,
  day:           25,
};


function excelSerialToISO(n) {
  const dnum = Number(n);
  if (!Number.isFinite(dnum) || dnum <= 0) return null;
  const base = Date.UTC(1899, 11, 30);        // 1899-12-30
  const ms = Math.round(dnum * 86400000);
  const dt = new Date(base + ms);
  if (Number.isNaN(dt.getTime())) return null;
  const Y = dt.getUTCFullYear();
  const M = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const D = String(dt.getUTCDate()).padStart(2, "0");
  return `${Y}-${M}-${D}`;
}

function isTrulyEmptyRow(row) {
  if (!Array.isArray(row)) return true;
  // Treat as empty if no machine, no pounds, no machine hours, and no date indicators
  const textish = (v) => (v == null ? "" : String(v).trim());
  const numish  = (v) => Number.isFinite(Number(v)) ? Number(v) : NaN;

  const hasMachine = !!textish(row[COL.machine]);
  const hasPounds  = Number.isFinite(numish(row[COL.pounds])) && numish(row[COL.pounds]) > 0;
  const hasMH      = Number.isFinite(numish(row[COL.machine_hours])) && numish(row[COL.machine_hours]) > 0;

  const hasSerial  = Number.isFinite(numish(row[COL.dateSerial])) && numish(row[COL.dateSerial]) > 0;
  const hasYMD     = Number.isFinite(numish(row[COL.year])) && Number.isFinite(numish(row[COL.day])) &&
                     (Number.isFinite(numish(row[COL.monthNum])) || (row[COL.monthTxt] && String(row[COL.monthTxt]).trim()));

  return !(hasMachine || hasPounds || hasMH || hasSerial || hasYMD);
}

export function mapRow(row){
  // Skip fully blank rows
  if (isTrulyEmptyRow(row)) return null;

  // Prefer serial date (col 0)
  let src_date = excelSerialToISO(row[COL.dateSerial]);

  // Fallback to Year/Mo#/Mo/Day#
  if (!src_date) {
    let m = safeNum(row[COL.monthNum]);
    if (!m) m = monthToInt(row[COL.monthTxt]);
    const y = safeNum(row[COL.year]);
    const d = safeNum(row[COL.day]);
    if (!(y && m && d)) {
      const err = new Error(`Bad date parts y/m/d = ${y||0}/${m||0}/${d||0}`);
      err.rowSample = row;
      throw err; // non-empty row with no valid date → real data issue, not a blank line
    }
    src_date = `${String(y).padStart(4,"0")}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  }

  const machine_hours = clampTo24(safeNum(row[COL.machine_hours]));
  const maint_dt_h    = clampTo24(safeNum(row[COL.maint_dt_h]));
  const pounds        = Math.max(0, safeNum(row[COL.pounds]));

  return {
    fact_source: "prod-excel",
    src_date,
    machine: safeStr(row[COL.machine]),
    shift_n: safeNum(row[COL.shift_n], null),
    material: null,
    pounds,
    machine_hours,
    maint_downtime_h: maint_dt_h,
    prod_downtime_h: 0,
    nameplate_lbs_hr: null,
  };
}

function toDb(rec){
  return {
    src_date: rec.src_date,
    machine: rec.machine || null,
    shift_n: rec.shift_n ?? null,
    pounds: safeNum(rec.pounds, 0),
    machine_hours: safeNum(rec.machine_hours, 0),
    maint_downtime_h: safeNum(rec.maint_downtime_h, 0),
    prod_downtime_h: 0,
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

  for (const r of records){
    const v = toDb(r);
    table.rows.add(
      v.src_date, v.machine, v.shift_n, v.pounds, v.machine_hours,
      v.maint_downtime_h, v.prod_downtime_h, v.nameplate_lbs_hr, v.material
    );
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

export async function runProdExcelIngest({ pool, dry=false } = {}){
  const all = await fetchProductionExcelRows();
  const body = (all && all.length) ? (looksLikeHeader(all[0]) ? all.slice(1) : all) : [];

  if (body.length) logWithIndexes(body[0]); // will print [0]..[n] with values

  const mapped = [];
  for (let i=0;i<body.length;i++){
    try {
      const rec = mapRow(body[i]);
      if (rec) mapped.push(rec);          // << skip empty rows (null)
    } catch(e){
      e.stage="mapRow"; e.rowIndex=i; e.rowSample=body[i]; throw e;
    }
  }

  if (dry) return { parsed: mapped.length, sample: mapped.slice(0,5) };

  try { await upsertProductionFacts(pool, mapped); }
  catch(e){ e.stage="sqlUpsert"; throw e; }

  return { parsed: mapped.length, inserted: mapped.length };
}

