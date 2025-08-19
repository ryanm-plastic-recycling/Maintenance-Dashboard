## Snapshot Caching & Schedules
- TVs read from SQL cache tables only; no Limble calls.
- Jobs:
  - `header_kpis`, `by_asset_kpis`, `work_orders_index|pm|status` (default: every 15 min)
  - `etl_assets_fields` (default: daily 02:00, heavy ingestion from Limble)
- Admin can edit cron expressions at **Admin → Update Schedules**.
- KPI by Asset snapshots compute **all** timeframes listed in `config.json` each run.
- Each endpoint returns `lastRefreshUtc` for UI display.
- NodeCache removed.

