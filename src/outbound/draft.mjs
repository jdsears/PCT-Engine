import { voiceGate } from '../answer.mjs';

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

// Outbound prose gets a stricter pass than chat answers: no exclamation marks on
// top of the shared voice gate (no em or en dashes, never "genuinely").
export function outboundVoice(text) {
  return voiceGate(String(text || '').replace(/!+/g, '.')).replace(/[ \t]+\./g, '.');
}

// True when the text is already clean of the banned marks. Used by the tests and
// as a final assertion before a draft is stored.
export function voiceClean(text) {
  return !/[—–!]/.test(text) && !/\bgenuinely\b/i.test(text);
}

const SYSTEM =
  "You write a short first-touch outreach email for Premier Control Technologies (PCT), a UK distributor of flow control products. " +
  "The campaign offers Marwin characterized control ball valves and control valves for data centre chilled-water cooling, with application sizing and short lead times. " +
  "Write to the named recipient in plain British English: warm, direct and brief, around 90 to 130 words. " +
  "Open by turning the one concrete reason for contact you are given into a natural opener. Do not embellish that reason or invent any other fact about the recipient, their company or their projects, and do not say PCT has been tracking or monitoring them. " +
  "Say briefly how PCT can help on data centre cooling, then close with a light, low-pressure ask for a short conversation. Sign off as the PCT sales team. " +
  "Do not use em dashes or en dashes. Never use the word genuinely. Do not use exclamation marks. No marketing hyperbole, no superlatives, no pushy language. Do not promise prices, figures or specifications. " +
  "Return strict JSON only, no preamble: {\"subject\": \"...\", \"body\": \"...\"}. The body is plain text with short paragraphs separated by a blank line and no Markdown.";

// Pull the first balanced JSON object out of the model's reply, tolerant of any
// stray text around it, and parse it.
function parseDraft(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in draft reply');
  return JSON.parse(raw.slice(start, end + 1));
}

// Generate one email from the assembled facts. The caller builds reasonLine from
// real research (a signal, the score reason); this layer only writes and cleans.
export async function draftForLead({ company, contact, reasonLine }) {
  const recipient = contact?.full_name
    ? `${contact.full_name}${contact.role_title ? ', ' + contact.role_title : ''} at ${company.name}`
    : `the relevant engineer or buyer at ${company.name}`;
  const user =
    `Recipient: ${recipient}.\n` +
    `The one concrete reason for contact (turn into a natural opener, do not embellish): ${reasonLine}.\n` +
    `What PCT can offer them: Marwin characterized control ball valves and control valves for data centre chilled-water cooling, supplied with application sizing and short lead times.\n` +
    `Write the email.`;

  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 600, system: SYSTEM, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`Claude draft failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const raw = (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  const parsed = parseDraft(raw);

  const subject = outboundVoice(parsed.subject || '');
  const body = outboundVoice(parsed.body || '');
  if (!subject || !body) throw new Error('draft missing subject or body');
  return { subject, body, model: MODEL };
}
