-- Create/update snapshot cache and scheduling tables
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'UpdateSchedules' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  CREATE TABLE dbo.UpdateSchedules (
    Name        sysname      NOT NULL PRIMARY KEY,
    Cron        nvarchar(64) NOT NULL,
    Enabled     bit          NOT NULL CONSTRAINT DF_UpdateSchedules_Enabled DEFAULT (1),
    LastRun     datetime2    NULL
  );
END

MERGE dbo.UpdateSchedules AS tgt
USING (VALUES
 ('header_kpis',        N'*/15 * * * *', 1),
 ('by_asset_kpis',      N'*/15 * * * *', 1),
 ('work_orders_index',  N'*/15 * * * *', 1),
 ('work_orders_pm',     N'*/15 * * * *', 1),
 ('work_orders_status', N'*/15 * * * *', 1),
 ('etl_assets_fields',  N'0 2 * * *',    1)
) AS src(Name, Cron, Enabled)
ON tgt.Name = src.Name
WHEN NOT MATCHED THEN INSERT (Name, Cron, Enabled) VALUES (src.Name, src.Cron, src.Enabled)
WHEN MATCHED THEN UPDATE SET Cron = src.Cron
;

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'KpiHeaderCache' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  CREATE TABLE dbo.KpiHeaderCache (
    SnapshotAt     datetime2      NOT NULL CONSTRAINT DF_KH_Snap DEFAULT SYSUTCDATETIME(),
    Timeframe      nvarchar(32)   NOT NULL, -- e.g., 'lastWeek','last30'
    RangeStart     datetime2      NOT NULL,
    RangeEnd       datetime2      NOT NULL,
    UptimePct      decimal(5,1)   NOT NULL,
    DowntimeHrs    decimal(10,1)  NOT NULL,
    MttrHrs        decimal(10,1)  NOT NULL,
    MtbfHrs        decimal(10,1)  NOT NULL,
    PlannedCount   int            NOT NULL,
    UnplannedCount int            NOT NULL
  );
  CREATE INDEX IX_KH_Timeframe_Snap ON dbo.KpiHeaderCache (Timeframe, SnapshotAt DESC);
END

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'KpiByAssetCache' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  CREATE TABLE dbo.KpiByAssetCache (
    SnapshotAt    datetime2      NOT NULL CONSTRAINT DF_KBA_Snap DEFAULT SYSUTCDATETIME(),
    Timeframe     nvarchar(32)   NOT NULL, -- matches dropdown values
    AssetID       int            NOT NULL,
    Name          nvarchar(200)  NULL,
    RangeStart    datetime2      NOT NULL,
    RangeEnd      datetime2      NOT NULL,
    UptimePct     decimal(5,1)   NULL,
    DowntimeHrs   decimal(10,1)  NULL,
    MttrHrs       decimal(10,1)  NULL,
    MtbfHrs       decimal(10,1)  NULL,
    PlannedPct    decimal(5,1)   NULL,
    UnplannedPct  decimal(5,1)   NULL,
    CONSTRAINT PK_KpiByAssetCache PRIMARY KEY (SnapshotAt, Timeframe, AssetID)
  );
  CREATE INDEX IX_KBA_Timeframe ON dbo.KpiByAssetCache (Timeframe, SnapshotAt DESC);
  CREATE INDEX IX_KBA_Asset ON dbo.KpiByAssetCache (AssetID, SnapshotAt DESC);
END

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'WorkOrdersCache' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  CREATE TABLE dbo.WorkOrdersCache (
    SnapshotAt  datetime2     NOT NULL CONSTRAINT DF_WO_Snap DEFAULT SYSUTCDATETIME(),
    Page        nvarchar(32)  NOT NULL,  -- 'index','pm','prodstatus'
    Data        nvarchar(max) NOT NULL,  -- JSON
    CONSTRAINT PK_WorkOrdersCache PRIMARY KEY (SnapshotAt, Page)
  );
  CREATE INDEX IX_WO_Page ON dbo.WorkOrdersCache (Page, SnapshotAt DESC);
END

