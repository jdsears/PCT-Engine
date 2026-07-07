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
  "Answer TWO gating questions, in order and independently. dcRelevant is true ONLY if BOTH are yes. Answer QUESTION 1 first on its own; a valid-looking contract or financing on the event side does not excuse a subject that is not a data centre. " +
  "QUESTION 1, the subject: is the thing being built, financed or contracted a data centre, a data centre campus, or a hyperscale or colocation facility? A residential or resi (housing) scheme, a school, leisure, office, hospital, retail, fulfilment or distribution centre or care home, or any non data centre construction, fails here and is rejected even when the headline is a real construction or contract win. Resi means residential. If the subject is not a data centre, dcRelevant is false. On a construction, contract or job headline the subject must be recognisably a data centre to pass; if you cannot confirm the subject is a data centre, including an unfamiliar or abbreviated term, default to reject rather than pass on the strength of the event. " +
  "QUESTION 2, the event: is this a real build event, the data centre being built, contracted, or financed, invested in or expanded as a specific data centre or campus? KEEP financing, investment, funding or expansion that attaches to an actual data centre or campus, for example a data centre campus securing financing, or a data centre operator funding an expansion or build-out. REJECT events that are not a build, and commentary not tied to a specific data centre or campus: an opposition or community meeting, a moratorium, ban or objection, a survey or report, an opinion or comment piece, a tax or policy debate, a court case, a leadership or staffing change, and generic sector financing, share, markets or outlook commentary not attached to a specific data centre build, for example convertible notes raised for a general data centre push. An equipment or component supply agreement to a data centre operator, for example generators or cooling kit, is a supplier's commercial news, not the data centre being built, and is rejected. The test for the event is whether the money or expansion attaches to an actual data centre or campus: if it does, keep; if it is sector mood music or a non-build event, reject. " +
  "Mentioning data centres is necessary but not sufficient, both questions must be yes. On any doubt about the subject reject; a financing or expansion clearly attached to a data centre or campus passes the event gate. " +
  "When the content is empty, thin, truncated or subscription and paywall boilerplate rather than the article itself, judge on the title alone, applying both questions to it: a title that clearly states a data centre build, financing for a build, or capacity expansion passes, and thin content is not by itself a reason to reject a clear title. " +
  "If dcRelevant is false, geoScope, operator and foreignLocation are null. " +
  "If dcRelevant is true, route by the UK dimension, not the operator's nationality: uk_project when a data centre is being built, financed or contracted in the UK, whoever owns it; foreign_only ONLY when the signal is clearly tied to a specific named non-UK location with no UK or expansion angle, and then you must name that place in foreignLocation (for example France, Jakarta, Maharashtra); expansion_watch for everything else that passed the gate, including a real data centre operator expanding or raising finance where the geography is unclear. " +
  "foreign_only requires positive evidence of a specific foreign location. Absent that, a real operator's expansion or financing event is expansion_watch, never foreign_only. When in doubt between expansion_watch and foreign_only, choose expansion_watch. " +
  "Once the gate has confirmed a real data centre operator with a build, financing or expansion event, the signal is kept; geography only decides the bucket, never whether to drop it. With no specific named foreign location the stable bucket is expansion_watch. Do not reject such a confirmed signal, and do not route it foreign_only without a named foreign location.";

// One classification per result: the DC-relevance gate, the geographic routing,
// and the operator named, all in a single call. Conservative by construction:
// any parse failure or uncertainty resolves to dcRelevant false (rejected), so
// noise is never stored as a data centre signal.
export async function classifySignal(result, { callModel = callClaude } = {}) {
  // The search query is never shown to the classifier. It reads "UK data centre
  // construction contract awarded" and anchors a plain construction win into the
  // keep pile, which is how a residential job survived four calibrations. The
  // query stays in the payload for logging; the model judges title and content.
  const user = `Title: ${result.title || ''}\nContent: ${(result.content || '').slice(0, 1200)}`;
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
