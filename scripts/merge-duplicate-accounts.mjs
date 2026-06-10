import { pool } from '../src/db.mjs';

// One-off cleanup for the duplicated named accounts. The first seed run, made
// while the Companies House key was failing, stored rows under the candidate
// names with no CH number; the second run stored the same companies again
// under their registry names. This pairs each unmatched named account with its
// CH-matched twin by normalised name, moves any dependants across, and removes
// the unmatched row and its lead.
//
// Dry run by default: it prints what it would do. Run with --apply to do it.

const APPLY = process.argv.includes('--apply');
const norm = (s) => String(s || '').toLowerCase().replace(/\b(ltd|limited|plc|llp|uk|group|holdings)\b/g, '').replace(/[^a-z0-9]/g, '');

const { rows: accounts } = await pool.query(
  `SELECT id, name, ch_number FROM companies WHERE named_account ORDER BY id`);
const matched = accounts.filter(a => a.ch_number);
const unmatched = accounts.filter(a => !a.ch_number);

const pairs = [];
const leftovers = [];
for (const u of unmatched) {
  const nu = norm(u.name);
  if (nu.length < 4) { leftovers.push(u); continue; }
  // Prefer an exact normalised match, then containment either way.
  const twin = matched.find(m => norm(m.name) === nu)
    || matched.find(m => { const nm = norm(m.name); return nm.length >= 4 && (nm.includes(nu) || nu.includes(nm)); });
  if (twin) pairs.push({ u, m: twin });
  else leftovers.push(u);
}

console.log(`Named accounts: ${accounts.length} total, ${matched.length} CH-matched, ${unmatched.length} unmatched.`);
console.log(`\nDuplicate pairs found: ${pairs.length}`);
for (const { u, m } of pairs) console.log(`  "${u.name}" (id ${u.id})  ->  "${m.name}" (${m.ch_number})`);
console.log(`\nUnmatched rows kept, no twin found: ${leftovers.length}`);
for (const u of leftovers) console.log(`  - ${u.name}`);

if (!APPLY) {
  console.log('\nDry run only. Review the pairs above, then run with --apply to merge.');
  await pool.end();
  process.exit(0);
}

let leadsRemoved = 0, companiesRemoved = 0;
for (const { u, m } of pairs) {
  // Move any dependants to the surviving row before deleting, defensively;
  // first-seed rows should have none.
  await pool.query(`UPDATE signals SET company_id = $1 WHERE company_id = $2`, [m.id, u.id]);
  await pool.query(`UPDATE contacts SET company_id = $1 WHERE company_id = $2`, [m.id, u.id]);
  const { rowCount: l } = await pool.query(`DELETE FROM leads WHERE company_id = $1`, [u.id]);
  leadsRemoved += l;
  await pool.query(`DELETE FROM companies WHERE id = $1`, [u.id]);
  companiesRemoved++;
}
console.log(`\nMerged: ${companiesRemoved} duplicate companies removed, ${leadsRemoved} duplicate leads removed.`);
console.log('Re-run scripts/research-run.mjs to refresh scores over the cleaned table.');
await pool.end();
