import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import os from 'os';
import moment from 'moment';
import _ from 'lodash';

dotenv.config();

const __filename = fileURLToPath(import.meta.url); // Convert import.meta.url to __filename
const __dirname = path.dirname(__filename); // Derive __dirname from __filename
const nets = os.networkInterfaces();
const ipv4 = Object.values(nets)
  .flat()
  .find(i => i.family === 'IPv4' && !i.internal)?.address;
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
        const clientId = process.env.CLIENT_ID;
        const clientSecret = process.env.CLIENT_SECRET;
        const credentials = { id: clientId, secret: clientSecret };

        // Construct the authorization header
        const base64Credentials = Buffer.from(`${credentials.id}:${credentials.secret}`).toString('base64');
        const headers = { 'Authorization': `Basic ${base64Credentials}` };

        // Make API request to fetch assets
        const response = await fetch('https://api.limblecmms.com:443/v2/assets/?locations=13425', {
            method: 'GET',
            headers: headers
        });

        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('Error fetching assets:', error);
        res.status(500).json({ error: 'An error occurred while fetching assets.' });
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
    const start = moment().subtract(30, 'days').unix();
    const end = moment().unix();
    const taskRes = await fetch(`https://api.limblecmms.com:443/v2/tasks?locations=13425&status=2&dateCompletedGte=${start}&dateCompletedLte=${end}`, { headers });
    const tasksJson = await taskRes.json();
    console.log("Raw KPI‐tasks payload:", JSON.stringify(tasksJson, null, 2));
   // pull out the real array of completed tasks
    const tasks = Array.isArray(tasksJson) 
                ? tasksJson 
                : Array.isArray(tasksJson.data) 
                  ? tasksJson.data 
                  : Array.isArray(tasksJson.data?.tasks) 
                    ? tasksJson.data.tasks 
                    : [];
    // now you can safely do:
    const unplanned = tasks.filter(t => t.type === 2);
    const laborRes = await fetch(`https://api.limblecmms.com:443/v2/tasks/labor?locations=13425&start=${start}`, { headers });
    const labor = await laborRes.json();

    const downtimeHrs = labor.downtimeHours;
    const totalHrs = labor.operationalHours;
    const uptimePct = totalHrs ? ((totalHrs - downtimeHrs) / totalHrs) * 100 : 0;

    const unplanned = tasks.filter(t => t.type === 2);
    const totalDowntimeMin = labor.entries.filter(e => e.taskType==='wo'&&e.downtime).reduce((sum,e)=>sum+e.duration,0);
    const mttrHrs = unplanned.length ? (totalDowntimeMin/60)/unplanned.length : 0;

    const sorted = unplanned.map(t=>t.dateCompleted).sort((a,b)=>a-b);
    const intervals = sorted.slice(1).map((d,i)=> (sorted[i+1]-sorted[i])/3600);
    const mtbfHrs = intervals.length ? _.mean(intervals) : 0;

    const plannedCount = tasks.filter(t=>t.type===4).length;
    const unplannedCount = unplanned.length;

    res.json({
      uptimePct: uptimePct.toFixed(1),
      downtimeHrs: downtimeHrs.toFixed(1),
      mttrHrs: mttrHrs.toFixed(1),
      mtbfHrs: mtbfHrs.toFixed(1),
      plannedCount,
      unplannedCount
    });
  } catch (err) {
    console.error(err);
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
