import { pool } from '../src/db.mjs';
import { pairDuplicates } from '../src/research/duplicateAccounts.mjs';

// Cleanup for duplicated named accounts: a row with no Companies House number
// alongside its CH-matched twin. It pairs them by normalised name, moves every
// dependant across, and removes the unmatched row and its lead.
//
// Written first for the seed runs, and brought up to the current schema after a
// live duplicate the confirm queue produced: a first confirm created the
// registered row and linked the signal, then failed on a missing column and
// left the review open; a second confirm, made without re-picking the entity,
// created a second row under the printed name with no number and no signal.
// The transaction in the confirm route now prevents that shape, but the pair it
// left behind still needs merging.
//
// Every table that references companies is handled, which the first version did
// not: outbound_drafts, company_campaigns and party_reviews were all added
// after it was written, and party_reviews, outbound_drafts and the contractor
// side of signals have no cascade, so a delete would simply have failed on a
// foreign key. Cross-checked against every REFERENCES companies(id) in the
// migrations.
//
// Dry run by default: it prints what it would do. --apply does it. --id <n>
// restricts the run to one duplicate row, which is the safe way to fix a single
// known pair without touching anything else.

const APPLY = process.argv.includes('--apply');
const idAt = process.argv.indexOf('--id');
const ONLY_ID = idAt !== -1 ? String(parseInt(process.argv[idAt + 1], 10)) : null;
if (idAt !== -1 && !ONLY_ID) {
  console.error('usage: node scripts/merge-duplicate-accounts.mjs [--id <duplicate company id>] [--apply]');
  process.exit(1);
}
const norm = (s) => String(s || '').toLowerCase().replace(/\b(ltd|limited|plc|llp|uk|group|holdings)\b/g, '').replace(/[^a-z0-9]/g, '');

const { rows: accounts } = await pool.query(
  `SELECT id, name, ch_number FROM companies WHERE named_account ORDER BY id`);
const matched = accounts.filter(a => a.ch_number);
const unmatched = accounts.filter(a => !a.ch_number);

// Pairing is the dangerous half of this script, so it lives in a tested module
// rather than here. See duplicateAccounts.mjs for what the old rule did to four
// real operators on the live register.
const { pairs, leftovers, contested } = pairDuplicates(accounts);

// With --id, only that duplicate is merged. Everything else is listed and left
// alone, so a single known pair can be fixed without a broad sweep.
const scoped = ONLY_ID ? pairs.filter(p => String(p.u.id) === ONLY_ID) : pairs;
if (ONLY_ID && !scoped.length) {
  console.error(`No duplicate pair found for company id ${ONLY_ID}. It may already be merged, or it may have no CH-matched twin.`);
  await pool.end();
  process.exit(1);
}

console.log(`Named accounts: ${accounts.length} total, ${matched.length} CH-matched, ${unmatched.length} unmatched.`);
console.log(`\nDuplicate pairs found: ${pairs.length}${ONLY_ID ? `, merging 1 (--id ${ONLY_ID})` : ''}`);
for (const { u, m } of pairs) {
  const mark = ONLY_ID ? (String(u.id) === ONLY_ID ? '  MERGE' : '  skip ') : '  ';
  console.log(`${mark}"${u.name}" (id ${u.id})  ->  "${m.name}" (${m.ch_number}, id ${m.id})`);
}
console.log(`\nUnmatched rows kept, no confident twin: ${leftovers.length}`);
for (const u of leftovers) console.log(`  - ${u.name}`);
if (contested.length) {
  console.log(`\nContested, left for a human: ${contested.length}`);
  for (const c of contested) {
    console.log(`  "${c.twin.name}" is claimed by ${c.claimants.length}: ${c.claimants.map(x => `"${x.name}"`).join(', ')}`);
  }
}

if (!APPLY) {
  console.log('\nDry run only. Review the pairs above, then run with --apply to merge.');
  await pool.end();
  process.exit(0);
}

let leadsRemoved = 0, companiesRemoved = 0;
for (const { u, m } of scoped) {
  // One transaction per pair, so a failure leaves the pair as it was rather
  // than half moved.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Both sides of a signal's linkage, since a duplicate may be the
    // contractor on one story and the operator on another.
    await client.query(`UPDATE signals SET company_id = $1 WHERE company_id = $2`, [m.id, u.id]);
    await client.query(`UPDATE signals SET contractor_company_id = $1 WHERE contractor_company_id = $2`, [m.id, u.id]);
    await client.query(`UPDATE contacts SET company_id = $1 WHERE company_id = $2`, [m.id, u.id]);
    // Drafts follow their company. Their lead is repointed below, and the
    // one-open-draft-per-lead index is on lead and campaign, not company, so
    // moving them cannot collide.
    await client.query(`UPDATE outbound_drafts SET company_id = $1 WHERE company_id = $2`, [m.id, u.id]);
    // Campaign membership is a composite key, so the survivor keeps what it has
    // and gains anything only the duplicate had.
    await client.query(
      `INSERT INTO company_campaigns (company_id, campaign, score, score_reason)
       SELECT $1, campaign, score, score_reason FROM company_campaigns WHERE company_id = $2
       ON CONFLICT (company_id, campaign) DO NOTHING`, [m.id, u.id]);
    await client.query(`DELETE FROM company_campaigns WHERE company_id = $1`, [u.id]);
    // The review that produced the duplicate now points at the surviving row,
    // so the decision it records stays true.
    await client.query(`UPDATE party_reviews SET company_id = $1 WHERE company_id = $2`, [m.id, u.id]);
    const { rowCount: l } = await client.query(`DELETE FROM leads WHERE company_id = $1`, [u.id]);
    leadsRemoved += l;
    await client.query(`DELETE FROM companies WHERE id = $1`, [u.id]);
    await client.query('COMMIT');
    companiesRemoved++;
    console.log(`  merged "${u.name}" (${u.id}) into "${m.name}" (${m.id})${l ? `, ${l} duplicate lead(s) removed` : ''}`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`  FAILED to merge "${u.name}" (${u.id}): ${String(e.message).slice(0, 200)}`);
  } finally {
    client.release();
  }
}
console.log(`\nMerged: ${companiesRemoved} duplicate companies removed, ${leadsRemoved} duplicate leads removed.`);
console.log('Re-run scripts/research-run.mjs to refresh scores over the cleaned table.');
await pool.end();
