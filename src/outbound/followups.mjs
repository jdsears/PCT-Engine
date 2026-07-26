import { pool } from '../db.mjs';
import { requireCampaign } from '../campaigns/registry.mjs';
import { confidentialityRule } from '../campaigns/prompts.mjs';
import { gatherGrounding } from './grounding.mjs';
import { renderGrounding, finaliseDraft, outboundVoice, stripSignoff, ensureGreeting } from './draft.mjs';

// Follow-ups: the second and third touch on a thread that has had no reply.
// Most replies to cold outreach arrive on a later touch, so a first email with
// no follow-up wastes the research behind it. The machine's initiative stops
// the moment anything comes back: one reply of any kind ends the sequence, and
// from then on drafts are responses. A follow-up is a draft like any other,
// through the same review queue, the same grounding check and the same send
// gates; nothing here sends.

// The confidentiality ceiling is the campaign's, so a campaign cannot protect
// its customers in the cold open and leak them three messages later.
const CAMPAIGN_DEF = requireCampaign(process.env.DEFAULT_CAMPAIGN || 'marwin_dc');

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

async function callClaude(system, user, { maxTokens = 700 } = {}) {
  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`Claude failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

function parseJsonObject(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in model reply');
  return JSON.parse(raw.slice(start, end + 1));
}

// The cadence, in days after the previous send: FOLLOWUP_DAYS '4,7' means the
// second touch four days after the first, the third seven days after the
// second, then the sequence ends. The list length caps the sequence.
export function followupDelays() {
  const parsed = String(process.env.FOLLOWUP_DAYS || '4,7')
    .split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n) && n >= 1 && n <= 60);
  return parsed.length ? parsed : [4, 7];
}
export const maxSequenceSteps = () => 1 + followupDelays().length;

// When the next touch after a send at `step` falls due, or null when the
// sequence is exhausted. Pure, so the cadence is provable offline. The unit is
// days in production and minutes on a rehearsal thread, so the whole sequence
// can be walked in an afternoon without touching the real cadence.
export function followupDueAt(sentAtIso, step, delays = followupDelays(), { unit = 'days' } = {}) {
  const delay = delays[step - 1];
  if (!delay) return null;
  const sent = new Date(sentAtIso).getTime();
  if (Number.isNaN(sent)) return null;
  return new Date(sent + delay * (unit === 'minutes' ? 60_000 : 86_400_000));
}

// 'Re: ' the previous subject, once. The recipient sees one thread.
export function reSubject(subject) {
  const s = String(subject || '').trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

const FOLLOWUP_SYSTEM =
  "You write a short follow-up email for Premier Control Technologies (PCT), a UK supplier of flow control products. An earlier email (provided) got no reply; this is the next touch on the same thread. " +
  "HARD RULE: you may state only what the GROUNDING supports, which includes what the previous email already said. No new claims, no invented developments, no manufactured urgency, no invented deadline or reason to reply now. Never write 'just bumping', 'just checking in' or 'circling back', and never guilt the recipient for not replying. " +
  confidentialityRule(CAMPAIGN_DEF) + " No part-specific spec claims. " +
  "VOICE: plain technical British English, calm, an engineer briefly re-raising something with a peer. No em dashes or en dashes, never the word genuinely, no exclamation marks, no pleasantries, no pressure. " +
  "STRUCTURE, two or three sentences: a fresh, plain angle on why it is worth a look, drawn from the grounding rather than a restatement of the whole first email; the same single light ask (a short call, or whether they are specifying flow control on the project). Do not apologise for writing again. " +
  "NO SIGN-OFF, absolute: the email ends on the ask. No name, no team or company line, no web address, no contact details; the signature is appended by the system. " +
  "Return strict JSON only: {\"subject\":\"...\",\"body\":\"...\",\"claims\":[{\"text\":\"<factual sentence>\",\"supportedBy\":\"signal|icp|range|contact|previous_email\"}]}. The body is plain text, no Markdown.";

// The grounding a follow-up may draw on: everything the cold open could use,
// plus the previous email itself, so a restatement is supported rather than
// flagged as an invention.
export function followupGroundingText(grounding, prev) {
  // The previous email is shown without any sign-off it may carry, so the
  // model never has a bad example to copy over the no-sign-off rule.
  return `${renderGrounding(grounding)}\nPrevious email on this thread (sent, no reply). Restating its supported facts is permitted:\nSubject: ${prev.subject}\n${stripSignoff(String(prev.body || '')).body}`;
}

// Draft one follow-up through the shared finishing pass: grounding check, one
// revision if needed, supplier and end-customer guardrails.
export async function draftFollowup(grounding, prev, { step, callModel = callClaude } = {}) {
  const groundingText = followupGroundingText(grounding, prev);
  const user = `GROUNDING (the only facts you may use):\n${groundingText}\n\nThis is touch ${step} on the thread. Write the follow-up email.`;
  const raw = await callModel(FOLLOWUP_SYSTEM, user, { maxTokens: 700 });
  const parsed = parseJsonObject(raw);
  const draft = {
    subject: reSubject(outboundVoice(parsed.subject || prev.subject)),
    body: outboundVoice(parsed.body || ''),
    claims: Array.isArray(parsed.claims) ? parsed.claims : [],
    model: MODEL,
  };
  if (!draft.body) throw new Error('follow-up missing body');
  const finished = await finaliseDraft(draft, grounding, { callModel, groundingText });
  return {
    ...finished,
    subject: reSubject(finished.subject || prev.subject),
    body: ensureGreeting(finished.body, grounding.contact?.name),
  };
}

// Threads whose next touch has fallen due: the latest sent draft per lead still
// at the outbound stage, with no reply anywhere on the lead, no open draft, a
// live address, no snooze, and room left in the sequence. Delay arithmetic
// happens here in followupDueAt, so the query stays simple.
export async function dueFollowups({ now = new Date() } = {}) {
  const { rows } = await pool.query(
    `SELECT l.id AS lead_id, d.id AS draft_id, d.subject, d.body, d.sent_at, d.sequence_step,
            d.campaign, d.company_id, d.contact_id
     FROM leads l
     JOIN LATERAL (
       SELECT id, subject, body, sent_at, sequence_step, campaign, company_id, contact_id
       FROM outbound_drafts WHERE lead_id = l.id AND status = 'sent' AND sent_at IS NOT NULL
       ORDER BY sent_at DESC NULLS LAST, sequence_step DESC LIMIT 1
     ) d ON true
     LEFT JOIN contacts ct ON ct.id = d.contact_id
     WHERE l.stage = 'outbound'
       AND (l.snoozed_until IS NULL OR l.snoozed_until < now())
       AND ct.id IS NOT NULL AND NOT ct.suppressed AND ct.email IS NOT NULL AND ct.email_bounced_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM outbound_drafts o WHERE o.lead_id = l.id AND o.status IN ('draft','approved'))
       -- Any real reply ends the machine's initiative. A bounce or an away
       -- reply is not engagement, and an untriaged reply pauses the sequence
       -- until triage has read it.
       AND NOT EXISTS (SELECT 1 FROM outbound_replies r JOIN outbound_drafts od ON od.id = r.draft_id
                       WHERE od.lead_id = l.id
                         AND (r.category IS NULL OR r.category NOT IN ('bounce', 'out_of_office')))`);
  const delays = followupDelays();
  return rows.filter(r => {
    const unit = r.campaign === 'rehearsal' ? 'minutes' : 'days';
    const due = followupDueAt(r.sent_at, r.sequence_step, delays, { unit });
    return due && due.getTime() <= now.getTime();
  });
}

// The sweep: draft the due follow-ups into the review queue, capped per pass.
export async function sweepFollowups({ limit = 5, log = () => {}, callModel = callClaude } = {}) {
  const due = await dueFollowups();
  const batch = due.slice(0, Math.min(Math.max(1, limit), 10));
  const report = { due: due.length, drafted: 0, flagged: 0, failed: 0 };
  if (batch.length) log(`Drafting ${batch.length} follow-up(s) of ${due.length} due.`);
  for (const t of batch) {
    try {
      const grounding = await gatherGrounding(t.lead_id);
      const d = await draftFollowup(grounding, { subject: t.subject, body: t.body }, { step: t.sequence_step + 1, callModel });
      await pool.query(
        `INSERT INTO outbound_drafts (lead_id, company_id, contact_id, campaign, email_type, sequence_step, parent_draft_id,
                                      subject, body, grounding, grounding_flags, rationale, model, status)
         VALUES ($1, $2, $3, $4, 'followup', $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, 'draft')`,
        [t.lead_id, t.company_id, t.contact_id, t.campaign, t.sequence_step + 1, t.draft_id,
         d.subject, d.body, JSON.stringify(grounding), JSON.stringify(d.flags),
         JSON.stringify({ reason: `no reply ${t.sequence_step > 1 ? 'after ' + t.sequence_step + ' touches' : 'to the first email'}, next touch due` }),
         d.model]);
      report.drafted++;
      if (d.flags.length) report.flagged++;
      log(`  ${d.subject}${d.flags.length ? `  [${d.flags.length} flag(s)]` : ''}`);
    } catch (e) {
      report.failed++;
      log(`  FAILED lead ${t.lead_id}: ${String(e.message).slice(0, 140)}`);
    }
  }
  return report;
}
