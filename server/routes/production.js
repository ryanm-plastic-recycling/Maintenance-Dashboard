// server/routes/production.js (ESM)
import express from 'express';
import sql from 'mssql';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireAdmin } from '../lib/adminAuth.js';

const QUALITY_DEFAULT = 0.70;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MAPPINGS_PATH = path.join(__dirname, '..', '..', 'public', 'mappings.json');

const DEFAULT_MAPPINGS = {
  capacities_lbs_hr: {},
  capacity_by_material_lbs_hr: {},
  capacity_aliases: {},
  material_aliases: {},
};

let mappings = DEFAULT_MAPPINGS;
try {
  const raw = fs.readFileSync(MAPPINGS_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  mappings = {
    capacities_lbs_hr: parsed.capacities_lbs_hr || {},
    capacity_by_material_lbs_hr: parsed.capacity_by_material_lbs_hr || {},
    capacity_aliases: parsed.capacity_aliases || {},
    material_aliases: parsed.material_aliases || {},
  };
} catch (err) {
  console.warn('[production-routes] Unable to read mappings.json:', err?.message || err);
}

const capacityAlias = mappings.capacity_aliases;
const capacityByLine = mappings.capacities_lbs_hr;
const capacityByMaterial = mappings.capacity_by_material_lbs_hr;
const materialAlias = mappings.material_aliases;

// --- tiny 60s cache for summary responses ---
const summaryCache = new Map();

const ISO_WEEKDAY = new Set([1, 2, 3, 4, 5]); // Monday = 1 .. Sunday = 7

function canonLine(machine) {
  if (!machine) return '';
  const raw = machine.trim();
  if (
    Object.prototype.hasOwnProperty.call(capacityByLine, raw) ||
    Object.prototype.hasOwnProperty.call(capacityByMaterial, raw)
  ) {
    return raw;
  }
  return capacityAlias?.[raw] || raw;
}

function canonMaterial(material) {
  const key = String(material ?? '').trim().toUpperCase();
  if (!key) return 'DEFAULT';
  return materialAlias?.[key] || key;
}

function capacityFor(machine, material) {
  const canon = canonLine(machine);
  const mat = canonMaterial(material);
  const byMat = capacityByMaterial?.[canon];
  if (byMat && byMat[mat] != null) return Number(byMat[mat]) || 0;
  if (byMat && byMat.DEFAULT != null) return Number(byMat.DEFAULT) || 0;
  const base = capacityByLine?.[canon];
  return Number(base) || 0;
}

function isWeekdayISO(iso) {
  if (!iso) return false;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  const dow = date.getUTCDay(); // 0=Sun .. 6=Sat
  const isoDow = dow === 0 ? 7 : dow;
  return ISO_WEEKDAY.has(isoDow);
}

function clamp(v, min, max) {
  if (!Number.isFinite(v)) v = 0;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function deriveDayMetrics(row) {
  const pounds = Number(row.pounds) || 0;
  const maintRaw = clamp(Number(row.maint_dt_h) || 0, 0, 24);
  let maint = maintRaw;
  let machineHoursRaw = Number(row.machine_hours);
  if (!Number.isFinite(machineHoursRaw) || machineHoursRaw < 0) machineHoursRaw = 0;
  machineHoursRaw = clamp(machineHoursRaw, 0, 24);
  
  const line = row.machine || '';
  const mat  = row.material || '';

  // 1) Start from machine_hours (what production reported)
  let runH = machineHoursRaw;

  // 2) ALWAYS use mappings (ignore any nameplate_lbs_hr coming from Excel)
  // const explicitCap = Number(row.nameplate_lbs_hr) || 0; // This allows for excel
  // let cap = explicitCap > 0 ? explicitCap : capacityFor(line, mat); // This allows for excel
  let cap = capacityFor(line, mat); // This ignores for excel and forced mappings!!!

  // 3) If runtime missing but we have pounds+cap, backfill runtime - - -Only use this as needed later!
  //if ((runH <= 0 || !Number.isFinite(runH)) && pounds > 0 && cap > 0) {
  //  runH = clamp(pounds / cap, 0, 24);
  //}

  // 4) If capacity still unknown but the line ran, infer cap from the day
  if ((cap <= 0 || !Number.isFinite(cap)) && runH > 0) {
    cap = pounds > 0 ? (pounds / runH) : 0;
  }

  // 5) Resolve 24h collisions by trusting machine_hours:
  //    keep runtime, and cap maintenance to the remainder.
  runH  = clamp(runH,  0, 24);
  maint = clamp(maint, 0, Math.max(0, 24 - runH));

  // 6) Remaining time budget is production DT
  const prod = clamp(24 - maint - runH, 0, 24);

  const rawCap = cap > 0 ? cap * 24 : 0;
  const adjCap = cap > 0 ? cap * Math.max(0, 24 - maint) : 0;
  const runCap = cap > 0 ? cap * runH : 0;
  const missMaint = cap > 0 ? cap * maint : 0;
  const missProd = cap > 0 ? cap * prod : 0;
  const under = Math.max(0, runCap - pounds);

  return {
    pounds,
    maint,
    maintRaw,
    machineHoursRaw,
    runH,
    prod,
    cap,
    rawCap,
    adjCap,
    runCap,
    missMaint,
    missProd,
    under,
  };
}

function aggregateByDate(rows) {
  const map = new Map();

  // Build fleet as the UNION of machines seen in data and those in mappings.
  const fromRows = new Set();
  rows.forEach(r => { if (r.machine) fromRows.add(canonLine(r.machine)); });

  const fromMap = new Set();
  Object.keys(capacityByLine || {}).forEach(k => fromMap.add(canonLine(k)));
  Object.keys(capacityByMaterial || {}).forEach(k => fromMap.add(canonLine(k)));

  const union = new Set([...fromRows, ...fromMap]);
  const FLEET_COUNT = Math.max(union.size, 1);

  for (const row of rows) {
    // if (!isWeekdayISO(row.src_date)) continue;    // WEEKDAY ONLY FILTER, REMOVE IF YOU WANT TO ONLY INCLUDE WEEKDDAYS!!!!!!!!!!!!!!!!!!!!!!!!!!!
    const key = row.src_date;
    const metrics = deriveDayMetrics(row);
    if (!map.has(key)) {
      map.set(key, {
        pounds: 0, runHours: 0, maintHours: 0, prodHours: 0,
        rawCapacity: 0, adjCapacity: 0, runCapacity: 0,
        underPerf: 0, missedMaint: 0, missedProd: 0,
        plannedHours: 0, machineDays: 0
      });
    }
    const agg = map.get(key);
    agg.pounds      += metrics.pounds;
    agg.runHours    += metrics.runH;
    agg.maintHours  += metrics.maint;
    agg.prodHours   += metrics.prod;
    agg.rawCapacity += metrics.rawCap;
    agg.adjCapacity += metrics.adjCap;
    agg.runCapacity += metrics.runCap;
    agg.underPerf   += metrics.under;
    agg.missedMaint += metrics.missMaint;
    agg.missedProd  += metrics.missProd;
    agg.machineDays += 1;
  }

  // Use full-fleet planned hours for every weekday in the range
  for (const [, agg] of map) {
    agg.plannedHours = 24 * FLEET_COUNT;
  }

  return [...map.entries()]
    .sort((a,b)=>a[0].localeCompare(b[0]))
    .map(([src_date, agg]) => {
      const availability = agg.plannedHours > 0 ? agg.runHours / agg.plannedHours : 0;
      const perfRaw      = agg.rawCapacity  > 0 ? agg.pounds  / agg.rawCapacity  : 0;
      const perfAdj      = agg.adjCapacity  > 0 ? agg.pounds  / agg.adjCapacity  : 0;
      const quality      = QUALITY_DEFAULT;
      const oee          = availability * perfAdj * quality;
      return {
        src_date,
        pounds: agg.pounds,
        run_hours: agg.runHours,
        maint_hours: agg.maintHours,
        prod_hours: agg.prodHours,
        capacity_potential_raw24_lbs: agg.rawCapacity,
        capacity_available_adj_lbs:   agg.adjCapacity,
        run_capacity_lbs:             agg.runCapacity,
        under_perf_lbs:               agg.underPerf,
        missed_maint_lbs:             agg.missedMaint,
        missed_prod_lbs:              agg.missedProd,
        total_missed_lbs:             agg.underPerf + agg.missedMaint + agg.missedProd,
        availability, perf_raw: perfRaw, perf_adj: perfAdj, quality, oee,
      };
    });
}

let materialColumnCache = { checked: false, name: null };

async function resolveMaterialColumn(pool) {
  if (!pool) return null;
  if (materialColumnCache.checked) return materialColumnCache.name;
  try {
    const { recordset } = await pool.request().query(`
      SELECT TOP (1) name
      FROM sys.columns
      WHERE object_id = OBJECT_ID('dbo.production_fact')
        AND LOWER(name) IN ('material','resin','material_family','type','resin_family','product_material')
      ORDER BY CASE LOWER(name)
        WHEN 'material' THEN 1
        WHEN 'resin' THEN 2
        WHEN 'type' THEN 3
        WHEN 'material_family' THEN 4
        WHEN 'resin_family' THEN 5
        WHEN 'product_material' THEN 6
        ELSE 7 END;
    `);
    materialColumnCache = {
      checked: true,
      name: recordset?.[0]?.name || null,
    };
  } catch (err) {
    materialColumnCache = { checked: true, name: null };
    console.warn('[production-routes] material column lookup failed:', err?.message || err);
  }
  return materialColumnCache.name;
}

async function loadLineDayRows(pool, from, to, opts = {}) {
  if (!pool) return [];
  const { includeMaterial = true, requestTimeoutMs = 45000 } = opts;

  // Only resolve material column if we plan to use it
  const materialColumn = await resolveMaterialColumn(pool);

  const materialSelect = (includeMaterial && materialColumn)
  ? 'mat.material'
  : 'CAST(NULL AS NVARCHAR(128)) AS material';

const applyJoin = (includeMaterial && materialColumn)
  ? `OUTER APPLY (
         SELECT TOP (1) pf.${materialColumn} AS material
         FROM dbo.production_fact AS pf
         WHERE CONVERT(date, pf.src_date) = CONVERT(date, v.src_date)
           AND pf.machine = v.machine
         ORDER BY pf.pounds DESC
       ) AS mat`
    : '';

  const query = `
  SELECT
    CONVERT(char(10), v.src_date, 23) AS src_date,
    v.machine,
    v.pounds,
    v.maint_dt_h,
    v.machine_hours,
    COALESCE(dm.material, 'DEFAULT') AS material,  -- dominant material for the day
    CAST(NULL AS int) AS nameplate_lbs_hr  -- <— no more Excel 8 here
  FROM dbo.v_prod_daily_line AS v
  LEFT JOIN dbo.v_prod_day_material AS dm
    ON dm.src_date = CAST(v.src_date AS date)
   AND dm.machine  = v.machine
  WHERE v.src_date BETWEEN @from AND @to
  ORDER BY v.src_date, v.machine;
`;

  // Use a longer per-request timeout
  const req = pool.request();
  req.input('from', sql.Date, from);
  req.input('to',   sql.Date, to);
  req.timeout = requestTimeoutMs;

  const out = await req.query(query).catch(e => {
    console.error('[loadLineDayRows] SQL failed', { from, to, err: e?.message || e });
    throw e;
  });

  return (out.recordset || [])
    .map(r => ({
      src_date: typeof r.src_date === 'string'
        ? r.src_date
        : (r.src_date ? r.src_date.toISOString().slice(0, 10) : null),
      machine: r.machine,
      pounds: r.pounds,
      maint_dt_h: r.maint_dt_h,
      machine_hours: r.machine_hours,
      material: r.material ?? null,
      nameplate_lbs_hr: r.nameplate_lbs_hr,
    }))
    .sort((a, b) => {
      const cmp = String(a.src_date || '').localeCompare(String(b.src_date || ''));
      return cmp !== 0 ? cmp : String(a.machine || '').localeCompare(String(b.machine || ''));
    });
}

export default function productionRoutes(poolPromise) {
  const r = express.Router();

  r.get('/production/summary', async (req, res) => {
  try {
    const pool = await poolPromise;
    if (!pool) { console.error('[production/summary] no pool'); return res.json([]); }

    const from = req.query.from || '2000-01-01';
    const to   = req.query.to   || '2100-01-01';
    const k    = `${from}|${to}`;

    // cache hit (60s TTL)
    const hit = summaryCache.get(k);
    if (hit && (Date.now() - hit.ts) < 60_000) {
      return res.json(hit.data);
    }

    let rows = [];
    try {
      rows = await loadLineDayRows(pool, from, to); // includeMaterial=false fast path
    } catch (e) {
      console.error('[production/summary] loadLineDayRows failed', { from, to, err: e?.message || e });
      return res.json([]);  // don’t 500 the UI
    }
    if (!rows || rows.length === 0) return res.json([]);

    let out;
    try {
      out = aggregateByDate(rows) || [];
    } catch (e) {
      console.error('[production/summary] aggregateByDate failed', e?.message || e);
      // simple fallback
      const map = new Map();
      for (const r of rows) {
        const d = (r.src_date || '').slice(0,10);
        if (!d) continue;
        const m = map.get(d) || { src_date: d, pounds: 0, run_hours: 0, maint_hours: 0, prod_hours: 0 };
        m.pounds      += Number(r.pounds)        || 0;
        m.run_hours   += Number(r.machine_hours) || 0;
        m.maint_hours += Number(r.maint_dt_h)    || 0;
        map.set(d, m);
      }
      out = [...map.values()].sort((a,b)=>a.src_date.localeCompare(b.src_date));
    }

    // cache store
    summaryCache.set(k, { ts: Date.now(), data: out });
    return res.json(out);
  } catch (e) {
    console.error('[production/summary] unexpected', e?.message || e);
    return res.json([]);
  }
});

  r.get('/production/by-line', async (req, res) => {
    try {
      const pool = await poolPromise;
      if (!pool) { console.error('[production/by-line] no pool'); return res.json([]); }
  
      const from = req.query.from || '2000-01-01';
      const to   = req.query.to   || '2100-01-01';
  
      try {
        const rows = await loadLineDayRows(pool, from, to, {
           includeMaterial: true,
           requestTimeoutMs: 45000
         });
        return res.json(rows || []);
      } catch (e) {
        console.error('[production/by-line] loadLineDayRows failed', { from, to, err: e?.message || e });
        return res.json([]);  // keep UI alive
      }
    } catch (e) {
      console.error('[production/by-line] unexpected', e?.message || e);
      return res.json([]);   // never 500 the UI
    }
  });

  r.get('/production/validate', async (req, res, next) => {
    try {
      const pool = await poolPromise;
      if (!pool) { res.status(503).json({ ok: false, error: 'No database connection' }); return; }
      const date = (req.query.date || '2025-08-01').slice(0, 10);
      const machineFilter = req.query.machine;

      const rows = await loadLineDayRows(pool, date, date);
      const filtered = rows.filter(row => {
        if (!isWeekdayISO(row.src_date)) return false;
        if (row.src_date !== date) return false;
        if (machineFilter && row.machine !== machineFilter) return false;
        return (Number(row.pounds) || 0) > 0 && (Number(row.maint_dt_h) || 0) > 0 && (Number(row.machine_hours) || 0) > 0;
      });

      const details = filtered.map(row => {
        const metrics = deriveDayMetrics(row);
        const perfRaw = metrics.rawCap > 0 ? metrics.pounds / metrics.rawCap : 0;
        const perfAdj = metrics.adjCap > 0 ? metrics.pounds / metrics.adjCap : 0;
        const prodFromInputs = clamp(24 - metrics.machineHoursRaw - metrics.maintRaw, 0, 24);
        return {
          machine: row.machine,
          src_date: row.src_date,
          pounds: metrics.pounds,
          machine_hours_reported: metrics.machineHoursRaw,
          maint_dt_h_reported: metrics.maintRaw,
          prod_dt_h_from_inputs: prodFromInputs,
          availability_from_inputs: metrics.machineHoursRaw / 24,
          run_hours_used: metrics.runH,
          maint_dt_h_used: metrics.maint,
          prod_dt_h_used: metrics.prod,
          availability_used: metrics.runH / 24,
          perf_raw: perfRaw,
          perf_adj: perfAdj,
          capacity_lbs_hr: metrics.cap,
          run_capacity_lbs: metrics.runCap,
          missed_maint_lbs: metrics.missMaint,
          missed_prod_lbs: metrics.missProd,
          under_perf_lbs: metrics.under,
        };
      });

      const summary = aggregateByDate(rows).find(s => s.src_date === date) || null;

      res.json({
        ok: true,
        date,
        machineFilter: machineFilter || null,
        matchedRows: details.length,
        details,
        summary,
      });
    } catch (e) { next(e); }
  });

  // --- diagnostics: capacity lookup ---------------------------------
r.get('/production/cap-check', requireAdmin, (req, res) => {
  try {
    const machine = (req.query.machine || '').trim();
    const rawMat  = (req.query.material || '').trim();
    const mat     = rawMat ? rawMat.toUpperCase() : '';
    const capByLine = capacityByLine[canonLine(machine)];
    const capByMat  = capacityByMaterial[canonLine(machine)];
    const matKey    = canonMaterial(mat);
    const mappingCap =
      (capByMat && (capByMat[matKey] ?? capByMat.DEFAULT)) ??
      (capByLine ?? null);

    res.json({
      machine_input: machine,
      material_input: rawMat,
      machine_canon: canonLine(machine),
      material_canon: matKey,
      from_capacities_lbs_hr: capByLine ?? null,
      from_capacity_by_material: capByMat ?? null,
      chosen_mapping_cap_lbs_hr: (mappingCap != null) ? Number(mappingCap) : null
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

  // --- diagnostics: per-day cap and perf-Adj exactly like UI --------------
r.get('/production/debug-cap', requireAdmin, async (req, res) => {
  try {
    const pool = await poolPromise;
    if (!pool) return res.json({ ok:false, error:'no DB pool' });

    const from = req.query.from || '2000-01-01';
    const to   = req.query.to   || '2100-01-01';
    const only = (req.query.machine || '').trim();  // optional machine filter

    // use includeMaterial so we test mapping-by-material too
    const rows = await loadLineDayRows(pool, from, to, {
      includeMaterial: true, requestTimeoutMs: 45000
    });

    const filt = only ? rows.filter(r => r.machine === only) : rows;

    // group rows by machine+day
    const dayMap = new Map(); // key: m|d -> {rows:[], lbs, maint, runH, capCandidates:[...]}
    for (const r of filt) {
      const d = (r.src_date || '').slice(0,10);
      if (!d) continue;
      const key = `${r.machine}|${d}`;
      // Force mappings
      const capRow = capacityFor(r.machine, r.material);
      const runH = Math.max(0, Number(r.machine_hours)||0);
      const md   = Math.max(0, Number(r.maint_dt_h)||0);
      const lbs  = Math.max(0, Number(r.pounds)||0);

      if (!dayMap.has(key)) dayMap.set(key, {
        machine:r.machine, day:d,
        sumCapRun:0, sumRun:0, capCandidates:[],
        lbs:0, maint:0
      });
      const o = dayMap.get(key);
      o.lbs   += lbs;
      o.maint  = Math.max(o.maint, md);
      if (capRow > 0) { o.sumCapRun += capRow * runH; o.sumRun += runH; o.capCandidates.push(capRow); }
    }

    // compute capDay and perfAdj per day
    const out = [];
    for (const o of dayMap.values()) {
      let capDay = 0;
      if (o.sumRun > 0) capDay = o.sumCapRun / o.sumRun;
      else if (o.capCandidates.length) {
        const s = o.capCandidates.slice().sort((a,b)=>a-b);
        capDay = s[Math.floor(s.length/2)];
      }
      const PERF_CAP = 1.25;
      const MIN_RUN_H_FOR_ADJ = 0.25;
      
      const adjDen = capDay * Math.max(0, 24 - o.maint);
      
      // if runtime is effectively zero, drop adjusted perf (NaN) to avoid blow-up
      let perfAdj = (o.sumRun > MIN_RUN_H_FOR_ADJ && adjDen > 0) ? (o.lbs / adjDen) : NaN;
      
      // cap (winsorize) daily values for display/debug parity with the UI
      if (Number.isFinite(perfAdj)) perfAdj = Math.min(perfAdj, PERF_CAP);
      
      out.push({ machine:o.machine, day:o.day, capDay, maint:o.maint, lbs:o.lbs, perfAdj });
    }

    // if a single machine requested, also give line-level tile numbers the same way as UI:
    let lineTile = null;
    if (only) {
      const rows = out.filter(x => x.machine === only);
      const nPA  = rows.filter(x => Number.isFinite(x.perfAdj)).length;
      const sumPA= rows.reduce((a,x)=>a + (Number.isFinite(x.perfAdj)?x.perfAdj:0),0);
      lineTile = {
        machine: only,
        perfAdj_dayAverage: (nPA>0? sumPA/nPA : null),
        note: 'day-average of daily perfAdj; not weighted by capacity'
      };
    }

    res.json({ ok:true, from, to, machineFilter: (only||null), days: out, lineTile });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});

  r.get('/production/debug-material', requireAdmin, async (req, res) => {
  const pool = await poolPromise; if (!pool) return res.json([]);
  const from = req.query.from || '2000-01-01';
  const to   = req.query.to   || '2100-01-01';
  const m    = req.query.machine;
  const rows = await loadLineDayRows(pool, from, to, { includeMaterial: true, requestTimeoutMs: 45000 });
  const filt = m ? rows.filter(r => r.machine === m) : rows;
  const map = new Map(); // m|d -> {lbsByMat}
  for (const r of filt) {
    const d = (r.src_date||'').slice(0,10); if (!d) continue;
    const key = `${r.machine}|${d}`;
    const mat = String(r.material||'').trim().toUpperCase() || 'DEFAULT';
    if (!map.has(key)) map.set(key, { machine:r.machine, day:d, lbsByMat:{} });
    const o = map.get(key);
    o.lbsByMat[mat] = (o.lbsByMat[mat]||0) + (Number(r.pounds)||0);
  }
  const out = [...map.values()].map(o => {
    let bestK='DEFAULT', bestV=-1;
    for (const [k,v] of Object.entries(o.lbsByMat)) if (v>bestV){ bestV=v; bestK=k; }
    return { machine:o.machine, day:o.day, dominant_material:bestK, lbs:o.lbsByMat[bestK] };
  });
  res.json(out);
});

  // --- admin: capacity audit (by day) ---------------------------------
r.get('/admin/cap-audit', requireAdmin, async (req, res) => {
  try {
    const pool = await poolPromise; if (!pool) return res.json({ ok:false, error:'no DB pool' });
    const from   = (req.query.from || '2000-01-01').slice(0,10);
    const to     = (req.query.to   || '2100-01-01').slice(0,10);
    const mach   = (req.query.machine || '').trim() || null;
    const limit  = Math.max(1, Math.min(Number(req.query.limit)||20, 500));

    // pull rows with day-level material
    const rows = await loadLineDayRows(pool, from, to, { includeMaterial: true, requestTimeoutMs: 45000 });
    const filt = mach ? rows.filter(r => r.machine === mach) : rows;

    // group by machine+day like the UI
    const byDay = new Map(); // m|d -> {machine, day, md, lbs, sumCapRun, sumRun, caps:[], mats:Set()}
    for (const r of filt) {
      const d  = (r.src_date||'').slice(0,10); if (!d) continue;
      const k  = `${r.machine}|${d}`;
      const nm = Number(r.nameplate_lbs_hr)||0;
      const mat= String(r.material||'').trim().toUpperCase() || 'DEFAULT';
      const capFromMap = nm>0 ? nm : capacityFor(r.machine, mat);
      const runH = Math.max(0, Number(r.machine_hours)||0);
      const md   = Math.max(0, Number(r.maint_dt_h)||0);
      const lbs  = Math.max(0, Number(r.pounds)||0);

      if (!byDay.has(k)) byDay.set(k, { machine:r.machine, day:d, md:0, lbs:0, sumCapRun:0, sumRun:0, caps:[], mats:new Set() });
      const o = byDay.get(k);
      o.lbs += lbs;
      o.md   = Math.max(o.md, md);
      o.mats.add(mat);
      if (capFromMap>0) { o.sumCapRun += capFromMap * runH; o.sumRun += runH; o.caps.push({cap:capFromMap, mat, nm}); }
    }

    // compute per-day figures
    const out = [];
    for (const o of byDay.values()) {
      let capDay = 0, how = 'none';
      if (o.sumRun > 0) { capDay = o.sumCapRun / o.sumRun; how = 'run-weighted'; }
      else if (o.caps.length) {
        const arr = o.caps.map(x=>x.cap).sort((a,b)=>a-b);
        capDay = arr[Math.floor(arr.length/2)]; how = 'median-candidate';
      }
      const adjDen = capDay * Math.max(0, 24 - o.md);
      const perfAdj = adjDen>0 ? (o.lbs/adjDen) : null;

      // show the “primary” material (by pounds) for the day
      let domMat = 'DEFAULT', mapLbs = {};
      for (const r of o.caps) mapLbs[r.mat] = (mapLbs[r.mat]||0) + 1;
      let best=-1; for (const [k,v] of Object.entries(mapLbs)) if (v>best){ best=v; domMat=k; }

      // show a representative mapped cap for that mat (ignoring nameplate)
      const chosenMapCap = capacityFor(o.machine, domMat);

      out.push({
        machine: o.machine,
        day: o.day,
        mat_dom: domMat,
        chosen_mapping_cap_lbs_hr: chosenMapCap,
        capDay_used_by_UI: capDay,
        capDay_how: how,              // run-weighted vs median-candidate
        maint_h: o.md,
        pounds: o.lbs,
        perfAdj: perfAdj
      });
    }

    // order newest first, cap
    const sorted = out.sort((a,b)=> (a.machine===b.machine ? a.day.localeCompare(b.day) : a.machine.localeCompare(b.machine)) );
    res.json({ ok:true, from, to, machine: mach, rows: sorted.slice(0, limit) });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});

  return r;
}
