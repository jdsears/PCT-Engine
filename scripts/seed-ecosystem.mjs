import { writeFile } from 'node:fs/promises';
import { pool } from '../src/db.mjs';
import { searchCompanies, confidentChMatch } from '../src/research/companiesHouse.mjs';
import { regionForPostcode } from '../src/research/region.mjs';

// Seeds the UK-checkable names harvested from the Olajuwon data centre
// ecosystem directory, forwarded by James on 16 August 2026 and mined on
// John's instruction. The directory is a US market map, not project intel;
// what it gives the register is names with UK arms across three lanes: the
// supplier tier that buys flow control as components (a CDU is largely
// pumps, plates and valves), the mission-critical contractors with UK
// businesses, and consultants extending the specification lane.
//
//   node --env-file=.env scripts/seed-ecosystem.mjs            (dry run, prints the plan)
//   node --env-file=.env scripts/seed-ecosystem.mjs --apply
//
// Mirrors seed-consultants: dry by default, writes ECOSYSTEM_DRAFT.md for
// John and James to curate, --apply seeds named accounts and memberships.
// Matching uses the tightened confidentChMatch, never the old containment
// rule, because the register learned that lesson live; anything not
// confident seeds unmatched by name, for the amend form and the site probe.
// Names the directory carries whose UK entity is unverified stay in the
// draft's hold table and are never seeded by this script.
//
// What this never does: no leads, no contacts, no scoring, nothing sent,
// and a field a human has set is never overwritten.

const ENTRIES = [
  // The supplier tier: buyers of flow control as components. Untyped on
  // purpose, the DC campaign's ICP types do not score suppliers; they ride
  // as named accounts the way Excool and Flakt Woods already do.
  { name: 'Airedale International Air Conditioning', type: null, campaigns: ['marwin_dc'], note: 'Airedale by Modine, Leeds; data centre cooling manufacturer, the standout UK name in the directory' },
  { name: 'STULZ UK', type: null, campaigns: ['marwin_dc'], note: 'precision cooling' },
  { name: 'Munters', type: null, campaigns: ['marwin_dc'], note: 'cooling and air management' },
  { name: 'Alfa Laval', type: null, campaigns: ['marwin_dc'], note: 'heat exchangers; may already be held, a re-run updates rather than duplicates' },
  { name: 'SPX Cooling Technologies UK', type: null, campaigns: ['marwin_dc'], note: 'the cooling-tower Marley brand sits here, which is also the answer to the MARLEY LIMITED question on the register' },
  { name: 'Danfoss', type: null, campaigns: ['marwin_dc'], note: 'pumps, drives and thermal components in the liquid cooling tier' },
  // Mission-critical contractors with UK businesses.
  { name: 'EMCOR UK', type: 'me_contractor', campaigns: ['marwin_dc'], note: 'critical environments M&E and facilities' },
  { name: 'Exyte', type: 'me_contractor', campaigns: ['marwin_dc', 'pharma_steriflow'], note: 'data centre builder and one of the biggest pharma cleanroom EPCs in Europe; the one dual-campaign catch' },
  // Consultants, extending the specification lane the VIRTUS reply opened.
  { name: 'AECOM', type: 'consultant', campaigns: ['marwin_dc'], note: 'UK design practice; also where Mark Quest re-homes' },
  { name: 'Jacobs UK', type: 'consultant', campaigns: ['marwin_dc'], note: 'UK engineering practice' },
  { name: 'Stantec UK', type: 'consultant', campaigns: ['marwin_dc'], note: 'UK engineering practice' },
  { name: 'Introba', type: 'consultant', campaigns: ['marwin_dc'], note: 'formerly Elementa; building services design' },
];

// Named in the directory, UK entity unverified. These go in the draft for
// curation and are deliberately not seeded: a named account with no real UK
// entity would spend discovery on nothing.
const HOLD = [
  'Boyd (liquid cooling and thermal; UK operations to verify)',
  'Chart Industries (data centre cooling; UK presence likely via Howden, verify the entity)',
  'Motivair (CDU maker, now under Schneider Electric; UK entity to verify)',
  'CoolIT Systems (direct-to-chip; European presence, UK entity to verify)',
  'Baltimore Aircoil (cooling towers; UK entity to verify)',
  'EVAPCO (cooling towers; European arms, UK entity to verify)',
  'M.C. Dean (mission critical electrical; London office, UK entity to verify)',
  'Syska Hennessy (mission critical engineering; London office, UK entity to verify)',
];

const APPLY = process.argv.includes('--apply');

const rows = [];
for (const e of ENTRIES) {
  const entry = { ...e, chNumber: null, postcode: null, region: null, verdict: 'none' };
  try {
    const outcome = confidentChMatch(e.name, await searchCompanies(e.name));
    entry.verdict = outcome.status;
    if (outcome.status === 'matched') {
      entry.chNumber = outcome.match.chNumber;
      entry.postcode = outcome.match.postcode;
      entry.name = outcome.match.name;
    }
  } catch (err) { console.log(`  CH search failed for ${e.name}: ${String(err.message).slice(0, 100)}`); }
  entry.region = regionForPostcode(entry.postcode);
  rows.push(entry);
  console.log(`  ${entry.chNumber ? 'matched ' : entry.verdict.padEnd(8)} ${entry.name}  [${e.type || 'untyped'}; ${e.campaigns.join(', ')}]`);
}

const matched = rows.filter(r => r.chNumber).length;
const md = `# The ecosystem harvest, first draft

From the Olajuwon data centre ecosystem directory, forwarded by James,
16 August 2026. For John and James to curate: strike through anything that
does not belong, correct names, and promote hold names once their UK entity
is confirmed. Seeded rows enter the register as named accounts on the listed
campaigns; suppliers ride untyped, contractors and consultants typed.
Generated ${new Date().toISOString().slice(0, 10)}; ${rows.length} seeds, ${matched} matched to Companies House.

| Company | Lane | Campaigns | CH number | Region | Note |
| --- | --- | --- | --- | --- | --- |
${rows.map(r => `| ${r.name} | ${r.type || 'supplier, untyped'} | ${r.campaigns.join(', ')} | ${r.chNumber || r.verdict} | ${r.region || ''} | ${r.note} |`).join('\n')}

## Hold: named in the directory, UK entity unverified, not seeded

${HOLD.map(h => `- ${h}`).join('\n')}
`;
await writeFile(new URL('../ECOSYSTEM_DRAFT.md', import.meta.url), md);
console.log(`\nWrote ECOSYSTEM_DRAFT.md: ${rows.length} seeds, ${matched} CH-matched, ${HOLD.length} on hold.`);

if (!APPLY) {
  console.log('Dry run. Nothing written to the register. Curate the draft, then re-run with --apply.');
  await pool.end();
  process.exit(0);
}

let created = 0, updated = 0;
for (const r of rows) {
  // Reconcile by CH number first, then name, so re-runs update rather than
  // duplicate, and a human's correction is never overwritten.
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
         company_type = COALESCE(company_type, $2),
         ch_number = COALESCE(ch_number, $3),
         region = COALESCE(region, $4), postcode = COALESCE(postcode, $5), updated_at = now()
       WHERE id = $1`,
      [existingId, r.type, r.chNumber, r.region, r.postcode]);
    updated++;
  } else {
    const { rows: ins } = await pool.query(
      `INSERT INTO companies (name, ch_number, company_type, region, postcode, named_account, source)
       VALUES ($1, $2, $3, $4, $5, true, 'seed_ecosystem') RETURNING id`,
      [r.name, r.chNumber, r.type, r.region, r.postcode]);
    companyId = ins[0].id;
    created++;
  }
  for (const c of r.campaigns) {
    await pool.query(
      `INSERT INTO company_campaigns (company_id, campaign) VALUES ($1, $2)
       ON CONFLICT (company_id, campaign) DO NOTHING`, [companyId, c]);
  }
}
console.log(`\nApplied: ${created} created, ${updated} updated across the listed campaigns.`);
console.log('The next research run scores them; the matcher walk and the site probe resolve the unmatched.');
await pool.end();
