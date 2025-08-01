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
// Build a list and comma separated string of asset IDs used for production KPIs
const assetIdList = Array.isArray(mappings.productionAssets)
  ? mappings.productionAssets.map(a => a.id)
  : [];
const assetIDs = assetIdList.join(',');

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

    // ─── Time ranges ────────────────────────────────────────────────────────
    const weekStart = process.env.KPI_WEEK_START
      ? moment.unix(Number(process.env.KPI_WEEK_START))
      : moment().startOf('isoWeek').subtract(1, 'week');
    const weekEnd = process.env.KPI_WEEK_END
      ? moment.unix(Number(process.env.KPI_WEEK_END))
      : moment(weekStart).endOf('isoWeek');
    const monthEnd = process.env.KPI_MONTH_END
      ? moment.unix(Number(process.env.KPI_MONTH_END))
      : moment();
    const monthStart = process.env.KPI_MONTH_START
      ? moment.unix(Number(process.env.KPI_MONTH_START))
      : moment(monthEnd).subtract(30, 'days');

    // ─── Helper to count weekdays (Mon-Fri) ─────────────────────────────────
    const countWeekdays = (start, end) => {
      let d = moment(start);
      let days = 0;
      while (d.isSameOrBefore(end, 'day')) {
        if (d.isoWeekday() <= 5) days++;
        d.add(1, 'day');
      }
      return days;
    };

    // ─── Pull labor data ────────────────────────────────────────────────────
    const weekLaborRes = await fetch(
      `https://api.limblecmms.com:443/v2/tasks/labor?assets=${assetIDs}&start=${weekStart.unix()}&end=${weekEnd.unix()}`,
      { headers }
    );
    const weekLaborJson = await weekLaborRes.json();
    const weekLabor = weekLaborJson.data || weekLaborJson;
    const weekEntries = Array.isArray(weekLabor.entries) ? weekLabor.entries : [];

    const monthLaborRes = await fetch(
      `https://api.limblecmms.com:443/v2/tasks/labor?assets=${assetIDs}&start=${monthStart.unix()}&end=${monthEnd.unix()}`,
      { headers }
    );
    const monthLaborJson = await monthLaborRes.json();
    const monthLabor = monthLaborJson.data || monthLaborJson;
    const monthEntries = Array.isArray(monthLabor.entries) ? monthLabor.entries : [];

    // ─── Fetch tasks referenced in labor entries ────────────────────────────
    const taskIds = [...new Set([...weekEntries, ...monthEntries].map(e => e.taskId))];
    let taskMap = {};
    if (taskIds.length) {
      const tasksRes = await fetch(
        `https://api.limblecmms.com:443/v2/tasks?tasks=${taskIds.join(',')}`,
        { headers }
      );
      const tasksJson = await tasksRes.json();
      const tasks = Array.isArray(tasksJson)
        ? tasksJson
        : Array.isArray(tasksJson.data?.tasks)
          ? tasksJson.data.tasks
          : Array.isArray(tasksJson.data)
            ? tasksJson.data
            : [];
      for (const t of tasks) {
        taskMap[t.id] = { assetId: t.assetId, type: t.type, downtime: t.downtime };
      }
    }

    // ─── Aggregation ───────────────────────────────────────────────────────
    const byAsset = {};
    const ensure = id => {
      if (!byAsset[id]) {
        byAsset[id] = {
          downtimeHrs: 0,
          plannedCount: 0,
          unplannedCount: 0,
          _downtimeMonth: 0,
          _unplannedMonth: 0
        };
      }
      return byAsset[id];
    };

    const weekTaskSets = {};
    for (const entry of weekEntries) {
      const info = taskMap[entry.taskId];
      if (!info) continue;
      const id = info.assetId || entry.assetId;
      const a = ensure(id);
      if (info.downtime) {
        a.downtimeHrs += (entry.timeSpent ?? entry.duration ?? 0) / 3600;
      }
      if (!weekTaskSets[id]) weekTaskSets[id] = new Set();
      weekTaskSets[id].add(entry.taskId);
    }

    for (const [assetId, set] of Object.entries(weekTaskSets)) {
      const m = ensure(Number(assetId));
      set.forEach(tid => {
        const info = taskMap[tid];
        if (!info) return;
        if (info.type === 4) m.plannedCount += 1;
        if (info.type === 2) m.unplannedCount += 1;
      });
    }

    for (const entry of monthEntries) {
      const info = taskMap[entry.taskId];
      if (!info) continue;
      const m = ensure(info.assetId || entry.assetId);
      if (info.downtime) {
        m._downtimeMonth += (entry.timeSpent ?? entry.duration ?? 0) / 3600;
      }
      if (info.type === 2) {
        m._unplannedMonth += 1;
      }
    }

    const weekDays = countWeekdays(weekStart, weekEnd);
    const monthDays = countWeekdays(monthStart, monthEnd);

    let totalDowntimeWeek = 0;
    let totalPlannedWeek = 0;
    let totalUnplannedWeek = 0;
    let totalDowntimeMonth = 0;
    let totalUnplannedMonth = 0;

    for (const id of assetIdList) {
      const m = ensure(id);
      totalDowntimeWeek += m.downtimeHrs;
      totalPlannedWeek += m.plannedCount;
      totalUnplannedWeek += m.unplannedCount;
      totalDowntimeMonth += m._downtimeMonth;
      totalUnplannedMonth += m._unplannedMonth;

      const opHoursMonth = monthDays * 24 - m._downtimeMonth;
      m.mttrHrs = m._unplannedMonth ? m._downtimeMonth / m._unplannedMonth : 0;
      m.mtbfHrs = m._unplannedMonth ? opHoursMonth / m._unplannedMonth : 0;
      delete m._downtimeMonth;
      delete m._unplannedMonth;
    }

    const totalWeekHours = weekDays * 24 * assetIdList.length;
    const uptimePct = totalWeekHours
      ? ((totalWeekHours - totalDowntimeWeek) / totalWeekHours) * 100
      : 0;
    const mttrHrs = totalUnplannedMonth
      ? totalDowntimeMonth / totalUnplannedMonth
      : 0;
    const mtbfHrs = totalUnplannedMonth
      ? ((monthDays * 24 * assetIdList.length) - totalDowntimeMonth) / totalUnplannedMonth
      : 0;

    res.json({
      overall: {
        uptimePct: +uptimePct.toFixed(1),
        downtimeHrs: +totalDowntimeWeek.toFixed(1),
        mttrHrs: +mttrHrs.toFixed(1),
        mtbfHrs: +mtbfHrs.toFixed(1),
        plannedCount: totalPlannedWeek,
        unplannedCount: totalUnplannedWeek
      },
      byAsset
    });
  } catch (err) {
    console.error('KPI error:', err);
    res.status(500).json({ error: 'Failed to fetch KPIs' });
  }
});

app.get('/api/kpis-by-asset', async (req, res) => {
  try {
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
        `https://api.limblecmms.com:443/v2/tasks?assets=${id}&status=2&dateCompletedGte=${start.unix()}&dateCompletedLte=${end.unix()}`,
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
        `https://api.limblecmms.com:443/v2/tasks/labor?assets=${id}&start=${start.unix()}`,
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

    res.json(result);
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
}

export default app;
