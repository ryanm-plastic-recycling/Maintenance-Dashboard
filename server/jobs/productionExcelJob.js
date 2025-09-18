// server/jobs/productionExcelJob.js
import sql from 'mssql';
import fetch from 'node-fetch';

const graphToken = async () => {
  const body = new URLSearchParams({
    client_id: process.env.GRAPH_CLIENT_ID,
    client_secret: process.env.GRAPH_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const res = await fetch(`https://login.microsoftonline.com/${process.env.GRAPH_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) throw new Error('Token failed: ' + (await res.text()));
  const j = await res.json();
  return j.access_token;
};

const getTableRows = async (token) => {
  const { SP_SITE_ID, SP_DRIVE_ID, SP_ITEM_ID, SP_SHEET_NAME, SP_TABLE_NAME } = process.env;
  // Read Excel table values (evaluated formulas -> values)
  const url = `https://graph.microsoft.com/v1.0/sites/${SP_SITE_ID}/drives/${SP_DRIVE_ID}/items/${SP_ITEM_ID}/workbook/worksheets('${encodeURIComponent(SP_SHEET_NAME)}')/tables('${encodeURIComponent(SP_TABLE_NAME)}')/rows`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }});
  if (!res.ok) throw new Error('Graph rows failed: ' + (await res.text()));
  const j = await res.json();
  return (j.value || []).map(r => r.values?.[0] || []);  // each row.values is 2D
};

const upsertStaging = async (pool, rows) => {
  if (!rows.length) return 0;

  // Header order per your screenshot/list
  const hdr = ["DATE","Machine","Shift","Source","Source Ref/PO","Lot Number","Note","Type","Color","Format","Options","Down Time","Reason for Downtime","Machine Hours","Standard","Pounds","Manhours","# Per Machine Hour","# Per Manhour2","Cost of Materials","Cost of Processing","Sales Price","Year","Mo#","Mo","Day#","Day","M#","UptimeCalc","ShiftUptime","GW Uptime"];

  // Table starts at row 5; Graph table excludes header if it’s part of the Excel "table"
  // If the first row smells like headers, drop it.
  const looksLikeHeader = (r) => r && r[0] && String(r[0]).toUpperCase() === 'DATE';
  const bodyRows = looksLikeHeader(rows[0]) ? rows.slice(1) : rows;

  const request = new sql.Request(pool);
  // Use TVP (table-valued parameter) or bulk insert; here is a simple row-by-row pattern for clarity.
  for (const r of bodyRows) {
    const rec = Object.fromEntries(hdr.map((k,i)=>[k, r[i]]));
    await request.batch(`
      MERGE dbo.production_staging AS tgt
      USING (SELECT
        CAST(${sql.escape(rec["DATE"])} AS DATE)              AS src_date,
        ${sql.escape(rec["Machine"])}                         AS machine,
        ${sql.escape(rec["Shift"])}                           AS shift,
        ${sql.escape(rec["Source"])}                          AS source,
        ${sql.escape(rec["Source Ref/PO"])}                   AS source_ref_po,
        ${sql.escape(rec["Lot Number"])}                      AS lot_number,
        ${sql.escape(rec["Note"])}                            AS note,
        ${sql.escape(rec["Type"])}                            AS type,
        ${sql.escape(rec["Color"])}                           AS color,
        ${sql.escape(rec["Format"])}                          AS format,
        ${sql.escape(rec["Options"])}                         AS options,
        TRY_CONVERT(DECIMAL(9,2), ${sql.escape(rec["Down Time"])})            AS down_time_hours,
        ${sql.escape(rec["Reason for Downtime"])}             AS reason_downtime,
        TRY_CONVERT(DECIMAL(9,2), ${sql.escape(rec["Machine Hours"])})        AS machine_hours,
        TRY_CONVERT(DECIMAL(12,2), ${sql.escape(rec["Standard"])})            AS standard,
        TRY_CONVERT(DECIMAL(18,2), ${sql.escape(rec["Pounds"])})              AS pounds,
        TRY_CONVERT(DECIMAL(9,2), ${sql.escape(rec["Manhours"])})             AS manhours,
        TRY_CONVERT(DECIMAL(12,4), ${sql.escape(rec["# Per Machine Hour"])})  AS per_machine_hour,
        TRY_CONVERT(DECIMAL(12,4), ${sql.escape(rec["# Per Manhour2"])})      AS per_manhour2,
        TRY_CONVERT(DECIMAL(18,2), ${sql.escape(rec["Cost of Materials"])})   AS cost_materials,
        TRY_CONVERT(DECIMAL(18,2), ${sql.escape(rec["Cost of Processing"])})  AS cost_processing,
        TRY_CONVERT(DECIMAL(18,2), ${sql.escape(rec["Sales Price"])})         AS sales_price,
        TRY_CONVERT(INT, ${sql.escape(rec["Year"])})          AS year_num,
        TRY_CONVERT(INT, ${sql.escape(rec["Mo#"])})           AS month_num,
        ${sql.escape(rec["Mo"])}                               AS month_name,
        TRY_CONVERT(INT, ${sql.escape(rec["Day#"])})          AS day_num,
        ${sql.escape(rec["Day"])}                              AS day_name,
        TRY_CONVERT(INT, ${sql.escape(rec["M#"])})            AS m_num,
        TRY_CONVERT(DECIMAL(12,4), ${sql.escape(rec["UptimeCalc"])})  AS uptime_calc,
        TRY_CONVERT(DECIMAL(12,4), ${sql.escape(rec["ShiftUptime"])}) AS shift_uptime,
        TRY_CONVERT(DECIMAL(12,4), ${sql.escape(rec["GW Uptime"])})   AS gw_uptime
      ) AS src
      ON (tgt.src_date = src.src_date
          AND tgt.machine = src.machine
          AND ISNULL(tgt.shift,'') = ISNULL(src.shift,'')
          AND ISNULL(tgt.lot_number,'') = ISNULL(src.lot_number,'')
          AND ISNULL(tgt.source_ref_po,'') = ISNULL(src.source_ref_po,''))
      WHEN MATCHED THEN UPDATE SET
        source            = src.source,
        note              = src.note,
        type              = src.type,
        color             = src.color,
        format            = src.format,
        options           = src.options,
        down_time_hours   = src.down_time_hours,
        reason_downtime   = src.reason_downtime,
        machine_hours     = src.machine_hours,
        standard          = src.standard,
        pounds            = src.pounds,
        manhours          = src.manhours,
        per_machine_hour  = src.per_machine_hour,
        per_manhour2      = src.per_manhour2,
        cost_materials    = src.cost_materials,
        cost_processing   = src.cost_processing,
        sales_price       = src.sales_price,
        year_num          = src.year_num,
        month_num         = src.month_num,
        month_name        = src.month_name,
        day_num           = src.day_num,
        day_name          = src.day_name,
        m_num             = src.m_num,
        uptime_calc       = src.uptime_calc,
        shift_uptime      = src.shift_uptime,
        gw_uptime         = src.gw_uptime,
        loaded_at_utc     = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (
        src_date, machine, shift, source, source_ref_po, lot_number, note, type, color, format, options,
        down_time_hours, reason_downtime, machine_hours, standard, pounds, manhours,
        per_machine_hour, per_manhour2, cost_materials, cost_processing, sales_price, year_num,
        month_num, month_name, day_num, day_name, m_num, uptime_calc, shift_uptime, gw_uptime
      ) VALUES (
        src.src_date, src.machine, src.shift, src.source, src.source_ref_po, src.lot_number, src.note, src.type, src.color, src.format, src.options,
        src.down_time_hours, src.reason_downtime, src.machine_hours, src.standard, src.pounds, src.manhours,
        src.per_machine_hour, src.per_manhour2, src.cost_materials, src.cost_processing, src.sales_price, src.year_num,
        src.month_num, src.month_name, src.day_num, src.day_name, src.m_num, src.uptime_calc, src.shift_uptime, src.gw_uptime
      );
    `);
  }
  return bodyRows.length;
};

export async function ingestProductionExcel(pool) {
  const token = await graphToken();
  const rows  = await getTableRows(token);
  const n     = await upsertStaging(pool, rows);
  // Push to fact
  await pool.request().execute('dbo.upsert_production_fact');
  return { rows: n };
}
