// server/routes/production.js (ESM)
import express from 'express';
import sql from 'mssql';

export default function productionRoutes(poolPromise) {
  const r = express.Router();

  // GET /api/production/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
  r.get('/production/summary', async (req, res, next) => {
    try {
      const pool = await poolPromise;
      const from = req.query.from || '2000-01-01';
      const to   = req.query.to   || '2100-01-01';
      const q = `
        SELECT src_date, pounds, availability, perf_adj, oee
        FROM dbo.v_prod_daily_overall
        WHERE src_date BETWEEN @from AND @to
        ORDER BY src_date;
      `;
      const rset = await pool.request()
        .input('from', sql.Date, from)
        .input('to',   sql.Date, to)
        .query(q);
      res.json(rset.recordset);
    } catch (e) { next(e); }
  });

  // GET /api/production/by-line?from=YYYY-MM-DD&to=YYYY-MM-DD
  r.get('/production/by-line', async (req, res, next) => {
    try {
      const pool = await poolPromise;
      const from = req.query.from || '2000-01-01';
      const to   = req.query.to   || '2100-01-01';
      const q = `
        SELECT src_date, machine, pounds, prod_dt_h, maint_dt_h,
               nameplate_lbs_hr, availability, perf_adj, oee
        FROM dbo.v_prod_daily_line
        WHERE src_date BETWEEN @from AND @to
        ORDER BY src_date, machine;
      `;
      const rset = await pool.request()
        .input('from', sql.Date, from)
        .input('to',   sql.Date, to)
        .query(q);
      res.json(rset.recordset);
    } catch (e) { next(e); }
  });
  // GET /api/production/by-line?from=YYYY-MM-DD&to=YYYY-MM-DD
  productionRouter.get('/by-line', async (req, res, next) => {
    try {
      const pool = await getPool(); // or req.app.get('db') in your pattern
      const from = req.query.from || '2000-01-01';
      const to   = req.query.to   || '2100-01-01';
  
      const q = `
        SELECT src_date, machine, pounds, prod_dt_h, maint_dt_h,
               nameplate_lbs_hr, machine_hours, availability, perf_adj, oee
        FROM dbo.v_prod_daily_line
        WHERE src_date BETWEEN @from AND @to
        ORDER BY src_date, machine;
      `;
      const r = await pool.request()
        .input('from', sql.Date, from)
        .input('to',   sql.Date, to)
        .query(q);
  
      res.json(r.recordset);
    } catch (e) { next(e); }
  });

  return r;
}
