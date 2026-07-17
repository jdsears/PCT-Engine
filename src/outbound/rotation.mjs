import { pool } from '../db.mjs';
import { maxSequenceSteps } from './followups.mjs';

// Contact rotation: when a sequence is spent, the final touch sent, the rest
// period passed, and not a word back, the lead points at the company's
// next-best specifier and re-enters the drafting pool for a fresh thread.
// One thread at a time per company, never the same person twice, and a hard
// cap on how many people are approached before the account rests for good.
// The guardrails are deliberate: emailing colleagues simultaneously reads as
// a campaign the moment two of them compare inboxes.

export const rotateCooldownDays = () => {
  const n = parseInt(process.env.ROTATE_COOLDOWN_DAYS || '10', 10);
  return Math.max(1, Math.min(60, Number.isNaN(n) ? 10 : n));
};
export const rotateMaxContacts = () => {
  const n = parseInt(process.env.ROTATE_MAX_CONTACTS || '3', 10);
  return Math.max(1, Math.min(5, Number.isNaN(n) ? 3 : n));
};

export async function rotateContacts({ log = () => {} } = {}) {
  // Spent sequences: still at outbound, final step sent, cooldown passed, no
  // real reply anywhere on the lead (a bounce or an away reply is not
  // engagement), nothing open in the queue.
  const { rows } = await pool.query(
    `SELECT l.id AS lead_id, l.company_id,
            (SELECT count(DISTINCT x.contact_id)::int FROM outbound_drafts x
             WHERE x.lead_id = l.id AND x.status = 'sent' AND x.contact_id IS NOT NULL) AS contacts_tried
     FROM leads l
     JOIN LATERAL (
       SELECT sent_at, sequence_step FROM outbound_drafts
       WHERE lead_id = l.id AND status = 'sent' AND sent_at IS NOT NULL
       ORDER BY sent_at DESC LIMIT 1
     ) d ON true
     WHERE l.stage = 'outbound' AND l.campaign <> 'rehearsal'
       AND (l.snoozed_until IS NULL OR l.snoozed_until < now())
       AND d.sequence_step >= $1
       AND d.sent_at < now() - make_interval(days => $2)
       AND NOT EXISTS (SELECT 1 FROM outbound_replies r JOIN outbound_drafts od ON od.id = r.draft_id
                       WHERE od.lead_id = l.id
                         AND (r.category IS NULL OR r.category NOT IN ('bounce', 'out_of_office')))
       AND NOT EXISTS (SELECT 1 FROM outbound_drafts o WHERE o.lead_id = l.id AND o.status IN ('draft', 'approved'))`,
    [maxSequenceSteps(), rotateCooldownDays()]);

  const report = { spent: rows.length, rotated: 0, rested: 0, waitingContact: 0 };
  for (const t of rows) {
    if (t.contacts_tried >= rotateMaxContacts()) { report.rested++; continue; }
    // The next-best specifier not yet written to: same ranking the drafter
    // uses, verified email first, and only contacts with a live address.
    const next = (await pool.query(
      `SELECT id, full_name FROM contacts
       WHERE company_id = $1 AND in_decision_orbit AND NOT suppressed AND NOT rehearsal
         AND email IS NOT NULL AND email_bounced_at IS NULL
         AND id NOT IN (SELECT contact_id FROM outbound_drafts WHERE lead_id = $2 AND contact_id IS NOT NULL)
       ORDER BY email_verified_at IS NULL, email_confidence DESC NULLS LAST LIMIT 1`,
      [t.company_id, t.lead_id])).rows[0];
    if (!next) { report.waitingContact++; continue; }
    await pool.query(
      `UPDATE leads SET contact_id = $2, stage = 'researched', updated_at = now() WHERE id = $1`,
      [t.lead_id, next.id]);
    report.rotated++;
    log(`lead ${t.lead_id}: sequence spent, rotating to ${next.full_name}; the drafting pool takes it from here`);
  }
  return report;
}
