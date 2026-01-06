# Maintenance Dashboard

This project provides a dashboard that displays data from the Limble CMMS API and local Azure SQL snapshots. It is built with Node.js and Express, serves static pages from `public/`, and exposes REST APIs plus scheduled jobs for KPI and production reporting.

## What’s inside

- **Runtime & tooling**: Node 18, Express, Axios/fetch, helmet, CORS, lodash, moment, node-cron, and Jest/ESLint for testing and linting.
- **Data sources**: Limble CMMS (`CLIENT_ID`, `CLIENT_SECRET`, `API_BASE_URL`) and Azure SQL (`AZURE_SQL_*`).
- **Frontend**: Static HTML/JS in `public/` (`index.html`, `pm.html`, `prodstatus.html`, `kpi-by-asset.html`, `admin.html`, etc.).
- **Background jobs**: Limble sync (`limbleSync.js`), KPI snapshot jobs (`kpiJobs.js`), production ingest/enrichment jobs, and ETL helpers (`etl.js`).
- **Admin controls**: Basic/Bearer-protected routes for cache refresh, schedule edits, and one-off job runs; telemetry capture; Limble webhook verification.

## API reference

Unless noted, routes are defined in `server.js`. Admin routes require Basic auth (`BASIC_AUTH_USER`, `BASIC_AUTH_PASS`) or a bearer token (`ADMIN_TOKEN`). Some config writes additionally expect `ADMIN_PASSWORD` in the request body.

### Public/read endpoints

- `GET /api/config` – return `public/config.json`.
- `GET /api/assets` – Limble assets for configured production assets.
- `GET /api/assets/fields` – Limble asset fields (paged).
- `GET /api/task` – recent open work orders (types 2,6) for location 13425.
- `GET /api/taskpm` – open preventative maintenance tasks for location 13425.
- `GET /api/hours` – labor hours since a fixed timestamp.
- `GET /api/status` – alias for `/api/workorders/prodstatus`.
- `GET /api/workorders/:page` – latest cached work orders for `index`, `pm`, or `prodstatus`.
- `GET /api/kpis/header` – header KPIs (weekly + monthly snapshots).
- `GET /api/kpis/by-asset` – KPI snapshot for a timeframe (`tf`/`timeframe` query).
- `GET /api/kpis-by-asset` and `GET /api/kpi/by-asset` – aliases to `/api/kpis/by-asset`.
- `GET /api/settings/kpi-theme` – current KPI color/threshold theme.
- `GET /api/health` – health check.

Production reporting (`server/routes/production.js`):
- `GET /api/production/summary?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /api/production/by-line?from=...&to=...`
- `GET /api/production/validate?date=YYYY-MM-DD&machine=...`
- `GET /api/production/dt-reasons?kind=prod|maint&dim=cat|fm&from=...&to=...&weekdaysOnly=1`

### Admin/write endpoints

- `POST /api/config` – replace `public/config.json` (requires `ADMIN_PASSWORD` in body).
- `POST /api/mappings` – replace `public/mappings.json` (requires `ADMIN_PASSWORD` in body).
- `PUT /api/settings/kpi-theme` – update KPI colors/thresholds (validates hex + numbers).
- `GET /api/admin/schedules` – list cron expressions from `dbo.UpdateSchedules`.
- `PUT /api/admin/schedules` – update cron expressions/enabled flags and reload scheduler.
- `POST /api/admin/run` – run a named job now (e.g., `header_kpis`, `by_asset_kpis`, `work_orders_index`, `work_orders_pm`, `work_orders_status`, `etl_assets_fields`, `limble_sync`, `limble_sync_refresh`, `limble_sync_completed`, `full_refresh_daily`, `index_maintenance`, `prod-excel`).
- `POST /api/admin/refresh-all` – refresh header/by-asset KPIs and all work-order snapshots.
- `POST /api/admin/run-prod-excel?dry=1` – ingest production Excel (optionally dry run).
- `POST /api/admin/full-refresh` – full refresh pipeline run.
- `POST /api/cache/refresh` – force refresh KPI and work-order caches.
- Diagnostics (admin only): `GET /api/production/cap-check`, `/production/debug-cap`, `/production/debug-material`, `/admin/cap-audit`.
- Integrations:
  - `POST /api/limble/webhook` – Limble webhook with HMAC signature check; triggers Windows PowerShell pulls.
  - `POST /api/telemetry` – append JSONL telemetry events (size/shape validated).

### Background jobs & schedules

- Jobs are registered in `server.js` and scheduled via `node-cron` using `dbo.UpdateSchedules` rows (see `server/scheduler.js`).
- Common jobs: `header_kpis`, `by_asset_kpis`, `work_orders_index|pm|status`, `etl_assets_fields`, `limble_sync`, `limble_sync_refresh`, `limble_sync_completed`, `full_refresh_daily`, `prod-excel`, `index_maintenance`.
- Admins can view/update cron strings via `GET/PUT /api/admin/schedules` or trigger jobs via `POST /api/admin/run`.
- The Docker image installs `cron` and runs `etl.js` nightly at 00:00 via `/etc/cron.d/etl-cron`.

## Setup & installation

1. Install dependencies:
   ```bash
   npm install
   ```
2. Configure environment (no `.env.example` is committed; create `.env`).
   Set `PORT=7601` for local runs and in PM2 env so the dashboard listens on the expected port:
   - Limble: `CLIENT_ID`, `CLIENT_SECRET`, `API_BASE_URL` (default `https://api.limblecmms.com:443`).
   - Azure SQL: `AZURE_SQL_SERVER`, `AZURE_SQL_DB`, `AZURE_SQL_USER`, `AZURE_SQL_PASS`.
   - Server: `PORT` (default `3000`, recommend `7601`), `LOCAL_IP` (for logging), `NODE_ENV`.
   - Admin auth: `BASIC_AUTH_USER`, `BASIC_AUTH_PASS` and/or `ADMIN_TOKEN`; `ADMIN_PASSWORD` for config/mappings POSTs.
   - Cache: `CACHE_TTL_MINUTES`, `CACHE_CHECK_PERIOD_SECONDS`, `STATUS_REFRESH_ENDPOINT`.
   - KPI windows: `KPI_WEEK_START`, `KPI_WEEK_END`, `KPI_MONTH_START`, `KPI_MONTH_END`.
   - Operations: `EXPECTED_RUN_DAYS` (e.g., `Mon-Fri`), `EXPECTED_HOURS_PER_DAY`.
   - Optional Limble sync tuning: `TASKS_URL`, `TASKS_LIMIT`, `LIMBLE_LOCATION_ID`.
   - Webhook: `CLIENT_SECRET` also validates `/api/limble/webhook` signatures.
3. Optional: PM2 process manager (see `ecosystem.config.cjs`):
   ```bash
   npm install -g pm2
   pm2 start ecosystem.config.cjs --env production
   ```
4. Optional: Docker ETL runner (cron):
   ```bash
   docker build -t maintenance-dashboard-etl .
   docker run --env-file .env maintenance-dashboard-etl
   ```

## How to start

- **Local dev server**
  ```bash
  PORT=7601 npm start          # serves the dashboard on PORT (default 3000; use 7601 in production)
  ```
- **PM2 (production)**
  ```bash
  pm2 start ecosystem.config.cjs --env production
  pm2 logs maintenance-dashboard
  ```
- **Run background jobs once** (`scripts/run-jobs-once.mjs`):
  ```bash
  node scripts/run-jobs-once.mjs --all        # run all KPI + work-order jobs
  node scripts/run-jobs-once.mjs --prod-excel # ingest production Excel + enrichment
  ```

## How to restart

- Local Node process: stop/restart the `npm start` process.
- PM2-managed app: `pm2 restart maintenance-dashboard` (or `pm2 reload` for zero-downtime).
- Docker ETL container: `docker restart <container>` (cron will keep scheduling nightly runs).

## How to update

1. Pull and install dependencies:
   ```bash
   git pull
   npm ci   # or npm install
   ```
2. Restart the runtime:
   - Local: stop and rerun `npm start`.
   - PM2: `pm2 reload maintenance-dashboard`.
   - Docker ETL: rebuild/pull the image and recreate the container.

## How to refresh data or schedules

- From the admin UI, use **Admin → Update Schedules** (backs `dbo.UpdateSchedules`).
- API shortcuts:
  - Refresh caches: `POST /api/cache/refresh` or `POST /api/admin/refresh-all`.
  - Run a single job: `POST /api/admin/run` with `{"job":"header_kpis"}` (and other job names above).
  - Force production Excel ingest: `POST /api/admin/run-prod-excel?dry=0`.

## Cache & operations

- Cache tuning via env:
  - `CACHE_TTL_MINUTES` – minutes before KPI/status data is refreshed (default `15`).
  - `CACHE_CHECK_PERIOD_SECONDS` – how often cache trims expired items (default `1800`).
  - `STATUS_REFRESH_ENDPOINT` – route for manual refresh (default `/api/cache/refresh`).
- Operational hours defaults: 24 hours/day, Monday–Friday.
  - Override with `EXPECTED_RUN_DAYS` (e.g., `Mon-Fri`, `Sun-Sat`) and `EXPECTED_HOURS_PER_DAY`.
- KPI time ranges default to last calendar week/month but can be overridden with `KPI_WEEK_START`, `KPI_WEEK_END`, `KPI_MONTH_START`, `KPI_MONTH_END` (Unix timestamps).

## KPI calculation logic

| KPI | Timeframe | Description |
|-----|-----------|-------------|
| downtimePct | Last calendar week | `(downtimeHours / operationalHours) * 100` |
| downtimeHrs | Last calendar week | Sum of all downtime labor entries in hours |
| mttrHrs | Last calendar month | `Σ downtimeHours / count(unplanned tasks)` |
| mtbfHrs | Last calendar month | `(workHours - downtimeHours) / count(unplanned tasks)` |
| planned vs unplanned count | Last calendar week | Number of tasks of each type |

- Assets default to 24/5 unless overridden via `EXPECTED_RUN_DAYS`/`EXPECTED_HOURS_PER_DAY`.
- KPI date ranges honor `KPI_*` overrides; otherwise last calendar week/month are used.
- Per-asset metrics are returned alongside overall values from `/api/kpis` endpoints. The page `kpi-by-asset.html` calls `/api/kpis/by-asset?timeframe=...` with: `currentWeek`, `lastWeek`, `trailing7Days`, `currentMonth`, `lastMonth`, `trailing30Days`, `currentYear`, `lastYear`, `trailing12Months`. Results are cached per timeframe key.

## ETL & scheduling details

- `etl.js` pulls Limble data and merges it into Azure SQL, using incremental watermarks for tasks, labor, and asset fields; failed rows are written to `bad_rows.json`, and a stub `notifyFailures()` is triggered when >10 rows fail.
- `cron.sh` + `Dockerfile` install cron and schedule `etl.js` daily at midnight.
- Snapshot caching and schedules are described in `docs/CACHING_AND_SCHEDULES.md` (TVs read from SQL cache tables only; jobs default to every 15 minutes, asset field ETL nightly).

## Development

- Lint code:
  ```bash
  npm run lint
  ```
- Run tests:
  ```bash
  npm test
  ```

The dashboard will be available at `http://<LOCAL_IP>:<PORT>/` when running. The admin interface lives at `http://<LOCAL_IP>:<PORT>/admin`.
