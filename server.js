import express  from 'express';
import { fileURLToPath } from 'url';
import path     from 'path';
import fs       from 'fs';
import fetch    from 'node-fetch';
import dotenv   from 'dotenv';
import os       from 'os';
import moment   from 'moment';
import _        from 'lodash';

dotenv.config();

// ─── derive __dirname ─────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── load mappings and build assetIDs once ───────────────────────────────
const rawMappings = fs.readFileSync(
  path.join(__dirname, 'public', 'mappings.json'),
  'utf8'
);
const mappings = JSON.parse(rawMappings);
// Build a comma separated list of asset IDs used for production status/KPIs
const assetIDs = Array.isArray(mappings.productionAssets)
  ? mappings.productionAssets.map(a => a.id).join(',')
  : '';

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

    const url = `https://api.limblecmms.com:443/v2/assets/?assets=${assetIDs}`;
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
        `https://api.limblecmms.com:443/v2/assets/fields/`,
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
        const response = await fetch('https://api.limblecmms.com:443/v2/tasks/?locations=13425&orderBy=-createdDate&limit=20&type=2,6&status=0', {
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
        const response = await fetch('https://api.limblecmms.com:443/v2/tasks/?locations=13425&type=1&orderBy=-createdDate&limit=20&status=0', {
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
        const response = await fetch('https://api.limblecmms.com:443/v2/tasks/labor?start=1693594754', {
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
    const clientId = process.env.CLIENT_ID;
    const clientSecret = process.env.CLIENT_SECRET;
    const headers = {
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
    };

    const now            = moment().unix();
    const lastWeekStart  = moment().subtract(7, 'days').unix();
    const last30Start    = moment().subtract(30, 'days').unix();

    // ─── Fetch tasks for 30 days (MTTR/MTBF) ───────────────────────────────
    const task30Res = await fetch(
      `https://api.limblecmms.com:443/v2/tasks?assets=${assetIDs}&status=2&dateCompletedGte=${last30Start}&dateCompletedLte=${now}`,
      { headers }
    );
    const task30Json = await task30Res.json();
    console.log('Raw KPI-tasks (30d):', JSON.stringify(task30Json, null, 2));

    const tasks30 = Array.isArray(task30Json)
      ? task30Json
      : Array.isArray(task30Json.data)
        ? task30Json.data
        : Array.isArray(task30Json.data?.tasks)
          ? task30Json.data.tasks
          : [];

    // ─── Fetch tasks for last week (planned vs unplanned) ──────────────────
    const taskWeekRes = await fetch(
      `https://api.limblecmms.com:443/v2/tasks?assets=${assetIDs}&status=2&dateCompletedGte=${lastWeekStart}&dateCompletedLte=${now}`,
      { headers }
    );
    const taskWeekJson = await taskWeekRes.json();
    console.log('Raw KPI-tasks (week):', JSON.stringify(taskWeekJson, null, 2));

    const tasksWeek = Array.isArray(taskWeekJson)
      ? taskWeekJson
      : Array.isArray(taskWeekJson.data)
        ? taskWeekJson.data
        : Array.isArray(taskWeekJson.data?.tasks)
          ? taskWeekJson.data.tasks
          : [];

    // ─── Labor for uptime (last week) ──────────────────────────────────────
    const laborWeekRes = await fetch(
      `https://api.limblecmms.com:443/v2/tasks/labor?assets=${assetIDs}&start=${lastWeekStart}`,
      { headers }
    );
    const laborWeekJson = await laborWeekRes.json();
    console.log('Raw labor payload (week):', JSON.stringify(laborWeekJson, null, 2));

    const laborWeek  = laborWeekJson.data || laborWeekJson;
    const entriesWeek = Array.isArray(laborWeek.entries) ? laborWeek.entries : [];

    // ─── Labor for MTTR/MTBF (30 days) ─────────────────────────────────────
    const labor30Res = await fetch(
      `https://api.limblecmms.com:443/v2/tasks/labor?assets=${assetIDs}&start=${last30Start}`,
      { headers }
    );
    const labor30Json = await labor30Res.json();
    console.log('Raw labor payload (30d):', JSON.stringify(labor30Json, null, 2));

    const labor30 = labor30Json.data || labor30Json;
    const entries30 = Array.isArray(labor30.entries) ? labor30.entries : [];

    // ─── Uptime (last week) ────────────────────────────────────────────────
    const downtimeHrs = laborWeek.downtimeHours || 0;
    const totalHrs    = laborWeek.operationalHours || 0;
    const uptimePct   = totalHrs ? ((totalHrs - downtimeHrs) / totalHrs) * 100 : 0;

    // ─── MTTR / MTBF (last 30 days) ────────────────────────────────────────
    const unplannedTasks30 = tasks30.filter(t => t.type === 2);
    const totalDowntimeMin = entries30
      .filter(e => e.taskType === 'wo' && e.downtime)
      .reduce((sum, e) => sum + e.duration, 0);
    const mttrHrs = unplannedTasks30.length
      ? (totalDowntimeMin / 60) / unplannedTasks30.length
      : 0;

    const sorted = unplannedTasks30
      .map(t => t.dateCompleted)
      .sort((a, b) => a - b);
    const intervals = sorted.slice(1).map((d, i) => (sorted[i + 1] - sorted[i]) / 3600);
    const mtbfHrs = intervals.length ? _.mean(intervals) : 0;

    // ─── Planned vs Unplanned (last week) ─────────────────────────────────
    const plannedCount   = tasksWeek.filter(t => t.type === 4).length;
    const unplannedCount = tasksWeek.filter(t => t.type === 2).length;

    res.json({
      uptimePct: uptimePct.toFixed(1),
      downtimeHrs: downtimeHrs.toFixed(1),
      mttrHrs: mttrHrs.toFixed(1),
      mtbfHrs: mtbfHrs.toFixed(1),
      plannedCount,
      unplannedCount
    });
  } catch (err) {
    console.error('KPI error:', err);
    res.status(500).json({ error: 'Failed to fetch KPIs' });
  }
});

if (process.env.NODE_ENV !== 'test') {
    app.listen(PORT, () => {
	console.log(`Local:  http://localhost:${PORT}/`);
    	console.log(`On LAN: http://${ipv4}:${PORT}/`);
        console.log(`NOICE! Server running at ${PORT}.`);
    });
}

export default app;
