import { pool } from '../src/db.mjs';
import { searchCompanies, companyProfile, confidentChMatch } from '../src/research/companiesHouse.mjs';
import { regionForPostcode } from '../src/research/region.mjs';

// The retro-matcher: walks register companies with no Companies House number
// and attaches the confident ones. John's instruction, 11 August 2026, when
// the Accounts view showed why so many rows read Unmatched: matching only
// ever happened at four doors, and the customer import deliberately skipped
// it, so nothing had ever walked back over the rows already here.
//
//   node --env-file=.env scripts/match-register.mjs
//   node --env-file=.env scripts/match-register.mjs --campaign pharma_steriflow --limit 50
//   node --env-file=.env scripts/match-register.mjs --apply
//
// Confidence is the extracted seed rule tightened for bulk: exactly one
// active candidate whose name and the register name contain one another
// after suffix stripping. Everything else, several fits or none, is listed
// and left for the amend form, never guessed. A number already held by
// another row is a merge candidate, reported not written. Dry by default;
// --apply attaches the number, adopts nothing else except filling an empty
// postcode and region, and caches the profile so register health can score.
// Batched (--limit, default 100) and re-runnable: matched rows leave the
// walk by matching.
//
// What this never does: rename a company, touch leads or contacts, or spend
// anything beyond Companies House lookups.

const APPLY = process.argv.includes('--apply');
const RECHECK = process.argv.includes('--recheck');
const argAfter = f => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : null; };
const campaign = argAfter('--campaign');
const limit = Math.max(1, Math.min(300, parseInt(argAfter('--limit') || '100', 10) || 100));

// --recheck: audit what earlier walks attached. The first live run leaked
// two wrong entities through the looser rule before it was tightened, so
// this re-judges every attached number against the cached register entry
// under the current rule and names the suspects. It never detaches; a wrong
// number is corrected through the amend form, a human decision.
if (RECHECK) {
  const { confidentChMatch: strict } = await import('../src/research/companiesHouse.mjs');
  const { rows } = await pool.query(
    `SELECT id, name, ch_number, ch_profile->>'company_name' AS registered
     FROM companies WHERE ch_number IS NOT NULL AND ch_profile IS NOT NULL ORDER BY name`);
  let suspects = 0;
  for (const r of rows) {
    if (!r.registered) continue;
    const verdict = strict(r.name, [{ name: r.registered, chNumber: r.ch_number, status: 'active' }]);
    if (verdict.status !== 'matched') {
      suspects++;
      console.log(`  suspect  #${r.id} ${r.name} -> ${r.registered} (${r.ch_number}); if wrong, paste the right number in the amend form`);
    }
  }
  console.log(`\n${rows.length} attached number(s) rechecked, ${suspects} suspect(s) under the tightened rule.`);
  console.log('Nothing was changed; a wrong number is corrected through the amend form.');
  await pool.end();
  process.exit(0);
}

const params = [];
let where = `ch_number IS NULL`;
if (campaign) { params.push(campaign); where += ` AND EXISTS (SELECT 1 FROM company_campaigns m WHERE m.company_id = companies.id AND m.campaign = $${params.length})`; }
params.push(limit);
const { rows } = await pool.query(
  `SELECT id, name, postcode, region FROM companies WHERE ${where}
   ORDER BY named_account DESC, icp_score DESC NULLS LAST, name LIMIT $${params.length}`, params);

console.log(`${rows.length} unmatched compan${rows.length === 1 ? 'y' : 'ies'}${campaign ? ` on ${campaign}` : ''} in this batch (limit ${limit}).`);
if (!rows.length) { await pool.end(); process.exit(0); }

const report = { matched: 0, ambiguous: 0, none: 0, collisions: 0, failed: 0 };
for (const co of rows) {
  let outcome;
  try {
    outcome = confidentChMatch(co.name, await searchCompanies(co.name));
  } catch (e) {
    report.failed++;
    console.log(`  failed   ${co.name}: ${String(e.message).slice(0, 100)}`);
    continue;
  }
  if (outcome.status === 'ambiguous') {
    report.ambiguous++;
    console.log(`  ambiguous ${co.name}: ${outcome.candidates.map(c => `${c.name} (${c.chNumber})`).join('; ')}  -> use the amend form`);
    continue;
  }
  if (outcome.status === 'dissolved_only') {
    report.dissolved = (report.dissolved || 0) + 1;
    console.log(`  dissolved ${co.name}: every name-agreeing entity is dissolved: ${outcome.candidates.map(c => `${c.name} (${c.chNumber})`).join('; ')}  -> if this is them, the business is gone; consider dismissing the account, or attach the number via the amend form to record the truth`);
    continue;
  }
  if (outcome.status === 'none') {
    report.none++;
    console.log(`  none     ${co.name}: no confident active match  -> use the amend form if you know the entity`);
    continue;
  }
  const m = outcome.match;
  const { rows: holder } = await pool.query(`SELECT id, name FROM companies WHERE ch_number = $1`, [m.chNumber]);
  if (holder.length) {
    report.collisions++;
    console.log(`  collision ${co.name}: ${m.chNumber} is already held by #${holder[0].id} ${holder[0].name}  -> a merge candidate, decide by hand`);
    continue;
  }
  report.matched++;
  console.log(`  matched  ${co.name} -> ${m.name} (${m.chNumber})`);
  if (APPLY) {
    await pool.query(
      `UPDATE companies SET ch_number = $2,
         postcode = COALESCE(postcode, $3), region = COALESCE(region, $4), updated_at = now()
       WHERE id = $1`,
      [co.id, m.chNumber, m.postcode || null, regionForPostcode(m.postcode) || co.region || null]);
    try { await companyProfile(m.chNumber); } catch { /* the cache is best effort */ }
  }
}

console.log(`\n${report.matched} confident, ${report.ambiguous} ambiguous, ${report.none} without a match, ${report.collisions} collision(s), ${report.failed} failed.`);
if (!APPLY) console.log('Dry run. Nothing written. Re-run with --apply to attach the confident matches.');
else console.log('Applied. Matched companies now sync directors and score register health on the next research run.');
await pool.end();
