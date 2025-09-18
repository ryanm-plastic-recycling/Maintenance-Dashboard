import fs from 'fs/promises';

console.log('[enrich-nameplate] MAPPINGS_PATH=', process.env.MAPPINGS_PATH);

export async function enrichNameplateFromMappings(pool) {
  const path = process.env.MAPPINGS_PATH;
  const raw = await fs.readFile(path, 'utf8');
  const j = JSON.parse(raw);

  const caps = j.capacities_lbs_hr || {};
  const aliases = j.capacity_aliases || {};

  // Build a resolver that maps known aliases → canonical machine name
  const resolveName = (m) => caps[m] !== undefined
    ? m
    : (aliases[m] ? aliases[m] : m);

  // Update per distinct machine seen in fact
  const rows = await pool.request().query(`
    SELECT DISTINCT machine FROM dbo.production_fact
  `);

  let updated = 0;
  for (const { machine } of rows.recordset) {
    const canon = resolveName(machine);
    const cap = caps[canon];
    if (cap === undefined) continue;

    const req = pool.request();
    req.input('machine', machine);
    req.input('cap', cap);
    const r = await req.query(`
      UPDATE dbo.production_fact
      SET nameplate_lbs_hr = @cap
      WHERE machine = @machine
        AND (nameplate_lbs_hr IS NULL OR nameplate_lbs_hr <> @cap)
    `);
    updated += r.rowsAffected?.[0] ?? 0;
  }

  console.log('[enrich-nameplate] updated rows:', updated);

  // optional: report any machines still lacking capacity
  const missing = await pool.request().query(`
    SELECT DISTINCT machine
    FROM dbo.production_fact
    WHERE nameplate_lbs_hr IS NULL
    ORDER BY machine
  `);
  if (missing.recordset.length) {
    console.log('[enrich-nameplate] machines still missing capacity:', missing.recordset.map(r => r.machine));
  }

  return { updated };
}
