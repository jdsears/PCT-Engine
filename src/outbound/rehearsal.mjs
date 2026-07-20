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
//
// Each stand-in address is its own lane, so John, James and Andy can rehearse
// at the same time without treading on each other. Replies attribute by
// conversation id, follow-ups schedule per send, and triage works per reply,
// so concurrent lanes never cross; status reports per lane, and ending a lane
// wipes that lane alone. The full wipe, no address given, remains the reset
// before going live.

// The stand-in carries the persona of the contact being rehearsed. Greetings
// on follow-ups and responses come from the lead's contact name, so a
// stand-in called "Rehearsal prospect" would make every generated turn open
// "Rehearsal," instead of "Dear Nancy,". Naming the stand-in after the real
// contact, with the stand-in marker kept in the tail, means what the
// teammate receives reads exactly as the prospect would receive it, which is
// the rehearsal's whole promise. With no contact name on file the neutral
// name remains and nothing is invented.
export function standInName(personaName, addr) {
  const local = String(addr || '').split('@')[0] || 'stand-in';
  const persona = String(personaName || '').trim();
  return persona ? `${persona} (rehearsal stand-in, ${local})` : `Rehearsal prospect (${local})`;
}

// Clone one reviewable cold open onto a rehearsal lead addressed to an
// internal teammate. The recipient must be on the internal allowlist, the same
// list test sends use; the kill switch keeps blocking everyone else. One
// rehearsal per address at a time: the lane is keyed by the address, so a
// second start for the same inbox would fold two journeys into one thread
// listing and muddle both.
export async function startRehearsal({ draftId = null, to }) {
  const addr = String(to || '').trim().toLowerCase();
  if (!isTestRecipient(addr)) return { started: false, reason: 'the stand-in address must be on the internal test allowlist' };
  const running = await pool.query(
    `SELECT 1 FROM leads l JOIN contacts ct ON ct.id = l.contact_id
     WHERE l.campaign = 'rehearsal' AND ct.rehearsal AND lower(ct.email) = $1 LIMIT 1`, [addr]);
  if (running.rows.length) {
    return { started: false, reason: 'this address already has a rehearsal running; end that one first. Rehearsals to other addresses are separate and carry on untouched' };
  }

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
    [d.company_id, standInName(d.grounding?.contact?.name, addr), addr])).rows[0];
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

// What the rehearsal lanes currently hold: the aggregate for the banner, and
// one entry per stand-in address so three teammates each see their own thread.
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
  const laneRows = (await pool.query(
    `SELECT DISTINCT ON (lower(ct.email)) lower(ct.email) AS to_email, l.stage
     FROM leads l JOIN contacts ct ON ct.id = l.contact_id
     WHERE l.campaign = 'rehearsal' AND ct.rehearsal
     ORDER BY lower(ct.email), l.created_at DESC`)).rows;
  const lanes = [];
  for (const lr of laneRows) {
    const c = (await pool.query(
      `SELECT
         (SELECT count(*)::int FROM outbound_drafts d JOIN contacts c2 ON c2.id = d.contact_id
          WHERE d.campaign = 'rehearsal' AND c2.rehearsal AND lower(c2.email) = $1) AS drafts,
         (SELECT count(*)::int FROM outbound_sends s JOIN outbound_drafts d ON d.id = s.draft_id
          JOIN contacts c2 ON c2.id = d.contact_id
          WHERE d.campaign = 'rehearsal' AND c2.rehearsal AND lower(c2.email) = $1
            AND s.sent AND NOT s.test_mode) AS sends,
         (SELECT count(*)::int FROM outbound_replies r JOIN outbound_drafts d ON d.id = r.draft_id
          JOIN contacts c2 ON c2.id = d.contact_id
          WHERE d.campaign = 'rehearsal' AND c2.rehearsal AND lower(c2.email) = $1) AS replies`,
      [lr.to_email])).rows[0];
    lanes.push({ to: lr.to_email, stage: lr.stage, ...c });
  }
  const active = Object.values(leads).reduce((a, n) => a + n, 0) > 0;
  return { active, lanes, leads, ...counts };
}

// The wipe, as data: every statement names campaign 'rehearsal' rows or
// rehearsal contacts and nothing else, children first, so the real pipeline
// cannot be touched here by construction. Scoped to one address it narrows
// every statement to that lane's stand-in contacts; unscoped it is the full
// reset before going live. Pure, so the gate can prove both properties.
export function wipeStatements(to = null) {
  const addr = to ? String(to).trim().toLowerCase() : null;
  const contactIds = addr
    ? `SELECT id FROM contacts WHERE rehearsal AND lower(email) = $1`
    : `SELECT id FROM contacts WHERE rehearsal`;
  const draftIds = addr
    ? `SELECT id FROM outbound_drafts WHERE campaign = 'rehearsal' AND contact_id IN (${contactIds})`
    : `SELECT id FROM outbound_drafts WHERE campaign = 'rehearsal'`;
  const params = addr ? [addr] : [];
  return [
    { table: 'replies', sql: `DELETE FROM outbound_replies WHERE draft_id IN (${draftIds})`, params },
    { table: 'sends', sql: `DELETE FROM outbound_sends WHERE draft_id IN (${draftIds})`, params },
    { table: 'drafts', sql: `DELETE FROM outbound_drafts WHERE id IN (${draftIds})`, params },
    { table: 'leads', sql: addr
        ? `DELETE FROM leads WHERE campaign = 'rehearsal' AND contact_id IN (${contactIds})`
        : `DELETE FROM leads WHERE campaign = 'rehearsal'`, params },
    { table: 'contacts', sql: `DELETE FROM contacts WHERE id IN (${contactIds})`, params },
  ];
}

// End a rehearsal. With an address, only that lane goes; without one, every
// lane goes, which is the going-live reset.
export async function endRehearsal({ to = null } = {}) {
  const wiped = {};
  for (const s of wipeStatements(to)) {
    wiped[s.table] = (await pool.query(s.sql, s.params)).rowCount;
  }
  return { wiped, scope: to ? String(to).trim().toLowerCase() : 'all' };
}
