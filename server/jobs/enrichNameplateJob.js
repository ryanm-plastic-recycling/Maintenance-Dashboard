// server/jobs/enrichNameplateJob.js
import fs from 'fs/promises';

export async function enrichNameplateFromMappings(pool) {
  const path = process.env.MAPPINGS_PATH;
  const raw = await fs.readFile(path, 'utf8');
  const j = JSON.parse(raw);

  const caps = j.capacities_lbs_hr || j.capacities || j.lines || {};
  const entries = Object.entries(caps); // [ [machine, lbsHr], ... ]
  if (!entries.length) {
    console.warn('[enrich-nameplate] No capacities found in mappings.json');
    return { updated: 0 };
  }

  let total = 0;
  for (const [machine, lbs] of entries) {
    const req = pool.request();
    req.input('machine', machine);
    req.input('cap', lbs);
    const r = await req.query(`
      UPDATE dbo.production_fact
      SET nameplate_lbs_hr = @cap
      WHERE machine = @machine AND (nameplate_lbs_hr IS NULL OR nameplate_lbs_hr <> @cap)
    `);
    total += r.rowsAffected?.[0] ?? 0;
  }
  console.log('[enrich-nameplate] updated rows:', total);
  return { updated: total };
}
