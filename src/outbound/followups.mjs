import { pool, hasColumn } from '../db.mjs';
import { requireCampaign } from '../campaigns/registry.mjs';
import { confidentialityRule } from '../campaigns/prompts.mjs';
import { gatherGrounding } from './grounding.mjs';
import { renderGrounding, finaliseDraft, outboundVoice, stripSignoff, ensureGreeting, flagGreetingMismatch } from './draft.mjs';

// Follow-ups: the second and third touch on a thread that has had no reply.
// Most replies to cold outreach arrive on a later touch, so a first email with
// no follow-up wastes the research behind it. The machine's initiative stops
// the moment anything comes back: one reply of any kind ends the sequence, and
// from then on drafts are responses. A follow-up is a draft like any other,
// through the same review queue, the same grounding check and the same send
// gates; nothing here sends.

// The confidentiality ceiling is the campaign's, so a campaign cannot protect
// its customers in the cold open and leak them three messages later. It is the
// LEAD'S campaign, resolved per draft from the grounding: a module-level
// default here meant a pharma follow-up would have carried the data centre
// ceiling, protecting the wrong customers.
const campaignDef = grounding => requireCampaign(grounding?.campaign || process.env.DEFAULT_CAMPAIGN || 'marwin_dc');

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

export function buildFollowupSystem(def) {
  return (
    "You write a short follow-up email for Premier Control Technologies (PCT), a UK supplier of flow control products. An earlier email (provided) got no reply; this is the next touch on the same thread. " +
    "HARD RULE: you may state only what the GROUNDING supports, which includes what the previous email already said. No new claims, no invented developments, no manufactured urgency, no invented deadline or reason to reply now. Never write 'just bumping', 'just checking in' or 'circling back', and never guilt the recipient for not replying. " +
    confidentialityRule(def) + " No part-specific spec claims. " +
    "VOICE: plain technical British English, calm, an engineer briefly re-raising something with a peer. No em dashes or en dashes, never the word genuinely, no exclamation marks, no pleasantries, no pressure. " +
    "STRUCTURE, two or three sentences: a fresh, plain angle on why it is worth a look, drawn from the grounding rather than a restatement of the whole first email; the same single light ask (a short call, or whether they are specifying flow control on the project). Do not apologise for writing again. " +
    "NO SIGN-OFF, absolute: the email ends on the ask. No name, no team or company line, no web address, no contact details; the signature is appended by the system. " +
    "Return strict JSON only: {\"subject\":\"...\",\"body\":\"...\",\"claims\":[{\"text\":\"<factual sentence>\",\"supportedBy\":\"signal|icp|range|contact|previous_email\"}]}. The body is plain text, no Markdown.");
}

// The final touch is a break-up email, agreed with James on 27 July 2026: the
// PCT voice stays, and the sequence ends by saying so. The hook is the truth
// of the finality, not theatre. The classic devices are banned by name because
// each one is a lie or a lever: there is no file to close, no feigned
// confusion, and no debt owed by someone who never replied. The statement
// "this is the last email on this" is true, the engine stops after it, and a
// one-word no being welcome is the lowest-effort reply a sequence can invite,
// which is why break-up emails get answers at all.
export function buildBreakupSystem(def) {
  return (
    "You write the FINAL email of a short outreach sequence for Premier Control Technologies (PCT), a UK supplier of flow control products. Earlier emails (the last one is provided) got no reply. This is a break-up email: it says plainly that it is the last one, and it is telling the truth, because the sequence ends here and no further email follows. " +
    "HARD RULE: you may state only what the GROUNDING supports, which includes what the previous email already said. No new claims, no invented developments, no manufactured urgency, no invented deadline. " +
    "BREAK-UP RULES, absolute: state in one plain sentence that this is the last email from PCT on this; never dress the ending up as 'closing your file', 'last chance' or any device that manufactures loss; never feign confusion about the silence, never guilt the recipient for it, and never apologise for having written. Say a one-line reply, even a no or a not now, is welcome. End by leaving the door open in general terms: if flow control comes up on their side later, PCT is easy to find. That door-open line must stay general, no invented event, date or offer. " +
    confidentialityRule(def) + " No part-specific spec claims. " +
    "VOICE: plain technical British English, calm, an engineer closing a loop with a peer. No em dashes or en dashes, never the word genuinely, no exclamation marks, no pleasantries, no pressure. " +
    "STRUCTURE, three sentences or so: the plain statement that this is the last email; the one-line-reply-welcome offer with the same light ask as before (" + def.positioning.ask + "); the general door left open. " +
    "NO SIGN-OFF, absolute: no name, no team or company line, no web address, no contact details; the signature is appended by the system. " +
    "Return strict JSON only: {\"subject\":\"...\",\"body\":\"...\",\"claims\":[{\"text\":\"<factual sentence>\",\"supportedBy\":\"signal|icp|range|contact|previous_email\"}]}. The body is plain text, no Markdown.");
}

// True when `step` is the sequence's last permitted touch, which is the one
// written as the break-up. Derived from the cadence, so lengthening
// FOLLOWUP_DAYS moves the break-up to the new end without a code change.
export const isFinalStep = (step, delays = followupDelays()) => step >= 1 + delays.length;

// The grounding a follow-up may draw on: everything the cold open could use,
// plus the previous email itself, so a restatement is supported rather than
// flagged as an invention.
export function followupGroundingText(grounding, prev) {
  // The previous email is shown without any sign-off it may carry, so the
  // model never has a bad example to copy over the no-sign-off rule. The
  // campaign travels, so the range lines are the lead's own campaign's.
  return `${renderGrounding(grounding, grounding?.campaign || 'marwin_dc')}\nPrevious email on this thread (sent, no reply). Restating its supported facts is permitted:\nSubject: ${prev.subject}\n${stripSignoff(String(prev.body || '')).body}`;
}

// Draft one follow-up through the shared finishing pass: grounding check, one
// revision if needed, supplier and end-customer guardrails.
export async function draftFollowup(grounding, prev, { step, callModel = callClaude } = {}) {
  const def = campaignDef(grounding);
  const groundingText = followupGroundingText(grounding, prev);
  // The last permitted touch is the break-up; every earlier one is an ordinary
  // follow-up. Same thread, same guardrails, different closing register.
  const finalTouch = isFinalStep(step);
  const user = `GROUNDING (the only facts you may use):\n${groundingText}\n\nThis is touch ${step} on the thread${finalTouch ? ', the final one' : ''}. Write the ${finalTouch ? 'break-up' : 'follow-up'} email.`;
  const raw = await callModel(finalTouch ? buildBreakupSystem(def) : buildFollowupSystem(def), user, { maxTokens: 700 });
  const parsed = parseJsonObject(raw);
  const draft = {
    subject: reSubject(outboundVoice(parsed.subject || prev.subject)),
    body: outboundVoice(parsed.body || ''),
    claims: Array.isArray(parsed.claims) ? parsed.claims : [],
    model: MODEL,
  };
  if (!draft.body) throw new Error('follow-up missing body');
  const finished = await finaliseDraft(draft, grounding, { callModel, groundingText });
  // The greeting is checked after it is guaranteed, on the final body: with
  // the grounding pinned to the thread's contact this never fires, and if
  // any future path drifts again the draft arrives blocked, not sendable.
  const body = ensureGreeting(finished.body, grounding.contact?.name);
  const mismatch = flagGreetingMismatch(body, grounding.contact);
  return {
    ...finished,
    flags: [...finished.flags, ...(mismatch ? [mismatch] : [])],
    subject: reSubject(finished.subject || prev.subject),
    body,
  };
}

// Threads whose next touch has fallen due: the latest sent draft per lead still
// The break-up waits for the LinkedIn stage, John's sequencing of 24 August
// 2026: emails one and two, then a message from James or Andy, then the
// break-up from the rep. The email sweeper cannot see LinkedIn, so the final
// touch asks here whether that stage still has a turn to take. Two bounds
// keep it honest: it only ever holds the FINAL touch, never an ordinary
// follow-up, and it never holds past the hold window, because a lead stuck
// forever waiting for an acceptance nobody will give is worse than a
// break-up sent a week late.
export const breakupMaxHoldDays = () => Math.max(0, parseInt(process.env.BREAKUP_MAX_HOLD_DAYS || '12', 10) || 12);
export const breakupAfterDmDays = () => Math.max(0, parseInt(process.env.BREAKUP_AFTER_DM_DAYS || '5', 10) || 5);

export function breakupHeld({ finalTouch = false, dueAt = null, now = Date.now(),
                              invitedAt = null, connectedAt = null, dmSentAt = null,
                              connectionWindowDays = 21, maxHoldDays = breakupMaxHoldDays(),
                              afterDmDays = breakupAfterDmDays() } = {}) {
  if (!finalTouch) return false;
  const due = new Date(dueAt).getTime();
  if (!Number.isNaN(due) && now - due > maxHoldDays * 86_400_000) return false;

  const age = iso => {
    const t = new Date(iso).getTime();
    return Number.isNaN(t) ? null : now - t;
  };
  if (dmSentAt) {
    const since = age(dmSentAt);
    // The message has been sent; give it room to be answered before the
    // sequence says it is stopping.
    return since != null && since < afterDmDays * 86_400_000;
  }
  // Connected and not yet messaged: the message is the next thing that
  // happens to this person, so the break-up waits for it.
  if (connectedAt) return true;
  // Invited and undecided: they may still accept, inside the same window the
  // connection sweep uses. Past it, silence is the answer and the sequence
  // finishes.
  if (invitedAt) {
    const since = age(invitedAt);
    return since != null && since < connectionWindowDays * 86_400_000;
  }
  // Never invited: LinkedIn has no turn to take here.
  return false;
}

// at the outbound stage, with no reply anywhere on the lead, no open draft, a
// live address, no snooze, and room left in the sequence. Delay arithmetic
// happens here in followupDueAt, so the query stays simple.
export async function dueFollowups({ now = new Date() } = {}) {
  // The LinkedIn stage arrives with migration 035; before it, the sequence
  // behaves exactly as it did and the break-up is never held.
  const liCols = await hasColumn('contacts', 'li_connected_at');
  const { rows } = await pool.query(
    `SELECT l.id AS lead_id, d.id AS draft_id, d.subject, d.body, d.sent_at, d.sequence_step,
            d.campaign, d.company_id, d.contact_id,
            ${liCols ? `ct.li_invited_at, ct.li_connected_at,
            (SELECT max(m.sent_at) FROM li_messages m WHERE m.contact_id = ct.id AND m.status = 'sent') AS dm_sent_at`
              : 'NULL::timestamptz AS li_invited_at, NULL::timestamptz AS li_connected_at, NULL::timestamptz AS dm_sent_at'}
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
       -- A human's reject on a touch is terminal for the thread, John's
       -- call of 20 August 2026 when blocked follow-ups respawned on every
       -- sweep: reject, redraft, block, forever. Once any draft at the next
       -- step has been rejected, the machine stops chasing this thread; a
       -- wording fix is an edit and save, never a reject.
       AND NOT EXISTS (SELECT 1 FROM outbound_drafts o2 WHERE o2.lead_id = l.id
                       AND o2.status = 'rejected' AND o2.sequence_step = d.sequence_step + 1)
       -- Any real reply ends the machine's initiative. A bounce or an away
       -- reply is not engagement, and an untriaged reply pauses the sequence
       -- until triage has read it.
       AND NOT EXISTS (SELECT 1 FROM outbound_replies r JOIN outbound_drafts od ON od.id = r.draft_id
                       WHERE od.lead_id = l.id
                         AND (r.category IS NULL OR r.category NOT IN ('bounce', 'out_of_office')))`);
  const delays = followupDelays();
  const finalStep = maxSequenceSteps();
  return rows.filter(r => {
    const unit = r.campaign === 'rehearsal' ? 'minutes' : 'days';
    const due = followupDueAt(r.sent_at, r.sequence_step, delays, { unit });
    if (!due || due.getTime() > now.getTime()) return false;
    // The rehearsal lane walks the whole sequence in an afternoon and must
    // never wait on a real LinkedIn acceptance.
    if (r.campaign === 'rehearsal') return true;
    return !breakupHeld({
      finalTouch: r.sequence_step + 1 >= finalStep,
      dueAt: due, now: now.getTime(),
      invitedAt: r.li_invited_at, connectedAt: r.li_connected_at, dmSentAt: r.dm_sent_at,
    });
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
      // Pinned to the thread's contact: the person the sent emails actually
      // went to. Without the pin, the grounding re-resolved the lead's
      // current best contact, and when discovery replaced the contact
      // between touches, a break-up greeted one person and addressed
      // another. The recipient, the greeting and the grounding are now the
      // same human by construction.
      const grounding = await gatherGrounding(t.lead_id, { campaign: t.campaign, contactId: t.contact_id });
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
