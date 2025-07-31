# Maintenance Dashboard 🚧

This project provides a small Node/Express application that proxies the
Limble CMMS API and serves a rotating dashboard. The frontend displays the
latest work orders for a configured location and can also list PM (preventative
maintenance) tasks. All data requests go through the server, which injects the
credentials from environment variables when communicating with Limble.

## Features

- 📋 **Live work order table** – the dashboard pulls the latest tasks from Limble
  whenever the page is loaded.
- 🏷️ **Asset name mapping** – asset IDs are converted to human readable names by
  first querying the `/api/assets` endpoint.
- 🗂️ **Status and priority decoding** – `public/mappings.json` translates status,
  type, priority, team and location IDs into meaningful text.
- 🔄 **Refresh button** – quickly reload the data without restarting the server.
- 🌐 **REST endpoints** – the server exposes several endpoints used by the
  frontend:
  - `/api/assets` fetches asset information.
  - `/api/task` returns recent open work orders.
  - `/api/taskpm` returns open preventative maintenance tasks.
  - `/api/hours` returns labor hour data.
  These endpoints proxy requests to Limble using credentials provided through
  environment variables.
- 🔐 **Admin configuration** – the `/admin` page (password protected) lets you
  update `public/config.json` to specify which pages rotate and which columns are
  shown. It also supports uploading a new `mappings.json` file.
- 🔁 **Automatic page rotation** – pages listed in `config.json` will cycle based on
  the configured interval so the dashboard can run unattended.
- ☀️ **7‑day weather forecast** – a sidebar displays the week's forecast with large icons and
  temperatures. Severe conditions such as heat, freeze or storms appear as alerts above the table.
- 🕒 **Large date and time** – the header shows the current date and time in a large
  font centered in the banner.
- 📑 **Page tabs** – navigation links at the top of each page allow switching between
  the work order view, the PM view and the admin interface.

  The dashboard UI lives in the `public/` directory and is styled with basic CSS.
  JavaScript on each page loads `config.json` and `mappings.json`, fetches data
  from the API routes above and renders the results in a table. Visible columns
  and auto‑rotation behaviour come from the values stored in `config.json`.

## Usage

Start the server with `pm2 start server.js --name maintenance-dashboard` then
open `http://<LOCAL_IP>:<PORT>/` in a browser. Use `/pm.html` for
preventative maintenance tasks or `/admin` to modify the configuration. The
dashboard will automatically cycle between pages if more than one is listed in
the configuration file.

## Setup

1. Ensure you have Node.js 18 or newer installed.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy `.env.example` to `.env` and fill in your Limble API credentials:
   ```bash
   cp .env.example .env
   # edit .env and set CLIENT_ID and CLIENT_SECRET
   ```
   Adjust `PORT`, `LOCAL_IP` and `ADMIN_PASSWORD` as needed.
4. Install PM2 globally:
   ```bash
   npm install -g pm2
   ```
5. *(Windows only)* install the PM2 startup helper and register it:
   ```bash
   npm install -g pm2-windows-startup
   pm2-startup install
   ```
6. Start the server under PM2 and save the process list:
   ```bash
   pm2 start server.js --name maintenance-dashboard
   pm2 save
   ```

## Development

- Lint code with:
  ```bash
  npm run lint
  ```
- Run tests with:
  ```bash
  npm test
  ```

The dashboard will be available at `http://<LOCAL_IP>:<PORT>/` when running.
The admin interface is available at `http://<LOCAL_IP>:<PORT>/admin`.
