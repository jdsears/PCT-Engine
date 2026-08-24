import { pool } from '../src/db.mjs';
import { recipientMismatch } from '../src/outbound/draft.mjs';

// The pool sweep, John's build of 24 August 2026, after four blocked cards in
// one afternoon: contacts attached by the old loose people search are still
// in the pool, and the draft gate can only flag them one card at a time as
// they surface. This asks every orbit contact the same recipient-truth
// question the gate asks, namesake, stated employer, foreign mailbox, in one
// pass, so the backlog clears in one decision instead of forty clicks.
//
// Dry by default: it prints what it would do and touches nothing. --apply
// suppresses the mismatched contacts with provenance on the row (the same
// shape the studio's suppress verb writes, reversible only by hand) and
// rejects their open drafts, which is what empties the blocked queue. It
// never deletes anything, never touches a confirmed contact (the nets stand
// aside for a recorded attestation), and never suppresses a contact in a
// live conversation: a person who has replied is a person, whatever their
// stored record says, and their card is a human's to judge.
//
// Usage: node --env-file=.env scripts/sweep-mismatched-contacts.mjs [--apply]

const APPLY = process.argv.includes('--apply');

const { rows } = await pool.query(
  `SELECT ct.id, ct.full_name, ct.role_title, ct.email,
          ct.payload->'recipient_confirmed' IS NOT NULL AS confirmed,
          c.name AS company, c.domain,
          EXISTS (
            SELECT 1 FROM outbound_drafts d JOIN leads l ON l.id = d.lead_id
            WHERE d.contact_id = ct.id
              AND (l.stage IN ('replied', 'handed_off')
                   OR EXISTS (SELECT 1 FROM outbound_replies r WHERE r.draft_id = d.id
                              AND (r.category IS NULL OR r.category NOT IN ('bounce', 'out_of_office'))))
          ) AS live,
          (SELECT count(*)::int FROM outbound_drafts d
           WHERE d.contact_id = ct.id AND d.status IN ('draft', 'approved')) AS open_drafts
   FROM contacts ct JOIN companies c ON c.id = ct.company_id
   WHERE ct.in_decision_orbit AND NOT ct.suppressed AND NOT ct.rehearsal
   ORDER BY c.name, ct.full_name`);

console.log(`Recipient-truth sweep over ${rows.length} orbit contact(s).${APPLY ? '' : ' Dry run: nothing changes without --apply.'}\n`);

const toSuppress = [];
let liveHeld = 0;
let openDrafts = 0;
for (const r of rows) {
  const nets = recipientMismatch(
    { name: r.full_name, role: r.role_title, email: r.email, confirmed: !!r.confirmed },
    { name: r.company, domain: r.domain });
  if (!nets.length) continue;
  const what = nets.map(n => (n.match(/^blocking: ([a-z ]+),/) || [])[1] || 'recipient').join(' + ');
  if (r.live) {
    liveHeld++;
    console.log(`  HELD, live conversation: ${r.full_name} on ${r.company}  [${what}]`);
    continue;
  }
  toSuppress.push({ ...r, reason: nets[0] });
  openDrafts += r.open_drafts;
  console.log(`  ${r.full_name}  <${r.email || 'no email'}>  on ${r.company}  [${what}]${r.open_drafts ? `  ${r.open_drafts} open draft(s)` : ''}`);
}

console.log(`\n${toSuppress.length} mismatched contact(s) to suppress, ${openDrafts} open draft(s) to reject` +
  `${liveHeld ? `, ${liveHeld} held for a human because their conversation is live` : ''}.`);

if (!APPLY) {
  if (toSuppress.length) console.log('Run again with --apply to suppress them and clear their drafts.');
  else console.log('Nothing to do. The pool is clean.');
  await pool.end();
  process.exit(0);
}

for (const r of toSuppress) {
  await pool.query(
    `UPDATE contacts SET suppressed = true,
       payload = COALESCE(payload, '{}'::jsonb) || $2::jsonb
     WHERE id = $1 AND NOT suppressed`,
    [r.id, JSON.stringify({ suppressed: { at: new Date().toISOString(), by: 'recipient sweep', reason: String(r.reason).slice(0, 200) } })]);
}
const { rowCount: rejected } = toSuppress.length
  ? await pool.query(
      `UPDATE outbound_drafts SET status = 'rejected', decided_by = 'recipient sweep'
       WHERE contact_id = ANY($1) AND status IN ('draft', 'approved')`,
      [toSuppress.map(r => r.id)])
  : { rowCount: 0 };

console.log(`\nApplied: ${toSuppress.length} contact(s) suppressed with provenance, ${rejected} open draft(s) rejected.`);
console.log('Suppression is reversible only by hand, which is the point. The nets and the selection screen stop the pool refilling.');
await pool.end();
