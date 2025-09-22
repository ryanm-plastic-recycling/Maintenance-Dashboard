// server/jobs/prodExcelIngest.js
export async function runProdExcelIngest({ dry=false } = {}) {
  const rows = await fetchFromGraph(); // you already do this
  console.log('[prod-excel] Graph rows:', rows.length);

  const header = rows[0]; // if your sheet has headers; otherwise set to null
  const body = headerLooksLikeHeader(header) ? rows.slice(1) : rows;

  const mapped = [];
  for (let i = 0; i < body.length; i++) {
    const raw = body[i];
    try {
      const rec = mapRow(raw);  // <-- see mapper below
      mapped.push(rec);
    } catch (e) {
      e.rowIndex = i;
      e.rowSample = raw;
      e.stage = 'mapRow';
      throw e;
    }
  }

  if (dry) {
    return { parsed: mapped.length, sample: mapped.slice(0, 5) };
  }

  // write to SQL with parameterized bulk upsert
  try {
    await upsertProductionFacts(mapped);
  } catch (e) {
    e.stage = 'sqlUpsert';
    // attach first failing row if you batch insert one-by-one
    throw e;
  }

  return { inserted: mapped.length };
}
