import { pool, hasColumn } from '../src/db.mjs';

// Clears the open follow-up drafts in one act, John's ask of 18 August 2026,
// with thirty-two break-ups queued that were drafted before the sweeper was
// pinned to each thread's contact. Rejecting is the safe verb: nothing
// sends, the leads keep their sent history, and the next sweeps redraft
// each due follow-up under the fixed rules, pinned to the thread's person,
// with the thread's truth shown on the card. Run this AFTER the fix has
// deployed, or the old code simply redrafts the same drift.
//
//   node --env-file=.env scripts/reject-open-followups.mjs           (dry run)
//   node --env-file=.env scripts/reject-open-followups.mjs --apply
//
// What this never does: send anything, touch sent drafts, or delete a row.

const APPLY = process.argv.includes('--apply');
const { rows } = await pool.query(
  `SELECT d.id, d.sequence_step, c.name AS company, ct.full_name AS recipient, d.body
   FROM outbound_drafts d
   JOIN companies c ON c.id = d.company_id
   LEFT JOIN contacts ct ON ct.id = d.contact_id
   WHERE d.email_type = 'followup' AND d.status IN ('draft', 'approved')
   ORDER BY c.name, d.sequence_step`);

console.log(`${rows.length} open follow-up draft(s).`);
for (const r of rows) {
  const greeted = String(r.body || '').trimStart().match(/^(?:dear\s+|hi\s+|hello\s+)?([A-Za-z][\w'-]*)\s*,/i)?.[1] || null;
  const first = String(r.recipient || '').trim().split(/\s+/)[0] || '';
  const drift = greeted && first && greeted.toLowerCase() !== first.toLowerCase();
  console.log(`  #${r.id} ${r.company}  step ${r.sequence_step ?? '?'}  to ${r.recipient || 'unknown'}${greeted ? `, greets ${greeted}` : ''}${drift ? '  <- DRIFTED' : ''}`);
}
if (!rows.length) { await pool.end(); process.exit(0); }

if (!APPLY) {
  console.log('\nDry run. Nothing rejected. Re-run with --apply to reject them all;');
  console.log('the sweeps then redraft each due follow-up under the pinned rules.');
  await pool.end();
  process.exit(0);
}

const actor = (await hasColumn('outbound_drafts', 'decided_by')) ? `, decided_by = 'reject-open-followups script'` : '';
const { rowCount } = await pool.query(
  `UPDATE outbound_drafts SET status = 'rejected'${actor}
   WHERE email_type = 'followup' AND status IN ('draft', 'approved')`);
console.log(`\nRejected ${rowCount}. Nothing was sent. The next sweeps redraft the due ones, pinned to their threads.`);
await pool.end();
