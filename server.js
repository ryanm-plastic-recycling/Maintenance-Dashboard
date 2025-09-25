import 'dotenv/config'; // or: const dotenv = require('dotenv'); dotenv.config();
import express  from 'express';
import { fileURLToPath } from 'url';
import path     from 'path';
import fs       from 'fs';
import fetch    from 'node-fetch';
import dotenv   from 'dotenv';
import os       from 'os';
import moment   from 'moment';
import _        from 'lodash';
import cors     from 'cors';
import sql      from 'mssql';
import adminRoutes from './server/routes/admin.js';
import limbleWebhook from './server/routes/limbleWebhook.js';
import { start as startScheduler, reload as reloadScheduler } from './server/scheduler.js';
import { refreshHeaderKpis, refreshByAssetKpis, refreshWorkOrders } from './server/jobs/kpiJobs.js';
import { runFullRefresh } from './server/jobs/pipeline.js';
import { fetchAllPages, syncLimbleToSql, syncLimbleCompletedOnly } from './server/jobs/limbleSync.js';
import productionRoutes from './server/routes/production.js';
import helmet from 'helmet';
import { adminLimiter, adminSlowdown, adminAuthLimiter } from './server/lib/adminRateLimit.js';

const API_V2 = `${process.env.API_BASE_URL}/v2`;

const EXPECTED_RUN_DAYS = process.env.EXPECTED_RUN_DAYS || 'Mon-Fri';
const EXPECTED_HOURS_PER_DAY = Number(process.env.EXPECTED_HOURS_PER_DAY || 24);

function parseRunDays(spec) {
  if (spec === 'Mon-Fri') return new Set([1,2,3,4,5]);
  if (spec === 'Sun-Sat') return new Set([1,2,3,4,5,6,7]);
  const map = { Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6, Sun:7 };
  return new Set(spec.split(',').map(s => map[s.trim()]).filter(Boolean));
}

const RUN_DAYS = parseRunDays(EXPECTED_RUN_DAYS);

function expectedOperationalHours(startISO, endISO) {
  const start = moment(startISO);
  const end   = moment(endISO);
  let days = 0;
  const cursor = start.clone().startOf('day');
  const last   = end.clone().startOf('day');
  while (cursor.isSameOrBefore(last)) {
    const dow = cursor.isoWeekday();
    if (RUN_DAYS.has(dow)) days += 1;
    cursor.add(1, 'day');
  }
  return days * EXPECTED_HOURS_PER_DAY;
}

// MSSQL pool
const sqlConfig = {
  server: process.env.AZURE_SQL_SERVER,
  database: process.env.AZURE_SQL_DB,
  user: process.env.AZURE_SQL_USER,
  password: process.env.AZURE_SQL_PASS,
  options: { encrypt: true }
};
const poolPromise =
  process.env.NODE_ENV === 'test'
    ? Promise.resolve(null)
    : new sql.ConnectionPool(sqlConfig).connect();

function resolveRange(timeframe) {
  const now = moment();
  switch (timeframe) {
    case 'currentWeek':
      return { start: now.clone().startOf('isoWeek'), end: now.clone().endOf('isoWeek') };
    case 'lastWeek':
      return {
        start: now.clone().subtract(1, 'week').startOf('isoWeek'),
        end:   now.clone().subtract(1, 'week').endOf('isoWeek')
      };
    case 'currentMonth':
      return { start: now.clone().startOf('month'), end: now.clone().endOf('month') };
    case 'lastMonth':
      return {
        start: now.clone().subtract(1, 'month').startOf('month'),
        end:   now.clone().subtract(1, 'month').endOf('month')
      };
    case 'currentYear':
      return { start: now.clone().startOf('year'), end: now.clone().endOf('year') };
    case 'lastYear':
      return {
        start: now.clone().subtract(1, 'year').startOf('year'),
        end:   now.clone().subtract(1, 'year').endOf('year')
      };
    case 'trailing7Days':
      return {
        start: now.clone().subtract(7, 'days').startOf('day'),
        end:   now.clone().endOf('day')
      };
    case 'trailing30Days':
      return {
        start: now.clone().subtract(30, 'days').startOf('day'),
        end:   now.clone().endOf('day')
      };
    case 'trailing12Months':
      return {
        start: now.clone().subtract(12, 'months').startOf('day'),
        end:   now.clone().endOf('day')
      };
    default:
      return {
        start: now.clone().subtract(1, 'month').startOf('month'),
        end:   now.clone().subtract(1, 'month').endOf('month')
      };
  }
}

// ─── derive __dirname ─────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── KPI Theme Config ──────────────────────────────────────────────────────
const THEME_PATH = path.join(__dirname, 'config', 'kpi-theme.json');
const DEFAULT_THEME = {
  colors: {
    good:   { bg: '#10B981', fg: '#0B1B13' },
    warn:   { bg: '#FBBF24', fg: '#1B1403' },
    bad:    { bg: '#EF4444', fg: '#1F0D0D' },
    neutral:{ bg: '#374151', fg: '#FFFFFF' }
  },
  thresholds: {
    downtimePct: { goodMax: 2.0, warnMax: 5.0 },
    plannedPct:  { goodMin: 70.0, warnMin: 50.0 },
    unplannedPct:{ goodMax: 30.0, warnMax: 50.0 },
    mttrHours:   { goodMax: 1.5,  warnMax: 3.0 },
    mtbfHours:   { goodMin: 72.0, warnMin: 36.0 }
  }
};

let themeCache = null;

function readTheme() {
  try {
    if (themeCache) return themeCache;
    const obj = JSON.parse(fs.readFileSync(THEME_PATH, 'utf8'));
    themeCache = obj;
    return obj;
  } catch {
    writeTheme(DEFAULT_THEME);
    themeCache = DEFAULT_THEME;
    return DEFAULT_THEME;
  }
}

function writeTheme(obj) {
  fs.mkdirSync(path.dirname(THEME_PATH), { recursive: true });
  fs.writeFileSync(THEME_PATH, JSON.stringify(obj, null, 2), 'utf8');
  themeCache = obj;
}

// ─── load mappings and build assetIDs once ───────────────────────────────
const rawMappings = fs.readFileSync(
  path.join(__dirname, 'public', 'mappings.json'),
  'utf8'
);
const mappings = JSON.parse(rawMappings);
// Build a list and comma separated string of asset IDs used for production KPIs
const assetIdList = Array.isArray(mappings.productionAssets)
  ? mappings.productionAssets.map(a => a.id)
  : [];
const assetIDs = assetIdList.join(',');

async function loadOverallKpis() {
  const clientId     = process.env.CLIENT_ID;
  const clientSecret = process.env.CLIENT_SECRET;
  const headers = {
    'Authorization': 'Basic ' + Buffer
      .from(`${clientId}:${clientSecret}`)
      .toString('base64')
  };

  // Define last week (ISO) and trailing 30 days for MTTR/MTBF
  const weekStart = process.env.KPI_WEEK_START
    ? moment.unix(Number(process.env.KPI_WEEK_START))
    : moment().startOf('isoWeek').subtract(1, 'week');
  const weekEnd = process.env.KPI_WEEK_END
    ? moment.unix(Number(process.env.KPI_WEEK_END))
    : weekStart.clone().endOf('isoWeek');
  const monthStart = process.env.KPI_MONTH_START
    ? moment.unix(Number(process.env.KPI_MONTH_START))
    : moment().subtract(30, 'days').startOf('day');
  const monthEnd = process.env.KPI_MONTH_END
    ? moment.unix(Number(process.env.KPI_MONTH_END))
    : moment().endOf('day');

  let totals = {
    operationalHours: 0,
    downtimeHours:    0,
    plannedCount:     0,
    unplannedCount:   0,
    downtimeMinutes:  0,
    unplannedWO:      0,
    dates:            []
  };

  for (const asset of mappings.productionAssets || []) {
    const id = asset.id;

    const tasksUrl = `${API_V2}/tasks?assets=${id}&status=2`;
    console.log(`📅 Fetching tasks for asset ${id}`);
    console.log(`   ↳ Week range: ${weekStart.toISOString()} to ${weekEnd.toISOString()}`);
    console.log(`   ↳ 30d range: ${monthStart.toISOString()} to ${monthEnd.toISOString()}`);
    const tasksRes = await fetch(tasksUrl, { headers });
    if (!tasksRes.ok) {
      console.error('loadOverallKpis tasks error:', tasksRes.status);
      const body = await tasksRes.text();
      throw new Error(`Tasks ${tasksRes.status}: ${body}`);
    }
    const tasksJson = await tasksRes.json();
    const rawTasks = Array.isArray(tasksJson)
      ? tasksJson
      : Array.isArray(tasksJson.data)
        ? tasksJson.data
        : Array.isArray(tasksJson.data?.tasks)
          ? tasksJson.data.tasks
          : [];

    const weekTasks = rawTasks.filter(t =>
      t.dateCompleted >= weekStart.unix() &&
      t.dateCompleted <= weekEnd.unix()
    );
    const monthTasks = rawTasks.filter(t =>
      t.dateCompleted >= monthStart.unix() &&
      t.dateCompleted <= monthEnd.unix()
    );

    totals.plannedCount   += weekTasks.filter(t => t.type === 1 || t.type === 4).length;
    totals.unplannedCount += weekTasks.filter(t => t.type === 2 || t.type === 6).length;
    totals.unplannedWO    += monthTasks.filter(t => t.type === 2 || t.type === 6).length;
    totals.dates           = totals.dates.concat(
      monthTasks.filter(t => t.type === 2 || t.type === 6).map(t => t.dateCompleted)
    );

    // ─── BEGIN WEEKLY LABOR FETCH ────────────────────────────────────────────
    // Sum labor entries for the week (fetched & filtered in-code)
    console.log(
      `   ↳ Fetching labor week entries: ${weekStart.toISOString()} to ${weekEnd.toISOString()}`
    );
    const laborWeekRes = await fetch(
      `${API_V2}/tasks/labor?limit=10000&start=${weekStart.unix()}&end=${weekEnd.unix()}`,
      { headers }
    );
    let rawWeekEntries = [];
    if (laborWeekRes.ok) {
      try {
        const json = await laborWeekRes.json();
        if (Array.isArray(json.data?.entries)) {
          rawWeekEntries = json.data.entries;
        } else if (Array.isArray(json.entries)) {
          rawWeekEntries = json.entries;
        }
      } catch (err) {
        console.error(`Error parsing labor week JSON for ${id}:`, err);
      }
    } else {
      console.warn(`Asset ${id} labor week fetch returned ${laborWeekRes.status}, treating as zero.`);
    }
    // now filter to this asset:
    const entriesWeek = rawWeekEntries.filter(e => e.assetID === id);
    // ─── INSERT DEBUG LOGGING FOR WEEK ENTRIES HERE ─────────────────────────
    console.log(`DEBUG [${id}] week entries count = ${entriesWeek.length}`);
    entriesWeek.slice(0,5).forEach((e,i) =>
      console.log(`  entry[${i}]`, {
        dateCompleted: e.dateCompleted,
        downtime:      e.downtime,
        timeSpent:     e.timeSpent ?? e.duration
      })
    );
    // ─── END DEBUG LOGGING ─────────────────────────────────────────────────
    const downtimeSec = entriesWeek
      .filter(e => e.downtime)
      .reduce((sum, e) => sum + (e.timeSpent ?? e.duration ?? 0), 0);
    const totalSecWeek = entriesWeek
      .reduce((sum, e) => sum + (e.timeSpent ?? e.duration ?? 0), 0);
    totals.downtimeHours    += downtimeSec / 3600;
    totals.operationalHours += (totalSecWeek - downtimeSec) / 3600;
    // ─── END WEEKLY LABOR SECTION ───────────────────────────────────────────

    // ─── BEGIN 30-DAY LABOR FETCH ───────────────────────────────────────────
    // Sum downtime minutes for the trailing 30 days
    console.log(
      `   ↳ Fetching labor 30d entries: ${monthStart.toISOString()} to ${monthEnd.toISOString()}`
    );
    const laborMonthRes = await fetch(
      `${API_V2}/tasks/labor?limit=10000&start=${monthStart.unix()}&end=${monthEnd.unix()}`,
      { headers }
    );
    let rawMonthEntries = [];
    if (laborMonthRes.ok) {
      try {
        const json = await laborMonthRes.json();
        if (Array.isArray(json.data?.entries)) {
          rawMonthEntries = json.data.entries;
        } else if (Array.isArray(json.entries)) {
          rawMonthEntries = json.entries;
        }
      } catch (err) {
        console.error(`Error parsing labor 30d JSON for ${id}:`, err);
      }
    } else {
      console.warn(`Asset ${id} labor 30d fetch returned ${laborMonthRes.status}, treating as zero.`);
    }
    const entriesMonth = rawMonthEntries.filter(e => e.assetID === id);
    // ─── INSERT DEBUG LOGGING FOR 30-DAY ENTRIES HERE ───────────────────────
    console.log(`DEBUG [${id}] 30d entries count = ${entriesMonth.length}`);
    entriesMonth.slice(0,5).forEach((e,i) =>
      console.log(`  entry[${i}]`, {
        dateCompleted: e.dateCompleted,
        downtime:      e.downtime,
        duration:      e.duration
      })
    );
    // ─── END DEBUG LOGGING ─────────────────────────────────────────────────
    totals.downtimeMinutes += entriesMonth
      .filter(e => e.downtime && e.taskType === 'wo')
      .reduce((sum, e) => sum + (e.duration ?? 0), 0);
  }
  // ─── END 30-DAY LABOR SECTION ──────────────────────────────────────────
  
  // Final KPI calculations
  const downtimePct = totals.operationalHours
    ? Math.max(0, Math.min(100, (totals.downtimeHours / totals.operationalHours) * 100))
    : 0;
  const mttrHrs = totals.unplannedWO
    ? (totals.downtimeMinutes / 60) / totals.unplannedWO
    : 0;
  const sortedDates = totals.dates.sort((a,b) => a - b);
  const intervals   = sortedDates.slice(1)
    .map((d,i) => (sortedDates[i+1] - d) / 3600);
  const mtbfHrs     = intervals.length ? _.mean(intervals) : 0;

  return {
    downtimePct: +downtimePct.toFixed(1),
    downtimeHrs: +totals.downtimeHours.toFixed(1),
    mttrHrs: +mttrHrs.toFixed(1),
    mtbfHrs: +mtbfHrs.toFixed(1),
    plannedCount: totals.plannedCount,
    unplannedCount: totals.unplannedCount
  };
}

async function loadByAssetKpis({ start, end }) {
  const clientId = process.env.CLIENT_ID;
  const clientSecret = process.env.CLIENT_SECRET;
  const headers = {
    'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  };

  // interpret task.downtime into MINUTES based on env
  const minutesFromTask = (t) => {
    const v = Number(t.downtime || 0);
    return process.env.DOWNTIME_UNITS === 'hours' ? v * 60
         : process.env.DOWNTIME_UNITS === 'seconds' ? v / 60
         : v;
  };

  function isUnplannedType(t) {
    const type = (t.type || t.workOrderType || t.category || '').toString().toLowerCase();
    return type === '2' || type === '6' || type.includes('unplanned') || type.includes('work request');
  }

  function getDowntimeHours(t) {
    if (Number.isFinite(t.downtimeHours)) return Number(t.downtimeHours);
    if (Number.isFinite(t.downtimeMinutes)) return Number(t.downtimeMinutes) / 60;
    if (Number.isFinite(t.metrics?.downtimeHours)) return Number(t.metrics.downtimeHours);
    if (Number.isFinite(t.downtime)) return minutesFromTask(t) / 60;
    return 0;
  }

  function countFailureEvents(tasksForAsset) {
    let n = 0;
    for (const t of tasksForAsset || []) {
      if (isUnplannedType(t) && getDowntimeHours(t) > 0) n++;
    }
    return n;
  }

  const result = { assets: {}, totals: {
    downtimePct: 0,
    downtimeHrs: 0,
    mttrHrs: 0,
    mtbfHrs: 0,
    plannedCount: 0,
    unplannedCount: 0,
    downtimeHoursUnplanned: 0,
    operationalHours: 0,
    failureEventCount: 0
  }};

  // totals for the whole report window
  let totalOperationalHours = 0;
  let totalDowntimeHours = 0;
  let totalDowntimeHoursUnplanned = 0;
  let totalUptimeHours = 0;
  let totalFailureEvents = 0;
  let totalUnplannedWO = 0;

  for (const asset of mappings.productionAssets || []) {
    const id = asset.id;
    const name = asset.name;

    const byAssetUrl = `${API_V2}/tasks?assets=${id}&status=2`;
    console.log(
      `📅 Fetching per-asset tasks for ${asset.name} (${asset.id}) from ` +
      `${start.toISOString()} to ${end.toISOString()} ` +
      `(URL: ${byAssetUrl})`
    );

    const tasksRes = await fetch(byAssetUrl, { headers });
    if (!tasksRes.ok) {
      const body = typeof tasksRes.text === 'function'
        ? await tasksRes.text().catch(() => '')
        : '';
      console.error('loadByAssetKpis tasks error:', tasksRes.status);
      throw new Error(`loadByAssetKpis tasks error: ${tasksRes.status}: ${body}`);
    }

    const tasksJson = await tasksRes.json();
    const rawTasks = Array.isArray(tasksJson)
      ? tasksJson
      : Array.isArray(tasksJson.data)
        ? tasksJson.data
        : Array.isArray(tasksJson.data?.tasks)
          ? tasksJson.data.tasks
          : [];

    // filter by completed date in window
    const tasksInRange = rawTasks.filter(t =>
      typeof t.dateCompleted === 'number' &&
      t.dateCompleted >= start.unix() &&
      t.dateCompleted <= end.unix()
    );

    // classify
    const plannedCount   = tasksInRange.filter(t => t.type === 1 || t.type === 4).length;
    const unplannedTasks = tasksInRange.filter(t => t.type === 2 || t.type === 6);
    const unplannedCount = unplannedTasks.length;

    const downtimeMinutesAll = tasksInRange.reduce((sum, t) => sum + minutesFromTask(t), 0);
    const downtimeMinutesUnplanned = unplannedTasks.reduce((sum, t) => sum + minutesFromTask(t), 0);

    const opHours = expectedOperationalHours(start.toISOString(), end.toISOString());
    const downtimeHours = downtimeMinutesAll / 60;
    const downtimeHoursUnplanned = downtimeMinutesUnplanned / 60;
    const uptimeHours = Math.max(0, opHours - downtimeHours);
    const failureEventCount = countFailureEvents(tasksInRange);

    const mttr = failureEventCount ? downtimeHoursUnplanned / failureEventCount : 0;
    const mtbf = failureEventCount ? uptimeHours / failureEventCount : 0;
    const downtimePct = opHours > 0
      ? Math.max(0, Math.min(100, (downtimeHours / opHours) * 100))
      : 0;

    result.assets[id] = {
      name,
      downtimePct: +downtimePct.toFixed(1),
      downtimeHrs: +downtimeHours.toFixed(1),
      mttrHrs: +mttr.toFixed(1),
      mtbfHrs: +mtbf.toFixed(1),
      plannedCount,
      unplannedCount,
      downtimeHoursUnplanned: +downtimeHoursUnplanned.toFixed(1),
      operationalHours: +opHours.toFixed(1),
      failureEventCount
    };

    totalOperationalHours       += opHours;
    totalUptimeHours            += uptimeHours;
    totalDowntimeHours          += downtimeHours;
    totalDowntimeHoursUnplanned += downtimeHoursUnplanned;
    totalFailureEvents          += failureEventCount;
    totalUnplannedWO            += unplannedCount;
    result.totals.plannedCount  += plannedCount;
    result.totals.unplannedCount += unplannedCount;
  }

  // totals
  result.totals.downtimePct = totalOperationalHours
    ? +((totalDowntimeHours / totalOperationalHours) * 100).toFixed(1)
    : 0;
  result.totals.downtimeHrs = +totalDowntimeHours.toFixed(1);
  result.totals.downtimeHoursUnplanned = +totalDowntimeHoursUnplanned.toFixed(1);
  result.totals.operationalHours = +totalOperationalHours.toFixed(1);
  result.totals.failureEventCount = totalFailureEvents;
  result.totals.mttrHrs = totalFailureEvents
    ? +((totalDowntimeHoursUnplanned) / totalFailureEvents).toFixed(1)
    : 0;
  result.totals.mtbfHrs = totalFailureEvents
    ? +((totalUptimeHours) / totalFailureEvents).toFixed(1)
    : 0;

  return result;
}

async function loadAssetStatus() {
  const basicAuth = Buffer
    .from(`${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`)
    .toString('base64');
  const headers = { 'Authorization': `Basic ${basicAuth}` };
  const url = `${API_V2}/assets/fields/?assets=${encodeURIComponent(assetIDs)}`;
  const resp = await fetch(url, { headers });
  const data = await resp.json();
  const fields = Array.isArray(data) ? data : data.data || [];
  return fields
    .filter(f => f.fieldID === 95)
    .map(f => ({ assetID: f.assetID, status: f.value }));
}

async function limble_sync_and_refresh_all() {
  const p = await poolPromise;
  await syncLimbleToSql(p);             // pulls Tasks/Assets/AssetFields into SQL (your updated limbleSync)
  await refreshWorkOrders(p, 'prodstatus');
  await refreshWorkOrders(p, 'index');
  await refreshWorkOrders(p, 'pm');
}

async function full_refresh_daily() {
  const p = await poolPromise;
  return runFullRefresh(p);
}

// ─── network info ─────────────────────────────────────────────────────────
const nets = os.networkInterfaces();
const ipv4 = Object.values(nets)
  .flat()
  .find(i => i.family === 'IPv4' && !i.internal)?.address;

// ─── express setup ────────────────────────────────────────────────────────
const app = express();

// 1) core middleware first
app.use(helmet());
app.use(cors());
app.use(express.json());

// 2) guards/rate limits that should run BEFORE routers
//    (protect the whole /api/admin surface)
app.use('/api/admin', adminAuthLimiter, adminSlowdown, adminLimiter);

// 3) API routers (mounted under /api)
app.use('/api', productionRoutes(poolPromise));   // /api/production/...
app.use('/api', adminRoutes(poolPromise));        // /api/admin/...
app.use('/api', limbleWebhook(poolPromise));      // /api/limble-...

// 4) static last
app.use(express.static(path.join(__dirname, 'public')));

app.fetchAndCache = async () => null;
const PORT = process.env.PORT || 3000;

// Serve the HTML file for the root path
// 3) static and root
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/pm', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'pm.html'));
});

app.get('/prodstatus', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'prodstatus.html'));
});

app.get('/kpi-by-asset.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'kpi-by-asset.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/config', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'config.json'));
});

app.post('/api/config', (req, res) => {
    if (req.body.password !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    fs.writeFile(path.join(__dirname, 'public', 'config.json'), JSON.stringify(req.body.config, null, 2), err => {
        if (err) {
            console.error('Config save error:', err);
            return res.status(500).json({ error: 'Failed to save config' });
        }
        res.json({ status: 'ok' });
    });
});

app.post('/api/mappings', (req, res) => {
    if (req.body.password !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    fs.writeFile(path.join(__dirname, 'public', 'mappings.json'), JSON.stringify(req.body.mappings, null, 2), err => {
        if (err) {
            console.error('Mappings save error:', err);
            return res.status(500).json({ error: 'Failed to save mappings' });
        }
        res.json({ status: 'ok' });
    });
});

// ─── KPI Theme Settings Endpoints ──────────────────────────────────────────
app.get('/api/settings/kpi-theme', (req, res) => {
  res.json(readTheme());
});

app.put('/api/settings/kpi-theme', (req, res) => {
  const body = req.body || {};
  const isHex = s => typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);
  const isNum = v => typeof v === 'number' && isFinite(v);

  const c = body.colors || {};
  const t = body.thresholds || {};
  const palettes = ['good', 'warn', 'bad', 'neutral'];
  for (const p of palettes) {
    if (!isHex(c?.[p]?.bg) || !isHex(c?.[p]?.fg)) {
      return res.status(400).json({ error: `Invalid hex for ${p}` });
    }
  }

  const metricDefs = {
    downtimePct: ['goodMax', 'warnMax'],
    plannedPct: ['goodMin', 'warnMin'],
    unplannedPct: ['goodMax', 'warnMax'],
    mttrHours: ['goodMax', 'warnMax'],
    mtbfHours: ['goodMin', 'warnMin']
  };
  for (const [k, keys] of Object.entries(metricDefs)) {
    for (const kk of keys) {
      if (!isNum(t?.[k]?.[kk])) {
        return res.status(400).json({ error: `Invalid threshold ${k}.${kk}` });
      }
    }
  }

  writeTheme(body);
  res.json(body);
});

app.get('/api/assets', async (req, res) => {
  try {
    const basicAuth = Buffer
      .from(`${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`)
      .toString('base64');
    const headers = { 'Authorization': `Basic ${basicAuth}` };

    const url = `${API_V2}/assets/?assets=${assetIDs}`;
    const resp = await fetch(url, { headers });
    const assetsData = await resp.json();

    res.json(assetsData);
  } catch (err) {
    console.error('Error fetching assets:', err);
    res.status(500).json({ error: 'An error occurred while fetching assets.' });
  }
});

app.get('/api/assets/fields', async (req, res) => {
  try {
    const basicAuth = Buffer
      .from(`${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`)
      .toString('base64');
    const headers = { 'Authorization': `Basic ${basicAuth}` };

    let page = 1, allFields = [];
    const limit = 500;

    while (true) {
      const url = [
        `${API_V2}/assets/fields/`,
        `?assets=${assetIDs}`,
        `&limit=${limit}`,
        `&page=${page}`
      ].join('');
      const resp  = await fetch(url, { headers });
      const batch = await resp.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      allFields = allFields.concat(batch);
      page++;
    }

    res.json(allFields);
  } catch (err) {
    console.error('Error fetching asset fields:', err);
    res.status(500).json({ error: 'Failed to fetch asset fields.' });
  }
});

app.get('/api/task', async (req, res) => {
    try {
        // Replace 'your_client_id' and 'your_client_secret' with your actual credentials
        const clientId = process.env.CLIENT_ID;
        const clientSecret = process.env.CLIENT_SECRET;
        const credentials = { id: clientId, secret: clientSecret };

        // Construct the authorization header
        const base64Credentials = Buffer.from(`${credentials.id}:${credentials.secret}`).toString('base64');
        const headers = { 'Authorization': `Basic ${base64Credentials}` };

        // Make API request with user-input value and authorization header
        const response = await fetch(`${API_V2}/tasks/?locations=13425&orderBy=-createdDate&limit=20&type=2,6&status=0`, {
            method: 'GET',
            headers: headers
        });

        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'An error occurred while fetching data.' });
    }
});

app.get('/api/taskpm', async (req, res) => {
    try {
        // Replace 'your_client_id' and 'your_client_secret' with your actual credentials
        const clientId = process.env.CLIENT_ID;
        const clientSecret = process.env.CLIENT_SECRET;
        const credentials = { id: clientId, secret: clientSecret };

        // Construct the authorization header
        const base64Credentials = Buffer.from(`${credentials.id}:${credentials.secret}`).toString('base64');
        const headers = { 'Authorization': `Basic ${base64Credentials}` };

        // Make API request using the new endpoint
        const response = await fetch(`${API_V2}/tasks/?locations=13425&type=1&orderBy=-createdDate&limit=20&status=0`, {
            method: 'GET',
            headers: headers
        });

        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'An error occurred while fetching new tasks.' });
    }
});

app.get('/api/hours', async (req, res) => {
    try {
        // Replace 'your_client_id' and 'your_client_secret' with your actual credentials
        const clientId = process.env.CLIENT_ID;
        const clientSecret = process.env.CLIENT_SECRET;
        const credentials = { id: clientId, secret: clientSecret };

        // Construct the authorization header
        const base64Credentials = Buffer.from(`${credentials.id}:${credentials.secret}`).toString('base64');
        const headers = { 'Authorization': `Basic ${base64Credentials}` };

        // Make API request using the new endpoint
        const response = await fetch(`${API_V2}/tasks/labor?start=1693594754`, {
            method: 'GET',
            headers: headers
        });

        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'An error occurred while fetching new tasks.' });
    }
});

// Ensure API responses are not cached by browsers/CDNs (prevents 304 + JSON mismatch)
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, max-age=0, must-revalidate');
  next();
});

// ---- Admin schedule API ----
app.get('/api/admin/schedules', async (req, res) => {
  const pool = await poolPromise;
  const { recordset } = await pool.request().query(`SELECT Name,Cron,Enabled,LastRun FROM dbo.UpdateSchedules ORDER BY Name`);
  res.json(recordset);
});

app.put('/api/admin/schedules', async (req, res) => {
  const body = req.body;
  if (!Array.isArray(body)) return res.status(400).json({ error: 'array required' });
  const pool = await poolPromise;
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    for (const r of body) {
      await new sql.Request(tx)
        .input('Name', sql.NVarChar, r.Name)
        .input('Cron', sql.NVarChar, r.Cron)
        .input('Enabled', sql.Bit, r.Enabled ? 1 : 0)
        .query(`UPDATE dbo.UpdateSchedules SET Cron=@Cron, Enabled=@Enabled WHERE Name=@Name`);
    }
    await tx.commit();
    await reloadScheduler(pool, jobs);
    res.json({ ok: true });
  } catch (e) {
    await tx.rollback();
    res.status(500).json({ error: String(e) });
  }
});

// ---- Admin: run a single job now (force) ----
app.post('/api/admin/run', async (req, res) => {
  try {
    const { job } = req.body || {};
    if (!job) return res.status(400).json({ error: 'missing job' });

    let result;
    switch (job) {
      case 'header_kpis':         result = await jobs.header_kpis(); break;
      case 'by_asset_kpis':       result = await jobs.by_asset_kpis(); break;
      case 'work_orders_index':   result = await jobs.work_orders_index(); break;
      case 'work_orders_pm':      result = await jobs.work_orders_pm(); break;
      case 'work_orders_status':  result = await jobs.work_orders_status(); break;
      case 'etl_assets_fields':   result = await jobs.etl_assets_fields(); break;
      case 'limble_sync':         result = await jobs.limble_sync(); break;
      case 'limble_sync_refresh': result = await jobs.limble_sync_refresh(); break;
      case 'limble_sync_completed': result = await jobs.limble_sync_completed(); break;
      case 'full_refresh_daily':  result = await jobs.full_refresh_daily(); break;
      default: return res.status(400).json({ error: 'unknown job' });
    }

    await (await poolPromise).request().input('n', sql.NVarChar, job)
      .query(`UPDATE dbo.UpdateSchedules SET LastRun = SYSUTCDATETIME() WHERE Name = @n`);

    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---- Admin: run common jobs now (header, by-asset, WOs) ----
app.post('/api/admin/refresh-all', async (req, res) => {
  try {
    const pool = await poolPromise;
    await refreshHeaderKpis(pool);
    await refreshByAssetKpis(pool);
    await refreshWorkOrders(pool, 'index');
    await refreshWorkOrders(pool, 'pm');
    await refreshWorkOrders(pool, 'prodstatus');
    await pool.request().query(`
      UPDATE dbo.UpdateSchedules SET LastRun = SYSUTCDATETIME()
      WHERE Name IN ('header_kpis','by_asset_kpis','work_orders_index','work_orders_pm','work_orders_status')
    `);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---- Route aliases for back-compat ----
// Old front-ends called /api/status; alias to cached prodstatus feed
app.get('/api/status', (req, res) => {
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  res.redirect(307, `/api/workorders/prodstatus${qs}`);
});

app.get('/api/kpis-by-asset', (req, res) => {
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  res.redirect(307, `/api/kpis/by-asset${qs}`);
});
app.get('/api/kpi/by-asset', (req, res) => {
  const qs = req.originalUrl.includes('?')
    ? req.originalUrl.slice(req.originalUrl.indexOf('?'))
    : '';
  res.redirect(307, `/api/kpis/by-asset${qs}`);
});
app.get('/api/kpis/by-asset', async (req, res) => {
  try {
    const tfRaw = String(req.query.tf ?? req.query.timeframe ?? 'lastMonth').trim();
    const alias = { last30d: 'last30', trailing30Days: 'last30' };
    const tf = alias[tfRaw] || tfRaw;

    const pool = await poolPromise;

    // find latest snapshot for this timeframe
    const top = await pool.request()
      .input('tf', sql.NVarChar, tf)
      .query(`SELECT TOP (1) SnapshotAt FROM dbo.KpiByAssetCache WHERE Timeframe=@tf ORDER BY SnapshotAt DESC;`);

    const latest = top.recordset[0]?.SnapshotAt;
    if (!latest) return res.json({ rows: [], assets: {}, lastRefreshUtc: null, range: null });

    const rs = await pool.request()
      .input('tf',   sql.NVarChar, tf)
      .input('snap', sql.DateTime2, latest)
      .query(`
        SELECT
          AssetID, Name, RangeStart, RangeEnd,
          UptimePct, DowntimeHrs, MttrHrs, MtbfHrs,
          PlannedPct, UnplannedPct,
          UnplannedCount, FailureEvents, ScheduledHrs,
          PlannedCount, DowntimeHoursUnplanned, OpenCount
        FROM dbo.KpiByAssetCache
        WHERE Timeframe=@tf AND SnapshotAt=@snap
        ORDER BY Name, AssetID;
      `);

    const rows = rs.recordset || [];
    const assets = {};
    for (const r of rows) {
      assets[String(r.AssetID)] = {
        assetID: r.AssetID,
        name:    r.Name || `Asset ${r.AssetID}`,
        downtimePct: (typeof r.UptimePct === 'number') ? (100 - Number(r.UptimePct)) : null,
        DowntimeHrs: r.DowntimeHrs,
        MttrHrs:     r.MttrHrs,
        MtbfHrs:     r.MtbfHrs,
        PlannedPct:  r.PlannedPct,
        UnplannedPct:r.UnplannedPct
      };
    }
    const range = rows.length ? { start: rows[0].RangeStart, end: rows[0].RangeEnd } : null;
    console.log(`[kpis/by-asset] tf=${tf} rows=${rows.length} snap=${latest?.toISOString?.() || latest}`);
    res.json({ rows, assets, range, lastRefreshUtc: latest });
  } catch (e) {
    console.error('[kpis/by-asset]', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/workorders/:page', async (req, res) => {
  const page = req.params.page; // 'index' | 'pm' | 'prodstatus'
  const pool = await poolPromise;
  const { recordset } = await pool.request()
    .input('page', sql.NVarChar, page)
    .query(`
      SELECT TOP (1) SnapshotAt, Data FROM dbo.WorkOrdersCache
      WHERE Page=@page ORDER BY SnapshotAt DESC
    `);
  if (!recordset.length) return res.json({ rows: [], lastRefreshUtc: null });
  const latest = recordset[0].SnapshotAt;
  const data = JSON.parse(recordset[0].Data);
  const payload = { rows: data, lastRefreshUtc: latest };
  if (page === 'prodstatus') payload.tiles = data; // back-compat
  res.json(payload);
});

const jobs = {
  async header_kpis()        { const p = await poolPromise; return refreshHeaderKpis(p); },
  async by_asset_kpis()      { const p = await poolPromise; return refreshByAssetKpis(p); },
  async work_orders_index()  { const p = await poolPromise; return refreshWorkOrders(p, 'index'); },
  async work_orders_pm()     { const p = await poolPromise; return refreshWorkOrders(p, 'pm'); },
  async work_orders_status() { const p = await poolPromise; return refreshWorkOrders(p, 'prodstatus'); },

  // ETL helpers
  etl_assets_fields: async () => {
    const p = await poolPromise;
    const basic = 'Basic ' + Buffer.from(`${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`).toString('base64');
    const json = await fetchAllPages(`/assets/fields/?assets=${encodeURIComponent(assetIDs)}`, 500, { Authorization: basic, Accept: 'application/json' });
    await p.request().input('payload', sql.NVarChar(sql.MAX), json).execute('dbo.Upsert_LimbleKPIAssetFields');
    return { ok: true };
  },

  // Limble syncs
  async limble_sync()             { const p = await poolPromise; return syncLimbleToSql(p); },
  async limble_sync_refresh()     { const p = await poolPromise;
                                    await syncLimbleToSql(p);
                                    await refreshWorkOrders(p,'prodstatus');
                                    await refreshWorkOrders(p,'index');
                                    await refreshWorkOrders(p,'pm');
                                    return { ok:true }; },
  async limble_sync_completed()   { const p = await poolPromise; return syncLimbleCompletedOnly(p); },

  // Any long “full refresh” you keep
  async full_refresh_daily()      { const p = await poolPromise; return runFullRefresh(p); },
};

const shouldListen =
  process.env.NODE_ENV !== 'test' || process.env.FORCE_LISTEN === 'true';

app.get('/api/kpis/header', async (req, res) => {
  try {
    const pool = await poolPromise;
    const q = `
      WITH x AS (
        SELECT TOP (1) * FROM dbo.KpiHeaderCache WHERE Timeframe='lastWeek' ORDER BY SnapshotAt DESC
      ), y AS (
        SELECT TOP (1) * FROM dbo.KpiHeaderCache WHERE Timeframe='last30'  ORDER BY SnapshotAt DESC
      )
      SELECT 
        (SELECT SnapshotAt,RangeStart,RangeEnd,UptimePct,DowntimeHrs,PlannedCount,UnplannedCount 
         FROM x FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS weekly,
        (SELECT SnapshotAt,RangeStart,RangeEnd,MttrHrs,MtbfHrs 
         FROM y FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS monthly
    `;
    const { recordset } = await pool.request().query(q);
    const row = recordset[0] || {};
    const weekly = row.weekly ? JSON.parse(row.weekly) : null;
    const monthly = row.monthly ? JSON.parse(row.monthly) : null;
    const lastRefreshUtc = weekly?.SnapshotAt || monthly?.SnapshotAt || null;
    res.json({ weekly, monthly, lastRefreshUtc });
  } catch (e) {
    console.error('[kpis/header]', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

if (shouldListen) {
  app.listen(PORT, () => {
    console.log(`Local:  http://localhost:${PORT}/`);
    console.log(`On LAN: http://${ipv4}:${PORT}/`);
    console.log(`NOICE! Server running at ${PORT}.`);
  });
} else {
  console.warn(
    'Skipping app.listen because NODE_ENV is "test". Set FORCE_LISTEN=true to override.'
  );
}

poolPromise.then(async (pool) => { 
  await startScheduler(pool, jobs);
  console.log('[scheduler] started and tasks registered');
});

export default app;
