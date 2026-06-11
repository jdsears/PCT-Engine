import { pool } from '../src/db.mjs';
import { inOrbit } from '../src/research/orbitRules.mjs';

// Re-marks the decision orbit from the titles already on file, with no external
// calls. Run it after editing the orbit titles in src/research/orbitRules.mjs,
// so a tuning change reaches the contacts already discovered without waiting
// for the thirty-day freshness window or spending a Unipile call.
//
// The orbit flag is recomputed from role_title for every non-suppressed
// contact, the one definition used across the engine. Dry run by default: it
// prints what would change. Run with --apply to write it.

const APPLY = process.argv.includes('--apply');

const { rows: contacts } = await pool.query(
  `SELECT c.id, c.full_name, c.role_title, c.in_decision_orbit, c.source, co.name AS company
   FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
   WHERE NOT c.suppressed`);

const toTrue = [], toFalse = [];
for (const c of contacts) {
  const want = inOrbit(c.role_title) === true;
  if (want === c.in_decision_orbit) continue;
  (want ? toTrue : toFalse).push(c);
}

const sample = (rows, n = 8) => rows.slice(0, n)
  .map(c => `  ${c.full_name} (${c.company || 'no company'}): "${c.role_title || 'no title'}"`);

console.log(`${APPLY ? 'Re-marking' : 'Dry run'} the decision orbit from stored titles.`);
console.log(`Contacts considered: ${contacts.length}`);
console.log(`Would enter the orbit: ${toTrue.length}`);
for (const line of sample(toTrue)) console.log(line);
if (toTrue.length > 8) console.log(`  ... and ${toTrue.length - 8} more`);
console.log(`Would leave the orbit: ${toFalse.length}`);
for (const line of sample(toFalse)) console.log(line);
if (toFalse.length > 8) console.log(`  ... and ${toFalse.length - 8} more`);

if (APPLY && (toTrue.length || toFalse.length)) {
  const ids = rows => rows.map(c => c.id);
  if (toTrue.length) {
    await pool.query(`UPDATE contacts SET in_decision_orbit = true WHERE id = ANY($1)`, [ids(toTrue)]);
  }
  if (toFalse.length) {
    await pool.query(`UPDATE contacts SET in_decision_orbit = false WHERE id = ANY($1)`, [ids(toFalse)]);
  }
  const { rows: [{ n }] } = await pool.query(
    `SELECT count(*)::int AS n FROM contacts WHERE in_decision_orbit AND NOT suppressed`);
  console.log(`\nApplied. In the decision orbit now: ${n}.`);
} else if (!APPLY) {
  console.log(`\nDry run only. Re-run with --apply to write these changes.`);
} else {
  console.log(`\nNothing to change.`);
}

await pool.end();
