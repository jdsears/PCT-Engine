import { requireCampaign } from '../campaigns/registry.mjs';
import { buildGateSystem } from '../campaigns/prompts.mjs';

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

async function callClaude(system, user, { maxTokens = 300 } = {}) {
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

const SCOPES = new Set(['uk_project', 'expansion_watch', 'foreign_only']);

// The gate's wording now lives in the campaign definition and is assembled by
// buildGateSystem. The two-question structure, the default to reject and the
// geographic routing are shared scaffolding; each campaign supplies only its
// own subject and event tests. The campaign suite proves the assembled data
// centre prompt is byte for byte the one this file used to hold, because that
// calibration was earned over several rounds of real misclassification.

// One classification per result: the DC-relevance gate, the geographic routing,
// and the operator named, all in a single call. Conservative by construction:
// any parse failure or uncertainty resolves to dcRelevant false (rejected), so
// noise is never stored as a data centre signal.
export async function classifySignal(result, { callModel = callClaude, campaign = 'marwin_dc' } = {}) {
  const def = typeof campaign === 'string' ? requireCampaign(campaign) : campaign;
  // The search query is never shown to the classifier. It reads "UK data centre
  // construction contract awarded" and anchors a plain construction win into the
  // keep pile, which is how a residential job survived four calibrations. The
  // query stays in the payload for logging; the model judges title and content.
  const user = `Title: ${result.title || ''}\nContent: ${(result.content || '').slice(0, 1200)}`;
  let parsed;
  try { parsed = parseJson(await callModel(buildGateSystem(def), user, { maxTokens: 300 })); }
  catch { return { dcRelevant: false, geoScope: null, operator: null }; }

  const dcRelevant = parsed.dcRelevant === true;
  if (!dcRelevant) return { dcRelevant: false, geoScope: null, operator: null };
  let geoScope = SCOPES.has(parsed.geoScope) ? parsed.geoScope : 'expansion_watch';
  const foreignLocation = typeof parsed.foreignLocation === 'string' && parsed.foreignLocation.trim() ? parsed.foreignLocation.trim() : null;
  // foreign_only needs positive evidence of a specific non-UK location. Without
  // it, a real operator's ambiguous-geography event routes to expansion_watch,
  // the safe home that surfaces for review rather than being discarded.
  if (geoScope === 'foreign_only' && !foreignLocation) geoScope = 'expansion_watch';
  const operator = typeof parsed.operator === 'string' && parsed.operator.trim() ? parsed.operator.trim() : null;
  return { dcRelevant, geoScope, operator };
}
