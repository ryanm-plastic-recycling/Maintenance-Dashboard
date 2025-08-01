# Maintenance Dashboard

This project provides a simple dashboard that displays data from the Limble CMMS
API. It is built with Node and Express and serves a single-page dashboard that
shows a live list of work orders for a configured location.

## Features

- **Live work order table** – the dashboard pulls the latest tasks from Limble
  whenever the page is loaded.
- **Asset name mapping** – asset IDs are converted to human readable names by
  first querying the `/api/assets` endpoint.
- **Status and priority decoding** – `public/mappings.json` translates status,
  type, priority, team and location IDs into meaningful text.
- **Refresh button** – quickly reload the data without restarting the server.
- **REST endpoints** – the server exposes several endpoints used by the
  frontend:
  - `/api/assets` fetches asset information.
  - `/api/task` returns recent open work orders.
  - `/api/taskpm` returns open preventative maintenance tasks.
  - `/api/hours` returns labor hour data.
  These endpoints proxy requests to Limble using credentials provided through
  environment variables.
- **7‑day weather forecast** – a sidebar displays the week's forecast with large icons and
  temperatures. Severe conditions such as heat, freeze or storms appear as alerts above the table.
- **Large date and time** – the header shows the current date and time in a large
  font centered in the banner.
- **Page tabs** – navigation links at the top of each page allow switching between
  the work order view, the PM view and the admin interface.

The dashboard itself lives in `public/index.html` and is styled with basic CSS.
JavaScript in the page fetches data from the endpoints above and renders it in a
table.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` and provide your Limble API credentials:
   ```bash
   cp .env.example .env
   # edit .env and fill CLIENT_ID and CLIENT_SECRET
   ```
3. (Optional) Adjust `PORT` and `LOCAL_IP` in `.env` to change where the server listens. Set `LOCAL_IP` to `192.168.48.255` to host on that address. Set `ADMIN_PASSWORD` for accessing the admin page.
4. Start the server:
   ```bash
   npm start
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

## KPI Calculation Logic

| KPI | Timeframe | Description |
|-----|-----------|-------------|
| uptimePct | Previous calendar week (Mon–Sun) | ((operationalHours - downtimeHours) / operationalHours) * 100 |
| downtimeHrs | Previous calendar week | Pulled from Limble’s /tasks/labor API per asset |
| mttrHrs | Last 30 days | Avg downtime duration per unplanned WO |
| mtbfHrs | Last 30 days | Avg interval (hrs) between unplanned WOs |
| planned vs unplanned % | Previous calendar week | Ratio of planned vs unplanned WOs |
| operationalHours | From Limble API per asset | Based on Limble asset settings (configured in CMMS) |

* All assets tracked are expected to run 24/5
* KPI timeframes and logic are centralized and adjustable
* Per-asset metrics are available via the new `/api/kpis-by-asset` endpoint and shown on `kpi-by-asset.html`
