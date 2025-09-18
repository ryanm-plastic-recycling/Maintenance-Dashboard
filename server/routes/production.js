// server/routes/production.js (ESM)
import express from 'express';
import sql from 'mssql';

export const productionRouter = express.Router();

// GET /api/production/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
productionRouter.get('/summary', async (req, res) => {
  const pool = req.app.get('db'); // however you expose it in your app
  const from = req.query.from || '2000-01-01';
  const to   = req.query.to   || '2100-01-01';

  const q = `
    SELECT src_date, pounds, availability, perf_adj, oee
    FROM dbo.v_prod_daily_overall
    WHERE src_date BETWEEN @from AND @to
    ORDER BY src_date;
  `;
  const r = await pool.request()
    .input('from', sql.Date, from)
    .input('to',   sql.Date, to)
    .query(q);

  res.json(r.recordset);
});

// GET /api/production/by-line?from=YYYY-MM-DD&to=YYYY-MM-DD
productionRouter.get('/by-line', async (req, res) => {
  const pool = req.app.get('db');
  const from = req.query.from || '2000-01-01';
  const to   = req.query.to   || '2100-01-01';

  const q = `
    SELECT src_date, machine, pounds, prod_dt_h, maint_dt_h,
           nameplate_lbs_hr, availability, perf_adj, oee
    FROM dbo.v_prod_daily_line
    WHERE src_date BETWEEN @from AND @to
    ORDER BY src_date, machine;
  `;
  const r = await pool.request()
    .input('from', sql.Date, from)
    .input('to',   sql.Date, to)
    .query(q);

  res.json(r.recordset);
});
