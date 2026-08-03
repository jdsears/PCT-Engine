// The grounded drafter and its safety pass, exercised offline. A deterministic
// stand-in model is injected so the full draft -> check -> revise pipeline runs
// without a network or a key. The case that matters most is the planted
// fabrication being caught and surfaced, never stored as clean.
import { composeDraft, findUnsupported, applySupplierGuardrail, outboundVoice, voiceClean, renderGrounding, flagEndCustomers, findLinks, stripSignoff, reflagText, ensureGreeting } from './draft.mjs';
import { hasBlockingFlag } from './sendDecision.mjs';
import { isOpenerGrade, openerNote } from './openerGrade.mjs';
import { voiceGate } from '../answer.mjs';
import { promptLinksBlock } from './links.mjs';

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  pass  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); fail++; }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

// Route a fake reply by which system prompt it is. check/revise may be arrays for
// sequential calls. Objects are JSON-encoded, mimicking the model's raw reply.
function fakeModel(responses) {
  const n = { draft: 0, check: 0, revise: 0 };
  return async (system) => {
    const phase = /fact-checker/.test(system) ? 'check' : /^Revise the outbound/.test(system) ? 'revise' : 'draft';
    const r = responses[phase];
    const val = Array.isArray(r) ? r[Math.min(n[phase], r.length - 1)] : r;
    n[phase]++;
    return typeof val === 'string' ? val : JSON.stringify(val);
  };
}

const grounding = {
  leadId: 1, companyId: 1, contactId: 1, campaign: 'marwin_dc',
  company: { name: 'Aery Data Centres Ltd', type: 'dc_developer', region: 'RA-5' },
  contact: { id: 1, name: 'Sam Lee', role: 'M&E Lead', email: 's@aery.example' },
  signal: { id: 9, type: 'news_dc_build', text: 'Aery secured planning for a 40MW data centre in Slough', source: 'https://x.example/a' },
  icpReason: 'type dc_developer fits the campaign',
  product: [{ title: 'Marwin CV3000 datasheet', page: 3, sourceId: 'cv3000', snippet: 'characterized control ball valve for chilled water service' }],
  blockedSuppliers: [], missing: [],
};

console.log('Grounded cold-open drafter:');

await check('a fully grounded draft passes the check clean', async () => {
  const model = fakeModel({
    draft: { subject: 'Flow control for the Slough scheme', body: 'You secured planning in Slough.\n\nMarwin valves suit chilled water cooling.', claims: [{ text: 'Aery secured planning in Slough.', supportedBy: 'signal' }] },
    check: { claims: [{ text: 'Aery secured planning in Slough.', supported: true, by: 'signal' }] },
  });
  const out = await composeDraft(grounding, { callModel: model });
  assert(out.flags.length === 0, `expected no flags, got ${JSON.stringify(out.flags)}`);
  assert(out.subject && out.body, 'subject and body present');
});

await check('a planted fabrication is CAUGHT and surfaced, never stored clean', async () => {
  // The drafter invents a second site; the revision fails to remove it; the
  // re-check still flags it, so it must come back as a flag, not as clean.
  const model = fakeModel({
    draft: { subject: 'Slough and Dublin', body: 'You secured planning in Slough. You have also broken ground on a second site in Dublin.', claims: [{ text: 'broken ground in Dublin', supportedBy: 'signal' }] },
    check: { claims: [{ text: 'You have also broken ground on a second site in Dublin.', supported: false, by: null }] },
    revise: { subject: 'Slough and Dublin', body: 'You secured planning in Slough. You have also broken ground on a second site in Dublin.', claims: [] },
  });
  const out = await composeDraft(grounding, { callModel: model });
  assert(out.flags.length > 0, 'the fabrication must be flagged');
  assert(out.flags.some(f => /Dublin/.test(f)), `the Dublin fabrication must be surfaced, got ${JSON.stringify(out.flags)}`);
});

await check('a copied sign-off is stripped mechanically, noted, and the draft stays clean', async () => {
  // The live failure, second round: shown a thread with an old sign-off, the
  // model copies it over the instruction. The tail is removed
  // deterministically, the reviewer is told, and nothing blocks because the
  // invented address went with the sign-off.
  const model = fakeModel({
    draft: { subject: 'Flow control for the Slough scheme', body: 'You secured planning in Slough.\n\nWorth a short call.\n\nPCT Sales Team\nPremier Control Technologies\nwww.pct.co.uk', claims: [{ text: 'planning secured', supportedBy: 'signal' }] },
    check: { claims: [{ text: 'planning secured', supported: true, by: 'signal' }] },
  });
  const out = await composeDraft(grounding, { callModel: model });
  assert(!/pct\.co\.uk/.test(out.body) && !/Sales Team/.test(out.body), `the sign-off must be gone, got ${JSON.stringify(out.body)}`);
  assert(out.body.endsWith('Worth a short call.'), 'the closing ask survives');
  assert(out.flags.some(f => /sign-off block was removed/.test(f)), 'the removal is noted for the reviewer');
  assert(!hasBlockingFlag(out.flags), 'nothing blocks once the sign-off is gone');
});

await check('a web address in a real sentence still BLOCKS', async () => {
  const model = fakeModel({
    draft: { subject: 'Slough', body: 'You secured planning in Slough. More detail is at www.pct.co.uk if useful.\n\nWorth a short call.', claims: [] },
    check: { claims: [] },
  });
  const out = await composeDraft(grounding, { callModel: model });
  assert(out.flags.some(f => /^blocking: web address/.test(f)), `an in-sentence address must still block, got ${JSON.stringify(out.flags)}`);
  assert(hasBlockingFlag(out.flags), 'and the shared predicate agrees');
});

await check('a human edit re-checks the guardrails: a fixed body clears, an unfixed fault keeps its flag', async () => {
  const g = { company: { name: 'Aery Data Centres Ltd' }, blockedSuppliers: ['HiddenOEM'] };
  const dirty = reflagText({ subject: 'Slough', body: 'Our valves are on the Microsoft campus. See www.pct.co.uk.\nHiddenOEM make them.', grounding: g });
  assert(dirty.some(f => /microsoft/i.test(f)), 'the end customer still flags after an edit');
  assert(dirty.some(f => /pct\.co\.uk/.test(f)), 'the address still flags after an edit');
  assert(dirty.some(f => /HiddenOEM/.test(f)), 'the blocked supplier still flags after an edit');
  const clean = reflagText({ subject: 'Slough', body: 'You secured planning in Slough. Worth a short call.', grounding: g });
  assert(clean.length === 0, `a fixed body carries no flags, got ${JSON.stringify(clean)}`);
  const old = process.env.MEETING_LINK;
  process.env.MEETING_LINK = 'https://book.example/pct';
  const withLink = reflagText({ subject: 's', body: 'Book here: https://book.example/pct', grounding: g });
  assert(withLink.length === 0, 'the booking link never flags on an edit');
  if (old === undefined) delete process.env.MEETING_LINK; else process.env.MEETING_LINK = old;
});

await check('the greeting is guaranteed: Dear on cold opens, bare on thread emails, never invented', async () => {
  assert(ensureGreeting('You secured planning in Slough.', 'Sam Lee', { dear: true }) === 'Dear Sam,\n\nYou secured planning in Slough.', 'a missing greeting is prepended');
  assert(ensureGreeting('Sam,\n\nYou secured planning.', 'Sam Lee', { dear: true }) === 'Dear Sam,\n\nYou secured planning.', 'a bare greeting upgrades to Dear');
  assert(ensureGreeting('Hi Sam, quick thought on Slough.', 'Sam Lee', { dear: true }) === 'Dear Sam, quick thought on Slough.', 'Hi upgrades and the inline continuation survives');
  assert(ensureGreeting('Dear Sam,\n\nAs discussed.', 'Sam Lee', { dear: true }) === 'Dear Sam,\n\nAs discussed.', 'a correct greeting passes through');
  assert(ensureGreeting('Sam, understood, and that is common.', 'Sam Lee') === 'Sam, understood, and that is common.', 'a thread email keeps its inline register');
  assert(ensureGreeting('Worth a second look.', null, { dear: true }) === 'Worth a second look.', 'no name on file, no invented greeting');
  const composed = await composeDraft(grounding, { callModel: fakeModel({
    draft: { subject: 'Slough', body: 'You secured planning in Slough.\n\nWorth a short call.', claims: [] },
    check: { claims: [] },
  }) });
  assert(composed.body.startsWith('Dear Sam,'), `a cold open always opens Dear, got ${JSON.stringify(composed.body.slice(0, 30))}`);
});

await check('links: approved PCT pages pass, manufacturer sites block even when grounded', async () => {
  // Per James, July 2026: prospects are pointed at PCT's own pages, never a
  // factory's. A grounded manufacturer address is still the wrong address.
  const olds = { m: process.env.MEETING_LINK, o: process.env.OUTBOUND_LINKS };
  process.env.MEETING_LINK = 'https://cal.example/pct';
  delete process.env.OUTBOUND_LINKS;
  const flagsFor = body => reflagText({ subject: 's', body, grounding: {} }).filter(f => /web address/.test(f));
  assert(flagsFor('See https://www.pctflow.com/our-products/valves/steriflow/ for the range.').length === 0,
    'an approved PCT page passes');
  assert(flagsFor('Book here: https://cal.example/pct?x=1').length === 0, 'the booking link still passes');
  assert(flagsFor('Details at www.marwinvalve.com.').length === 1,
    'a manufacturer site blocks, grounded or not');
  assert(flagsFor('See https://www.pctflow.com/our-products/valves/steriflow/deep/invented/').length === 1,
    'an invented deeper path under an approved page blocks');
  assert(flagsFor('The range is at https://www.pctflow.com/our-products/valves/marwin-valve/.').length === 0,
    'the Marwin page John supplied passes, and its path is marwin-valve, not the guessable marwin');
  process.env.OUTBOUND_LINKS = JSON.stringify({ example_page: { url: 'https://www.pctflow.com/our-products/valves/example-range/', label: 'Example range page' } });
  assert(flagsFor('See https://www.pctflow.com/our-products/valves/example-range/.').length === 0,
    'a page added through the override passes without a deploy');
  process.env.OUTBOUND_LINKS = JSON.stringify({ evil: { url: 'https://marwinvalve.com/', label: 'nope' } });
  assert(flagsFor('Details at https://marwinvalve.com/.').length === 1,
    'the override can never approve a non-PCT address');
  process.env.OUTBOUND_LINKS = 'not json';
  assert(flagsFor('See https://www.pctflow.com/our-products/valves/steriflow/.').length === 0,
    'a malformed override changes nothing');
  assert(/steriflow/.test(promptLinksBlock()) && /Never any other web address/.test(promptLinksBlock()),
    'the drafter is shown the approved pages and the prohibition');
  for (const [k, v] of [['MEETING_LINK', olds.m], ['OUTBOUND_LINKS', olds.o]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

await check('stripSignoff never eats a real closing line', async () => {
  const ask = 'You secured planning in Slough.\n\nWould a short call this week be useful?';
  assert(stripSignoff(ask).removed === 0 && stripSignoff(ask).body === ask, 'a closing question is content, not a sign-off');
  const regards = 'Body paragraph here.\n\nKind regards\nJohn';
  assert(stripSignoff(regards).removed === 1 && stripSignoff(regards).body === 'Body paragraph here.', 'a valediction goes');
  assert(stripSignoff('Single paragraph only.').removed === 0, 'a lone paragraph is never stripped');
});

await check('the booking link is the one permitted address; part numbers never false-positive', async () => {
  const old = process.env.MEETING_LINK;
  process.env.MEETING_LINK = 'https://book.example/pct';
  const model = fakeModel({
    draft: { subject: 'Slough', body: 'You secured planning in Slough. A short call may help: https://book.example/pct', claims: [] },
    check: { claims: [] },
  });
  const out = await composeDraft(grounding, { callModel: model });
  assert(!out.flags.some(f => /web address/.test(f)), `the booking link must pass, got ${JSON.stringify(out.flags)}`);
  if (old === undefined) delete process.env.MEETING_LINK; else process.env.MEETING_LINK = old;
  assert(findLinks('The CV3861-10 at 3.5 bar suits the Mark 96.').length === 0, 'codes and figures are not links');
  assert(findLinks('see www.pct.co.uk or pctflow.com').length === 2, 'www and bare domains are both caught');
});

await check('a successful revision clears the flag and drops the invented claim', async () => {
  const model = fakeModel({
    draft: { subject: 'Slough', body: 'You secured planning in Slough. You have also broken ground in Dublin.', claims: [] },
    check: [
      { claims: [{ text: 'You have also broken ground in Dublin.', supported: false, by: null }] },
      { claims: [{ text: 'You secured planning in Slough.', supported: true, by: 'signal' }] },
    ],
    revise: { subject: 'Slough', body: 'You secured planning in Slough.', claims: [] },
  });
  const out = await composeDraft(grounding, { callModel: model });
  assert(out.flags.length === 0, `expected clean after revision, got ${JSON.stringify(out.flags)}`);
  assert(!/Dublin/.test(out.body), 'the fabrication must be gone from the body');
});

await check('findUnsupported returns only the claims marked unsupported, quoted', () => {
  const got = findUnsupported([{ text: 'a', supported: true }, { text: 'b', supported: false }, { text: '', supported: false }]);
  assert(JSON.stringify(got) === JSON.stringify(['b']), JSON.stringify(got));
});

console.log('\nGuardrail and voice on the final text:');

await check('the supplier guardrail redacts a blocked name and records it', () => {
  const g = applySupplierGuardrail('We work with FooOEM and Marwin.', ['FooOEM']);
  assert(!/FooOEM/.test(g.text) && /our supplier/.test(g.text), `redacted: ${g.text}`);
  assert(g.removed.includes('FooOEM'), 'records the removed name');
  const noop = applySupplierGuardrail('Marwin valves for cooling.', []);
  assert(noop.text === 'Marwin valves for cooling.' && noop.removed.length === 0, 'no blocked names is a no-op');
});

await check('composeDraft redacts a blocked supplier and flags the redaction', async () => {
  const model = fakeModel({
    draft: { subject: 'Valves', body: 'We supply FooOEM valves for cooling.', claims: [] },
    check: { claims: [] },
  });
  const out = await composeDraft({ ...grounding, blockedSuppliers: ['FooOEM'] }, { callModel: model });
  assert(!/FooOEM/.test(out.body), 'blocked supplier must be redacted from the body');
  assert(out.flags.some(f => /redacted/.test(f)), 'the redaction must be surfaced as a flag');
});

await check('the outbound voice strips dashes, exclamation marks and "genuinely"', () => {
  const v = outboundVoice('Great news — this is genuinely useful! Really useful!');
  assert(voiceClean(v), `not clean: ${v}`);
});

console.log('\nOpener-grade signals (no cold email opens on a fact only a scraper would cite):');

await check('real project-event types are opener-grade, register movements are not', () => {
  for (const t of ['news_dc_build', 'news_contract', 'planning'])
    assert(isOpenerGrade({ type: t }), `${t} should be opener-grade`);
  for (const t of ['ch_filing', 'ch_director_change', 'ch_officers', 'ch_incorporation'])
    assert(!isOpenerGrade({ type: t }), `${t} should not be opener-grade`);
  assert(!isOpenerGrade(null), 'null is not opener-grade');
  assert(isOpenerGrade({ signal_type: 'planning' }), 'accepts a raw row with signal_type');
});

await check('the review note reads correctly for an event and for a filing', () => {
  const ev = openerNote({ type: 'planning' }, true);
  assert(ev.kind === 'event' && /project event/.test(ev.text), ev.text);
  const fit = openerNote({ type: 'ch_filing' }, false);
  assert(fit.kind === 'fit' && /profile fit/.test(fit.text) && /routine filing/.test(fit.text), fit.text);
});

await check('the story date reaches the drafter, so age is never presented as news', () => {
  const base = { company: { name: 'Acme' }, contact: null, icpReason: null, product: [], blockedSuppliers: [], missing: [] };
  const dated = renderGrounding({ ...base, openerGrade: true,
    signal: { type: 'news_dc_build', text: 'campus approved', publishedAt: '2026-05-12T00:00:00Z' } });
  assert(dated.includes('[story date: 2026-05-12]'), 'a known date is shown to the drafter');
  assert(dated.includes('do not present the story as newer than its date'), 'with the instruction that goes with it');
  const undated = renderGrounding({ ...base, openerGrade: true,
    signal: { type: 'news_dc_build', text: 'campus approved' } });
  assert(!undated.includes('story date'), 'no date, no invented one');
});

await check('renderGrounding opens on a project event but marks a filing never-mention', () => {
  const base = { company: { name: 'Datum' }, contact: null, product: [], icpReason: null };
  const event = renderGrounding({ ...base, signal: { type: 'planning', text: 'planning granted for a Slough data centre' }, openerGrade: true });
  assert(/Signal to open on/.test(event) && /Open on this/.test(event), 'an event must be offered as the hook');

  const filing = renderGrounding({ ...base, signal: { type: 'ch_filing', text: 'filed a confirmation statement with updates' }, openerGrade: false });
  assert(/NEVER mention it/.test(filing), 'a filing must be marked never-mention');
  assert(!/Signal to open on/.test(filing), 'a filing must not be offered as the hook');
  assert(/profile fit/i.test(filing), 'a filing must instruct the profile-fit opening');
});

await check('a confirmation-statement lead drafts a filing-free opening', async () => {
  const grounding = {
    company: { name: 'Datum Datacentres', type: 'dc_developer', region: 'RA-5' },
    contact: { name: 'Sam Lee', role: 'M&E Lead' },
    signal: { type: 'ch_filing', text: 'Datum Datacentres filed a confirmation statement with updates' },
    openerGrade: false, icpReason: 'type dc_developer fits the campaign',
    product: [{ title: 'Marwin CV3000 datasheet', page: 3, snippet: 'characterized control ball valve for chilled water service' }],
    blockedSuppliers: [],
  };
  const model = fakeModel({
    draft: { subject: 'Flow control for your data centre cooling', body: 'Marwin control valves suit chilled water cooling specification on data centre projects. Worth a short call if you are specifying flow control.', claims: [] },
    check: { claims: [] },
  });
  const out = await composeDraft(grounding, { callModel: model });
  assert(!/confirmation statement|register|filing/i.test(out.body), `the opening must not cite the filing: ${out.body}`);
  assert(out.flags.length === 0, 'a clean profile-fit draft has no flags');
});

console.log('\nSupplier voice, range positioning, and end-customer confidentiality:');

await check('the voice gate rewrites PCT as a supplier and leaves technical distribution alone', () => {
  const a = voiceGate('PCT is a distributor of valves');
  assert(/\bsupplier\b/.test(a) && !/distributor/i.test(a), `distributor must become supplier: ${a}`);
  assert(/we supply/i.test(voiceGate('we distribute control valves')), 'we distribute must become we supply');
  assert(/Suppliers/.test(voiceGate('Distributors add cost')), 'leading-cap Distributors must become Suppliers');
  assert(/flow distribution header/.test(voiceGate('a flow distribution header')), 'technical distribution must be left alone');
});

await check('the cold-open grounding positions the range, not a single part specification', () => {
  const text = renderGrounding({ company: { name: 'Aery' }, contact: null, signal: null, icpReason: null,
    product: [{ title: 'CV3000 datasheet', page: 3, snippet: 'rated to 40 bar' }] });
  assert(/Marwin and Steriflow/.test(text), 'must lead on the ranges');
  assert(!/\[P1\]/.test(text) && !/40 bar/.test(text), 'must not present a per-part spec snippet');
  assert(/never name or imply a specific data centre operator/.test(text), 'must carry the confidentiality limit');
});

await check('a named operator or implying phrase is flagged, the recipient name is not', () => {
  assert(flagEndCustomers('used by Google on their builds', 'Aery').length > 0, 'Google must be flagged');
  assert(flagEndCustomers('trusted by a major US hyperscaler', 'Aery').includes('a major us'), 'the implying phrase must be flagged');
  assert(flagEndCustomers('valves for Oracle', 'Oracle Data Centres').length === 0, 'the recipient name is not an end-customer breach');
  assert(flagEndCustomers('used across some of the largest data centre builds', 'Aery').length === 0, 'the safe general form is clean');
});

await check('composeDraft makes a named end customer a BLOCKING flag, and passes the general form', async () => {
  const grounding = { company: { name: 'Aery Datacentres' }, contact: null, signal: null, icpReason: null, blockedSuppliers: [] };
  const named = await composeDraft(grounding, { callModel: fakeModel({
    draft: { subject: 'Cooling control valves', body: 'Marwin and Steriflow valves are used by Microsoft on major builds.', claims: [] },
    check: { claims: [] } }) });
  assert(named.flags.some(f => /^blocking/i.test(f)), 'a named operator must produce a blocking flag');

  const clean = await composeDraft(grounding, { callModel: fakeModel({
    draft: { subject: 'Cooling control valves', body: 'PCT supplies the Marwin and Steriflow ranges, already trusted across some of the largest data centre builds.', claims: [] },
    check: { claims: [] } }) });
  assert(!clean.flags.some(f => /^blocking/i.test(f)), 'the general track record must not be blocked');
});

console.log(`\n=== Outbound draft gate: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
