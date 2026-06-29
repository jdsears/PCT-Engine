import { voiceGate } from '../answer.mjs';
import { isOpenerGrade } from './openerGrade.mjs';

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

// Outbound prose gets a stricter pass than chat answers: no exclamation marks on
// top of the shared voice gate (no em or en dashes, never "genuinely").
export function outboundVoice(text) {
  return voiceGate(String(text || '').replace(/!+/g, '.')).replace(/[ \t]+\./g, '.');
}

// True when the text is already clean of the banned marks.
export function voiceClean(text) {
  return !/[—–!]/.test(text) && !/\bgenuinely\b/i.test(text);
}

// Pull the first balanced JSON object out of a model reply, tolerant of fences
// or stray text around it.
function parseJsonObject(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in model reply');
  return JSON.parse(raw.slice(start, end + 1));
}

// The real model call. Injected as `callModel` in the functions below so the
// pipeline can be exercised offline with deterministic stand-ins.
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

// Render the grounding as the only facts the drafter is permitted to use. The
// opener is chosen here: a real project event is given as the hook, while an
// administrative filing is marked context-only and never the hook.
export function renderGrounding(g) {
  const lines = [];
  lines.push(`Company: ${g.company?.name || 'unknown'}${g.company?.region ? ', region ' + g.company.region : ''}.`);
  lines.push(g.contact?.name
    ? `Contact: ${g.contact.name}${g.contact.role ? ', ' + g.contact.role : ', role not recorded'}.`
    : `Contact: not recorded. Address a specifier or buyer in neutral terms, do not assume a role.`);
  // Grade decides the opening. Fall back to deriving it from the signal type so
  // an older grounding without the flag still classifies correctly.
  const openerGrade = g.openerGrade ?? isOpenerGrade(g.signal);
  if (g.signal && openerGrade) {
    lines.push(`Signal to open on, a real project event the recipient could have noticed: ${g.signal.text}${g.signal.source ? ' [source: ' + g.signal.source + ']' : ''}. Open on this.`);
  } else {
    if (g.signal) lines.push(`Context only, an administrative filing (${g.signal.type}). NEVER mention it to the recipient and never give it as a reason for contact; it only tells us the account is worth approaching.`);
    else lines.push('No project signal on file. Do not invent a reason for contact.');
    lines.push('Open on profile fit: lead with why Marwin control valves are relevant to data centre chilled-water cooling specification, and a light reason a person in the contact\'s role might care. Be specific to the work, do not say they fit a profile.');
  }
  lines.push(g.icpReason ? `Why this account scored: ${g.icpReason}.` : `ICP reason: not recorded.`);
  if (g.product?.length) {
    lines.push('Product facts you may state (each with its citation), and nothing beyond these:');
    g.product.forEach((p, i) => lines.push(`  [P${i + 1}] ${p.snippet} (source: ${p.title}${p.page ? ', p' + p.page : ''})`));
  } else {
    lines.push('Product facts: none retrieved. Do not make any specific product claim; keep to a general, honest offer of help.');
  }
  return lines.join('\n');
}

const DRAFT_SYSTEM =
  "You write the first-touch cold-open email for Premier Control Technologies (PCT), a UK distributor of flow control products, for the Marwin data centre cooling campaign. " +
  "HARD RULE: you may state only what the GROUNDING supports. Do not invent or embellish anything about the prospect, their projects, sites or people beyond the signal given. Do not make a product claim that is not in the grounding. Do not reference proof, case studies, named customers or results unless they are in the grounding. Do not invent a mutual connection, prior conversation, referral or deadline. Do not manufacture urgency. If the grounding is thin, write less. " +
  "OPENER RULE: an administrative or routine register filing (a confirmation statement, annual accounts, an officer or registered-office change) is never given to the recipient as a reason for contact and is never mentioned, even though it is true; it may only tell us the account is worth approaching. Open on a real project event only when the grounding gives one to open on. " +
  "VOICE: plain technical British English, calm and restrained, one engineer flagging something relevant to a peer then getting out of the way. No opening pleasantries such as hoping the email finds them well, no hype, no superlatives, no closing pressure. No em dashes or en dashes, never the word genuinely, no exclamation marks. " +
  "STRUCTURE, four or five sentences total: an opening chosen by the grounding (if it gives a signal to open on, open on that event the way a person would; otherwise open on profile fit as the grounding directs, and do not mention any filing or signal); one relevant grounded line on why Marwin suits the application; a single light specific ask (a short call, or whether they are specifying flow control on the project); a plain sign-off as the PCT sales team. " +
  "Every factual sentence must trace to a grounding item. " +
  "Return strict JSON only, no preamble: {\"subject\":\"...\",\"body\":\"...\",\"claims\":[{\"text\":\"<factual sentence>\",\"supportedBy\":\"signal|icp|product|contact\"}]}. The body is plain text, short paragraphs separated by a blank line, no Markdown.";

// Generate one grounded cold-open draft. Returns subject, body and the model's
// own list of which grounding item supports each factual claim.
export async function draftColdOpen(grounding, { callModel = callClaude } = {}) {
  const raw = await callModel(DRAFT_SYSTEM, `GROUNDING (the only facts you may use):\n${renderGrounding(grounding)}\n\nWrite the cold-open email.`, { maxTokens: 700 });
  const parsed = parseJsonObject(raw);
  const subject = outboundVoice(parsed.subject || '');
  const body = outboundVoice(parsed.body || '');
  if (!subject || !body) throw new Error('draft missing subject or body');
  return { subject, body, claims: Array.isArray(parsed.claims) ? parsed.claims : [], model: MODEL };
}

const CHECK_SYSTEM =
  "You are a strict fact-checker for an outbound sales email. You are given the GROUNDING, the only facts the email is permitted to assert, and the EMAIL. " +
  "List every factual claim the email makes about the prospect, their project or site, the product, any proof or result, or a relationship. For each, decide whether the GROUNDING directly supports it. " +
  "Generic courtesy, a plain offer of help and the ask itself are not factual claims. Be strict: if a claim is not clearly supported by the grounding, mark it unsupported. A claim that names a specific project detail, a product capability, a proof point or a relationship not in the grounding is unsupported. " +
  "Return strict JSON only: {\"claims\":[{\"text\":\"<claim, quoted from the email>\",\"supported\":true|false,\"by\":\"signal|icp|product|contact|null\"}]}.";

// Pure: the claims the checker marked unsupported, quoted. Testable offline.
export function findUnsupported(claims) {
  return (claims || []).filter(c => c && c.supported === false).map(c => String(c.text || '').trim()).filter(Boolean);
}

// The safety pass. Re-derives the claims independently of the drafter and returns
// any the grounding does not support.
export async function checkGrounding(draft, grounding, { callModel = callClaude } = {}) {
  const user = `GROUNDING:\n${renderGrounding(grounding)}\n\nEMAIL:\nSubject: ${draft.subject}\n\n${draft.body}`;
  const parsed = parseJsonObject(await callModel(CHECK_SYSTEM, user, { maxTokens: 700 }));
  const claims = Array.isArray(parsed.claims) ? parsed.claims : [];
  return { claims, unsupported: findUnsupported(claims) };
}

const REVISE_SYSTEM =
  "Revise the cold-open email to remove or correct the listed unsupported claims, keeping only what the GROUNDING supports. Same voice and rules: plain British English, no em or en dashes, never genuinely, no exclamation marks, no hype, no invented facts. It is better to say less than to keep an unsupported claim. " +
  "Return strict JSON only: {\"subject\":\"...\",\"body\":\"...\",\"claims\":[{\"text\":\"...\",\"supportedBy\":\"signal|icp|product|contact\"}]}.";

async function reviseDraft(draft, grounding, unsupported, { callModel = callClaude } = {}) {
  const user = `GROUNDING:\n${renderGrounding(grounding)}\n\nCURRENT EMAIL:\nSubject: ${draft.subject}\n\n${draft.body}\n\nUNSUPPORTED CLAIMS TO REMOVE OR CORRECT:\n${unsupported.map(u => '- ' + u).join('\n')}`;
  const parsed = parseJsonObject(await callModel(REVISE_SYSTEM, user, { maxTokens: 700 }));
  return { subject: outboundVoice(parsed.subject || ''), body: outboundVoice(parsed.body || ''), claims: Array.isArray(parsed.claims) ? parsed.claims : [], model: MODEL };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Supplier-naming guardrail on the final text: redact any blocked (non-nameable)
// supplier name the grounding carried, the same policy the co-pilot applies.
export function applySupplierGuardrail(text, blocked) {
  let out = String(text || '');
  const removed = [];
  for (const name of blocked || []) {
    if (!name) continue;
    const re = new RegExp(`\\b${escapeRe(name)}\\b`, 'gi');
    if (re.test(out)) { removed.push(name); out = out.replace(re, 'our supplier'); }
  }
  return { text: out, removed };
}

// The full pipeline: draft, check, one revision if needed, re-check, then the
// supplier guardrail. Returns the final text plus the flags the reviewer must
// see. A draft is never returned as clean while unsupported claims remain.
export async function composeDraft(grounding, { callModel = callClaude } = {}) {
  let draft = await draftColdOpen(grounding, { callModel });
  let check = await checkGrounding(draft, grounding, { callModel });
  if (check.unsupported.length) {
    draft = await reviseDraft(draft, grounding, check.unsupported, { callModel });
    check = await checkGrounding(draft, grounding, { callModel });
  }
  const s = applySupplierGuardrail(draft.subject, grounding.blockedSuppliers);
  const b = applySupplierGuardrail(draft.body, grounding.blockedSuppliers);
  const redacted = [...new Set([...s.removed, ...b.removed])];
  const flags = [...check.unsupported, ...redacted.map(n => `supplier name redacted: ${n}`)];
  return { subject: s.text, body: b.text, model: draft.model, claims: draft.claims, flags };
}
