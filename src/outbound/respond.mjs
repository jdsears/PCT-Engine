import { pool } from '../db.mjs';
import { search } from '../retrieve.mjs';
import { renderGrounding, finaliseDraft, outboundVoice, stripSignoff } from './draft.mjs';
import { reSubject } from './followups.mjs';
import { COMPANY_FACTS } from './companyFacts.mjs';

// Response drafts: when a prospect replies with interest, a question or an
// objection, the engine drafts the answer the same way the co-pilot answers a
// question, from the documents and the thread, never from thin air. A response
// is a draft like any other: review queue, grounding check, guardrails, human
// approval, and it sends as a threaded reply. The goal of every response is
// the same, a short meeting, video or in person, then handoff.

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

async function callClaude(system, user, { maxTokens = 800 } = {}) {
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

const RESPOND_SYSTEM =
  "You write a reply to a prospect who has answered an outbound email from Premier Control Technologies (PCT), a UK supplier of flow control products. " +
  "HARD RULE: you may state only what the GROUNDING supports: the thread so far, the prospect's reply, the corpus extracts from PCT's own documents, and the standing range facts. If their question cannot be answered from these, say plainly that you will confirm the detail with engineering and come back, and never guess or improvise a specification, price, lead time or capability. " +
  "OBJECTIONS: acknowledge the point plainly and answer only what the facts support. Never argue past them, never discount, never invent a counter-example. A price question gets no number unless one is in the extracts; offer to put a quotation together instead. " +
  "GOAL: every response works towards one thing, a short meeting, video call or a visit, where a specialist can take it properly. One light ask. If a booking link is provided in the grounding, include it exactly as given; otherwise offer to suggest times. " +
  "CONFIDENTIALITY RULE, absolute: never name or imply any specific data centre operator or end customer. 'Some of the largest data centre builds' is the ceiling of specificity. " +
  "VOICE: plain technical British English, calm, an engineer answering a peer. No em dashes or en dashes, never the word genuinely, no exclamation marks, no hype. Three to six sentences. " +
  "NO SIGN-OFF, absolute: the reply ends on the ask. No name, no team or company line, no contact details; the signature is appended by the system. The only web address permitted is the booking link exactly as the grounding gives it; any other address you write would be invented. " +
  "SHAPE: two or three short paragraphs separated by blank lines, never one dense block. Answer their point first, then the one light ask. " +
  "Return strict JSON only: {\"subject\":\"...\",\"body\":\"...\",\"claims\":[{\"text\":\"<factual sentence>\",\"supportedBy\":\"thread|reply|corpus|range\"}]}. The body is plain text, no Markdown.";

// The grounding a response may draw on: the cold open's grounding, the thread,
// the reply itself, corpus extracts retrieved against the reply, and the
// booking link when configured.
export function responseGroundingText(grounding, thread, replyText, extracts) {
  const lines = [renderGrounding(grounding)];
  lines.push('Standing company facts, citable as they stand:');
  for (const f of COMPANY_FACTS) lines.push(`  ${f}`);
  lines.push('The thread so far, our sent emails. Restating their supported facts is permitted:');
  // Sign-offs are stripped from the examples shown to the model: a model
  // shown an old sign-off copies it over the no-sign-off instruction.
  for (const t of thread) lines.push(`  [sent] Subject: ${t.subject}\n  ${stripSignoff(String(t.body || '')).body.slice(0, 800)}`);
  lines.push(`Their reply, the message to answer:\n${String(replyText || '').slice(0, 3000)}`);
  if (extracts.length) {
    lines.push('Corpus extracts from PCT documents, citable facts for answering their question:');
    for (const x of extracts) lines.push(`  [${x.title}${x.page ? ', p' + x.page : ''}] ${x.snippet}`);
  } else {
    lines.push('No corpus extract matched their question. Technical detail must be deferred to engineering, not improvised.');
  }
  const link = String(process.env.MEETING_LINK || '').trim();
  lines.push(link
    ? `Booking link you may include, exactly as given: ${link}`
    : 'No booking link is configured; offer to suggest times for a short call instead.');
  return lines.join('\n');
}

// Draft the response to one captured reply and queue it for review. Refuses
// quietly when the lead already has an open draft, so triage re-runs and
// manual requests never pile up duplicates.
export async function draftResponse(replyId, { replyText = null, callModel = callClaude } = {}) {
  const r = (await pool.query(
    `SELECT r.id, r.subject AS reply_subject, r.body, r.snippet, r.draft_id,
            d.lead_id, d.company_id, d.contact_id, d.campaign, d.subject AS draft_subject, d.grounding
     FROM outbound_replies r JOIN outbound_drafts d ON d.id = r.draft_id
     WHERE r.id = $1`, [replyId])).rows[0];
  if (!r) return { drafted: false, reason: 'reply not found or not matched to a draft' };

  const open = await pool.query(
    `SELECT 1 FROM outbound_drafts WHERE lead_id = $1 AND status IN ('draft','approved') LIMIT 1`, [r.lead_id]);
  if (open.rowCount) return { drafted: false, reason: 'an open draft already exists for this lead' };

  const thread = (await pool.query(
    `SELECT subject, body, sequence_step FROM outbound_drafts
     WHERE lead_id = $1 AND status = 'sent' ORDER BY sequence_step ASC, sent_at ASC`, [r.lead_id])).rows;
  const grounding = r.grounding && typeof r.grounding === 'object' ? r.grounding : { company: {}, blockedSuppliers: [] };
  const text = replyText || r.body || r.snippet || '';

  // Corpus retrieval against what they actually asked, the co-pilot's own
  // search, so a technical answer carries real document extracts or none.
  let extracts = [];
  let blocked = Array.isArray(grounding.blockedSuppliers) ? [...grounding.blockedSuppliers] : [];
  try {
    const hits = await search(String(text).slice(0, 300), { k: 4 });
    extracts = hits.map(h => ({
      title: h.title, page: h.page ?? null,
      snippet: (h.content || h.snippet || '').slice(0, 400),
    }));
    blocked = [...new Set([...blocked, ...hits.filter(h => h.nameable === false).map(h => h.manufacturer).filter(Boolean)])];
  } catch { extracts = []; }

  const groundingText = responseGroundingText({ ...grounding, blockedSuppliers: blocked }, thread, text, extracts);
  const user = `GROUNDING (the only facts you may use):\n${groundingText}\n\nWrite the reply.`;
  const parsed = parseJsonObject(await callModel(RESPOND_SYSTEM, user, { maxTokens: 800 }));
  const draft = {
    subject: reSubject(outboundVoice(parsed.subject || r.reply_subject || r.draft_subject)),
    body: outboundVoice(parsed.body || ''),
    claims: Array.isArray(parsed.claims) ? parsed.claims : [],
    model: MODEL,
  };
  if (!draft.body) throw new Error('response missing body');
  const finished = await finaliseDraft(draft, { ...grounding, blockedSuppliers: blocked }, { callModel, groundingText });
  const subject = reSubject(finished.subject || r.reply_subject || r.draft_subject);

  const step = (thread[thread.length - 1]?.sequence_step || 1);
  await pool.query(
    `INSERT INTO outbound_drafts (lead_id, company_id, contact_id, campaign, email_type, sequence_step, parent_draft_id, reply_id,
                                  subject, body, grounding, grounding_flags, rationale, model, status)
     VALUES ($1, $2, $3, $4, 'response', $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13, 'draft')`,
    [r.lead_id, r.company_id, r.contact_id, r.campaign, step, r.draft_id, r.id,
     subject, finished.body,
     JSON.stringify({ ...grounding, responseExtracts: extracts, replyText: String(text).slice(0, 3000) }),
     JSON.stringify(finished.flags),
     JSON.stringify({ reason: 'response to their reply, goal is a short meeting' }),
     finished.model]);
  return { drafted: true, subject, flags: finished.flags };
}
