import { requireCampaign } from '../campaigns/registry.mjs';

// Two parties per signal.
//
// A contractor-appointment headline names two sellable parties: the operator
// whose facility it is and the contractor who won the work. The relevance gate
// returns one operator field, and its prompt is frozen, calibrated over several
// rounds of real misclassification and protected byte for byte by the campaign
// suite. So the second party does not come from the gate. This is a separate,
// smaller extraction that runs only on signals the gate has already kept: the
// gate decides what is real, this names who is in it. The gate's verdict, its
// routing and its prompt are never touched.
//
// Conservative by construction: only names printed in the text, never inferred,
// either party null when the text does not name it, and any failure returns
// both null rather than a guess.

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

async function callClaude(system, user, { maxTokens = 200 } = {}) {
  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`Claude failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

function parseJson(raw) {
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  if (s === -1 || e <= s) throw new Error('no JSON object');
  return JSON.parse(raw.slice(s, e + 1));
}

// The extraction prompt, assembled from the campaign so the nouns fit the
// sector, but sharing nothing with the gate prompt and asserting nothing about
// relevance. The story has already passed the gate when this runs.
export function buildPartiesSystem(campaign) {
  const def = typeof campaign === 'string' ? requireCampaign(campaign) : campaign;
  const g = def.signals.gate;
  return (
    `You extract the named parties from a news story about ${g.subjectNounPlural || g.subjectNoun + 's'}. ` +
    'Return strict JSON only: {"operator": "<name or null>", "contractor": "<name or null>"}. ' +
    `The operator is the ${g.operatorNoun.split(' or ')[0]} whose facility it is: the owner, developer or end client the work is for. ` +
    'The contractor is the construction, engineering or fit-out firm named as appointed, awarded, contracted or delivering the work. ' +
    'Rules, all strict. Name a party ONLY when the text prints its name; copy the name as printed. ' +
    'Never infer one party from the other, never guess from context, never fill a missing party with a landlord, investor, consultant or equipment supplier. ' +
    'If the story names only the facility owner, contractor is null. If it names only the appointed firm, operator is null. ' +
    'If you cannot tell which side a named company is on, put it on neither and return null for that side.'
  );
}

// A comma-or-and list of firms in one field, "Turner Construction, DPR
// Construction and Mortenson", is a joint venture reported as one string. The
// party columns hold one name a side, and the matcher cannot place a list, so
// it would count as a phantom unknown in the telemetry. We keep the first
// named as the primary party: on a build the first-named contractor is the
// lead or main contractor, the most sellable and the one a follow-up would
// name, and the same holds for a lead developer. The rest are dropped rather
// than invented into party rows the single-field model has no room for.
export function primaryParty(name) {
  const s = String(name || '').trim();
  if (!s) return null;
  // Split on commas and semicolons only. A reported joint venture is written
  // as a comma list, "Turner Construction, DPR Construction and Mortenson",
  // and the first named is the lead. An ampersand or a bare "and" with no
  // comma is left alone, because "Larsen & Toubro" and "Balfour Beatty and
  // Vinci" are single names, not lists, and splitting them would lose a real
  // company. The trailing "and Mortenson" of a comma list rides on the last
  // fragment, which is dropped anyway.
  const parts = s.split(/\s*[;,]\s*/).map(p => p.trim()).filter(Boolean);
  if (parts.length <= 1) return s;
  // A bare corporate suffix after a comma ("Turner Construction, Inc.") is
  // punctuation, not a list; keep the pair joined.
  if (/^(inc|inc\.|llc|ltd|ltd\.|limited|plc|llp|co|co\.|corp|corp\.|gmbh)$/i.test(parts[1])) return `${parts[0]}, ${parts[1]}`;
  return parts[0];
}

// Extract both parties from a kept signal. Injectable model call, offline
// testable; returns { operator, contractor }, either null, both null on any
// failure. The caller decides what to do with them; nothing is written here.
export async function extractParties(result, { callModel = callClaude, campaign = 'marwin_dc' } = {}) {
  const def = typeof campaign === 'string' ? requireCampaign(campaign) : campaign;
  const user = `Title: ${result.title || ''}\nContent: ${(result.content || '').slice(0, 1200)}`;
  let parsed;
  try { parsed = parseJson(await callModel(buildPartiesSystem(def), user, { maxTokens: 200 })); }
  catch { return { operator: null, contractor: null }; }
  const clean = v => (typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null' ? v.trim() : null);
  let operator = primaryParty(clean(parsed.operator));
  let contractor = primaryParty(clean(parsed.contractor));
  // A single-party event whose one party the model returned in both fields, as
  // the OXB manufacturing-partner signal did, is one party, not two. Keep the
  // operator and drop the echo, so the contractor side is not a duplicate.
  if (operator && contractor && operator.toLowerCase() === contractor.toLowerCase()) contractor = null;
  return { operator, contractor };
}
