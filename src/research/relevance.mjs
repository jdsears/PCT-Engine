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
  "Return strict JSON only: {\"dcRelevant\": true|false, \"geoScope\": \"uk_project\"|\"expansion_watch\"|\"foreign_only\"|null, \"operator\": \"<the data centre operator or contractor named, or null>\", \"foreignLocation\": \"<the specific non-UK place, or null>\"}. " +
  "Answer TWO gating questions in order. dcRelevant is true ONLY if BOTH are yes. " +
  "QUESTION 1, the subject: is the thing in question a data centre, a data centre campus, or a hyperscale or colocation facility? Residential, resi, homes, housing, schools, leisure, offices, hospitals, retail, fulfilment or distribution centres, care homes and general construction are NOT data centres. If the subject is not a data centre, dcRelevant is false, even when the headline sounds like a project or construction win. " +
  "QUESTION 2, the event: is the story about that data centre being built, financed for a specific build, contracted, or expanded in capacity? An opposition or community meeting, a moratorium, ban or planning objection, a survey or report, an opinion or comment piece, a tax or policy debate, a court case, a leadership or staffing change, or generic financing, share or markets news not tied to a specific build are NOT build events. If the event is not a build, a financing for a specific build, a contract, or a capacity expansion, dcRelevant is false, even when data centres are mentioned. " +
  "Mentioning data centres is necessary but NOT sufficient, both questions must be yes, and on any doubt about either answer false. " +
  "If dcRelevant is false, geoScope, operator and foreignLocation are null. " +
  "If dcRelevant is true, route by the UK dimension, not the operator's nationality: uk_project when a data centre is being built, financed or contracted in the UK, whoever owns it; foreign_only ONLY when the signal is clearly tied to a specific named non-UK location with no UK or expansion angle, and then you must name that place in foreignLocation (for example France, Jakarta, Maharashtra); expansion_watch for everything else that passed the gate, including a real data centre operator expanding or raising finance where the geography is unclear. " +
  "foreign_only requires positive evidence of a specific foreign location. Absent that, a real operator's expansion or financing event is expansion_watch, never foreign_only. When in doubt between expansion_watch and foreign_only, choose expansion_watch.";

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
  let geoScope = SCOPES.has(parsed.geoScope) ? parsed.geoScope : 'expansion_watch';
  const foreignLocation = typeof parsed.foreignLocation === 'string' && parsed.foreignLocation.trim() ? parsed.foreignLocation.trim() : null;
  // foreign_only needs positive evidence of a specific non-UK location. Without
  // it, a real operator's ambiguous-geography event routes to expansion_watch,
  // the safe home that surfaces for review rather than being discarded.
  if (geoScope === 'foreign_only' && !foreignLocation) geoScope = 'expansion_watch';
  const operator = typeof parsed.operator === 'string' && parsed.operator.trim() ? parsed.operator.trim() : null;
  return { dcRelevant, geoScope, operator };
}
