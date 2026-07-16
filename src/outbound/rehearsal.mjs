import { pool } from '../db.mjs';
import { isTestRecipient } from '../mail.mjs';

// The rehearsal lane: the full conversation journey, send, reply, triage,
// response, follow-ups, meeting, handoff, exercised on cloned rows so a
// teammate can play the prospect from their own inbox. Isolation is by data,
// not by branches: a rehearsal clones a real draft onto a rehearsal lead with
// a stand-in contact, tagged campaign 'rehearsal' end to end, and then the
// production code path runs unmodified. What you rehearse is what will happen
// live. The real lead, its draft and its contact are never touched, so going
// live starts exactly where it would have anyway, and ending the rehearsal
// deletes every tagged row.

// Clone one reviewable cold open onto a rehearsal lead addressed to an
// internal teammate. The recipient must be on the internal allowlist, the same
// list test sends use; the kill switch keeps blocking everyone else.
export async function startRehearsal({ draftId = null, to }) {
  const addr = String(to || '').trim().toLowerCase();
  if (!isTestRecipient(addr)) return { started: false, reason: 'the stand-in address must be on the internal test allowlist' };

  const d = (await pool.query(
    draftId
      ? `SELECT id, lead_id, company_id, subject, body, grounding, grounding_flags, rationale, model
         FROM outbound_drafts WHERE id = $1 AND campaign <> 'rehearsal' AND email_type = 'cold_open' AND status IN ('draft','approved')`
      : `SELECT id, lead_id, company_id, subject, body, grounding, grounding_flags, rationale, model
         FROM outbound_drafts WHERE campaign <> 'rehearsal' AND email_type = 'cold_open' AND status IN ('draft','approved')
         ORDER BY created_at DESC LIMIT 1`,
    draftId ? [draftId] : [])).rows[0];
  if (!d) return { started: false, reason: draftId ? 'no open cold-open draft with that id' : 'no open cold-open draft to rehearse with; generate drafts first' };
  const flags = Array.isArray(d.grounding_flags) ? d.grounding_flags : [];
  if (flags.some(f => /^blocking/i.test(String(f)))) {
    return { started: false, reason: 'that draft carries a blocking flag; rehearse with a clean one' };
  }

  const contact = (await pool.query(
    `INSERT INTO contacts (company_id, full_name, role_title, email, in_decision_orbit, rehearsal)
     VALUES ($1, $2, 'Rehearsal stand-in', $3, false, true) RETURNING id`,
    [d.company_id, `Rehearsal prospect (${addr.split('@')[0]})`, addr])).rows[0];
  const lead = (await pool.query(
    `INSERT INTO leads (company_id, contact_id, stage, campaign, score, region)
     SELECT company_id, $2, 'researched', 'rehearsal', score, region FROM leads WHERE id = $1
     RETURNING id`, [d.lead_id, contact.id])).rows[0];
  const clone = (await pool.query(
    `INSERT INTO outbound_drafts (lead_id, company_id, contact_id, campaign, email_type, sequence_step,
                                  subject, body, grounding, grounding_flags, rationale, model, status)
     VALUES ($1, $2, $3, 'rehearsal', 'cold_open', 1, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, 'draft')
     RETURNING id`,
    [lead.id, d.company_id, contact.id, d.subject, d.body,
     JSON.stringify(d.grounding || {}), JSON.stringify(flags),
     JSON.stringify({ ...(d.rationale || {}), rehearsal: `cloned from draft ${d.id}; the original is untouched` }),
     d.model])).rows[0];

  return { started: true, leadId: lead.id, draftId: clone.id, clonedFrom: d.id, to: addr };
}

// What the rehearsal lane currently holds, for the banner.
export async function rehearsalStatus() {
  const leads = (await pool.query(
    `SELECT stage, count(*)::int AS n FROM leads WHERE campaign = 'rehearsal' GROUP BY stage`)).rows
    .reduce((a, r) => { a[r.stage] = r.n; return a; }, {});
  const counts = (await pool.query(
    `SELECT
       (SELECT count(*)::int FROM outbound_drafts WHERE campaign = 'rehearsal') AS drafts,
       (SELECT count(*)::int FROM outbound_sends s JOIN outbound_drafts d ON d.id = s.draft_id
        WHERE d.campaign = 'rehearsal' AND s.sent AND NOT s.test_mode) AS sends,
       (SELECT count(*)::int FROM outbound_replies r JOIN outbound_drafts d ON d.id = r.draft_id
        WHERE d.campaign = 'rehearsal') AS replies`)).rows[0];
  const active = Object.values(leads).reduce((a, n) => a + n, 0) > 0;
  return { active, leads, ...counts };
}

// End the rehearsal: delete every tagged row, children first, and nothing
// else. The real pipeline cannot be touched here by construction, since only
// campaign 'rehearsal' rows and rehearsal contacts are named.
export async function endRehearsal() {
  const replies = await pool.query(
    `DELETE FROM outbound_replies WHERE draft_id IN (SELECT id FROM outbound_drafts WHERE campaign = 'rehearsal')`);
  const sends = await pool.query(
    `DELETE FROM outbound_sends WHERE draft_id IN (SELECT id FROM outbound_drafts WHERE campaign = 'rehearsal')`);
  const drafts = await pool.query(`DELETE FROM outbound_drafts WHERE campaign = 'rehearsal'`);
  const leads = await pool.query(`DELETE FROM leads WHERE campaign = 'rehearsal'`);
  const contacts = await pool.query(`DELETE FROM contacts WHERE rehearsal`);
  return {
    wiped: {
      replies: replies.rowCount, sends: sends.rowCount, drafts: drafts.rowCount,
      leads: leads.rowCount, contacts: contacts.rowCount,
    },
  };
}
