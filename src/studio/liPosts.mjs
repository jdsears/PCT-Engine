import { pool } from '../db.mjs';
import { freshOnly } from '../research/freshness.mjs';
import { outboundVoice, flagEndCustomers } from '../outbound/draft.mjs';
import { unipile, ROUTES, unipileConfigured } from '../research/unipile.mjs';

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
  "SHAPE: the first sentence stands alone as its own opening line and must carry the story's hook, since the feed folds everything after it. Then short paragraphs of one or two sentences separated by blank lines, never one solid block. " +
  "Return the post text only, no preamble and no quotation marks around it.";

// The shape guaranteed rather than hoped for: a hook line, then paragraphs of
// at most two sentences with blank lines between. A post that arrives as one
// solid block is split at sentence boundaries; one already shaped passes
// through with its whitespace tidied. The editor can always reshape by hand.
export function formatPost(body) {
  const paras = String(body || '').trim().split(/\n\s*\n/).map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out = [];
  for (const p of paras) {
    const sentences = p.split(/(?<=[.?])\s+(?=[A-Z£$0-9])/);
    if (out.length === 0 && sentences.length > 1) {
      out.push(sentences.shift());
    }
    for (let i = 0; i < sentences.length; i += 2) {
      out.push(sentences.slice(i, i + 2).join(' '));
    }
  }
  return out.join('\n\n');
}

// Hashtags are curated, never model-chosen, so a tag can never be invented:
// the standing pair, plus cooling when the story is about cooling, plus the
// UK tag on UK project stories.
export function hashtagsFor({ title = '', body = '', geoScope = '' } = {}) {
  const tags = ['#datacentres', '#flowcontrol'];
  if (/cool|chill|thermal|liquid/i.test(`${title} ${body}`)) tags.push('#cooling');
  if (geoScope === 'uk_project') tags.push('#ukconstruction');
  tags.push('#valves');
  return tags;
}

// The full text as it should appear on LinkedIn: the shaped body, the story
// link on its own line so readers can check the source, then the hashtags.
export function renderPostText({ body, sourceUrl = null, hashtags = [] }) {
  const parts = [formatPost(body)];
  if (sourceUrl) parts.push(`Story: ${sourceUrl}`);
  if (hashtags.length) parts.push(hashtags.join(' '));
  return parts.filter(Boolean).join('\n\n');
}

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
  const take = Math.min(Math.max(1, limit), 5);
  // Over-fetch, then keep only stories that are not evidenced stale: a signal
  // is stored when WE saw it, and a republished three-year-old story carries a
  // recent observed_at. The published date decides, in code rather than SQL,
  // since a third-party date string must never abort the query. That is how a
  // three-year-old story became a live post: nothing read the date it carried.
  const { rows: fetched } = await pool.query(
    `SELECT s.id, s.title, s.operator, s.url, s.geo_scope,
            s.payload->>'content' AS content, s.payload->>'published' AS published
     FROM signals s
     WHERE s.dc_relevant AND s.geo_scope IN ('uk_project', 'expansion_watch') AND s.title IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM li_posts p WHERE p.signal_id = s.id AND p.status IN ('draft', 'posted'))
     ORDER BY s.observed_at DESC LIMIT $1`, [take * 3]);
  const signals = freshOnly(fetched, r => r.published).slice(0, take);
  const staleSkipped = fetched.length - freshOnly(fetched, r => r.published).length;

  const report = { considered: signals.length, staleSkipped, drafted: 0, flagged: 0, failed: 0 };
  for (const s of signals) {
    try {
      const { body, flags } = await writePost({ headline: s.title, story: s.content, operator: s.operator }, { callModel });
      await pool.query(
        `INSERT INTO li_posts (signal_id, topic, body, grounding, status)
         VALUES ($1, $2, $3, $4::jsonb, 'draft')`,
        [s.id, s.title, body, JSON.stringify({ signal: { id: s.id, title: s.title, operator: s.operator, source: s.url, geoScope: s.geo_scope, publishedAt: s.published || null }, flags })]);
      report.drafted++;
      if (flags.length) report.flagged++;
    } catch (e) {
      report.failed++;
      console.error('[studio] post generation failed:', String(e.message).slice(0, 140));
    }
  }
  return report;
}

// Publishing, the studio's second sanctioned write after the invite, agreed
// with John in July 2026: one post per human click on one open, unflagged
// draft, through the connected account, capped per day, with the exact text
// assembled here from the approved body, the story link and the curated
// hashtags. Nothing ever posts on a schedule.
export const postDailyCap = () => Math.max(1, parseInt(process.env.LINKEDIN_POST_DAILY_CAP || '2', 10));

export async function postsPublishedToday() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM unipile_calls
     WHERE endpoint = 'POST /api/v1/posts' AND outcome = 'ok'
       AND (called_at AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'UTC')::date`);
  return rows[0].n;
}

export async function publishPost(id) {
  const p = (await pool.query(
    `SELECT id, topic, body, grounding, status FROM li_posts WHERE id = $1`, [id])).rows[0];
  if (!p) return { posted: false, reason: 'post not found' };
  if (p.status !== 'draft') return { posted: false, reason: 'only an open draft can be posted' };
  const flags = p.grounding?.flags || [];
  if (flags.length) return { posted: false, reason: 'the draft carries a blocking flag; edit it clean first' };
  if (!unipileConfigured()) return { posted: false, reason: 'the LinkedIn lane is not configured on this service' };
  if (!process.env.UNIPILE_ACCOUNT_ID) return { posted: false, reason: 'UNIPILE_ACCOUNT_ID is not set' };
  const used = await postsPublishedToday();
  if (used >= postDailyCap()) {
    return { posted: false, reason: `the daily post cap is used (${used} of ${postDailyCap()}); it resets at midnight UTC` };
  }
  const text = renderPostText({
    body: p.body,
    sourceUrl: p.grounding?.signal?.source || null,
    hashtags: hashtagsFor({ title: p.grounding?.signal?.title || p.topic, body: p.body, geoScope: p.grounding?.signal?.geoScope }),
  });
  await unipile(ROUTES.createPost, {
    form: { account_id: process.env.UNIPILE_ACCOUNT_ID, text },
    target: `li_post ${p.id}`,
  });
  await pool.query(
    `UPDATE li_posts SET status = 'posted', posted_at = now(), updated_at = now(),
            grounding = jsonb_set(COALESCE(grounding, '{}'::jsonb), '{postedText}', $2::jsonb)
     WHERE id = $1`, [p.id, JSON.stringify(text)]);
  return { posted: true };
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
