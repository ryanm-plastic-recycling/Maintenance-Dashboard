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

dotenv.config();

const API_V2 = `${process.env.API_BASE_URL}/v2`;

const cacheTtlSeconds = Number(process.env.CACHE_TTL_MINUTES ?? 60) * 60;
const checkPeriod = Number(process.env.CACHE_CHECK_PERIOD_SECONDS ?? 1800);
const cache = new NodeCache({ stdTTL: cacheTtlSeconds, checkperiod: checkPeriod });

async function fetchAndCache(key, loaderFn) {
  if (!cache.has(key)) {
    const data = await loaderFn();
    cache.set(key, data);
  }
  return cache.get(key);
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
  const clientId = process.env.CLIENT_ID;
  const clientSecret = process.env.CLIENT_SECRET;
  const headers = {
    'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  };

  const weekStart = moment().startOf('isoWeek').subtract(1, 'week');
  const weekEnd   = moment(weekStart).endOf('isoWeek');
  const monthStart = moment().subtract(1, 'month').startOf('month');
  const monthEnd   = moment().subtract(1, 'month').endOf('month');

  let totals = {
    operationalHours: 0,
    downtimeHours: 0,
    plannedCount: 0,
    unplannedCount: 0,
    downtimeMinutes: 0,
    unplannedWO: 0,
    dates: []
  };

  for (const asset of mappings.productionAssets || []) {
    const id = asset.id;

    const weekTasksRes = await fetch(
      `${API_V2}/tasks?assets=${id}&status=2&dateCompletedGte=${weekStart.unix()}&dateCompletedLte=${weekEnd.unix()}`,
      { headers }
    );
    const weekTasksJson = await weekTasksRes.json();
    const weekTasks = Array.isArray(weekTasksJson)
      ? weekTasksJson
      : Array.isArray(weekTasksJson.data)
        ? weekTasksJson.data
        : Array.isArray(weekTasksJson.data?.tasks)
          ? weekTasksJson.data.tasks
          : [];
    totals.plannedCount   += weekTasks.filter(t => t.type === 4).length;
    totals.unplannedCount += weekTasks.filter(t => t.type === 2).length;

    const laborWeekRes = await fetch(
      `${API_V2}/tasks/labor?assets=${id}&start=${weekStart.unix()}`,
      { headers }
    );
    const laborWeekJson = await laborWeekRes.json();
    const laborWeek = laborWeekJson.data || laborWeekJson;
    totals.operationalHours += laborWeek.operationalHours || 0;
    totals.downtimeHours    += laborWeek.downtimeHours || 0;

    const task30Res = await fetch(
      `${API_V2}/tasks?assets=${id}&status=2&dateCompletedGte=${monthStart.unix()}&dateCompletedLte=${monthEnd.unix()}`,
      { headers }
    );
    const task30Json = await task30Res.json();
    const tasks30 = Array.isArray(task30Json)
      ? task30Json
      : Array.isArray(task30Json.data)
        ? task30Json.data
        : Array.isArray(task30Json.data?.tasks)
          ? task30Json.data.tasks
          : [];
    const unplanned30 = tasks30.filter(t => t.type === 2);
    totals.unplannedWO += unplanned30.length;
    totals.dates = totals.dates.concat(unplanned30.map(t => t.dateCompleted));

    const labor30Res = await fetch(
      `${API_V2}/tasks/labor?assets=${id}&start=${monthStart.unix()}`,
      { headers }
    );
    const labor30Json = await labor30Res.json();
    const labor30 = labor30Json.data || labor30Json;
    const entries30 = Array.isArray(labor30.entries) ? labor30.entries : [];
    totals.downtimeMinutes += entries30
      .filter(e => e.taskType === 'wo' && e.downtime)
      .reduce((sum, e) => sum + e.duration, 0);
  }

  const uptimePct = totals.operationalHours
    ? ((totals.operationalHours - totals.downtimeHours) / totals.operationalHours) * 100
    : 0;
  const mttrHrs = totals.unplannedWO
    ? (totals.downtimeMinutes / 60) / totals.unplannedWO
    : 0;
  const sorted = totals.dates.sort((a, b) => a - b);
  const intervals = sorted.slice(1).map((d, i) => (sorted[i + 1] - sorted[i]) / 3600);
  const mtbfHrs = intervals.length ? _.mean(intervals) : 0;

  return {
    uptimePct: +uptimePct.toFixed(1),
    downtimeHrs: +totals.downtimeHours.toFixed(1),
    mttrHrs: +mttrHrs.toFixed(1),
    mtbfHrs: +mtbfHrs.toFixed(1),
    plannedCount: totals.plannedCount,
    unplannedCount: totals.unplannedCount
  };
}

async function loadByAssetKpis() {
  const clientId = process.env.CLIENT_ID;
  const clientSecret = process.env.CLIENT_SECRET;
  const headers = {
    'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  };

  const start = moment().subtract(1, 'month').startOf('month');
  const end   = moment().subtract(1, 'month').endOf('month');

  const result = { assets: {}, totals: {
    uptimePct: 0,
    downtimeHrs: 0,
    mttrHrs: 0,
    mtbfHrs: 0,
    plannedCount: 0,
    unplannedCount: 0
  }};

  let totalOperational = 0;
  let totalDowntime = 0;
  let totalDowntimeMin = 0;
  let totalUnplannedWO = 0;
  let allDates = [];

  for (const asset of mappings.productionAssets || []) {
    const id = asset.id;
    const name = asset.name;

    const tasksRes = await fetch(
      `${API_V2}/tasks?assets=${id}&status=2&dateCompletedGte=${start.unix()}&dateCompletedLte=${end.unix()}`,
      { headers }
    );
    const tasksJson = await tasksRes.json();
    const tasks = Array.isArray(tasksJson)
      ? tasksJson
      : Array.isArray(tasksJson.data)
        ? tasksJson.data
        : Array.isArray(tasksJson.data?.tasks)
          ? tasksJson.data.tasks
          : [];
    const plannedCount = tasks.filter(t => t.type === 4).length;
    const unplannedTasks = tasks.filter(t => t.type === 2);
    const unplannedCount = unplannedTasks.length;

    const laborRes = await fetch(
      `${API_V2}/tasks/labor?assets=${id}&start=${start.unix()}`,
      { headers }
    );
    const laborJson = await laborRes.json();
    const labor = laborJson.data || laborJson;
    const operationalHours = labor.operationalHours || 0;
    const downtimeHours = labor.downtimeHours || 0;
    const entries = Array.isArray(labor.entries) ? labor.entries : [];
    const downtimeMinutes = entries.filter(e => e.taskType === 'wo' && e.downtime).reduce((s, e) => s + e.duration, 0);

    const mttr = unplannedCount ? (downtimeMinutes / 60) / unplannedCount : 0;
    const dates = unplannedTasks.map(t => t.dateCompleted).sort((a,b) => a - b);
    const intervals = dates.slice(1).map((d,i) => (dates[i+1]-dates[i]) / 3600);
    const mtbf = intervals.length ? _.mean(intervals) : 0;
    const uptime = operationalHours ? ((operationalHours - downtimeHours) / operationalHours) * 100 : 0;

    result.assets[id] = {
      name,
      uptimePct: +uptime.toFixed(1),
      downtimeHrs: +downtimeHours.toFixed(1),
      mttrHrs: +mttr.toFixed(1),
      mtbfHrs: +mtbf.toFixed(1),
      plannedCount,
      unplannedCount
    };

    totalOperational += operationalHours;
    totalDowntime += downtimeHours;
    totalDowntimeMin += downtimeMinutes;
    totalUnplannedWO += unplannedCount;
    result.totals.plannedCount += plannedCount;
    result.totals.unplannedCount += unplannedCount;
    allDates = allDates.concat(unplannedTasks.map(t => t.dateCompleted));
  }

  const uptimeTot = totalOperational ? ((totalOperational - totalDowntime) / totalOperational) * 100 : 0;
  const mttrTot = totalUnplannedWO ? (totalDowntimeMin / 60) / totalUnplannedWO : 0;
  const sorted = allDates.sort((a,b) => a - b);
  const intervals = sorted.slice(1).map((d,i) => (sorted[i+1]-sorted[i]) / 3600);
  const mtbfTot = intervals.length ? _.mean(intervals) : 0;

  result.totals.uptimePct = +uptimeTot.toFixed(1);
  result.totals.downtimeHrs = +totalDowntime.toFixed(1);
  result.totals.mttrHrs = +mttrTot.toFixed(1);
  result.totals.mtbfHrs = +mtbfTot.toFixed(1);

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
    const byAsset = await app.fetchAndCache('kpis_byAsset', loadByAssetKpis);

    // Return both overall and per‐asset KPIs
    res.json({ overall, byAsset });
  } catch (err) {
    console.error('KPI error:', err);
    res.status(500).json({ error: 'Failed to fetch KPIs' });
  }
});

app.get('/api/status', async (req, res) => {
  try {
    const status = await app.fetchAndCache('status', loadAssetStatus);
    res.json(status);
  } catch (err) {
    console.error('Status error:', err);
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

app.post(process.env.STATUS_REFRESH_ENDPOINT || '/api/cache/refresh', async (req, res) => {
  cache.del(['kpis_overall', 'kpis_byAsset', 'status']);
  await Promise.all([
    app.fetchAndCache('kpis_overall', loadOverallKpis),
    app.fetchAndCache('kpis_byAsset', loadByAssetKpis),
    app.fetchAndCache('status', loadAssetStatus),
  ]);
  res.send({ ok: true });
});

app.get('/api/kpis-by-asset', async (req, res) => {
  try {
    const data = await app.fetchAndCache('kpis_byAsset', loadByAssetKpis);
    res.json(data);
  } catch (err) {
    console.error('KPIs by asset error:', err);
    res.status(500).json({ error: 'Failed to fetch KPIs by asset' });
  }
});

if (process.env.NODE_ENV !== 'test') {
    app.listen(PORT, () => {
        console.log(`Local:  http://localhost:${PORT}/`);
        console.log(`On LAN: http://${ipv4}:${PORT}/`);
        console.log(`NOICE! Server running at ${PORT}.`);
    });
    const refreshMs = cacheTtlSeconds * 1000;
    setInterval(async () => {
      await Promise.all([
        app.fetchAndCache('kpis_overall', loadOverallKpis),
        app.fetchAndCache('kpis_byAsset', loadByAssetKpis),
        app.fetchAndCache('status', loadAssetStatus),
      ]);
      console.log('✅ Cache refreshed at', new Date().toISOString());
    }, refreshMs);
}

app.fetchAndCache = fetchAndCache;
export { fetchAndCache };
export default app;
