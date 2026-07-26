// The campaign registry, and the proof that migrating the data centre campaign
// into it changed nothing. The originals below are the exact strings that were
// hardcoded in relevance.mjs and draft.mjs before this work; the assembled
// strings must equal them character for character. If a future edit to the
// shared scaffolding drifts, this fails loudly rather than quietly rewording a
// gate that took several calibration rounds to get right.
import { allCampaigns, getCampaign, requireCampaign, activeCampaignIds, listCampaigns } from './registry.mjs';
import { buildGateSystem, buildDraftSystem, buildRangeLines, confidentialityRule } from './prompts.mjs';
import { canColdOpen, crossCampaignDays } from '../outbound/crossCampaign.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = rel => readFileSync(join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  pass  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); fail++; }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
function assertSame(actual, expected, what) {
  if (actual === expected) return;
  const a = String(actual), b = String(expected);
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  throw new Error(`${what} differs at character ${i}\n  assembled: ${JSON.stringify(a.slice(Math.max(0, i - 40), i + 60))}\n  original:  ${JSON.stringify(b.slice(Math.max(0, i - 40), i + 60))}`);
}

// The gate prompt exactly as relevance.mjs held it before the registry.
const ORIGINAL_GATE_SYSTEM =
  "You classify a news result for a UK flow-control distributor that sells into data centre cooling, through the contractors and engineers building UK data centres. " +
  "Return strict JSON only: {\"dcRelevant\": true|false, \"geoScope\": \"uk_project\"|\"expansion_watch\"|\"foreign_only\"|null, \"operator\": \"<the data centre operator or contractor named, or null>\"}. " +
  "Answer TWO gating questions, in order and independently. dcRelevant is true ONLY if BOTH are yes. Answer QUESTION 1 first on its own; a valid-looking contract or financing on the event side does not excuse a subject that is not a data centre. " +
  "Both questions are about the story's PRIMARY subject, the one the headline names and the piece is mainly about. A passing mention of a different data centre project elsewhere in the text, for example in a league table or roundup listing other contractors' wins, a list of other deals, or related-story links, does NOT make the story about a data centre. If the primary subject is not a data centre, reject, even when a real data centre project is name-checked later in the body; that project will have its own story. " +
  "QUESTION 1, the subject: is the thing being built, financed or contracted a data centre, a data centre campus, or a hyperscale or colocation facility? A residential or resi (housing) scheme, a school, leisure, office, hospital, retail, fulfilment or distribution centre or care home, or any non data centre construction, fails here and is rejected even when the headline is a real construction or contract win. Resi means residential. If the subject is not a data centre, dcRelevant is false. On a construction, contract or job headline the subject must be recognisably a data centre to pass; if you cannot confirm the subject is a data centre, including an unfamiliar or abbreviated term, default to reject rather than pass on the strength of the event. " +
  "QUESTION 2, the event: is this a real build event, the data centre being built, contracted, or financed, invested in or expanded as a specific data centre or campus? KEEP financing, investment, funding or expansion that attaches to an actual data centre or campus, for example a data centre campus securing financing, or a data centre operator funding an expansion or build-out. REJECT events that are not a build, and commentary not tied to a specific data centre or campus: an opposition or community meeting, a moratorium, ban or objection, a survey or report, an opinion or comment piece, a tax or policy debate, a court case, a leadership or staffing change, and generic sector financing, share, markets or outlook commentary not attached to a specific data centre build, for example convertible notes raised for a general data centre push. An equipment or component supply agreement to a data centre operator, for example generators or cooling kit, is a supplier's commercial news, not the data centre being built, and is rejected. The test for the event is whether the money or expansion attaches to an actual data centre or campus: if it does, keep; if it is sector mood music or a non-build event, reject. " +
  "Mentioning data centres is necessary but not sufficient, both questions must be yes. On any doubt about the subject reject; a financing or expansion clearly attached to a data centre or campus passes the event gate. " +
  "When the content is empty, thin, truncated or subscription and paywall boilerplate rather than the article itself, judge on the title alone, applying both questions to it: a title that clearly states a data centre build, financing for a build, or capacity expansion passes, and thin content is not by itself a reason to reject a clear title. " +
  "If dcRelevant is false, geoScope, operator and foreignLocation are null. " +
  "If dcRelevant is true, route by the UK dimension, not the operator's nationality: uk_project when a data centre is being built, financed or contracted in the UK, whoever owns it; foreign_only ONLY when the signal is clearly tied to a specific named non-UK location with no UK or expansion angle, and then you must name that place in foreignLocation (for example France, Jakarta, Maharashtra); expansion_watch for everything else that passed the gate, including a real data centre operator expanding or raising finance where the geography is unclear. " +
  "foreign_only requires positive evidence of a specific foreign location. Absent that, a real operator's expansion or financing event is expansion_watch, never foreign_only. When in doubt between expansion_watch and foreign_only, choose expansion_watch. " +
  "Once the gate has confirmed a real data centre operator with a build, financing or expansion event, the signal is kept; geography only decides the bucket, never whether to drop it. With no specific named foreign location the stable bucket is expansion_watch. Do not reject such a confirmed signal, and do not route it foreign_only without a named foreign location.";

// The drafter prompt exactly as draft.mjs held it before the registry.
const ORIGINAL_DRAFT_SYSTEM =
  "You write the first-touch cold-open email for Premier Control Technologies (PCT), a UK supplier of flow control products, for the data centre cooling campaign. PCT is a supplier, not a distributor. " +
  "HARD RULE: you may state only what the GROUNDING supports. Do not invent or embellish anything about the prospect, their projects, sites or people beyond the signal given. Do not make a product claim that is not in the grounding. Do not reference proof, case studies, named customers or results unless they are in the grounding. Do not invent a mutual connection, prior conversation, referral or deadline. Do not manufacture urgency. If the grounding is thin, write less. " +
  "OPENER RULE: an administrative or routine register filing (a confirmation statement, annual accounts, an officer or registered-office change) is never given to the recipient as a reason for contact and is never mentioned, even though it is true; it may only tell us the account is worth approaching. Open on a real project event only when the grounding gives one to open on. " +
  "POSITIONING RULE: open a conversation about a trusted range, not a data sheet for one valve. Position the Marwin and Steriflow control valve ranges as suited to and trusted in the application. Do NOT lead on a single part number, and do NOT assert any part-specific specification in a cold open, no pressure rating, no material suitability, no temperature figure. Specifics belong in a live conversation, not a first approach. " +
  "TRACK RECORD: you may state, confidently and in general form, that Marwin and Steriflow control valves are already used across some of the largest data centre builds. CONFIDENTIALITY RULE, absolute: never name or imply any specific data centre operator or end customer. 'Some of the largest data centre builds' is the ceiling of specificity. No 'a major US hyperscaler', no 'a well-known search company', no named operator, nothing that points to a specific customer. " +
  "VOICE: plain technical British English, calm and restrained, one engineer flagging something relevant to a peer then getting out of the way. No opening pleasantries such as hoping the email finds them well, no hype, no superlatives, no closing pressure. No em dashes or en dashes, never the word genuinely, no exclamation marks. " +
  "GREETING: when the contact's name is given, the body begins 'Dear ' then their first name and a comma, on its own line. With no name given, begin with no greeting at all; never invent a name and never write Dear Sir or Madam. " +
  "STRUCTURE, four or five sentences total: an opening chosen by the grounding (if it gives a signal to open on, open on that event the way a person would; otherwise open on profile fit as the grounding directs, and do not mention any filing or signal); one line positioning the Marwin and Steriflow control valve ranges as trusted for data centre cooling, including the general track record across some of the largest data centre builds, with no named customer and no part-specific spec; a single light specific ask (a short call, or whether they are specifying flow control on the project). " +
  "NO SIGN-OFF, absolute: the email ends on the ask. No name, no team line, no company line, no web address, no phone number, no contact details of any kind; the sender's signature is appended by the system after approval, and a web address you write would be invented. " +
  "Every factual sentence must trace to a grounding item. " +
  "Return strict JSON only, no preamble: {\"subject\":\"...\",\"body\":\"...\",\"claims\":[{\"text\":\"<factual sentence>\",\"supportedBy\":\"signal|icp|range|contact\"}]}. The body is plain text, short paragraphs separated by a blank line, no Markdown.";

// The four range positioning lines exactly as renderGrounding pushed them.
const ORIGINAL_RANGE_LINES = [
  'Range positioning, lead on this, not on a single part number or its specifications:',
  '  PCT supplies the Marwin and Steriflow control valve ranges, suited to and trusted in data centre cooling.',
  '  Track record, state in general form and with confidence: Marwin and Steriflow control valves are already used across some of the largest data centre builds.',
  '  Hard limit: never name or imply a specific data centre operator or end customer. "Some of the largest data centre builds" is the ceiling of specificity.',
  '  Do not make any part-specific spec claim (pressure rating, material, temperature) in the cold open.',
];

const ORIGINAL_CONFIDENTIALITY =
  "CONFIDENTIALITY RULE, absolute: never name or imply any specific data centre operator or end customer. 'Some of the largest data centre builds' is the ceiling of specificity.";

// The orbit titles exactly as orbitRules.mjs held them, order included, because
// the people-search keys on the first eight and a reordering would quietly
// change who gets found.
const ORIGINAL_ORBIT_TITLES = [
  'design engineer', 'building services', 'mechanical engineer', 'mep',
  'controls', 'hvac', 'project manager', 'commissioning engineer',
  'cooling', 'chilled water', 'water', 'mechanical design', 'project engineer',
  'programme manager', 'program manager', 'm&e', 'design manager', 'design director',
  'head of engineering', 'engineering manager', 'engineering director',
  'technical director', 'projects director', 'project director', 'construction director',
  'data design',
  'estimator', 'contracts manager', 'preconstruction', 'pre-construction',
  'pre construction', 'cost manager', 'cost management',
  'specification', 'procurement', 'category manager',
];

console.log('The campaign registry:');

check('campaigns load from files, and an unknown id is refused', () => {
  const all = allCampaigns();
  assert(all.length >= 1, 'at least one campaign is defined');
  assert(getCampaign('marwin_dc'), 'the data centre campaign loads');
  assert(getCampaign('MARWIN_DC'), 'the id is matched case-insensitively');
  assert(getCampaign('nope') === null, 'an unknown id returns null, never a default');
  assert(getCampaign('') === null, 'an empty id returns null');
  let threw = false;
  try { requireCampaign('nope'); } catch { threw = true; }
  assert(threw, 'the strict form throws rather than falling back to a campaign');
  assert(activeCampaignIds().includes('marwin_dc'), 'the data centre campaign is active');
  assert(listCampaigns().every(c => c.id && c.displayName && c.status), 'the listing carries id, name and status');
});

check('a campaign definition carries every field the machinery reads', () => {
  for (const c of allCampaigns()) {
    for (const path of ['grounding.lines', 'grounding.retrievalFocus', 'icp.companyTypes', 'icp.weights',
                        'signals.sweepQueries', 'signals.gate.subjectTest', 'signals.gate.eventTest',
                        'positioning.trustLine', 'positioning.confidentialityRule', 'orbitTitles']) {
      const v = path.split('.').reduce((o, k) => (o == null ? o : o[k]), c);
      assert(v != null && (!Array.isArray(v) || v.length), `${c.id} is missing ${path}`);
    }
    assert(Array.isArray(c.grounding.lines) && c.grounding.lines.length, `${c.id} names its grounding lines`);
    assert(c.icp.weights && Object.values(c.icp.weights).reduce((a, b) => a + b, 0) === 100,
      `${c.id} ICP weights sum to 100`);
  }
});

console.log('\nThe data centre campaign, migrated and unchanged:');

check('the assembled gate prompt is the original, byte for byte', () => {
  assertSame(buildGateSystem(requireCampaign('marwin_dc')), ORIGINAL_GATE_SYSTEM, 'the gate system prompt');
});

check('the assembled drafter prompt is the original, byte for byte', () => {
  assertSame(buildDraftSystem(requireCampaign('marwin_dc')), ORIGINAL_DRAFT_SYSTEM, 'the draft system prompt');
});

check('the range positioning lines and the confidentiality rule are unchanged', () => {
  const lines = buildRangeLines(requireCampaign('marwin_dc'));
  assert(lines.length === ORIGINAL_RANGE_LINES.length, 'the same number of range lines');
  lines.forEach((l, i) => assertSame(l, ORIGINAL_RANGE_LINES[i], `range line ${i + 1}`));
  assertSame(confidentialityRule(requireCampaign('marwin_dc')), ORIGINAL_CONFIDENTIALITY, 'the confidentiality rule');
});

check('the migrated sweep queries and ICP config match what the code held', () => {
  const c = requireCampaign('marwin_dc');
  assert(c.signals.sweepQueries.length === 5, 'five sweep queries, as before');
  assert(c.signals.sweepQueries[0].query === 'UK data centre planning permission granted hyperscale colocation campus', 'the first query is unchanged');
  assert(c.signals.sweepQueries[3].type === 'news_contract', 'the fit-out query stays a contract signal');
  assert(JSON.stringify(c.icp.companyTypes) === JSON.stringify(['dc_developer', 'me_contractor', 'end_client']), 'the company types are unchanged');
  assert(JSON.stringify(c.icp.weights) === JSON.stringify({ namedAccount: 25, typeFit: 25, signals: 30, chHealth: 20 }), 'the weights are unchanged');
  assert(JSON.stringify(c.icp.signalTypes) === JSON.stringify(['news_dc_build', 'news_contract', 'planning']), 'the scoring signal types are unchanged');
  assert(c.icp.noSignalReason === 'no data centre build or contract signals', 'the no-signal reason is unchanged');
  assert(JSON.stringify(c.orbitTitles) === JSON.stringify(ORIGINAL_ORBIT_TITLES),
    'the orbit titles are the original list, in the original order');
  assert(c.orbitTitles.slice(0, 8).join('|') === 'design engineer|building services|mechanical engineer|mep|controls|hvac|project manager|commissioning engineer',
    'the first eight still lead with the cooling roles the people-search keys on');
});

console.log('\nThe pharma campaign, a deliberately tight first cut:');

check('pharma is defined, active, and scoped to the sanitary corpus', () => {
  const p = requireCampaign('pharma_steriflow');
  assert(p.status === 'active', 'pharma is active');
  assert(JSON.stringify(p.grounding.lines) === JSON.stringify(['steriflow', 'steriflow_fb', 'low_flow']),
    'the grounding scope names the sanitary lines in the chunk vocabulary');
  assert(!p.grounding.lines.includes('marwin'), 'a pharma draft cannot ground in Marwin material');
  assert(!requireCampaign('marwin_dc').grounding.lines.some(l => p.grounding.lines.includes(l)),
    'and the two scopes do not overlap, so neither campaign can cite the other');
  assert(p.links.rangePage === 'steriflow_page', 'it offers the Steriflow range page');
});

check('the pharma trust line is the corpus-grounded sentence and nothing stronger', () => {
  const p = requireCampaign('pharma_steriflow');
  assert(p.positioning.trustLine === 'Steriflow valves are widely used across pharmaceutical and biotech production.',
    'the approved sentence, exactly');
  assert(!/largest|leading|world|biggest|top /i.test(p.positioning.trustLine), 'no superlative crept in');
  const draft = buildDraftSystem(p);
  assert(/never name or imply any specific pharmaceutical or biotech manufacturer or end customer/.test(draft),
    'the confidentiality rule names the right kind of customer');
  assert(/ceiling of specificity/.test(draft), 'and states the ceiling');
  assert(!/data centre/i.test(draft), 'no data centre wording leaks into the pharma drafter');
});

check('the pharma gate is biased to reject and refuses non-facility events', () => {
  const g = buildGateSystem(requireCampaign('pharma_steriflow'));
  for (const phrase of ['default to reject', 'hospital', 'university', 'warehouse', 'pure research',
                        'drug approval', 'clinical trial results', 'company financial results',
                        'merger, acquisition']) {
    assert(g.toLowerCase().includes(phrase.toLowerCase()), `the gate names ${phrase}`);
  }
  assert(/even when a pharmaceutical company is the client/i.test(g),
    'a real client on a non-facility build does not carry the subject test');
  assert(!/data centre campus securing financing/i.test(g), 'the DC calibration examples do not leak in');
});

console.log('\nCross-campaign contact protection:');

check('a contact cold-opened by another campaign is held for the window', () => {
  const now = Date.parse('2026-07-26T09:00:00Z');
  const day = 86_400_000;
  const fresh = canColdOpen({ lastColdOpenAt: null, campaign: 'pharma_steriflow', now });
  assert(fresh.ok, 'a contact never cold-opened is open to any campaign');
  const held = canColdOpen({ lastColdOpenAt: new Date(now - 10 * day).toISOString(),
    lastColdOpenCampaign: 'marwin_dc', campaign: 'pharma_steriflow', now });
  assert(!held.ok, 'ten days after a data centre open, pharma is held');
  assert(/another campaign/.test(held.reason) && /marwin_dc/.test(held.reason), 'and the reason names the campaign');
  assert(held.waitDays === 80, 'with the days remaining of the ninety day window');
  const past = canColdOpen({ lastColdOpenAt: new Date(now - 91 * day).toISOString(),
    lastColdOpenCampaign: 'marwin_dc', campaign: 'pharma_steriflow', now });
  assert(past.ok, 'past the window it is open again');
  const same = canColdOpen({ lastColdOpenAt: new Date(now - 2 * day).toISOString(),
    lastColdOpenCampaign: 'marwin_dc', campaign: 'marwin_dc', now });
  assert(same.ok, 'the same campaign is governed by its own cadence, not this window');
  assert(crossCampaignDays() === 90, 'the default window is ninety days');
});

console.log('\nThe scoped views, so a switcher never labels mixed data:');

// A working switcher over a section that receives the campaign and does not
// filter on it is worse than no switcher: it puts one campaign's name above
// every campaign's rows. These two checks are static reads of the front end and
// the API, because the gate runs with no database and no browser.
check('every campaign-scoped section actually scopes its data', () => {
  const app = read('web/src/App.jsx');
  const m = app.match(/CAMPAIGN_SCOPED = new Set\(\[([^\]]*)\]/);
  assert(m, 'App declares which sections are campaign-scoped');
  const sections = [...m[1].matchAll(/'([a-z]+)'/g)].map(x => x[1]);
  assert(sections.length >= 6, 'and names them');
  for (const section of sections) {
    const file = `web/src/${section[0].toUpperCase()}${section.slice(1)}.jsx`;
    const src = read(file);
    assert(/function \w+\(\{[^}]*\bcampaign\b/.test(src), `${file} takes the campaign prop`);
    assert(new RegExp(`<${section[0].toUpperCase()}${section.slice(1)}[^>]*campaign=\\{campaign\\}`, 's').test(app),
      `App passes the campaign to ${section}`);
    // Insights fetches every campaign at once and splits client-side, which is
    // still scoping; everything else must send the campaign to the API.
    if (/\/api\/insights\/campaigns/.test(src)) continue;
    assert(/withCampaign\(|params\.set\('campaign'/.test(src), `${file} sends the campaign to the API`);
    const deps = [...src.matchAll(/\}, \[([^\]]*)\]\)/g)].map(x => x[1]);
    assert(deps.some(d => /\bcampaign\b/.test(d)), `${file} refetches when the campaign changes`);
  }
});

check('every signal type a campaign declares is filterable and has a label', () => {
  const server = read('src/server.mjs');
  const labels = read('web/src/labels.js');
  const filters = server.match(/const SIGNAL_FILTERS = \{([\s\S]*?)\};/);
  assert(filters, 'the server declares the signal filter buckets');
  for (const c of allCampaigns()) {
    for (const type of c.icp?.signalTypes || []) {
      assert(filters[1].includes(`'${type}'`), `${c.id} signal type ${type} is in a filter bucket`);
      assert(new RegExp(`\\b${type}:`).test(labels), `${c.id} signal type ${type} has a UI label`);
    }
  }
});

console.log('\nMigration 023, checked against the schema the earlier migrations declare:');

// The gate has no database, so it cannot run the migration; but the columns a
// backfill reads must exist in the tables the earlier migration files create,
// and that is a static fact. This exists because the first cut of the 023
// backfill selected score and score_reason from companies, the leads table's
// column names, and failed against the live database. companies holds
// icp_score and icp_breakdown.
check('the company_campaigns backfill selects only real companies columns', () => {
  const schema = read('src/migrations/003_research.sql');
  const table = schema.match(/CREATE TABLE IF NOT EXISTS companies \(([\s\S]*?)\n\);/);
  assert(table, '003 declares the companies table');
  const columns = new Set(table[1].split('\n')
    .map(l => l.replace(/--.*$/, '').trim())
    .filter(l => /^[a-z_]+\s/.test(l))
    .map(l => l.split(/\s+/)[0]));
  assert(columns.has('icp_score') && columns.has('icp_breakdown'), 'the parse found the scoring columns');

  const mig = read('src/migrations/023_campaigns.sql');
  const backfill = mig.match(/INSERT INTO company_campaigns[\s\S]*?SELECT ([\s\S]*?) FROM companies/);
  assert(backfill, '023 backfills company_campaigns from companies');
  for (const item of backfill[1].split(',').map(x => x.trim())) {
    if (/^'.*'$/.test(item)) continue; // a literal, the campaign id
    assert(item.startsWith('companies.'), `${item} is table-qualified`);
    const col = item.slice('companies.'.length);
    assert(columns.has(col), `companies.${col} exists in the declared schema`);
  }
});

check('every statement in 023 is guarded, so the file re-runs clean', () => {
  // Comments go first: a semicolon inside one would otherwise split a statement.
  const mig = read('src/migrations/023_campaigns.sql').replace(/--[^\n]*/g, '');
  const statements = mig.split(';').map(x => x.trim()).filter(Boolean);
  for (const st of statements) {
    const ok = /^(ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS|CREATE TABLE IF NOT EXISTS|CREATE INDEX IF NOT EXISTS)/.test(st)
      || (/^UPDATE /.test(st) && /IS NULL/.test(st))
      || (/^INSERT /.test(st) && /ON CONFLICT/.test(st));
    assert(ok, `unguarded statement: ${st.slice(0, 60)}`);
  }
});

console.log(`\n=== Campaign gate: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
