import { pool } from '../db.mjs';
import { outboundVoice, flagEndCustomers } from '../outbound/draft.mjs';

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

async function callClaude(system, user, { maxTokens = 500 } = {}) {
  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`Claude failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

const SYSTEM =
  "You draft a short LinkedIn post for a UK flow control specialist commenting on data centre industry news. The post appears under his own name, so it reads like a practitioner's take, not marketing. " +
  "GROUNDING RULE: you may reference only the news story provided. Do not invent figures, projects or details beyond it. You may add one general line that the Marwin and Steriflow control valve ranges his company supplies are trusted across some of the largest data centre builds. " +
  "CONFIDENTIALITY RULE, absolute: never state or imply that any named company is a customer. The story's subject may be discussed as news; it must never read as a client reference. No customer names, ever. " +
  "VOICE: plain British English, calm, first person, three to six sentences. A practitioner's observation about what the story means for data centre cooling and flow control, then a light closing thought or question to invite comment. No em dashes or en dashes, never the word genuinely, no exclamation marks, no hashtags, no emojis, no links. " +
  "Return the post text only, no preamble and no quotation marks around it.";

// Draft posts from the newest gated signals that do not already have one. The
// classifier and gate upstream mean everything here is a real data centre story.
// callModel is injectable so the pipeline is testable offline.
export async function generateLiPosts({ limit = 3, callModel = callClaude } = {}) {
  const { rows: signals } = await pool.query(
    `SELECT s.id, s.title, s.operator, s.url, s.geo_scope, s.payload->>'content' AS content
     FROM signals s
     WHERE s.dc_relevant AND s.geo_scope IN ('uk_project', 'expansion_watch') AND s.title IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM li_posts p WHERE p.signal_id = s.id AND p.status IN ('draft', 'posted'))
     ORDER BY s.observed_at DESC LIMIT $1`, [Math.min(Math.max(1, limit), 5)]);

  const report = { considered: signals.length, drafted: 0, flagged: 0, failed: 0 };
  for (const s of signals) {
    try {
      const user = `The news story:\nHeadline: ${s.title}\n${s.content ? `Story: ${String(s.content).slice(0, 900)}\n` : ''}Write the post.`;
      const body = outboundVoice(await callModel(SYSTEM, user, { maxTokens: 500 }));
      if (!body) throw new Error('empty post');
      // The story's own subject may be named as news; any other operator, or a
      // customer-implying phrase, is a flag the reviewer must clear by editing.
      const flags = flagEndCustomers(body, s.operator).map(n =>
        `blocking: names or implies a customer relationship (${n}); the story may be discussed as news, never as a client reference`);
      await pool.query(
        `INSERT INTO li_posts (signal_id, topic, body, grounding, status)
         VALUES ($1, $2, $3, $4::jsonb, 'draft')`,
        [s.id, s.title, body, JSON.stringify({ signal: { id: s.id, title: s.title, operator: s.operator, source: s.url, geoScope: s.geo_scope }, flags })]);
      report.drafted++;
      if (flags.length) report.flagged++;
    } catch (e) {
      report.failed++;
      console.error('[studio] post generation failed:', String(e.message).slice(0, 140));
    }
  }
  return report;
}

// The suggested connection note: deterministic, in voice, and under LinkedIn's
// three-hundred character invite limit by construction. No model call, so the
// queue costs nothing to browse, and the sender edits before sending anyway.
export function connectNote(contact, companyName) {
  const first = String(contact.full_name || '').trim().split(/\s+/)[0] || 'there';
  const work = contact.role_title
    ? `your ${String(contact.role_title).trim()} role at ${companyName}`
    : `your work at ${companyName}`;
  const note = `Hi ${first}, I look after flow control for data centre cooling at PCT, supplier of the Marwin and Steriflow valve ranges. Given ${work}, I thought it worth connecting.`;
  return note.length <= 300 ? note : `Hi ${first}, I look after flow control for data centre cooling at PCT. Given your work at ${companyName}, I thought it worth connecting.`;
}
