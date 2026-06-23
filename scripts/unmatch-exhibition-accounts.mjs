import { pool } from '../src/db.mjs';
import { scoreCompany } from '../src/research/icp.mjs';

// One-off cleanup for the exhibition seed's wrong Companies House matches. The
// brand names are short, so the matcher attached some unrelated registered
// companies and pulled their directors. This un-matches a company: it removes
// the contacts pulled from the wrong entity, clears the Companies House number,
// profile, domain and postcode, re-scores it, and leaves it as a clean,
// unmatched named account for Andy to point at the right company.
//
// Only touches source = 'exhibition' rows, and is a dry run unless --apply.
// Add Andy's later confirmations as arguments, a CH number or an exact stored
// name, rather than editing the list:
//
//   node scripts/unmatch-exhibition-accounts.mjs            (dry run)
//   node scripts/unmatch-exhibition-accounts.mjs --apply
//   node scripts/unmatch-exhibition-accounts.mjs --apply "MARLEY LIMITED" 03378613

const APPLY = process.argv.includes('--apply');
const extra = process.argv.slice(2).filter(a => a !== '--apply');

// The clearly wrong matches from the first run, by Companies House number, with
// the brand and the wrong entity noted so this stays readable.
const WRONG = [
  { brand: 'Trane',   ch: '13730907', wrong: 'TRANE FARM INVESTMENTS LTD' },
  { brand: 'Elevate', ch: '16493295', wrong: 'E&G ELEVATED DRONES LIMITED' },
  { brand: 'Airdale', ch: '15671942', wrong: 'AIRDALE IMMIGRATION CONSULTANT LTD' },
];

const targets = [];
for (const w of WRONG) {
  const { rows } = await pool.query(
    `SELECT id, name, ch_number FROM companies WHERE source = 'exhibition' AND ch_number = $1`, [w.ch]);
  if (rows[0]) targets.push({ ...rows[0], brand: w.brand, rename: w.brand });
  else console.log(`  not found, already cleaned or never matched: ${w.brand} (${w.ch})`);
}
for (const a of extra) {
  const { rows } = await pool.query(
    `SELECT id, name, ch_number FROM companies WHERE source = 'exhibition' AND (ch_number = $1 OR lower(name) = lower($1))`, [a]);
  if (rows[0]) targets.push({ ...rows[0], brand: a, rename: null });
  else console.log(`  not found among exhibition accounts: ${a}`);
}

for (const t of targets) {
  const { rows: [{ n: dir }] } = await pool.query(
    `SELECT count(*)::int AS n FROM contacts WHERE company_id = $1 AND source = 'ch_officers'`, [t.id]);
  const renameNote = t.rename && t.rename.toLowerCase() !== t.name.toLowerCase() ? `, rename to "${t.rename}"` : '';
  console.log(`${APPLY ? 'un-matching' : 'would un-match'} "${t.name}" (was ${t.brand}): clear CH ${t.ch_number}, remove ${dir} register director(s)${renameNote}`);
  if (!APPLY) continue;
  await pool.query(`DELETE FROM contacts WHERE company_id = $1 AND source = 'ch_officers'`, [t.id]);
  await pool.query(
    `UPDATE companies SET name = COALESCE($2, name), ch_number = NULL, ch_profile = NULL,
       domain = NULL, postcode = NULL, region = NULL, updated_at = now() WHERE id = $1`,
    [t.id, t.rename]);
  const { rows: [co] } = await pool.query(`SELECT * FROM companies WHERE id = $1`, [t.id]);
  const { score, breakdown } = scoreCompany(co, []);
  await pool.query(`UPDATE companies SET icp_score = $1, icp_breakdown = $2::jsonb, updated_at = now() WHERE id = $3`,
    [score, JSON.stringify(breakdown), t.id]);
}

console.log(`\n${APPLY ? 'Cleaned' : 'Would clean'} ${targets.length} wrong match(es).${APPLY ? '' : ' Re-run with --apply to write.'}`);
console.log('They stay as named accounts, now unmatched, ready for Andy to point at the right company.');
await pool.end();
