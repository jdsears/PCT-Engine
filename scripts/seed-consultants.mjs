import { writeFile } from 'node:fs/promises';
import { pool } from '../src/db.mjs';
import { searchCompanies } from '../src/research/companiesHouse.mjs';
import { regionForPostcode } from '../src/research/region.mjs';

// Seeds the data centre design consultancies as named accounts on the Marwin
// DC campaign, John's instruction of 7 August 2026 after VIRTUS's live reply
// named the missing third party out loud: the operator and their consultants
// write the performance spec, the contractors buy. Getting written into those
// specs multiplies across every project the consultancy touches.
//
//   node --env-file=.env scripts/seed-consultants.mjs            (dry run, prints the plan)
//   node --env-file=.env scripts/seed-consultants.mjs --apply
//
// Dry run by default and it also writes CONSULTANTS_DRAFT.md for John and
// James to curate: strike out what does not belong, add what is missing.
// Consultancies are a curated list, not a discovery sweep, because news
// stories rarely credit the designer; the firms are well known and finite.
// Safe to re-run; existing rows update rather than duplicate, and a field a
// human has set is never overwritten.
//
// What this never does: no leads, no contacts, no scoring, nothing sent.
// Consultants score as a type fit on the next research run and their people
// arrive through the same discovery the rest of the register uses.

const CANDIDATES = [
  'Arup', 'Cundall', 'Hoare Lea', 'Black & White Engineering',
  'RED Engineering Design', 'Sudlows', 'Hurley Palmer Flatt',
  'Mott MacDonald', 'Ramboll UK', 'WSP UK', 'Buro Happold',
  'AtkinsRealis UK', 'PM Group', 'Keysource', 'Future-tech',
];

const APPLY = process.argv.includes('--apply');
const norm = (s) => String(s || '').toLowerCase().replace(/\b(ltd|limited|plc|llp|uk|group|holdings)\b/g, '').replace(/[^a-z0-9]/g, '');

const rows = [];
for (const name of CANDIDATES) {
  const entry = { name, chNumber: null, postcode: null, region: null };
  try {
    const matches = await searchCompanies(name);
    const best = matches.find(m => m.status === 'active' && (norm(m.name).includes(norm(name)) || norm(name).includes(norm(m.name))));
    if (best) { entry.chNumber = best.chNumber; entry.postcode = best.postcode; entry.name = best.name; }
  } catch (e) { console.log(`  CH search failed for ${name}: ${String(e.message).slice(0, 100)}`); }
  entry.region = regionForPostcode(entry.postcode);
  rows.push(entry);
  console.log(`  ${entry.chNumber ? 'matched ' : 'unmatched'} ${entry.name}${entry.region ? `  ${entry.region}` : ''}`);
}

const matched = rows.filter(r => r.chNumber).length;
const md = `# Data centre design consultancies, first draft

For John and James to curate: strike through anything that does not belong,
correct names and regions, and add anything missing. These enter the register
as named accounts of type consultant on the Marwin DC campaign; outbound to
them writes to specification fit, never supply. Generated ${new Date().toISOString().slice(0, 10)};
${rows.length} candidates, ${matched} matched to Companies House.

| Consultancy | CH number | Region |
| --- | --- | --- |
${rows.map(r => `| ${r.name} | ${r.chNumber || 'unmatched'} | ${r.region || ''} |`).join('\n')}
`;
await writeFile(new URL('../CONSULTANTS_DRAFT.md', import.meta.url), md);
console.log(`\nWrote CONSULTANTS_DRAFT.md: ${rows.length} consultancies, ${matched} CH-matched.`);

if (!APPLY) {
  console.log('Dry run. Nothing written to the register. Curate the draft, then re-run with --apply.');
  await pool.end();
  process.exit(0);
}

let created = 0, updated = 0;
for (const r of rows) {
  // Reconcile by CH number first, then name, so re-runs update rather than
  // duplicate. company_type fills only when empty: a human's correction to a
  // row is never overwritten by a re-run.
  let existingId = null;
  if (r.chNumber) {
    const { rows: found } = await pool.query(`SELECT id FROM companies WHERE ch_number = $1`, [r.chNumber]);
    existingId = found[0]?.id ?? null;
  }
  if (!existingId) {
    const { rows: found } = await pool.query(
      `SELECT id FROM companies WHERE lower(name) = lower($1) LIMIT 1`, [r.name]);
    existingId = found[0]?.id ?? null;
  }
  let companyId = existingId;
  if (existingId) {
    await pool.query(
      `UPDATE companies SET named_account = true,
         company_type = COALESCE(company_type, 'consultant'),
         ch_number = COALESCE(ch_number, $2),
         region = COALESCE(region, $3), postcode = COALESCE(postcode, $4), updated_at = now()
       WHERE id = $1`,
      [existingId, r.chNumber, r.region, r.postcode]);
    updated++;
  } else {
    const { rows: ins } = await pool.query(
      `INSERT INTO companies (name, ch_number, company_type, region, postcode, named_account, source)
       VALUES ($1, $2, 'consultant', $3, $4, true, 'seed_consultants') RETURNING id`,
      [r.name, r.chNumber, r.region, r.postcode]);
    companyId = ins[0].id;
    created++;
  }
  await pool.query(
    `INSERT INTO company_campaigns (company_id, campaign) VALUES ($1, 'marwin_dc')
     ON CONFLICT (company_id, campaign) DO NOTHING`, [companyId]);
}
console.log(`\nApplied: ${created} created, ${updated} updated, all on the marwin_dc register as consultants.`);
console.log('The next research run scores them; contact discovery works them like any named account.');
await pool.end();
