const express = require('express');
const path = require('path');
const fetch = require('node-fetch'); // For making API requests
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/data', async (req, res) => {
    try {
        // Replace 'your_client_id' and 'your_client_secret' with your actual credentials
        const clientId = 'X7XBEI853G3G7T2C8K0CUO84FHW9RB3Z';
        const clientSecret = 'IQFFNDNDCN6HFZ01DED83Q5F1LEISF1M';
        const credentials = { id: clientId, secret: clientSecret };

        // Construct the authorization header
        const base64Credentials = Buffer.from(`${credentials.id}:${credentials.secret}`).toString('base64');
        const headers = { 'Authorization': `Basic ${base64Credentials}` };

        // Make API request with user-input value and authorization header
        const response = await fetch('https://api.limblecmms.com:443/v2/tasks/?locations=13425&type=2&orderBy=-createdDate&limit=10&completedStart=0&status=1', {
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

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

