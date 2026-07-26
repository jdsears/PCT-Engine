// The lead-gen unlock, proven offline: two parties per signal, the matcher's
// three honest outcomes, proposals that only a human turns into accounts, and
// staleness as a computed flag. The relevance gate appears here only to prove
// it was not touched.
import { buildPartiesSystem, extractParties } from './parties.mjs';
import { matchParty, matchOperator, OPERATOR_ALIASES } from './match.mjs';
import { planPartyActions, proposalsPerRun, normName } from './partyActions.mjs';
import { staleDays, isStale, staleSql } from './staleness.mjs';
import { buildGateSystem } from '../campaigns/prompts.mjs';
import { requireCampaign } from '../campaigns/registry.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = rel => readFileSync(join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  pass  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); fail++; }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

console.log('Two parties per signal (pure, injected model):');

const asModel = payload => async () => JSON.stringify(payload);

await check('a contractor-appointment story yields both parties', async () => {
  const p = await extractParties(
    { title: 'Mace wins fit-out contract on Stellium Newcastle campus', content: '...' },
    { callModel: asModel({ operator: 'Stellium Data Centers', contractor: 'Mace' }) });
  assert(p.operator === 'Stellium Data Centers' && p.contractor === 'Mace', 'both parties returned');
});

await check('single-party headlines yield one and null, nothing inferred', async () => {
  const opOnly = await extractParties({ title: 'x' }, { callModel: asModel({ operator: 'Ark Data Centres', contractor: null }) });
  assert(opOnly.operator === 'Ark Data Centres' && opOnly.contractor === null, 'operator only');
  const conOnly = await extractParties({ title: 'x' }, { callModel: asModel({ operator: null, contractor: 'ISG' }) });
  assert(conOnly.operator === null && conOnly.contractor === 'ISG', 'contractor only');
  const literal = await extractParties({ title: 'x' }, { callModel: asModel({ operator: 'null', contractor: '  ' }) });
  assert(literal.operator === null && literal.contractor === null, 'string "null" and whitespace are null');
});

await check('any failure returns both null, never a guess', async () => {
  const bad = await extractParties({ title: 'x' }, { callModel: async () => 'not json at all' });
  assert(bad.operator === null && bad.contractor === null, 'a parse failure is both null');
  const thrown = await extractParties({ title: 'x' }, { callModel: async () => { throw new Error('down'); } });
  assert(thrown.operator === null && thrown.contractor === null, 'a thrown call is both null');
});

await check('the extraction prompt is its own, and the gate prompt is untouched', async () => {
  const parties = buildPartiesSystem('marwin_dc');
  assert(/Never infer one party from the other/.test(parties), 'the never-infer rule is stated');
  assert(/copy the name as printed/i.test(parties), 'names are copied, not normalised');
  assert(!/dcRelevant/.test(parties) && !/QUESTION 1/.test(parties), 'no gate wording leaks into the extraction');
  // The gate itself: byte-for-byte protection lives in the campaign suite; here
  // we prove this work did not add so much as a field to what the gate returns.
  // The word contractor has always been in the gate's prose ("the operator or
  // contractor named"); what must not appear is a contractor key in its JSON
  // contract, which is where an extension would have gone.
  const gate = buildGateSystem(requireCampaign('marwin_dc'));
  assert(!/"contractor"/.test(gate), 'the gate JSON contract gained no field');
  assert(/"operator"/.test(gate), 'and still asks for the operator it always did');
});

console.log('\nThe matcher, three honest outcomes:');

const REGISTER = [
  { id: 1, name: 'PURE DATA CENTRES GROUP LTD' },
  { id: 2, name: 'ARK DATA CENTRES LIMITED' },
  { id: 3, name: 'VOLTA HOLDINGS LIMITED' },
  { id: 4, name: 'VOLTA GREAT SUTTON LIMITED' },
];

await check('matched, unknown and ambiguous are distinct outcomes', async () => {
  const m = matchParty('Pure DC', REGISTER);
  assert(m.status === 'matched' && m.company.id === 1, 'the alias-seeded brand matches one account');
  assert(matchParty('Kao Data', REGISTER).status === 'unknown', 'an unheard-of name is unknown, not null');
  const a = matchParty('Volta', REGISTER);
  assert(a.status === 'ambiguous' && a.candidates.length === 2, 'two plausible accounts are ambiguous, with the list');
});

await check('an alias learned as data resolves the same name next run', async () => {
  assert(matchParty('The Newcastle colo firm', REGISTER).status === 'unknown', 'unknown before the alias');
  const after = matchParty('The Newcastle colo firm', REGISTER, { aliases: { 'newcastle colo': 'ark data centres' } });
  assert(after.status === 'matched' && after.company.id === 2, 'the stored alias matches without a code change');
  assert(OPERATOR_ALIASES['pure dc'], 'the seeded map remains the floor');
});

await check('matchOperator keeps its original single-answer contract', async () => {
  assert(matchOperator('Pure DC', REGISTER)?.id === 1, 'one confident candidate links');
  assert(matchOperator('Volta', REGISTER) === null, 'ambiguous is null');
  assert(matchOperator('Kao Data', REGISTER) === null, 'unknown is null');
});

console.log('\nProposals: the engine proposes, a human decides:');

const state = () => ({ proposed: 0, cap: 2, known: (s => ({ has: k => s.has(k), add: k => s.add(k) }))(new Set()) });

await check('an unmatched party on a uk_project signal becomes a proposal', async () => {
  const acts = planPartyActions(
    { operator: 'Kao Data', contractor: null, geo_scope: 'uk_project' },
    { operator: { status: 'unknown' }, contractor: null }, state());
  assert(acts.some(a => a.act === 'propose' && a.party === 'operator'), 'proposed');
  assert(acts.some(a => a.act === 'count'), 'and counted in telemetry');
});

await check('expansion_watch unknowns are counted, never proposed', async () => {
  const acts = planPartyActions(
    { operator: 'Kao Data', contractor: null, geo_scope: 'expansion_watch' },
    { operator: { status: 'unknown' }, contractor: null }, state());
  assert(!acts.some(a => a.act === 'propose'), 'no proposal off a watch signal');
  assert(acts.some(a => a.act === 'count'), 'but the miss is visible');
});

await check('ambiguous never links and never proposes; it goes to review', async () => {
  const acts = planPartyActions(
    { operator: 'Volta', contractor: null, geo_scope: 'uk_project' },
    { operator: { status: 'ambiguous', candidates: [{ id: 3 }, { id: 4 }] }, contractor: null }, state());
  assert(!acts.some(a => a.act === 'link'), 'no link');
  assert(!acts.some(a => a.act === 'propose'), 'no proposal');
  assert(acts.some(a => a.act === 'review_ambiguous' && a.candidates.length === 2), 'a review row with the candidates');
});

await check('both parties act independently, and matched only ever links', async () => {
  const acts = planPartyActions(
    { operator: 'Ark', contractor: 'Winvic', geo_scope: 'uk_project' },
    { operator: { status: 'matched', company: { id: 2 } }, contractor: { status: 'unknown' } }, state());
  assert(acts.some(a => a.act === 'link' && a.party === 'operator' && a.companyId === 2), 'the operator links');
  assert(acts.some(a => a.act === 'propose' && a.party === 'contractor'), 'the contractor proposes');
  assert(!acts.some(a => a.act === 'count' && a.party === 'operator'), 'a matched party is not an unmatched name');
});

await check('the per-run cap holds and the excess is counted, not lost', async () => {
  const st = state();
  const one = (name, i) => planPartyActions(
    { operator: name, contractor: null, geo_scope: 'uk_project' },
    { operator: { status: 'unknown' }, contractor: null }, st);
  const all = ['A Ltd', 'B Ltd', 'C Ltd', 'D Ltd'].flatMap(one);
  assert(all.filter(a => a.act === 'propose').length === 2, 'exactly the cap proposes');
  assert(all.filter(a => a.act === 'over_cap').length === 2, 'the excess is explicit');
  assert(all.filter(a => a.act === 'count').length === 4, 'every miss is still counted');
});

await check('a reviewed name, dismissed included, is never proposed again', async () => {
  const st = state();
  st.known.add(normName('Kao Data'));
  const acts = planPartyActions(
    { operator: 'Kao Data', contractor: null, geo_scope: 'uk_project' },
    { operator: { status: 'unknown' }, contractor: null }, st);
  assert(!acts.some(a => a.act === 'propose'), 'no re-proposal');
  assert(acts.some(a => a.act === 'count'), 'the recurrence still counts, so frequency stays honest');
});

await check('the default cap is small and configurable', async () => {
  assert(proposalsPerRun() === 5, 'five per run unless PROPOSALS_PER_RUN says otherwise');
});

console.log('\nProposals stay outside the engine until confirmed (static):');

await check('nothing in the research run creates a company', async () => {
  const src = read('src/research/runResearch.mjs');
  assert(!/INSERT INTO companies/i.test(src), 'the run proposes into party_reviews, never into companies');
  assert(/INSERT INTO party_reviews/.test(src), 'proposals land in the review table');
  const sweep = read('src/research/newsResearch.mjs');
  assert(!/INSERT INTO companies/i.test(sweep), 'the sweep stores signals only');
});

await check('only the confirm and merge routes touch the register, and no spend paths', async () => {
  const src = read('src/server.mjs');
  const reviewBlock = src.slice(src.indexOf("The review queue"), src.indexOf("app.get('/api/signals'"));
  assert(/INSERT INTO companies/.test(reviewBlock), 'confirm creates the account');
  assert(!/findymail|linkedin|unipile/i.test(reviewBlock), 'no Findymail, no LinkedIn at proposal or confirm');
  assert(/searchCompanies/.test(reviewBlock), 'Companies House enrichment is the read-only kind');
});

console.log('\nStaleness, a flag over the scoring, not a formula:');

await check('an aged lead is stale and a new signal or human action clears it', async () => {
  const now = Date.parse('2026-07-26T09:00:00Z');
  assert(isStale({ updatedAt: '2026-02-01', now, days: 120 }), 'no movement for over the window is stale');
  assert(!isStale({ updatedAt: '2026-02-01', newestSignalAt: '2026-07-01', now, days: 120 }), 'a new signal clears it');
  assert(!isStale({ updatedAt: '2026-07-20', newestSignalAt: '2026-01-01', now, days: 120 }), 'a human action clears it');
  assert(!isStale({ updatedAt: null, newestSignalAt: null, now, days: 120 }), 'nothing known is not the same as known old');
});

await check('the window is campaign config, default 120 days', async () => {
  assert(staleDays('marwin_dc') === 120 && staleDays('pharma_steriflow') === 120, 'both campaigns carry the default');
  assert(staleDays({ staleness: { days: 45 } }) === 45, 'a campaign can shorten it');
  assert(staleDays({}) === 120, 'absent config falls back');
});

await check('drafting excludes stale leads by default and only by default', async () => {
  const sql = staleSql('l', '$4');
  assert(/contractor_company_id = l\.company_id/.test(sql), 'activity counts both linkage sides');
  const src = read('src/outbound/generateDrafts.mjs');
  assert(/includeStale = false/.test(src), 'the default is exclusion');
  assert(/includeStale \? .TRUE. : `NOT \$\{staleSql/.test(src.replace(/\n/g, ' ')) || src.includes("includeStale ? 'TRUE' : `NOT ${staleSql"), 'the clause flips on the option, not on a constant');
});

console.log('\nThe gate, the pacing and the spend rules, untouched (static):');

await check('the gate path is wired to nothing from this work', async () => {
  // The byte-for-byte prompt proof lives in the campaign suite. The invariant
  // here is wiring: neither the gate nor the prompt assembly imports or calls
  // the party extraction, so no code path can smuggle the second party into
  // the calibrated judgement.
  const rel = read('src/research/relevance.mjs');
  assert(!/parties\.mjs|extractParties|buildPartiesSystem/.test(rel), 'relevance.mjs never touches the extraction');
  const prompts = read('src/campaigns/prompts.mjs');
  assert(!/parties\.mjs|extractParties|buildPartiesSystem/.test(prompts), 'prompt assembly never touches the extraction');
});

await check('people-discovery pacing is untouched', async () => {
  const src = read('src/research/peopleDiscovery.mjs');
  assert(!/party_review|proposal|contractor/i.test(src), 'people discovery knows nothing of proposals');
});

console.log(`\n=== Lead-gen gate: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
