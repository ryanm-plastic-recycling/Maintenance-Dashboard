// server/routes/production.js (ESM)
import express from 'express';
import sql from 'mssql';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
  const mat = row.material || '';
  const explicitCap = Number(row.nameplate_lbs_hr) || 0;
  const cap = explicitCap > 0 ? explicitCap : capacityFor(line, mat);

  let runH = machineHoursRaw;
  if (runH <= 0 && pounds > 0 && cap > 0) {
    runH = clamp(pounds / cap, 0, 24);
  }

  const totalHM = maint + runH;
  if (totalHM > 24 && totalHM > 0) {
    const scale = 24 / totalHM;
    maint = clamp(maint * scale, 0, 24);
    runH = clamp(runH * scale, 0, 24);
  }

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
  for (const row of rows) {
    if (!isWeekdayISO(row.src_date)) continue;
    const key = row.src_date;
    const metrics = deriveDayMetrics(row);
    if (!map.has(key)) {
      map.set(key, {
        pounds: 0,
        runHours: 0,
        maintHours: 0,
        prodHours: 0,
        rawCapacity: 0,
        adjCapacity: 0,
        runCapacity: 0,
        underPerf: 0,
        missedMaint: 0,
        missedProd: 0,
        plannedHours: 0,
        machineDays: 0,
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
    agg.plannedHours += 24;
    agg.machineDays += 1;
  }

  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([src_date, agg]) => {
      const availability = agg.plannedHours > 0 ? agg.runHours / agg.plannedHours : 0;
      const perfRaw      = agg.rawCapacity > 0 ? agg.pounds / agg.rawCapacity : 0;
      const perfAdj      = agg.adjCapacity > 0 ? agg.pounds / agg.adjCapacity : 0;
      const quality      = QUALITY_DEFAULT;
      const oee          = availability * perfAdj * quality;
      const totalMissed  = agg.underPerf + agg.missedMaint + agg.missedProd;

      return {
        src_date,
        pounds: agg.pounds,
        run_hours: agg.runHours,
        maint_hours: agg.maintHours,
        prod_hours: agg.prodHours,
        capacity_potential_raw24_lbs: agg.rawCapacity,
        capacity_available_adj_lbs: agg.adjCapacity,
        run_capacity_lbs: agg.runCapacity,
        under_perf_lbs: agg.underPerf,
        missed_maint_lbs: agg.missedMaint,
        missed_prod_lbs: agg.missedProd,
        total_missed_lbs: totalMissed,
        availability,
        perf_raw: perfRaw,
        perf_adj: perfAdj,
        quality,
        oee,
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

async function loadLineDayRows(pool, from, to) {
  if (!pool) return [];
  const materialColumn = await resolveMaterialColumn(pool);
  const materialSelect = materialColumn
    ? 'mat.material'
    : 'CAST(NULL AS NVARCHAR(128)) AS material';
  const applyJoin = materialColumn
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
      ${materialSelect},
      v.nameplate_lbs_hr
    FROM dbo.v_prod_daily_line AS v
    ${applyJoin}
    WHERE v.src_date BETWEEN @from AND @to
    ORDER BY v.src_date, v.machine;
  `;

  const out = await pool.request()
    .input('from', sql.Date, from)
    .input('to',   sql.Date, to)
    .query(query);

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
    .filter(r => isWeekdayISO(r.src_date))
    .sort((a, b) => {
      const cmp = String(a.src_date || '').localeCompare(String(b.src_date || ''));
      return cmp !== 0 ? cmp : String(a.machine || '').localeCompare(String(b.machine || ''));
    });
}

export default function productionRoutes(poolPromise) {
  const r = express.Router();

  r.get('/production/summary', async (req, res, next) => {
    try {
      const pool = await poolPromise;
      if (!pool) { res.json([]); return; }
      const from = req.query.from || '2000-01-01';
      const to   = req.query.to   || '2100-01-01';

      const rows = await loadLineDayRows(pool, from, to);
      const summary = aggregateByDate(rows);
      res.json(summary);
    } catch (e) { next(e); }
  });

  r.get('/production/by-line', async (req, res, next) => {
    try {
      const pool = await poolPromise;
      if (!pool) { res.json([]); return; }
      const from = req.query.from || '2000-01-01';
      const to   = req.query.to   || '2100-01-01';

      const rows = await loadLineDayRows(pool, from, to);
      // Production's historical "downtime" column is ignored; prod DT is derived from machine_hours & maint_dt.
      res.json(rows);
    } catch (e) { next(e); }
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

  return r;
}
