import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import os from 'os';

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

if (process.env.NODE_ENV !== 'test') {
    app.listen(PORT, () => {
	console.log(`Local:  http://localhost:${PORT}/`);
    	console.log(`On LAN: http://${ipv4}:${PORT}/`);
        console.log(`NOICE! Server running at ${PORT}.`);
    });
}

export default app;
