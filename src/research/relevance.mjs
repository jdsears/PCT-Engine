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

const SYSTEM =
  "You classify a news result for a UK flow-control distributor that sells into data centre cooling, through the contractors and engineers building UK data centres. " +
  "Decide three things and return strict JSON only: {\"dcRelevant\": true|false, \"geoScope\": \"uk_project\"|\"expansion_watch\"|\"foreign_only\"|null, \"operator\": \"<the data centre operator or contractor named, or null>\"}. " +
  "dcRelevant is true ONLY if the result is genuinely about a data centre development, build, campus, capacity expansion, or a contract on one. A school, care home, office, hospital, fulfilment or distribution centre, leisure or residential scheme, a court case, or any non data centre story is dcRelevant false. The word in a search query does not count; judge the actual story. " +
  "If dcRelevant is false, geoScope and operator are null. " +
  "If dcRelevant is true, set geoScope by the UK dimension, not the operator's nationality: uk_project when a data centre is being built, financed or contracted in the UK whoever owns it; expansion_watch when a real data centre operator is expanding and a UK site is plausible though not named yet; foreign_only when the build is wholly in another country with no UK or expansion angle. " +
  "When the UK angle is unclear but the named party is a real data centre operator that is expanding, choose expansion_watch, not uk_project and not foreign_only. When in doubt about dcRelevant at all, choose false.";

// One classification per result: the DC-relevance gate, the geographic routing,
// and the operator named, all in a single call. Conservative by construction:
// any parse failure or uncertainty resolves to dcRelevant false (rejected), so
// noise is never stored as a data centre signal.
export async function classifySignal(result, { callModel = callClaude } = {}) {
  const user = `Title: ${result.title || ''}\nContent: ${(result.content || '').slice(0, 1200)}\nSearch query that found it: ${result.query || ''}`;
  let parsed;
  try { parsed = parseJson(await callModel(SYSTEM, user, { maxTokens: 300 })); }
  catch { return { dcRelevant: false, geoScope: null, operator: null }; }

  const dcRelevant = parsed.dcRelevant === true;
  if (!dcRelevant) return { dcRelevant: false, geoScope: null, operator: null };
  const geoScope = SCOPES.has(parsed.geoScope) ? parsed.geoScope : 'expansion_watch';
  const operator = typeof parsed.operator === 'string' && parsed.operator.trim() ? parsed.operator.trim() : null;
  return { dcRelevant, geoScope, operator };
}
