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
  // Range positioning, the cold open leads on this, not on one valve or its specs.
  // These are the standing, grounded facts the email may state.
  lines.push('Range positioning, lead on this, not on a single part number or its specifications:');
  lines.push('  PCT supplies the Marwin and Steriflow control valve ranges, suited to and trusted in data centre cooling.');
  lines.push('  Track record, state in general form and with confidence: Marwin and Steriflow control valves are already used across some of the largest data centre builds.');
  lines.push('  Hard limit: never name or imply a specific data centre operator or end customer. "Some of the largest data centre builds" is the ceiling of specificity.');
  lines.push('  Do not make any part-specific spec claim (pressure rating, material, temperature) in the cold open.');
  return lines.join('\n');
}

const DRAFT_SYSTEM =
  "You write the first-touch cold-open email for Premier Control Technologies (PCT), a UK supplier of flow control products, for the data centre cooling campaign. PCT is a supplier, not a distributor. " +
  "HARD RULE: you may state only what the GROUNDING supports. Do not invent or embellish anything about the prospect, their projects, sites or people beyond the signal given. Do not make a product claim that is not in the grounding. Do not reference proof, case studies, named customers or results unless they are in the grounding. Do not invent a mutual connection, prior conversation, referral or deadline. Do not manufacture urgency. If the grounding is thin, write less. " +
  "OPENER RULE: an administrative or routine register filing (a confirmation statement, annual accounts, an officer or registered-office change) is never given to the recipient as a reason for contact and is never mentioned, even though it is true; it may only tell us the account is worth approaching. Open on a real project event only when the grounding gives one to open on. " +
  "POSITIONING RULE: open a conversation about a trusted range, not a data sheet for one valve. Position the Marwin and Steriflow control valve ranges as suited to and trusted in the application. Do NOT lead on a single part number, and do NOT assert any part-specific specification in a cold open, no pressure rating, no material suitability, no temperature figure. Specifics belong in a live conversation, not a first approach. " +
  "TRACK RECORD: you may state, confidently and in general form, that Marwin and Steriflow control valves are already used across some of the largest data centre builds. CONFIDENTIALITY RULE, absolute: never name or imply any specific data centre operator or end customer. 'Some of the largest data centre builds' is the ceiling of specificity. No 'a major US hyperscaler', no 'a well-known search company', no named operator, nothing that points to a specific customer. " +
  "VOICE: plain technical British English, calm and restrained, one engineer flagging something relevant to a peer then getting out of the way. No opening pleasantries such as hoping the email finds them well, no hype, no superlatives, no closing pressure. No em dashes or en dashes, never the word genuinely, no exclamation marks. " +
  "STRUCTURE, four or five sentences total: an opening chosen by the grounding (if it gives a signal to open on, open on that event the way a person would; otherwise open on profile fit as the grounding directs, and do not mention any filing or signal); one line positioning the Marwin and Steriflow control valve ranges as trusted for data centre cooling, including the general track record across some of the largest data centre builds, with no named customer and no part-specific spec; a single light specific ask (a short call, or whether they are specifying flow control on the project). " +
  "NO SIGN-OFF, absolute: the email ends on the ask. No name, no team line, no company line, no web address, no phone number, no contact details of any kind; the sender's signature is appended by the system after approval, and a web address you write would be invented. " +
  "Every factual sentence must trace to a grounding item. " +
  "Return strict JSON only, no preamble: {\"subject\":\"...\",\"body\":\"...\",\"claims\":[{\"text\":\"<factual sentence>\",\"supportedBy\":\"signal|icp|range|contact\"}]}. The body is plain text, short paragraphs separated by a blank line, no Markdown.";

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
// any the grounding does not support. groundingText widens the permitted facts
// for the later email types (a follow-up may restate what we already sent; a
// response may draw on the reply and the corpus extracts) without touching the
// cold-open path.
export async function checkGrounding(draft, grounding, { callModel = callClaude, groundingText = null } = {}) {
  const user = `GROUNDING:\n${groundingText || renderGrounding(grounding)}\n\nEMAIL:\nSubject: ${draft.subject}\n\n${draft.body}`;
  const parsed = parseJsonObject(await callModel(CHECK_SYSTEM, user, { maxTokens: 700 }));
  const claims = Array.isArray(parsed.claims) ? parsed.claims : [];
  return { claims, unsupported: findUnsupported(claims) };
}

const REVISE_SYSTEM =
  "Revise the outbound email to remove or correct the listed unsupported claims, keeping only what the GROUNDING supports. Same voice and rules: plain British English, no em or en dashes, never genuinely, no exclamation marks, no hype, no invented facts. It is better to say less than to keep an unsupported claim. " +
  "Return strict JSON only: {\"subject\":\"...\",\"body\":\"...\",\"claims\":[{\"text\":\"...\",\"supportedBy\":\"signal|icp|product|contact\"}]}.";

async function reviseDraft(draft, grounding, unsupported, { callModel = callClaude, groundingText = null } = {}) {
  const user = `GROUNDING:\n${groundingText || renderGrounding(grounding)}\n\nCURRENT EMAIL:\nSubject: ${draft.subject}\n\n${draft.body}\n\nUNSUPPORTED CLAIMS TO REMOVE OR CORRECT:\n${unsupported.map(u => '- ' + u).join('\n')}`;
  const parsed = parseJsonObject(await callModel(REVISE_SYSTEM, user, { maxTokens: 700 }));
  return { subject: outboundVoice(parsed.subject || ''), body: outboundVoice(parsed.body || ''), claims: Array.isArray(parsed.claims) ? parsed.claims : [], model: MODEL };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Web addresses in a draft body. The drafters are told the email ends on the
// ask and the signature owns identity, so any address a draft carries is
// either invented (the model once wrote www.pct.co.uk, which is not PCT's
// site) or copied from a grounding source that has no place in a prospect
// email. Only the configured booking link is permitted. TLD-bounded so part
// numbers and figures never false-positive.
const LINK_RE = /https?:\/\/[^\s)>,;]+|www\.[^\s)>,;]+|\b[a-z0-9][a-z0-9-]*\.(?:com|co\.uk|org\.uk|net|org|io|ai|uk|de|fr|eu)(?:\/[^\s)>,;]*)?/gi;
export function findLinks(text) {
  return [...new Set(String(text || '').match(LINK_RE) || [])];
}
const sameLink = (a, b) => {
  const norm = s => String(s || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  return norm(a) === norm(b) || (norm(b) && norm(a).startsWith(norm(b)));
};

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

// End-customer confidentiality guardrail, alongside the supplier-naming one. The
// data centre track record is sayable in general form, but the specific operators
// are never named or implied. This flags a draft that names or points at a
// specific end customer; the flag is blocking, such a draft cannot be approved.
const END_CUSTOMER_NAMES = [
  'google', 'alphabet', 'microsoft', 'azure', 'amazon', 'aws', 'meta', 'facebook',
  'apple', 'oracle', 'openai', 'anthropic', 'tiktok', 'bytedance', 'tencent', 'alibaba', 'nvidia', 'hyperscaler',
];
const END_CUSTOMER_PHRASES = [
  'a major us', 'well-known search', "world's biggest tech", "world's largest tech", 'major tech firm', 'major hyperscaler',
];
export function flagEndCustomers(text, recipientName) {
  const hay = String(text || '').toLowerCase();
  const recipient = String(recipientName || '').toLowerCase();
  const hits = [];
  for (const name of END_CUSTOMER_NAMES) {
    if (recipient && recipient.includes(name)) continue; // the recipient's own name is the addressee, not an end customer
    if (new RegExp(`\\b${escapeRe(name)}\\b`, 'i').test(hay)) hits.push(name);
  }
  for (const ph of END_CUSTOMER_PHRASES) if (hay.includes(ph)) hits.push(ph);
  return [...new Set(hits)];
}

// The shared finishing pipeline for every outbound email type: check, one
// revision if needed, re-check, then the supplier and end-customer guardrails.
// Returns the final text plus the flags the reviewer must see. A draft is never
// returned as clean while unsupported claims or a named end customer remain.
export async function finaliseDraft(draft, grounding, { callModel = callClaude, groundingText = null } = {}) {
  let check = await checkGrounding(draft, grounding, { callModel, groundingText });
  if (check.unsupported.length) {
    draft = await reviseDraft(draft, grounding, check.unsupported, { callModel, groundingText });
    check = await checkGrounding(draft, grounding, { callModel, groundingText });
  }
  const s = applySupplierGuardrail(draft.subject, grounding.blockedSuppliers);
  const b = applySupplierGuardrail(draft.body, grounding.blockedSuppliers);
  const redacted = [...new Set([...s.removed, ...b.removed])];
  // A named end customer is a blocking fault: the track record is general, the
  // operator is never named. The "blocking" prefix makes the review refuse approval.
  const named = [...new Set([...flagEndCustomers(b.text, grounding.company?.name), ...flagEndCustomers(s.text, grounding.company?.name)])];
  // Any web address except the booking link blocks approval until removed:
  // the signature owns identity, and an address the model wrote is invented.
  const meetingLink = String(process.env.MEETING_LINK || '').trim();
  const links = findLinks(`${s.text}\n${b.text}`).filter(u => !(meetingLink && sameLink(u, meetingLink)));
  const flags = [
    ...check.unsupported,
    ...redacted.map(n => `supplier name redacted: ${n}`),
    ...named.map(n => `blocking: names or implies a specific end customer (${n}); the operator must never be named`),
    ...links.map(u => `blocking: web address in the draft (${u}); remove it, the signature owns identity and only the booking link may appear`),
  ];
  return { subject: s.text, body: b.text, model: draft.model, claims: draft.claims, flags };
}

// The cold-open pipeline: draft, then the shared finishing pass.
export async function composeDraft(grounding, { callModel = callClaude } = {}) {
  const draft = await draftColdOpen(grounding, { callModel });
  return finaliseDraft(draft, grounding, { callModel });
}
