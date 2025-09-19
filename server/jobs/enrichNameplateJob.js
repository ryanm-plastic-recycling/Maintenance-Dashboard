// server/jobs/enrichNameplateJob.js
import fs from 'fs/promises';

export async function enrichNameplateFromMappings(pool) {
  const j = JSON.parse(await fs.readFile(process.env.MAPPINGS_PATH, 'utf8'));
  const caps = j.capacities_lbs_hr || {};
  const byMat = j.capacity_by_material_lbs_hr || {};
  const alias = j.capacity_aliases || {};
  const matAlias = j.material_aliases || {};

  const canonLine = (m) => (caps[m] !== undefined || byMat[m]) ? m : (alias[m] || m);
  const normMat = (x) => {
    const k = String(x ?? '').trim().toUpperCase();
    return matAlias[k] || (k === '' ? 'DEFAULT' : k);
  };

  const rows = await pool.request().query(`
    SELECT DISTINCT machine, material /* adjust column names if needed */
    FROM dbo.production_fact
  `);

  let updated = 0;
  for (const { machine, material } of rows.recordset) {
    const line = canonLine(machine);
    const m = normMat(material);

    const cap = byMat[line]?.[m] ?? byMat[line]?.DEFAULT ?? caps[line];
    if (cap == null) continue;

    const r = await pool.request()
      .input('machine', machine)
      .input('cap', cap)
      .query(`
        UPDATE dbo.production_fact
        SET nameplate_lbs_hr = @cap
        WHERE machine = @machine
          AND (nameplate_lbs_hr IS NULL OR nameplate_lbs_hr <> @cap)
      `);
    updated += r.rowsAffected?.[0] ?? 0;
  }
  console.log('[enrich-nameplate] updated rows:', updated);
  return { updated };
}
