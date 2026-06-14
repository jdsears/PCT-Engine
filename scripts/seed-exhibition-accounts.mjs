import { pool } from '../src/db.mjs';
import { searchCompanies, companyProfile } from '../src/research/companiesHouse.mjs';
import { resolveDomain } from '../src/research/domains.mjs';
import { syncOfficerContacts } from '../src/research/officerContacts.mjs';
import { scoreCompany } from '../src/research/icp.mjs';
import { regionForPostcode } from '../src/research/region.mjs';
import { getCreditsSpent } from '../src/research/findymail.mjs';

// Seeds the exhibition contacts from Andy and James as named accounts and runs
// them through the existing research functions: Companies House match, domain
// resolve, director pull, and ICP score with a stored breakdown. It writes no
// new research logic, only calls what already exists, and never touches
// Findymail, so no email credit is spent. A company already on file, by name or
// by Companies House number, is skipped rather than overwritten. Safe to re-run.

const SOURCE = 'exhibition';
// Andy notes most of these are cooling designers and integrators, so this is
// the default type for the batch, editable per account later.
const DEFAULT_TYPE = 'cooling_integrator';
// RA-5 is Ireland, marked inactive in the region map, so the Irish entities are
// stored but held: not on the UK register, and not worked while RA-5 is off.
const IRELAND_REGION = 'RA-5';

// Trade-show names. A "(Ireland)" suffix marks an Irish entity to hold.
const NAMES = [
  'Vertiv', 'Carrier', 'Weatherite', 'NTT Global Data', 'Armstrong', 'Trane',
  'Flakt Group', 'Powerload', 'Marley', 'Sudlows', 'Ormandy Rycroft', 'Excool',
  'Elevate', 'Daikin', 'Aalberts', 'SubZero (Ireland)', 'Stulz',
  'Tankbuilder (Ireland)', 'Tate (Ireland)', 'CPV', 'Austin Hughes', 'Airsys',
  'Emcor Group', 'Anord Mardix', 'Airdale', 'DC Cooling Systems',
  'Equans Data Centres', 'Data Centre UK',
];

const norm = (s) => String(s || '').toLowerCase()
  .replace(/\b(ltd|limited|plc|llp|uk|group|holdings)\b/g, '').replace(/[^a-z0-9]/g, '');

const report = { added: 0, skipped: 0, matched: 0, directors: 0, irish: [], unmatched: [], skippedNames: [] };

for (const raw of NAMES) {
  const isIrish = /\(ireland\)/i.test(raw);
  const name = raw.replace(/\s*\(ireland\)\s*/i, '').trim();

  // Skip if a company of this name is already on file (case-insensitive).
  const byName = await pool.query(`SELECT id, name FROM companies WHERE lower(name) = lower($1) LIMIT 1`, [name]);
  if (byName.rows.length) {
    report.skipped++; report.skippedNames.push(`${name} (already on file as "${byName.rows[0].name}")`);
    console.log(`  skip ${name}: already on file`);
    continue;
  }

  if (isIrish) {
    // Held: store the named account, region RA-5, no UK research since an Irish
    // entity is not on Companies House and matching it there would mislead.
    await pool.query(
      `INSERT INTO companies (name, company_type, region, named_account, source)
       VALUES ($1, $2, $3, true, $4)`,
      [name, DEFAULT_TYPE, IRELAND_REGION, SOURCE]);
    report.added++; report.irish.push(name);
    console.log(`  added ${name}: held, Ireland (RA-5) inactive, no UK research`);
    continue;
  }

  // Companies House match, the same heuristic the original seed used: an active
  // company whose name contains, or is contained by, the candidate name.
  let chNumber = null, postcode = null, chName = name;
  try {
    const matches = await searchCompanies(name);
    const best = matches.find(m => m.status === 'active'
      && (norm(m.name).includes(norm(name)) || norm(name).includes(norm(m.name))));
    if (best) { chNumber = best.chNumber; postcode = best.postcode; chName = best.name; }
  } catch (e) { console.log(`  CH search failed for ${name}: ${String(e.message).slice(0, 100)}`); }

  // Skip if this Companies House entity is already on file under another name,
  // which catches trading names that resolve to an existing registered company.
  if (chNumber) {
    const byCh = await pool.query(`SELECT id, name FROM companies WHERE ch_number = $1 LIMIT 1`, [chNumber]);
    if (byCh.rows.length) {
      report.skipped++; report.skippedNames.push(`${name} (same Companies House number as "${byCh.rows[0].name}")`);
      console.log(`  skip ${name}: Companies House number already on file`);
      continue;
    }
  }

  const region = regionForPostcode(postcode);
  const { rows: [inserted] } = await pool.query(
    `INSERT INTO companies (name, ch_number, company_type, region, postcode, named_account, source)
     VALUES ($1, $2, $3, $4, $5, true, $6) RETURNING id`,
    [chName, chNumber, DEFAULT_TYPE, region, postcode, SOURCE]);
  report.added++;
  if (chNumber) report.matched++; else report.unmatched.push(name);
  console.log(`  added ${chName}: ${chNumber ? 'CH ' + chNumber : 'no confident CH match'}`);

  // Cache the Companies House profile onto the row (keyed by ch_number).
  if (chNumber) { try { await companyProfile(chNumber); } catch { /* cache is best effort */ } }

  // Official domain, conservative, null rather than a guess.
  try {
    const domain = await resolveDomain(chName);
    if (domain) await pool.query(`UPDATE companies SET domain = $1, updated_at = now() WHERE id = $2`, [domain, inserted.id]);
  } catch (e) { console.log(`  domain lookup failed for ${chName}: ${String(e.message).slice(0, 80)}`); }

  // Directors from the public register, never Findymail.
  if (chNumber) {
    try {
      const oc = await syncOfficerContacts({ id: inserted.id, ch_number: chNumber, name: chName });
      report.directors += oc.added;
    } catch (e) { console.log(`  director pull failed for ${chName}: ${String(e.message).slice(0, 80)}`); }
  }

  // ICP score with stored breakdown. A fresh account has no signals yet.
  const { rows: [co] } = await pool.query(`SELECT * FROM companies WHERE id = $1`, [inserted.id]);
  const { score, breakdown } = scoreCompany(co, []);
  await pool.query(`UPDATE companies SET icp_score = $1, icp_breakdown = $2::jsonb, updated_at = now() WHERE id = $3`,
    [score, JSON.stringify(breakdown), inserted.id]);
}

console.log('\n=== Exhibition seed report ===');
console.log(`Added: ${report.added}   Skipped, already present: ${report.skipped}`);
console.log(`Of the new ones: ${report.matched} matched to Companies House, ${report.directors} directors pulled`);
console.log(`Irish, stored and held at RA-5: ${report.irish.join(', ') || 'none'}`);
console.log(`Not confidently matched, for Andy to help: ${report.unmatched.join(', ') || 'none'}`);
if (report.skippedNames.length) { console.log('Skipped:'); for (const s of report.skippedNames) console.log(`  - ${s}`); }
console.log(`Findymail credit spent this run: ${getCreditsSpent()}`);
await pool.end();
