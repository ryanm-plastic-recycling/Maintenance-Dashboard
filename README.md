# Maintenance Dashboard

This project provides a simple dashboard that displays data from the Limble CMMS
API. It is built with Node and Express and serves a single-page dashboard that
shows a live list of work orders for a configured location.

## Features

- **Live work order table** – the dashboard pulls the latest tasks from Limble
  whenever the page is loaded.
- **Asset name mapping** – asset IDs are converted to human readable names by
  first querying the `/api/assets` endpoint.
- **KPI asset list** – the dashboard reads `public/mappings.json` at startup to
  determine which asset IDs should be included when calculating KPIs. These IDs
  are passed directly to Limble when fetching labor and task details.
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
2. Copy `.env.example` to `.env` and provide your Limble API credentials and base URL:
   ```bash
   cp .env.example .env
   # edit .env and fill CLIENT_ID, CLIENT_SECRET and API_BASE_URL
   ```
3. (Optional) Adjust `PORT` and `LOCAL_IP` in `.env` to change where the server listens. Set `LOCAL_IP` to `192.168.48.255` to host on that address. Set `ADMIN_PASSWORD` for accessing the admin page.
4. (Optional) Configure cache settings in `.env`:
   ```bash
   CACHE_TTL_MINUTES=15
 CACHE_CHECK_PERIOD_SECONDS=1800
 STATUS_REFRESH_ENDPOINT=/api/cache/refresh
 API_BASE_URL=https://api.limblecmms.com:443
   ```
5. Start the server:
   ```bash
   npm start
   ```

### Cache settings
The cache is controlled via environment variables:
- `CACHE_TTL_MINUTES` – minutes before KPI and status data is refreshed (default `15`)
- `CACHE_CHECK_PERIOD_SECONDS` – how often the cache trims expired items (default `1800`)
- `STATUS_REFRESH_ENDPOINT` – route for manually forcing a refresh (default `/api/cache/refresh`)
- `API_BASE_URL` – base URL for Limble API requests (default `https://api.limblecmms.com:443`)

### KPI time ranges
KPI calculations default to the previous calendar week and previous 30 days. Override
these ranges by setting any of the following environment variables to Unix timestamps:

- `KPI_WEEK_START`
- `KPI_WEEK_END`
- `KPI_MONTH_START`
- `KPI_MONTH_END`

If only a start value is supplied, the end defaults to the end of that week or month.

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
| uptimePct | Last calendar week | `((workHours - downtimeHours) / workHours) * 100` |
| downtimeHrs | Last calendar week | Sum of all downtime labor entries in hours |
| mttrHrs | Last 30 days | `Σ downtimeHours / count(unplanned tasks)` |
| mtbfHrs | Last 30 days | `(workHours - downtimeHours) / count(unplanned tasks)` |
| planned vs unplanned count | Last calendar week | Number of tasks of each type |

* All assets are assumed to run 24/5.
* Time ranges can be overridden via the `KPI_*` environment variables
  (see [KPI time ranges](#kpi-time-ranges)). When unset, the server uses the
  last calendar week and previous 30 days.
* Per-asset metrics are returned alongside the overall values from `/api/kpis`.
