import { pool } from '../src/db.mjs';
import { companyTypeForParty } from '../src/research/partyType.mjs';
import { scoreCompany } from '../src/research/icp.mjs';

// Backfill company_type for accounts confirmed through the review queue before
// the type was set on confirm.
//
// Those accounts scored exactly 35 against a lead threshold of 40: named
// account 25, type fit 0, signals 0, Companies House health 10 as the neutral
// value for an uncached profile. So the queue could add an account but never
// produce a lead from it, which is what the queue is for. The party the review
// recorded says what each one is, and the campaign says what that party means.
//
// Dry run by default, showing the score each account moves from and to, with
// the component breakdown so a surprise is visible rather than assumed. Only
// company_type is written, and only where it is currently null, so an account a
// human has typed is never touched. Run scripts/research-run.mjs afterwards to
// rescore and let the survivors become leads.

const APPLY = process.argv.includes('--apply');

// Every company created by a confirmed proposal that still has no type, with
// the review that produced it.
const { rows } = await pool.query(
  `SELECT c.id, c.name, c.company_type, c.icp_score, c.ch_profile, c.named_account,
          r.party, r.campaign
   FROM companies c
   JOIN party_reviews r ON r.company_id = c.id AND r.status IN ('confirmed', 'merged')
   WHERE c.company_type IS NULL
   ORDER BY c.name`);

if (!rows.length) {
  console.log('No confirmed accounts are missing a company type. Nothing to do.');
  await pool.end();
  process.exit(0);
}

const report = { total: rows.length, typed: 0, crossed: 0, unchanged: 0, noMapping: 0 };
for (const c of rows) {
  const type = companyTypeForParty(c.campaign, c.party);
  if (!type) {
    report.noMapping++;
    console.log(`  [no mapping] ${c.name}: campaign ${c.campaign} declares no type for party ${c.party}`);
    continue;
  }
  // Score as the engine would, before and after, using this company's own
  // signals so the figures are the real ones rather than an estimate.
  const { rows: signals } = await pool.query(
    `SELECT * FROM signals WHERE (company_id = $1 OR contractor_company_id = $1) AND campaign = $2`,
    [c.id, c.campaign]);
  const before = scoreCompany({ ...c, company_type: null }, signals, null, c.campaign).score;
  const after = scoreCompany({ ...c, company_type: type }, signals, null, c.campaign).score;
  const threshold = Number(process.env.RESEARCH_LEAD_THRESHOLD || 40);
  const crosses = before < threshold && after >= threshold;
  if (crosses) report.crossed++;
  if (after > before) report.typed++; else report.unchanged++;
  console.log(`  ${c.name}: ${c.party} on ${c.campaign} -> ${type}   score ${before} to ${after}` +
    `${crosses ? `  (crosses the ${threshold} threshold)` : ''}` +
    `${signals.length === 0 ? '   [no signals linked]' : `   [${signals.length} signal(s)]`}`);
  if (APPLY) {
    await pool.query(
      `UPDATE companies SET company_type = $2, updated_at = now() WHERE id = $1 AND company_type IS NULL`,
      [c.id, type]);
  }
}

console.log('\n=== Confirmed accounts missing a company type ===');
console.log(`Found: ${report.total}   Typed: ${report.typed}   Already at the same score: ${report.unchanged}   No mapping: ${report.noMapping}`);
console.log(`Would cross the lead threshold: ${report.crossed}`);
if (!APPLY) console.log('Dry run, no writes. Re-run with --apply to persist (only company_type changes, and only where it is null).');
else console.log('Applied. Run scripts/research-run.mjs next to rescore and create the leads.');
await pool.end();
