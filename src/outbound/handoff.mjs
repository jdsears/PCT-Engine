import { pool } from '../db.mjs';

// The handoff pack: when a meeting is booked and the conversation passes to a
// person, they get the whole grounded story in one plain email, the research,
// the thread, what was claimed and what was asked, so the meeting starts warm
// and nothing has to be reconstructed from the app under time pressure.

export async function gatherHandoffData(leadId) {
  const lead = (await pool.query(
    `SELECT l.id, l.stage, l.score, l.meeting_booked_at, l.meeting_kind, l.meeting_at, l.handoff_note,
            c.name AS company, c.region, c.company_type, c.icp_score
     FROM leads l JOIN companies c ON c.id = l.company_id WHERE l.id = $1`, [leadId])).rows[0];
  if (!lead) return null;
  const draft = (await pool.query(
    `SELECT d.subject, d.rationale, d.grounding, ct.full_name, ct.role_title, ct.email, ct.li_invited_at
     FROM outbound_drafts d LEFT JOIN contacts ct ON ct.id = d.contact_id
     WHERE d.lead_id = $1 AND d.status = 'sent' ORDER BY sequence_step ASC, sent_at ASC LIMIT 1`, [leadId])).rows[0] || {};
  const thread = (await pool.query(
    `SELECT email_type, subject, body, sent_at FROM outbound_drafts
     WHERE lead_id = $1 AND status = 'sent' ORDER BY sent_at ASC`, [leadId])).rows;
  const replies = (await pool.query(
    `SELECT r.from_email, r.received_at, r.category, COALESCE(r.body, r.snippet) AS text
     FROM outbound_replies r JOIN outbound_drafts d ON d.id = r.draft_id
     WHERE d.lead_id = $1 ORDER BY r.received_at ASC`, [leadId])).rows;
  return { lead, draft, thread, replies };
}

// Plain text, in voice, safe to forward internally. Pure, so the wording is
// testable offline.
export function renderHandoffPack({ lead, draft, thread, replies }, { note = null } = {}) {
  const g = draft.grounding && typeof draft.grounding === 'object' ? draft.grounding : {};
  const meeting = lead.meeting_booked_at
    ? `${lead.meeting_kind === 'f2f' ? 'Face to face' : 'Video call'}${lead.meeting_at ? ', ' + new Date(lead.meeting_at).toUTCString().slice(0, 16) : ', time to be fixed'}`
    : 'Not booked yet';
  const lines = [
    `Handoff: ${lead.company}`,
    '',
    `Contact: ${draft.full_name || 'not recorded'}${draft.role_title ? ', ' + draft.role_title : ''}${draft.email ? ', ' + draft.email : ''}.`,
    `Meeting: ${meeting}.`,
    `Why this account: ${g.icpReason || (lead.icp_score != null ? `ICP score ${lead.icp_score}` : 'see the app')}.`,
    g.signal?.text ? `The signal that started it: ${g.signal.text}${g.signal.source ? ' (' + g.signal.source + ')' : ''}.` : null,
    draft.li_invited_at ? 'A LinkedIn invite has also gone from the connected account.' : null,
    note ? `Note from the sender: ${note}` : null,
    '',
    `The thread, ${thread.length} sent and ${replies.length} received:`,
  ].filter(l => l !== null);
  for (const t of thread) {
    lines.push(`--- Sent (${t.email_type.replace('_', ' ')}), ${t.sent_at ? new Date(t.sent_at).toUTCString().slice(0, 16) : ''}: ${t.subject}`);
    lines.push(String(t.body || '').trim());
  }
  for (const r of replies) {
    lines.push(`--- Received${r.category ? ' (' + r.category.replace(/_/g, ' ') + ')' : ''}, ${r.received_at ? new Date(r.received_at).toUTCString().slice(0, 16) : ''}, from ${r.from_email}:`);
    lines.push(String(r.text || '').trim().slice(0, 1500));
  }
  lines.push('', 'Everything above is grounded in the app: Outbound, conversations. Reply to the prospect from your own mailbox from here on; the engine stops writing on this thread once it is handed off.');
  return { subject: `Handoff: ${lead.company}, ${draft.full_name || 'contact in the app'}`, text: lines.join('\n') };
}
