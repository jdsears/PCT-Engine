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

// The end-customer check for a post, with the story's own subject exempted,
// since it may be discussed as news but never as a client reference. One
// function, so writing a post and re-checking an edited one apply the same rule.
export function postFlags(body, operator) {
  return flagEndCustomers(body, operator).map(n =>
    `blocking: names or implies a customer relationship (${n}); the story may be discussed as news, never as a client reference`);
}

// Write one post from one story, guardrails applied: the voice gate on the
// text, and the end-customer check. Shared by the signal-driven posts and the
// intel inbox commentary.
export async function writePost({ headline, story, operator }, { callModel = callClaude } = {}) {
  const user = `The news story:\nHeadline: ${headline}\n${story ? `Story: ${String(story).slice(0, 900)}\n` : ''}Write the post.`;
  const body = outboundVoice(await callModel(SYSTEM, user, { maxTokens: 500 }));
  if (!body) throw new Error('empty post');
  return { body, flags: postFlags(body, operator) };
}

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
      const { body, flags } = await writePost({ headline: s.title, story: s.content, operator: s.operator }, { callModel });
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

// LinkedIn headlines arrive as stored: often "Role at Company | Sector | Tag"
// with a tail of credential letters. For the note we want the role alone: keep
// the first segment (pipes, middots and spaced dashes are separators), cut at
// " at ", then strip trailing credential tokens (short, multi-capital: BEng,
// MSc, MCIBSE).
export function cleanRole(roleTitle) {
  let r = String(roleTitle || '').trim()
    .split(/\s*\|\s*|\s*·\s*|\s+[–—-]\s+/)[0]
    .split(/\s+at\s+/i)[0]
    .replace(/[.,;\s]+$/g, '');
  const credential = t => /^[A-Za-z]{2,8}\.?$/.test(t) && (t.match(/[A-Z]/g) || []).length >= 2;
  let parts = r.split(/,\s*/);
  while (parts.length > 1 && credential(parts[parts.length - 1])) parts.pop();
  r = parts.join(', ');
  let words = r.split(/\s+/);
  while (words.length > 1 && credential(words[words.length - 1])) words.pop();
  r = words.join(' ').replace(/[.,;\s]+$/g, '');
  return r.length > 60 ? '' : r;
}

// Registered names are upper case in the register. For prose, title-case the
// all-caps ones and drop the corporate suffix; tokens with digits or three or
// fewer letters (UK, DC01, EMEA initialisms) are left exactly as stored.
export function companyDisplay(name) {
  let n = String(name || '').trim().replace(/[\s,]+(LIMITED|LTD\.?|PLC|LLP)$/i, '');
  if (n && n === n.toUpperCase()) {
    n = n.split(/\s+/).map(t =>
      (/^[A-Z]{4,}$/.test(t) ? t.charAt(0) + t.slice(1).toLowerCase() : t)).join(' ');
  }
  return n;
}

// The suggested connection note: deterministic, in voice, and under LinkedIn's
// three-hundred character invite limit by construction. No model call, so the
// queue costs nothing to browse, and the sender edits before sending anyway.
export function connectNote(contact, companyName) {
  const first = String(contact.full_name || '').trim().split(/\s+/)[0] || 'there';
  const company = companyDisplay(companyName);
  const role = cleanRole(contact.role_title);
  const work = role ? `your ${role} role at ${company}` : `your work at ${company}`;
  const note = `Hi ${first}, I'm the MD at PCT, supplier of the Marwin and Steriflow valve ranges used across some of the largest data centre builds. Given ${work}, I thought it worth connecting.`;
  return note.length <= 300 ? note : `Hi ${first}, I'm the MD at PCT, supplier of the Marwin and Steriflow valve ranges. Given your work at ${company}, I thought it worth connecting.`;
}
