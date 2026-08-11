import { voiceGate } from '../answer.mjs';
import { isOpenerGrade } from './openerGrade.mjs';
import { requireCampaign } from '../campaigns/registry.mjs';
import { buildDraftSystem, buildRangeLines } from '../campaigns/prompts.mjs';
import { approvedLinkList } from './links.mjs';
import { writtenCompanyName } from './companyName.mjs';
import { meetingLinks } from './senders.mjs';

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
export function renderGrounding(g, campaign = 'marwin_dc') {
  const def = typeof campaign === 'string' ? requireCampaign(campaign) : campaign;
  const lines = [];
  // The written form, so a Companies House name in capitals with LIMITED after
  // it never reaches a draft. The stored form stays on the register and in the
  // guardrails; only the prose the model may quote is presented.
  lines.push(`Company: ${writtenCompanyName(g.company?.name) || 'unknown'}${g.company?.region ? ', region ' + g.company.region : ''}.`);
  // The one relationship fact that changes a draft's register: the account
  // records say this company already buys from PCT. A cold introduction to an
  // existing customer reads as not knowing your own customers, which is worse
  // than no email. Prospects and unknowns keep the cold shape; only a recorded
  // customer changes it, and the grade is tone context, never something to
  // recite or build claims on.
  if (['a', 'b', 'c'].includes(g.company?.customerStatus)) {
    lines.push('This company is an existing PCT customer in the account records. Write as a supplier they already know: do not introduce PCT as if they had never heard of it and do not present this as first contact. Do not claim any specific purchase or order history, because none is recorded here.');
  }
  // Consultancies performance-specify and never purchase, a structure a live
  // operator reply spelt out: the spec is written by the operator and their
  // consultants, the buying happens through the contractors. An email to a
  // consultant about supply reads as not knowing how their industry works.
  if (g.company?.type === 'consultant') {
    lines.push('The recipient is at a design consultancy. Consultancies performance-specify flow control on their projects and never purchase it: write to specification fit, approved equals and design support, never to supply, stock or price.');
  }
  lines.push(g.contact?.name
    ? `Contact: ${g.contact.name}${g.contact.role ? ', ' + g.contact.role : ', role not recorded'}.`
    : `Contact: not recorded. Address a specifier or buyer in neutral terms, do not assume a role.`);
  // Grade decides the opening. Fall back to deriving it from the signal type so
  // an older grounding without the flag still classifies correctly.
  const openerGrade = g.openerGrade ?? isOpenerGrade(g.signal);
  if (g.signal && openerGrade) {
    lines.push(`Signal to open on, a real project event the recipient could have noticed: ${g.signal.text}${g.signal.source ? ' [source: ' + g.signal.source + ']' : ''}${g.signal.publishedAt ? ' [story date: ' + String(g.signal.publishedAt).slice(0, 10) + ']' : ''}. Open on this and do not present the story as newer than its date.`);
    // Which side of the story the recipient sits on. Without this a contractor
    // gets addressed as if they owned the campus, which reads as not having
    // read the article at all.
    if (g.signal.matchedAs === 'contractor') {
      lines.push('The recipient is at the contractor appointed or delivering the work in this signal, not the client whose facility it is. Write to the delivery side: their project, their specification decisions. Do not congratulate them on building their own facility.');
    } else if (g.signal.matchedAs === 'operator') {
      // Sharpened from a live operator reply, August 2026: operators and
      // their consultants performance-specify while their contractors do the
      // buying, so the owner-side email aims at the spec, not the order.
      lines.push('The recipient is at the operator or end client whose facility this signal describes. Write to the owner side of it: operators and their consultants performance-specify flow control while their contractors purchase it, so aim at the specification decision, never the purchase order.');
    }
  } else {
    if (g.signal) lines.push(`Context only, an administrative filing (${g.signal.type}). NEVER mention it to the recipient and never give it as a reason for contact; it only tells us the account is worth approaching.`);
    else lines.push('No project signal on file. Do not invent a reason for contact.');
    lines.push(`Open on profile fit: ${def.positioning.profileFitLine}`);
  }
  lines.push(g.icpReason ? `Why this account scored: ${g.icpReason}.` : `ICP reason: not recorded.`);
  // Range positioning, the cold open leads on this, not on one valve or its specs.
  // These are the standing, grounded facts the email may state.
  lines.push(...buildRangeLines(def));
  return lines.join('\n');
}

// The drafter's system prompt is assembled from the campaign's positioning
// pack. Everything protecting the reader, the voice, the greeting, the
// no-sign-off rule and the claim tracing is shared; the campaign supplies its
// phrase, its positioning and its confidentiality ceiling.

// Generate one grounded cold-open draft. Returns subject, body and the model's
// own list of which grounding item supports each factual claim.
export async function draftColdOpen(grounding, { callModel = callClaude, campaign = 'marwin_dc' } = {}) {
  const def = typeof campaign === 'string' ? requireCampaign(campaign) : campaign;
  const raw = await callModel(buildDraftSystem(def), `GROUNDING (the only facts you may use):\n${renderGrounding(grounding, def)}\n\nWrite the cold-open email.`, { maxTokens: 700 });
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
  // The checker judges against the same campaign's permitted facts the drafter
  // wrote from; the grounding carries which campaign that is.
  const user = `GROUNDING:\n${groundingText || renderGrounding(grounding, grounding.campaign || 'marwin_dc')}\n\nEMAIL:\nSubject: ${draft.subject}\n\n${draft.body}`;
  const parsed = parseJsonObject(await callModel(CHECK_SYSTEM, user, { maxTokens: 700 }));
  const claims = Array.isArray(parsed.claims) ? parsed.claims : [];
  return { claims, unsupported: findUnsupported(claims) };
}

const REVISE_SYSTEM =
  "Revise the outbound email to remove or correct the listed unsupported claims, keeping only what the GROUNDING supports. Same voice and rules: plain British English, no em or en dashes, never genuinely, no exclamation marks, no hype, no invented facts. It is better to say less than to keep an unsupported claim. " +
  "Return strict JSON only: {\"subject\":\"...\",\"body\":\"...\",\"claims\":[{\"text\":\"...\",\"supportedBy\":\"signal|icp|product|contact\"}]}.";

async function reviseDraft(draft, grounding, unsupported, { callModel = callClaude, groundingText = null } = {}) {
  const user = `GROUNDING:\n${groundingText || renderGrounding(grounding, grounding.campaign || 'marwin_dc')}\n\nCURRENT EMAIL:\nSubject: ${draft.subject}\n\n${draft.body}\n\nUNSUPPORTED CLAIMS TO REMOVE OR CORRECT:\n${unsupported.map(u => '- ' + u).join('\n')}`;
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
const normLink = s => String(s || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '')
  .replace(/[.,;:]+$/, '').replace(/\/+$/, '');
const sameLink = (a, b) => {
  return normLink(a) === normLink(b) || (normLink(b) && normLink(a).startsWith(normLink(b)));
};
// An address a draft may carry: the booking link (prefix match, it carries
// query parameters) or an approved PCT page matched exactly, so a deeper
// path invented under an approved page still blocks.
export function allowedLink(u) {
  // Any configured booking link passes, the global one or a rep's own: the
  // drafter is only ever shown the signer's, and a booking page is a PCT
  // destination whichever diary it lands in. Everything else still blocks.
  if (meetingLinks().some(l => sameLink(u, l))) return true;
  return approvedLinkList().some(a => normLink(u) === normLink(a));
}

// A trailing sign-off block, mechanically removed. The drafters are told not
// to sign off, but a model shown a thread containing an old sign-off will
// copy the example over the instruction, so the tail is cleaned
// deterministically: trailing paragraphs of short lines, none ending like a
// sentence, at least one looking like a sign-off marker (a valediction, a
// team or company line, a web address). A real closing ask ends with a full
// stop or question mark and is never touched.
const SIGNOFF_MARK = /\b(regards|thanks|thank you|sincerely|cheers|sales team|premier control technologies|\bpct\b)\b|www\.|https?:\/\/|\.(com|co\.uk|net|org)\b/i;
export function stripSignoff(body) {
  const paras = String(body || '').trim().split(/\n{2,}/);
  let removed = 0;
  while (paras.length > 1) {
    const lines = paras[paras.length - 1].split('\n').map(s => s.trim()).filter(Boolean);
    const shortLines = lines.length <= 6 && lines.every(l => l.split(/\s+/).length <= 7 && !/[.?!]$/.test(l));
    if (!(shortLines && lines.some(l => SIGNOFF_MARK.test(l)))) break;
    paras.pop();
    removed++;
  }
  return { body: paras.join('\n\n'), removed };
}

// The greeting, guaranteed rather than hoped for: a cold open begins
// "Dear First," and the lighter thread emails begin "First,". The model is
// instructed to open this way, and this normaliser makes it certain: a
// missing greeting is prepended, a bare or Hi/Hello lead-in is upgraded to
// the house form, an existing correct one passes through, and with no name
// on file nothing is ever invented. An inline continuation ("Michael,
// understood, and...") is preserved, only the lead-in token changes.
export function ensureGreeting(body, fullName, { dear = false } = {}) {
  const first = String(fullName || '').trim().split(/\s+/)[0];
  const b = String(body || '').trim();
  if (!first || !b) return b;
  const greet = dear ? `Dear ${first},` : `${first},`;
  const lead = new RegExp(`^(?:dear\\s+|hi\\s+|hello\\s+)?${escapeRe(first)}\\s*,?`, 'i');
  if (lead.test(b)) return b.replace(lead, greet);
  return `${greet}\n\n${b}`;
}

// Re-run the deterministic guardrails against edited text, so a human fix
// clears a stored flag and an unfixed fault keeps it, honestly. Only the
// mechanical rules re-run here: the model's unsupported-claim advisories
// describe the text as drafted, and once a person has edited, authorship is
// theirs; the absolute rules (end customers, blocked suppliers, web
// addresses) hold whoever wrote the words.
export function reflagText({ subject = '', body = '', grounding = {} }) {
  const text = `${subject}\n${body}`;
  const links = findLinks(text).filter(u => !allowedLink(u));
  const named = [...new Set(flagEndCustomers(text, grounding?.company?.name))];
  const suppliers = (Array.isArray(grounding?.blockedSuppliers) ? grounding.blockedSuppliers : [])
    .filter(n => n && text.toLowerCase().includes(String(n).toLowerCase()));
  return [
    ...named.map(n => `blocking: names or implies a specific end customer (${n}); the operator must never be named`),
    ...suppliers.map(n => `blocking: names a supplier that may not be named (${n})`),
    ...links.map(u => `blocking: web address not on the approved list (${u}); only the booking link and the approved PCT pages may appear, never a manufacturer site`),
  ];
}

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
// One company, several names: the recipient exemption must cover the
// recipient's known aliases as well as their registered name. Learned live
// on the first sending day, when a draft addressed to Amazon WEB Services
// Emea Sarl was blocked for saying AWS, the recipient's own abbreviation
// for themselves. Discussing the addressee's own project under any of their
// names is the addressee, never an end-customer reference; the same names
// written to anyone else still block.
const END_CUSTOMER_ALIAS_GROUPS = [
  ['amazon', 'aws'], ['google', 'alphabet'], ['microsoft', 'azure'],
  ['meta', 'facebook'], ['bytedance', 'tiktok'],
];
function recipientCovers(recipient, name) {
  if (recipient.includes(name)) return true;
  return END_CUSTOMER_ALIAS_GROUPS.some(g => g.includes(name) && g.some(a => recipient.includes(a)));
}
export function flagEndCustomers(text, recipientName) {
  // URLs are the link rule's business, not the name rule's: an approved
  // address may lawfully contain a giant's name, bookings.cloud.microsoft
  // being Microsoft's own host for the reps' booking pages, which blocked
  // the first live response for naming an end customer nobody had named.
  // Stripping URLs here loses nothing, because any unapproved address still
  // blocks as a link in its own right.
  const hay = String(text || '').replace(LINK_RE, ' ').toLowerCase();
  const recipient = String(recipientName || '').toLowerCase();
  const hits = [];
  for (const name of END_CUSTOMER_NAMES) {
    if (recipient && recipientCovers(recipient, name)) continue; // the recipient's own name is the addressee, not an end customer
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
  // Clean a copied sign-off before the link check, so an address that only
  // lived in the sign-off goes quietly with it; a link in a real sentence
  // still blocks below.
  const swept = stripSignoff(draft.body);
  const s = applySupplierGuardrail(draft.subject, grounding.blockedSuppliers);
  const b = applySupplierGuardrail(swept.body, grounding.blockedSuppliers);
  const redacted = [...new Set([...s.removed, ...b.removed])];
  // A named end customer is a blocking fault: the track record is general, the
  // operator is never named. The "blocking" prefix makes the review refuse approval.
  const named = [...new Set([...flagEndCustomers(b.text, grounding.company?.name), ...flagEndCustomers(s.text, grounding.company?.name)])];
  // Any web address off the approved list blocks approval until removed. A
  // grounded link is not the same as an approved one: the documentation is
  // full of manufacturer addresses, and prospects are sent to PCT's own
  // pages, never a factory's.
  const links = findLinks(`${s.text}\n${b.text}`).filter(u => !allowedLink(u));
  const flags = [
    ...check.unsupported,
    ...(swept.removed ? ['a trailing sign-off block was removed; the signature is appended at send'] : []),
    ...redacted.map(n => `supplier name redacted: ${n}`),
    ...named.map(n => `blocking: names or implies a specific end customer (${n}); the operator must never be named`),
    ...links.map(u => `blocking: web address not on the approved list (${u}); only the booking link and the approved PCT pages may appear, never a manufacturer site`),
  ];
  return { subject: s.text, body: b.text, model: draft.model, claims: draft.claims, flags };
}

// The cold-open pipeline: draft, the shared finishing pass, then the
// guaranteed greeting.
export async function composeDraft(grounding, { callModel = callClaude } = {}) {
  // The grounding carries the lead's campaign; drafting on the default here
  // would write a pharma lead with the data centre positioning.
  const campaign = grounding.campaign || 'marwin_dc';
  const draft = await draftColdOpen(grounding, { callModel, campaign });
  const finished = await finaliseDraft(draft, grounding, { callModel });
  return { ...finished, body: ensureGreeting(finished.body, grounding.contact?.name, { dear: true }) };
}
