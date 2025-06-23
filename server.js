import express from 'express';
import { fileURLToPath } from 'url'; // Import the 'fileURLToPath' function from the 'url' module
import path from 'path';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url); // Convert import.meta.url to __filename
const __dirname = path.dirname(__filename); // Derive __dirname from __filename

const app = express();
const PORT = process.env.PORT || 3000;
// Get your local IP address (replace with your actual IP)
const localIP = '192.168.0.5'; // Replace with your local IP address

app.use(express.static(path.join(__dirname, 'public')));

// Serve the HTML file for the root path
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/assets', async (req, res) => {
    try {
        // Replace 'your_client_id' and 'your_client_secret' with your actual credentials
        const clientId = 'X7XBEI853G3G7T2C8K0CUO84FHW9RB3Z';
        const clientSecret = 'IQFFNDNDCN6HFZ01DED83Q5F1LEISF1M';
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
        const clientId = 'X7XBEI853G3G7T2C8K0CUO84FHW9RB3Z';
        const clientSecret = 'IQFFNDNDCN6HFZ01DED83Q5F1LEISF1M';
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
        const clientId = 'X7XBEI853G3G7T2C8K0CUO84FHW9RB3Z';
        const clientSecret = 'IQFFNDNDCN6HFZ01DED83Q5F1LEISF1M';
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
        const clientId = 'X7XBEI853G3G7T2C8K0CUO84FHW9RB3Z';
        const clientSecret = 'IQFFNDNDCN6HFZ01DED83Q5F1LEISF1M';
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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`NOICE! Contact Ryan McCauley before stopping this service! Server running at http://0.0.0.0:${PORT}/`);
});