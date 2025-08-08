import express  from 'express';
import { fileURLToPath } from 'url';
import path     from 'path';
import fs       from 'fs';
import fetch    from 'node-fetch';
import dotenv   from 'dotenv';
import os       from 'os';
import moment   from 'moment';
import _        from 'lodash';
import NodeCache from 'node-cache';
import cors     from 'cors';

dotenv.config();

const API_V2 = `${process.env.API_BASE_URL}/v2`;

// Default to a 5 minute cache refresh if env var not set
const cacheTtlSeconds = Number(process.env.CACHE_TTL_MINUTES ?? 5) * 60;
const checkPeriod = Number(process.env.CACHE_CHECK_PERIOD_SECONDS ?? 1800);
const cache = new NodeCache({ stdTTL: cacheTtlSeconds, checkperiod: checkPeriod });

async function fetchAndCache(key, loaderFn) {
  let data = cache.get(key);
  if (data === undefined) {
    data = await loaderFn();
    cache.set(key, data);
  }
  return data;
}

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
  const uptimePct = totals.operationalHours
    ? ((totals.operationalHours - totals.downtimeHours) / totals.operationalHours) * 100
    : 0;
  const mttrHrs = totals.unplannedWO
    ? (totals.downtimeMinutes / 60) / totals.unplannedWO
    : 0;
  const sortedDates = totals.dates.sort((a,b) => a - b);
  const intervals   = sortedDates.slice(1)
    .map((d,i) => (sortedDates[i+1] - d) / 3600);
  const mtbfHrs     = intervals.length ? _.mean(intervals) : 0;

  return {
    uptimePct: +uptimePct.toFixed(1),
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

  const result = { assets: {}, totals: {
    uptimePct: 0,
    downtimeHrs: 0,
    mttrHrs: 0,
    mtbfHrs: 0,
    plannedCount: 0,
    unplannedCount: 0
  }};

  // totals for the whole report window
  let totalPeriodHours = 0;
  let totalDowntimeHours = 0;
  let totalDowntimeMinUnplanned = 0;
  let totalUnplannedWO = 0;
  let allDates = [];

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

    // downtime mins (all vs unplanned)
    const downtimeMinutesAll = tasksInRange.reduce((sum, t) => sum + minutesFromTask(t), 0);
    const downtimeMinutesUnplanned = unplannedTasks.reduce((sum, t) => sum + minutesFromTask(t), 0);

    // KPIs
    const mttr = unplannedCount ? (downtimeMinutesUnplanned / 60) / unplannedCount : 0;
    const dates = unplannedTasks.map(t => t.dateCompleted).sort((a,b) => a - b);
    const intervals = dates.slice(1).map((d,i) => (dates[i+1] - dates[i]) / 3600);
    const mtbf = intervals.length ? _.mean(intervals) : 0;

    // uptime: denominator is report window length
    const periodHours = end.diff(start, 'seconds') / 3600;
    const downtimeHours = downtimeMinutesAll / 60;
    const uptime = periodHours > 0
      ? Math.max(0, Math.min(100, ((periodHours - downtimeHours) / periodHours) * 100))
      : 0;

    // save per-asset
    result.assets[id] = {
      name,
      uptimePct: +uptime.toFixed(1),
      downtimeHrs: +downtimeHours.toFixed(1),
      mttrHrs: +mttr.toFixed(1),
      mtbfHrs: +mtbf.toFixed(1),
      plannedCount,
      unplannedCount
    };

    // roll up
    totalPeriodHours          += periodHours;
    totalDowntimeHours        += downtimeHours;
    totalDowntimeMinUnplanned += downtimeMinutesUnplanned;
    totalUnplannedWO          += unplannedCount;
    result.totals.plannedCount += plannedCount;
    result.totals.unplannedCount += unplannedCount;
    allDates = allDates.concat(dates);
  }

  // totals
  result.totals.uptimePct   = totalPeriodHours
    ? +(((totalPeriodHours - totalDowntimeHours) / totalPeriodHours) * 100).toFixed(1)
    : 0;
  result.totals.downtimeHrs = +totalDowntimeHours.toFixed(1);
  result.totals.mttrHrs     = totalUnplannedWO
    ? +((totalDowntimeMinUnplanned / 60) / totalUnplannedWO).toFixed(1)
    : 0;

  const sorted = allDates.sort((a,b) => a - b);
  const intervalsTot = sorted.slice(1).map((d,i) => (sorted[i+1] - sorted[i]) / 3600);
  result.totals.mtbfHrs = intervalsTot.length ? +_.mean(intervalsTot).toFixed(1) : 0;

  return result;
}

async function loadAssetStatus() {
  const basicAuth = Buffer
    .from(`${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`)
    .toString('base64');
  const headers = { 'Authorization': `Basic ${basicAuth}` };

  const url = `${API_V2}/assets/fields?assets=${assetIDs}`;
  const resp = await fetch(url, { headers });
  const data = await resp.json();
  const fields = Array.isArray(data) ? data : data.data || [];
  return fields
    .filter(f => f.fieldID === 95)
    .map(f => ({ assetID: f.assetID, status: f.value }));
}

// ─── network info ─────────────────────────────────────────────────────────
const nets = os.networkInterfaces();
const ipv4 = Object.values(nets)
  .flat()
  .find(i => i.family === 'IPv4' && !i.internal)?.address;

// ─── express setup ────────────────────────────────────────────────────────
const app = express();
app.fetchAndCache = fetchAndCache;
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));

// Serve the HTML file for the root path
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

app.get('/api/kpis', async (req, res) => {
  try {
    // Pull from cache (or load & cache on miss)
    const overall = await app.fetchAndCache('kpis_overall', loadOverallKpis);
    const byAsset = await app.fetchAndCache(
      'kpis_byAsset_lastMonth',
      () => loadByAssetKpis(resolveRange('lastMonth'))
    );

    // Return both overall and per‐asset KPIs
    res.json({ overall, byAsset });
  } catch (err) {
    console.error('KPI error:', err);
    res.status(500).json({ error: 'Failed to fetch KPIs' });
  }
});

// New endpoint: return only aggregate KPIs for header cards
app.get('/api/kpis/header', async (req, res) => {
  try {
    const overall = await app.fetchAndCache('kpis_overall', loadOverallKpis);
    res.json(overall);
  } catch (err) {
    console.error('KPI header error:', err);
    res.status(500).json({ error: 'Failed to fetch KPI header' });
  }
});

app.get('/api/status', async (req, res) => {
  try {
    const status = await app.fetchAndCache('status', loadAssetStatus);
    const nextRefresh = cache.getTtl('status') ?? Date.now() + cacheTtlSeconds * 1000;
    res.json({ status, nextRefresh });
  } catch (err) {
    console.error('Status error:', err);
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

app.post(process.env.STATUS_REFRESH_ENDPOINT || '/api/cache/refresh', async (req, res) => {
  const byAssetKeys = cache.keys().filter(k => k.startsWith('kpis_byAsset_'));
  cache.del(['kpis_overall', 'status', ...byAssetKeys]);
  await Promise.all([
    app.fetchAndCache('kpis_overall', loadOverallKpis),
    app.fetchAndCache('kpis_byAsset_lastMonth', () => loadByAssetKpis(resolveRange('lastMonth'))),
    app.fetchAndCache('status', loadAssetStatus),
  ]);
  res.send({ ok: true });
});

async function handleKpisByAsset(req, res) {
  try {
    const timeframe = String(req.query.timeframe || 'lastMonth');
    const range = resolveRange(timeframe);
    const cacheKey = `kpis_byAsset_${timeframe}`;

    const data = await app.fetchAndCache(cacheKey, async () => {
      const payload = await loadByAssetKpis(range);
      // attach the actual window the server used
      return {
        ...payload,
        range: {
          label: timeframe,
          startUnix: range.start.unix(),
          endUnix: range.end.unix(),
          startISO: range.start.toISOString(),
          endISO: range.end.toISOString(),
        }
      };
    });

    res.json(data);
  } catch (err) {
    console.error('KPIs by asset error:', err);
    res.status(500).json({ error: 'Failed to fetch KPIs by asset' });
  }
}

app.get('/api/kpis-by-asset', handleKpisByAsset);
app.get('/api/kpis/by-asset', handleKpisByAsset);

const shouldListen =
  process.env.NODE_ENV !== 'test' || process.env.FORCE_LISTEN === 'true';

  if (shouldListen) {
    app.listen(PORT, () => {
      console.log(`Local:  http://localhost:${PORT}/`);
      console.log(`On LAN: http://${ipv4}:${PORT}/`);
      console.log(`NOICE! Server running at ${PORT}.`);
    });
    const refreshMs = cacheTtlSeconds * 1000;
    setInterval(async () => {
      try {
        await Promise.all([
          app
            .fetchAndCache('kpis_overall', loadOverallKpis)
            .catch((err) => {
              console.error('Failed to refresh kpis_overall cache:', err);
              throw err;
            }),
          app
            .fetchAndCache('kpis_byAsset_lastMonth', () => loadByAssetKpis(resolveRange('lastMonth')))
            .catch((err) => {
              console.error('Failed to refresh kpis_byAsset cache:', err);
              throw err;
            }),
          app
            .fetchAndCache('status', loadAssetStatus)
            .catch((err) => {
              console.error('Failed to refresh status cache:', err);
              throw err;
            }),
        ]);
        console.log('✅ Cache refreshed at', new Date().toISOString());
      } catch (err) {
        console.error('❌ Cache refresh failed:', err);
      }
    }, refreshMs);
  } else {
    console.warn(
      'Skipping app.listen because NODE_ENV is "test". Set FORCE_LISTEN=true to override.'
    );
  }
export { fetchAndCache, loadOverallKpis, loadByAssetKpis };
export default app;
