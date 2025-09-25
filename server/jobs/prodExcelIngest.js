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
function normMachine(v) {
  const s = v == null ? '' : String(v).trim();
  if (!s) return null;
  // hard trim to staging width
  return s.length > 64 ? s.slice(0, 64) : s;
}

// TODO: update these indexes after you run a dry-run with the index log
const COL = {
  dateSerial:    0,   // Excel serial DATE
  machine:       1,
  shift_n:       2,
  materialType:  7,   // "Type" column (Excel col H)
  color:         8,   // "Color" column (Excel col I)
  maint_dt_h:    11,  // "Down Time"
  machine_hours: 13,  // "Machine Hours"
  pounds:        15,  // "Pounds"
  year:          22,  // fallback y/m/d
  monthNum:      23,
  monthTxt:      24,
  day:           25,
};

// simple normalizer: upper-case, trim, map trivial aliases you want
function normMaterial(v) {
  const s = (v == null ? '' : String(v)).trim().toUpperCase();
  if (!s) return null;
  // cheap fixups if you want (you can expand this or let SQL aliasing handle it):
  if (s === 'PP.' ) return 'PP';
  return s;
}

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
  const material = normMaterial(row[COL.materialType]); // <-- pick "Type" from Excel
  
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
      throw err; // non-empty row with no valid date → skip upstream
    }
    src_date = `${String(y).padStart(4,"0")}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  }

  // Require a valid machine
  const machineName = normMachine(row[COL.machine]);
  if (!machineName) {
    const err = new Error('NO_MACHINE');
    err.code = 'NO_MACHINE';
    err.rowSample = row;
    throw err; // handled as a skip in the loop
  }

  // Parse once (no duplicates)
  const machine_hours = clampTo24(safeNum(row[COL.machine_hours]));
  const maint_dt_h    = clampTo24(safeNum(row[COL.maint_dt_h]));
  const pounds        = Math.max(0, safeNum(row[COL.pounds]));

  return {
    fact_source: "prod-excel",
    src_date,
    machine: machineName,
    shift_n: safeNum(row[COL.shift_n], null),
    material,
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
  if (!records?.length) return;

  // Build TVP that matches dbo.upsert_production_staging_tvp
  const tvp = new sql.Table('ProductionStagingTvp'); // name of the TVP type
  tvp.columns.add('src_date',          sql.Date);
  tvp.columns.add('machine',           sql.NVarChar(64));
  tvp.columns.add('shift',             sql.NVarChar(8));
  tvp.columns.add('source',            sql.NVarChar(64));
  tvp.columns.add('source_ref_po',     sql.NVarChar(128));
  tvp.columns.add('lot_number',        sql.NVarChar(128));
  tvp.columns.add('note',              sql.NVarChar(sql.MAX));
  tvp.columns.add('type',              sql.NVarChar(64));
  tvp.columns.add('color',             sql.NVarChar(64));
  tvp.columns.add('format',            sql.NVarChar(64));
  tvp.columns.add('options',           sql.NVarChar(128));
  tvp.columns.add('down_time_hours',   sql.Decimal(9,2));
  tvp.columns.add('reason_downtime',   sql.NVarChar(512));
  tvp.columns.add('machine_hours',     sql.Decimal(9,2));
  tvp.columns.add('standard',          sql.Decimal(12,2));
  tvp.columns.add('pounds',            sql.Decimal(18,2));
  tvp.columns.add('manhours',          sql.Decimal(9,2));
  tvp.columns.add('per_machine_hour',  sql.Decimal(12,4));
  tvp.columns.add('per_manhour2',      sql.Decimal(12,4));
  tvp.columns.add('cost_materials',    sql.Decimal(18,2));
  tvp.columns.add('cost_processing',   sql.Decimal(18,2));
  tvp.columns.add('sales_price',       sql.Decimal(18,2));
  tvp.columns.add('year_num',          sql.Int);
  tvp.columns.add('month_num',         sql.Int);
  tvp.columns.add('month_name',        sql.NVarChar(16));
  tvp.columns.add('day_num',           sql.Int);
  tvp.columns.add('day_name',          sql.NVarChar(16));
  tvp.columns.add('m_num',             sql.Int);
  tvp.columns.add('uptime_calc',       sql.Decimal(12,4));
  tvp.columns.add('shift_uptime',      sql.Decimal(12,4));
  tvp.columns.add('gw_uptime',         sql.Decimal(12,4));
  // the proc will compute normalized columns (row_hash, *_n, etc.)

  function shiftLabel(n){
    const s = Number.isFinite(n) ? Number(n) : null;
    return s == null ? null : String(s); // your staging has both shift (text) and shift_n (computed later)
  }

  for (const r of records){
    // map our minimal rec → full TVP row; most extra fields NULL
    tvp.rows.add(
      r.src_date,                         // src_date
      r.machine || null,                  // machine
      shiftLabel(r.shift_n),              // shift (text)
      null,                               // source
      null,                               // source_ref_po
      null,                               // lot_number
      null,                               // note
      r.material || null,                 // type
      row[COL.color] || null,             // color
      null,                               // format
      null,                               // options
      r.maint_downtime_h ?? 0,            // down_time_hours (shift-maint from sheet)
      null,                               // reason_downtime
      r.machine_hours ?? 0,               // machine_hours
      null,                               // standard
      r.pounds ?? 0,                      // pounds
      null,                               // manhours
      null,                               // per_machine_hour
      null,                               // per_manhour2
      null,                               // cost_materials
      null,                               // cost_processing
      null,                               // sales_price
      Number(r.src_date?.slice(0,4)) || null,            // year_num
      Number(r.src_date?.slice(5,7)) || null,            // month_num
      null,                                             // month_name
      Number(r.src_date?.slice(8,10)) || null,          // day_num
      null,                                             // day_name
      null,                                             // m_num
      null, null, null                                  // uptime_calc, shift_uptime, gw_uptime
    );
  }
  // 1) Upsert into staging via your proc
  const req = pool.request();
  req.input('Rows', tvp);
  await req.execute('dbo.upsert_production_staging_tvp');
// Blank data cleanup.
  await pool.request().query(`
  DELETE FROM dbo.production_staging
  WHERE machine IS NULL OR LTRIM(RTRIM(machine)) = ''
`);

  // (optional single safety clean before roll)
 await pool.request().query(`
   DELETE FROM dbo.production_staging
   WHERE machine IS NULL OR LTRIM(RTRIM(machine)) = ''
 `);
 // 2) Roll staging → production_fact (once)
 await pool.request().execute('dbo.upsert_production_fact');

  // 2) Roll staging → production_fact (your existing proc)
  await pool.request().execute('dbo.upsert_production_fact');
}

export async function runProdExcelIngest({ pool, dry=false } = {}){
  const all = await fetchProductionExcelRows();
  const body = (all && all.length) ? (looksLikeHeader(all[0]) ? all.slice(1) : all) : [];

  if (body.length) logWithIndexes(body[0]); // will print [0]..[n] with values

      const mapped = [];
  let skippedEmpty = 0;
  let skippedBadDate = 0;
  let skippedNoMachine = 0;

  for (let i = 0; i < body.length; i++) {
    try {
      const rec = mapRow(body[i]);
      if (rec) {
        mapped.push(rec);
      } else {
        skippedEmpty++;
      }
    } catch (e) {
      const msg = String(e.message || '');
      if (msg.startsWith('Bad date parts')) {
        skippedBadDate++;
        if (skippedBadDate <= 3) {
          console.warn('[prod-excel] skipped row (bad date) idx', i);
          logWithIndexes(body[i]);
        }
        continue;
      }
      if (e.code === 'NO_MACHINE') {
        skippedNoMachine++;
        if (skippedNoMachine <= 3) {
          console.warn('[prod-excel] skipped row (no machine) idx', i);
          logWithIndexes(body[i]);
        }
        continue;
      }
      e.stage = 'mapRow'; e.rowIndex = i; e.rowSample = body[i];
      throw e;
    }
  }

  if (dry) {
    return {
      parsed: mapped.length,
      skippedEmpty,
      skippedBadDate,
      skippedNoMachine,
      sample: mapped.slice(0,5)
    };
  }


  try { await upsertProductionFacts(pool, mapped); }
  catch(e){ e.stage="sqlUpsert"; throw e; }

  return { parsed: mapped.length, inserted: mapped.length };
}

