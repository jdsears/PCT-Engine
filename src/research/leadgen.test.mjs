// The lead-gen unlock, proven offline: two parties per signal, the matcher's
// three honest outcomes, proposals that only a human turns into accounts, and
// staleness as a computed flag. The relevance gate appears here only to prove
// it was not touched.
import { buildPartiesSystem, extractParties, primaryParty } from './parties.mjs';
import { matchParty, matchOperator, OPERATOR_ALIASES } from './match.mjs';
import { planPartyActions, proposalsPerRun, normName } from './partyActions.mjs';
import { staleDays, isStale, staleSql } from './staleness.mjs';
import { companyTypeForParty } from './partyType.mjs';
import { pairDuplicates, sameCompany } from './duplicateAccounts.mjs';
import { scoreCompany } from './icp.mjs';
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

await check('the same name on both sides is one party, operator kept, contractor dropped', async () => {
  // The OXB manufacturing-partner signal returned OXB as both operator and
  // contractor on a single-party event.
  const p = await extractParties({ title: 'OXB selected as manufacturing partner' },
    { callModel: asModel({ operator: 'OXB', contractor: 'OXB' }) });
  assert(p.operator === 'OXB' && p.contractor === null, 'one party, not a duplicate');
});

await check('a joint-venture list keeps the first-named as the primary party', async () => {
  assert(primaryParty('Turner Construction, DPR Construction and Mortenson') === 'Turner Construction',
    'the lead contractor is the first named');
  assert(primaryParty('Larsen & Toubro, Shapoorji Pallonji, Tata Projects and NCC') === 'Larsen & Toubro',
    'a four-name comma list reduces to the first, and the ampersand inside that first name is left intact');
  assert(primaryParty('Balfour Beatty and Vinci') === 'Balfour Beatty and Vinci',
    'a two-firm name with no comma is left alone, not split on a bare and');
  assert(primaryParty('Turner Construction, Inc.') === 'Turner Construction, Inc.',
    'a corporate suffix after a comma is punctuation, not a list');
  assert(primaryParty('Skanska') === 'Skanska', 'a single name is unchanged');
  assert(primaryParty('') === null && primaryParty(null) === null, 'empty is null');
  // The extraction applies it, so a list never reaches the matcher as one name.
  const p = await extractParties({ title: 'JV appointed' },
    { callModel: asModel({ operator: 'Mercer County Authority', contractor: 'Turner, DPR and Mortenson' }) });
  assert(p.contractor === 'Turner', 'the stored contractor is a single matchable name');
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

console.log('\nA confirmed account must be able to become a lead:');

await check('the 35-point dead end is real, and the type is what fixes it', async () => {
  // The live run showed seven confirmed accounts at exactly 35 against a
  // threshold of 40: named 25, type 0, signals 0, CH health 10 neutral. The
  // queue could add an account but never produce a lead, which is its purpose.
  const untyped = { named_account: true, company_type: null, ch_profile: null };
  assert(scoreCompany(untyped, [], null, 'marwin_dc').score === 35,
    'an untyped confirmed account scores 35, under the 40 threshold');
  const typed = { ...untyped, company_type: 'me_contractor' };
  assert(scoreCompany(typed, [], null, 'marwin_dc').score === 60,
    'and 60 once typed, which clears it');
});

await check('each campaign declares what its parties are, and unknowns are null', async () => {
  assert(companyTypeForParty('marwin_dc', 'operator') === 'dc_developer', 'a DC operator develops data centres');
  assert(companyTypeForParty('marwin_dc', 'contractor') === 'me_contractor', 'a DC contractor is M&E');
  assert(companyTypeForParty('pharma_steriflow', 'operator') === 'pharma_manufacturer', 'a pharma operator manufactures');
  assert(companyTypeForParty('pharma_steriflow', 'contractor') === 'me_contractor', 'a pharma contractor is M&E too');
  assert(companyTypeForParty('no_such_campaign', 'operator') === null, 'an unknown campaign types nothing');
  // Declared, not positional: reordering companyTypes must not silently change
  // what a confirmed account becomes.
  for (const id of ['marwin_dc', 'pharma_steriflow']) {
    const def = requireCampaign(id);
    assert(def.icp.partyTypes?.operator && def.icp.partyTypes?.contractor, `${id} declares both parties`);
    for (const t of Object.values(def.icp.partyTypes)) {
      assert(def.icp.companyTypes.includes(t), `${id} maps a party to ${t}, which is in its own ICP vocabulary`);
    }
  }
});

await check('the confirm and merge routes set the type, and merge never overwrites one', async () => {
  const src = read('src/server.mjs');
  const block = src.slice(src.indexOf('The review queue'), src.indexOf("app.get('/api/signals'"));
  assert(/companyTypeForParty\(r\.campaign, r\.party\)/.test(block), 'the party decides the type');
  assert(/company_type = COALESCE\(company_type, \$2\)/.test(block), 'merge fills a missing type only');
  assert(/COALESCE\(companies\.company_type, EXCLUDED\.company_type\)/.test(block),
    'and a conflicting insert keeps the type already on the row');
});

console.log('\nDuplicate pairing, where a wrong pair deletes a real account:');

// The live register, exactly as the dry run printed it. The old rule stripped
// "uk" and "ltd" from "DATA CENTRE UK LTD", leaving "datacentre", then matched
// on bare substring containment, so every operator with "Data Centres" in its
// name paired with it. Applied without scoping, four real accounts would have
// been deleted and merged into one.
const LIVE_REGISTER = [
  { id: 119, name: 'DATA CENTRE UK LTD', ch_number: '06485189' },
  { id: 121, name: "PP O'CONNOR LIMITED", ch_number: '10411214' },
  { id: 13, name: 'Echelon Data Centres', ch_number: null },
  { id: 22, name: '4D Data Centres', ch_number: null },
  { id: 24, name: 'Custodian Data Centres', ch_number: null },
  { id: 118, name: 'Equans Data Centres', ch_number: null },
  { id: 132, name: "PP O'Connor", ch_number: null },
];

await check('four unrelated operators are never merged into one generic name', async () => {
  const { pairs, leftovers } = pairDuplicates(LIVE_REGISTER);
  assert(pairs.length === 1, `exactly one real duplicate, got ${pairs.length}`);
  assert(pairs[0].u.id === 132 && pairs[0].m.id === 121, 'and it is the PP O\u2019Connor pair');
  for (const name of ['Echelon Data Centres', '4D Data Centres', 'Custodian Data Centres', 'Equans Data Centres']) {
    assert(leftovers.some(l => l.name === name), `${name} is left alone`);
  }
});

await check('a name of only generic words identifies nothing', async () => {
  assert(sameCompany('DATA CENTRE UK LTD', 'Echelon Data Centres') === false, 'no distinctive tokens, no pair');
  assert(sameCompany('DATA CENTRE UK LTD', 'DATA CENTRE UK LTD') === false, 'not even with itself');
  assert(sameCompany("PP O'Connor", "PP O'CONNOR LIMITED") === true, 'the real duplicate still pairs');
});

await check('pairing is exact, so a longer real name is not eaten', async () => {
  assert(sameCompany('Skanska', 'Skanska Rail') === false, 'a subsidiary is a different company');
  assert(sameCompany('Mace', 'Mace Group Limited') === true, 'a corporate suffix and group are not identity');
});

await check('a twin claimed by two rows is left for a human, never guessed', async () => {
  const { pairs, contested } = pairDuplicates([
    { id: 1, name: 'ACME LIMITED', ch_number: '111' },
    { id: 2, name: 'Acme', ch_number: null },
    { id: 3, name: 'ACME', ch_number: null },
  ]);
  assert(pairs.length === 0, 'a contested twin pairs with neither');
  assert(contested.length === 1 && contested[0].claimants.length === 2, 'and is reported as contested');
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

console.log('\nThe confirm queue renders what Companies House returned:');

await check('a rendered candidate option is never empty when the API returned a title', async () => {
  const { searchResultRows, candidateRows } = await import('./companiesHouse.mjs');
  // A realistic Companies House search response, raw field names as the API
  // sends them. The bug this guards: re-mapping searchCompanies output with
  // these raw names a second time, which yields undefined name and number and
  // renders as an empty pair of brackets in the queue.
  const api = { items: [
    { title: 'KAO DATA LIMITED', company_number: '10870034', company_status: 'active', address_snippet: 'Harlow, Essex' },
    { title: 'KAO DATA CAMPUS LIMITED', company_number: '11417538', company_status: 'active' },
  ] };
  const rows = candidateRows(searchResultRows(api));
  assert(rows.length === 2, 'every returned entity survives');
  for (const r of rows) {
    assert(r.name && r.name.length > 0, 'the name is present');
    assert(r.chNumber && r.chNumber.length > 0, 'the number is present');
    assert(`${r.name} (${r.chNumber})`.length > 4, 'so the rendered option label cannot be empty');
  }
});

await check('a hand-entered company number shapes to the canonical form or refuses', async () => {
  const { cleanChNumber } = await import('./companiesHouse.mjs');
  // James's APT case: the right entity was findable but never suggested, so
  // the reviewer types the number. Companies House numbers are eight
  // characters; typed input arrives with spaces, lower case and dropped
  // leading zeros.
  assert(cleanChNumber('07053790') === '07053790', 'the live number passes as typed');
  assert(cleanChNumber(' 070 53790 ') === '07053790', 'spaces are stripped');
  assert(cleanChNumber('7053790') === '07053790', 'a dropped leading zero is restored');
  assert(cleanChNumber('sc123456') === 'SC123456', 'prefixed registrations upper-case');
  assert(cleanChNumber('123456789') === null, 'nine digits is not a number');
  assert(cleanChNumber('CYRUSONE') === null && cleanChNumber('') === null && cleanChNumber(null) === null, 'words and blanks refuse');
});

await check('the confirm route verifies a typed number and the add route guards the register (static)', async () => {
  const server = read('src/server.mjs');
  assert(/entered at review and verified/.test(server), 'a hand-entered confirm records how the number arrived');
  assert(/Companies House does not answer for/.test(server), 'an unverifiable number refuses plainly');
  const addBlock = server.slice(server.indexOf("app.post('/api/accounts'"), server.indexOf("app.get('/api/accounts'"));
  assert(/getCampaign\(String\(body\.campaign/.test(addBlock), 'the campaign resolves through the registry, never free text');
  assert(/matchParty\(name, register/.test(addBlock), 'the matcher guards the door against duplicates');
  assert(/source\)[\s\S]*'manual'/.test(addBlock), 'a hand-added account says where it came from');
  assert(/already on the register/.test(addBlock), 'an existing account is pointed at, never duplicated');
  assert(/import \{[^}]*cleanChNumber[^}]*\} from '\.\/research\/companiesHouse\.mjs'/.test(server), 'the server imports what it uses');
  assert(/import \{[^}]*matchParty[^}]*\} from '\.\/research\/match\.mjs'/.test(server), 'and the matcher too');
});

await check('amending an account verifies, aliases the old name, and adds people honestly (static)', async () => {
  const server = read('src/server.mjs');
  const patchBlock = server.slice(server.indexOf("app.patch('/api/accounts/:id'"), server.indexOf("app.post('/api/accounts/:id/contacts'"));
  assert(/companyProfile\(clean\)/.test(patchBlock), 'a new number is verified against Companies House');
  assert(/name = \$/.test(patchBlock) && /'manual_match'/.test(patchBlock), 'the registered name takes over and the old name becomes an alias');
  assert(/COALESCE\(postcode,/.test(patchBlock) && /COALESCE\(region,/.test(patchBlock), 'held fields fill gaps only');
  assert(/nothing to change/.test(patchBlock), 'an empty amendment refuses rather than writing nothing silently');
  const contactBlock = server.slice(server.indexOf("app.post('/api/accounts/:id/contacts'"), server.indexOf("app.get('/api/accounts'"));
  assert(/'manual'/.test(contactBlock) && /in_decision_orbit/.test(contactBlock), 'a hand-added person says so and enters the orbit deliberately');
  assert(/actorFor\('contacts', 'added_by', req\)/.test(contactBlock), 'the adder is recorded when signed in');
  assert(/ON CONFLICT \(linkedin_url\) DO NOTHING/.test(contactBlock), 'a known profile is never duplicated');
});

await check('every candidate producer uses the one mapper, and the queue reads its fields', async () => {
  const run = read('src/research/runResearch.mjs');
  assert(/candidateRows\(await searchCompanies/.test(run), 'the research run shapes candidates through candidateRows');
  assert(!/company_number|address_snippet/.test(run), 'and never re-reads raw API field names');
  const server = read('src/server.mjs');
  const reviewBlock = server.slice(server.indexOf('The review queue'), server.indexOf("app.get('/api/signals'"));
  assert(/candidateRows\(await searchCompanies/.test(reviewBlock), 'the distinct route shapes candidates the same way');
  assert(!/company_number|address_snippet/.test(reviewBlock), 'with no raw field names of its own');
  const ui = read('web/src/ReviewQueue.jsx');
  assert(/c\.name/.test(ui) && /c\.chNumber/.test(ui), 'the queue reads exactly the fields the mapper emits');
});

console.log('\nA headline is a story, not a prospect:');

await check('the title fallback may link, and only link', async () => {
  const fallback = { operator: '10 UK data centre construction projects', contractor: null,
    geo_scope: 'uk_project', operatorIsTitleFallback: true };
  const unknown = planPartyActions(fallback, { operator: { status: 'unknown' }, contractor: null }, state());
  assert(unknown.length === 0, 'an unknown headline proposes nothing, counts nothing');
  const ambiguous = planPartyActions(fallback, { operator: { status: 'ambiguous', candidates: [{ id: 3 }, { id: 4 }] }, contractor: null }, state());
  assert(ambiguous.length === 0, 'an ambiguous headline files no review');
  const matched = planPartyActions(fallback, { operator: { status: 'matched', company: { id: 2 } }, contractor: null }, state());
  assert(matched.some(a => a.act === 'link' && a.companyId === 2), 'a confidently matched headline still links, the original behaviour');
});

await check('a trailing bracketed abbreviation folds into the same name', async () => {
  assert(normName('Al Moammar Information Systems Company') === normName('Al Moammar Information Systems Company (MIS)'),
    'the two printed forms are one counter row');
  const register = [{ id: 9, name: 'AL MOAMMAR INFORMATION SYSTEMS LTD' }];
  const bare = matchParty('Al Moammar Information Systems Company', register);
  const bracketed = matchParty('Al Moammar Information Systems Company (MIS)', register);
  assert(bare.status === bracketed.status, 'and the matcher treats them alike');
  assert(normName('Volta (UK)') === normName('Volta'), 'a bracketed geography folds too');
  assert(normName('MIS (Al Moammar) Systems') !== '', 'a bracket mid-name is untouched');
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

console.log('\nThe retro-matcher: confident or left for a human:');

await check('bulk matching requires exactly one active, name-agreeing candidate', async () => {
  const { confidentChMatch } = await import('./companiesHouse.mjs');
  const one = confidentChMatch('Tankbuilder', [
    { name: 'TANKBUILDER LIMITED', chNumber: '01234567', status: 'active' },
    { name: 'TANKBUILDER SERVICES LIMITED', chNumber: '07654321', status: 'dissolved' },
  ]);
  assert(one.status === 'matched' && one.match.chNumber === '01234567', 'one active fit attaches');
  const two = confidentChMatch('Volta', [
    { name: 'VOLTA HOLDINGS LIMITED', chNumber: '01111111', status: 'active' },
    { name: 'VOLTA GREAT SUTTON LIMITED', chNumber: '02222222', status: 'active' },
  ]);
  assert(two.status === 'ambiguous' && two.candidates.length === 2, 'a holdings shell never wins by suffix stripping; two fits go to a human');
  assert(confidentChMatch('Quest Medical', [
    { name: 'UNRELATED HOLDINGS LIMITED', chNumber: '03333333', status: 'active' },
  ]).status === 'none', 'no name agreement is none, not a stretch');
  assert(confidentChMatch('Anything', []).status === 'none' && confidentChMatch('', []).status === 'none', 'empty is none, never an error');
});

await check('the live leaks are sealed and the GSK shape resolves', async () => {
  const { confidentChMatch } = await import('./companiesHouse.mjs');
  // Frozen from the first live walk, 11 August 2026: two wrong entities the
  // looser substring rule attached, and the obvious one it refused.
  assert(confidentChMatch('Oxitec', [
    { name: 'OXI-TECH SOLUTIONS LIMITED', chNumber: '10761534', status: 'active' },
  ]).status === 'none', 'a word boundary is a boundary: Oxitec is not Oxi-Tech');
  assert(confidentChMatch('Olympus Surgical Technologies Europe', [
    { name: 'SURGICAL TECHNOLOGIES LTD', chNumber: '12708054', status: 'active' },
  ]).status === 'none', 'the identity word cannot be swallowed: first tokens must agree');
  const gsk = confidentChMatch('GSK', [
    { name: 'GSK PLC', chNumber: '03888792', status: 'active' },
    { name: 'GSK ACCOUNTANCY LTD', chNumber: '08134121', status: 'active' },
    { name: 'GSK BESPOKE DESIGNS LIMITED', chNumber: '11247658', status: 'active' },
  ]);
  assert(gsk.status === 'matched' && gsk.match.chNumber === '03888792', 'the exact legal name wins over its extensions');
  const dechra = confidentChMatch('Dechra Pharmaceuticals Plc', [
    { name: 'DECHRA PHARMACEUTICALS LIMITED', chNumber: '03369634', status: 'active' },
    { name: 'DECHRA PHARMACEUTICALS HOLDINGS LIMITED', chNumber: '14856770', status: 'active' },
    { name: 'DECHRA LIMITED', chNumber: '04513124', status: 'active' },
  ]);
  assert(dechra.status === 'matched' && dechra.match.chNumber === '03369634', 'exact beats holdings and abbreviation');
});

await check('a dissolved register row is news, not a prospect', async () => {
  const { confidentChMatch } = await import('./companiesHouse.mjs');
  // Frozen from the second live walk, 12 August 2026: Fletchers Engineering
  // agreed with exactly one entity, dissolved since September 2021, and the
  // walk called it none while research scored the row 60 on name and type
  // alone. The matcher now reports the shape and research refuses to score
  // any company whose cached register status is not active.
  const f = confidentChMatch('Fletchers Engineering', [
    { name: 'FLETCHERS ENGINEERING LIMITED', chNumber: '12562063', status: 'dissolved' },
  ]);
  assert(f.status === 'dissolved_only' && f.candidates[0].chNumber === '12562063',
    'name agreement with only dead entities is dissolved_only, not none');
  const mixed = confidentChMatch('Fletchers Engineering', [
    { name: 'FLETCHERS ENGINEERING LIMITED', chNumber: '12562063', status: 'dissolved' },
    { name: 'FLETCHERS ENGINEERING LIMITED', chNumber: '15999999', status: 'active' },
  ]);
  assert(mixed.status === 'matched' && mixed.match.chNumber === '15999999',
    'a live successor still matches; dissolved_only only fires when nothing is left alive');
  const r = read('src/research/runResearch.mjs');
  assert(/chStatus && chStatus !== 'active'/.test(r) && /Companies House status \$\{chStatus\}, not a prospect/.test(r),
    'research skips any cached status that is not active before scoring');
  const m = read('scripts/match-register.mjs');
  assert(/dissolved_only/.test(m) && /dismissing the account/.test(m),
    'the walk names the dissolved shape and hands the human both choices');
});

await check('a company\'s own website can say what the name search cannot', async () => {
  const { extractRegistrationNumbers } = await import('./webRegistration.mjs');
  // Frozen from upperton.com's footer, 12 August 2026: the register says
  // Upperton Pharma Solutions, Companies House says Upperton Limited, and
  // the site states the number, as the trading disclosure rules require of
  // every UK company. The probe reads it; nothing else on a page qualifies.
  const upperton = 'Copyright © 2026 Upperton Limited. Registration number: 03833301. Registered office address: Albert Einstein Centre, Nottingham Science Park, Nottingham, NG7 2TN. Registered in England. All rights reserved.';
  assert(JSON.stringify(extractRegistrationNumbers(upperton)) === '["03833301"]',
    'the footer number is found exactly once; the year and the postcode never read as numbers');
  assert(extractRegistrationNumbers('VAT registration number 361324525').length === 0, 'a VAT number is not an identity');
  assert(JSON.stringify(extractRegistrationNumbers('Registered in Scotland, company no. SC123456')) === '["SC123456"]', 'prefixed registrations keep their prefix');
  assert(JSON.stringify(extractRegistrationNumbers('<footer>Company No. 3833301</footer>')) === '["03833301"]', 'tags come off and short old registrations pad to eight');
  assert(extractRegistrationNumbers('Call us on 0115 855 7050. © 2026. The company now employs 250 people.').length === 0, 'phones, years and prose are silence');
  assert(extractRegistrationNumbers('Company number 01234567. Registered number 07654321.').length === 2, 'several distinct numbers all surface, for a human to pick');
  const m = read('scripts/match-register.mjs');
  assert(/registrationFromSite\(co\.domain\)/.test(m), 'the walk probes only when the name search has failed and a domain exists');
  assert(/company_status === 'active'/.test(m) && /fetchCompanyProfile/.test(m), 'a stated number is verified against Companies House before anything is attached');
  assert(/its site states \$\{num\}, already held/.test(m), 'the collision check holds for site-stated numbers too');
  const w = read('src/research/webRegistration.mjs');
  assert(/AbortSignal\.timeout/.test(w) && !/pool\.|INSERT INTO|UPDATE /.test(w), 'the probe is bounded and touches no database');
});

await check('the matcher and typing scripts are dry, bounded and confined (static)', async () => {
  const m = read('scripts/match-register.mjs');
  assert(/Dry run\. Nothing written\./.test(m) && /--apply/.test(m), 'the matcher is dry by default');
  assert(/confidentChMatch/.test(m), 'it uses the extracted confidence rule');
  assert(/collision/.test(m) && /merge candidate/.test(m), 'a number already held is reported, never written over');
  assert(/COALESCE\(postcode,/.test(m) && /COALESCE\(region,/.test(m), 'held fields fill gaps only');
  assert(!/SET name|INSERT INTO leads|INSERT INTO contacts/i.test(m), 'it never renames and never touches leads or contacts');
  assert(/--recheck/.test(m) && /It never detaches/.test(m) && !/ch_number\s*=\s*NULL/i.test(m),
    'the recheck audit re-judges attached numbers under the current rule and reports; correction stays a human act');
  const t = read('scripts/type-members.mjs');
  assert(/Dry run\. Nothing written\./.test(t) && /--apply/.test(t), 'the typing wave is dry by default');
  assert(/requireCampaign\(campArg\)/.test(t) && /def\.icp\.companyTypes\.includes\(type\)/.test(t),
    'the type resolves through the campaign\'s own ICP, never free text');
  assert(/company_type IS NULL/.test(t), 'a type any human has set is never overwritten');
});

await check('the ecosystem seed is curated, tightened and confined (static)', async () => {
  // The Olajuwon directory harvest, 16 August 2026: a US market map mined
  // for UK arms. The seed mirrors the consultants pattern but matches with
  // the tightened rule, and names without a verified UK entity stay on the
  // draft's hold list rather than becoming named accounts that would spend
  // discovery on nothing.
  const s = read('scripts/seed-ecosystem.mjs');
  assert(/Dry run\. Nothing written to the register\./.test(s) && /--apply/.test(s), 'dry by default');
  assert(/confidentChMatch\(e\.name, await searchCompanies\(e\.name\)\)/.test(s) && !/norm\(m\.name\)\.includes/.test(s),
    'every seed is judged by the tightened rule, never the old containment');
  assert(/COALESCE\(company_type/.test(s) && /ON CONFLICT \(company_id, campaign\) DO NOTHING/.test(s),
    'human fields hold and membership is idempotent');
  assert(!/INSERT INTO leads|INSERT INTO contacts/i.test(s), 'no leads, no contacts, nothing sent');
  assert(/ECOSYSTEM_DRAFT\.md/.test(s) && /const HOLD/.test(s) && /not seeded/i.test(s),
    'unverified names stay in the draft for curation');
});

console.log('\nReactivation: the relationship is the qualification:');

await check('a seeded reactivation wave crosses the lead threshold on the relationship alone', async () => {
  // The imported customers mostly carry no company type and no Companies
  // House number, which is exactly why the campaign weights the named
  // membership itself at 45: being a deliberately seeded existing customer
  // is the fit, and a wave becomes leads without waiting for news.
  const seeded = { named_account: true, company_type: null, ch_profile: null };
  const s = scoreCompany(seeded, [], null, 'richards_reactivation');
  assert(s.score >= 40, `a bare seeded customer clears the 40 threshold, got ${s.score}`);
  const unseeded = { named_account: false, company_type: null, ch_profile: null };
  assert(scoreCompany(unseeded, [], null, 'richards_reactivation').score < 40,
    'an unseeded company does not, so the wave stays the human choice');
});

await check('the reactivation campaign is manual, sweepless, and honest about it', async () => {
  const def = requireCampaign('richards_reactivation');
  assert(def.status === 'manual', 'nothing runs until the first wave is calibrated');
  assert(def.signals.sweepQueries.length === 0, 'a relationship campaign has no news sweep');
  assert(!def.signals.gate, 'and no gate, because a gate that never runs would be dead text');
  assert(/never invent any order history/.test(def.positioning.profileFitLine), 'the opener rule bans invented history');
  assert(/never name or imply any other customer/.test(def.positioning.confidentialityRule), 'confidentiality holds');
  const { activeCampaignIds } = await import('../campaigns/registry.mjs');
  assert(!activeCampaignIds().includes('richards_reactivation'), 'the scheduler never touches it while manual');
});

await check('the wave seeder is dry by default, filtered, and keeps the Ireland rule (static)', async () => {
  const src = read('scripts/seed-reactivation.mjs');
  assert(/Dry run\. Nothing written\./.test(src) && /--apply/.test(src), 'dry by default');
  assert(/customer_status = ANY/.test(src), 'waves select existing customers by grade');
  assert(/<> 'Ireland'/.test(src), 'Republic customers are served, never prospected, and a reactivation email is prospecting');
  assert(/--segment/.test(src) && /--region/.test(src) && /--limit/.test(src), 'waves are shaped, not floods');
  assert(!/INSERT INTO leads|INSERT INTO contacts/i.test(src) && !/icp_score|scoreCompany/.test(src), 'seeding touches membership only');
  assert(/ON CONFLICT \(company_id, campaign\) DO NOTHING/.test(src), 're-runs never duplicate membership');
});

console.log('\nThe census: population coverage, proposed never written:');

await check('the census prompt is the campaign\'s own and tells the model not to invent', async () => {
  const { buildCensusSystem } = await import('./census.mjs');
  const dc = buildCensusSystem('marwin_dc');
  assert(/data centre/.test(dc) && /"operator"/.test(dc) && /"contractor"/.test(dc), 'the DC census asks for its two parties');
  assert(/never invent, merge or guess a name/.test(dc), 'the never-invent rule is stated');
  assert(/reviewed by a person against Companies House/.test(dc), 'and the model is told why');
  assert(/No consultancies, no suppliers, no publications/.test(dc), 'the population is the sellable one');
  const ph = buildCensusSystem('pharma_steriflow');
  assert(/pharmaceutical/.test(ph) && !/data centre/.test(ph), 'the pharma census is pharma\'s own');
  assert(!/dcRelevant|QUESTION 1/.test(dc), 'no gate wording leaks into the census');
});

await check('the census reply parses strictly and junk is dropped, never guessed at', async () => {
  const { parseCensus } = await import('./census.mjs');
  const good = parseCensus('Here you go:\n{"companies":[{"name":"Kao Data","party":"operator"},{"name":"NG Bailey","party":"contractor"}]}');
  assert(good.length === 2 && good[0].norm, 'clean candidates with the queue\'s normal form');
  const junk = parseCensus('{"companies":[{"name":"","party":"operator"},{"name":"Real Co","party":"investor"},{"name":"Kao Data","party":"operator"},{"name":"KAO DATA LTD","party":"operator"}]}');
  assert(junk.length === 1 && junk[0].name === 'Kao Data', 'empty names, unknown parties and normal-form duplicates all drop');
  assert(parseCensus('not json') .length === 0 && parseCensus('').length === 0, 'a failed parse is empty, never an error');
});

await check('the census diff runs through the matcher, three honest buckets', async () => {
  const { censusDiff } = await import('./census.mjs');
  const { normName: nn } = await import('./partyActions.mjs');
  const cands = [
    { name: 'Pure DC', party: 'operator', norm: nn('Pure DC') },
    { name: 'Kao Data', party: 'operator', norm: nn('Kao Data') },
    { name: 'Volta', party: 'operator', norm: nn('Volta') },
  ];
  const { fresh, known, ambiguous } = censusDiff(cands, REGISTER);
  assert(known.length === 1 && known[0].companyId === 1, 'an aliased brand is already on the register');
  assert(fresh.length === 1 && fresh[0].name === 'Kao Data', 'the genuinely new name is the census\'s answer');
  assert(ambiguous.length === 1 && ambiguous[0].candidates.length === 2, 'ambiguity goes to a human, never a guess');
});

await check('the census script proposes into the queue and touches nothing else (static)', async () => {
  const src = read('scripts/census-run.mjs');
  assert(/Dry run\. Nothing written\./.test(src) && /--propose/.test(src), 'dry by default, proposing is explicit');
  assert(/requireCampaign\(campArg\)/.test(src) && /Campaign: \$\{def\.id\}/.test(src), 'the campaign resolves through the registry and is printed first');
  assert(/ON CONFLICT \(name_norm, campaign\) DO NOTHING/.test(src), 'a decided or waiting name is never relitigated');
  assert(/SELECT name_norm FROM party_reviews WHERE campaign/.test(src), 'the queue\'s history blocks re-proposal up front');
  assert(/censusProposalsMax/.test(src), 'the per-run cap protects the queue from a flood');
  assert(!/INSERT INTO companies|INSERT INTO leads|INSERT INTO contacts/i.test(src), 'the census writes proposals, never register rows');
  assert(/topic: 'general'/.test(src), 'population search, not the news window');
  assert(/stopping rather than enumerating from model memory alone/.test(src), 'no snippets, no census');
  const { censusProposalsMax } = await import('./census.mjs');
  const saved = process.env.CENSUS_PROPOSALS_MAX;
  try {
    delete process.env.CENSUS_PROPOSALS_MAX;
    assert(censusProposalsMax() === 15, 'the default cap is fifteen');
    process.env.CENSUS_PROPOSALS_MAX = '500';
    assert(censusProposalsMax() === 50, 'the ceiling is fifty');
  } finally {
    if (saved === undefined) delete process.env.CENSUS_PROPOSALS_MAX; else process.env.CENSUS_PROPOSALS_MAX = saved;
  }
});

await check('discovery batches doubled and each campaign searches from its own account', async () => {
  const { peopleSearchLimit } = await import('./peopleDiscovery.mjs');
  const saved = process.env.ENGINE_PEOPLE_SEARCH_LIMIT;
  try {
    delete process.env.ENGINE_PEOPLE_SEARCH_LIMIT;
    assert(peopleSearchLimit() === 4, 'the default doubles to four accounts a cycle');
    process.env.ENGINE_PEOPLE_SEARCH_LIMIT = '25';
    assert(peopleSearchLimit() === 10, 'the ceiling is ten, not unlimited');
    process.env.ENGINE_PEOPLE_SEARCH_LIMIT = '1';
    assert(peopleSearchLimit() === 1, 'the floor is one');
  } finally {
    if (saved === undefined) delete process.env.ENGINE_PEOPLE_SEARCH_LIMIT; else process.env.ENGINE_PEOPLE_SEARCH_LIMIT = saved;
  }
  const disc = read('src/research/peopleDiscovery.mjs');
  assert(/accountForCampaign\(campaign\)/.test(disc), 'each search runs through the campaign\'s own account');
  assert(/filter\(id => getCampaign\(id\)\)/.test(disc), 'a stray membership value never decides the account');
  const lane = read('src/research/linkedinResearch.mjs');
  assert(/accountId: acct = null/.test(lane) && /`findContacts: \$\{company\.name\}`, acct\)/.test(lane), 'findContacts threads the account to the search');
  const uni = read('src/research/unipile.mjs');
  assert(/callsUsedToday\(acct\)/.test(uni) && /AND account_id = \$1/.test(uni), 'the daily lane cap counts per account once the ledger can say');
});

await check('the enrich script is the force lever: scoped, routed, backlog first', async () => {
  // John's instruction, 12 August 2026: pharma research created 125 leads
  // and drafting sat at zero, every lead waiting on an emailable specifier.
  // The manual enrich walk is the force lever for that moment, so it gained
  // what the in-cycle search already had: a campaign scope, per-campaign
  // account routing, and blocked-leads-first ordering.
  const s = read('scripts/linkedin-enrich.mjs');
  assert(/--campaign/.test(s) && /requireCampaign\(campaignArg\)/.test(s), 'the campaign scope resolves through the registry, never free text');
  assert(/accountForCampaign\(laneFor\(co\)\)/.test(s), 'every search rides the campaign\'s own connected account');
  assert(/filter\(id => getCampaign\(id\)\)/.test(s), 'a stray membership value never decides the account');
  assert(/ORDER BY EXISTS \(/.test(s) && /stage = 'researched'/.test(s) && /email_bounced_at IS NULL/.test(s),
    'companies whose leads are waiting on an emailable specifier come first');
  assert(/Dry run/.test(s) && /--apply/.test(s), 'the walk stays dry by default');
});

await check('the people search speaks each campaign\'s own language', async () => {
  // Found on the first pharma force run, 12 August 2026: the dry run showed
  // pharma companies about to be searched for MEP and HVAC people, and a
  // process engineer it might find would classify out of orbit and never
  // draft. Every definition already carried its own orbitTitles; only the
  // studio read them. Now the search keys on the campaign's first eight and
  // the classification widens with the whole list.
  const { inOrbit, ORBIT_TITLES } = await import('./orbitRules.mjs');
  const { getCampaign } = await import('../campaigns/registry.mjs');
  const pharma = getCampaign('pharma_steriflow');
  assert(inOrbit('Senior Process Engineer') === false, 'the shared list alone does not know pharma');
  assert(inOrbit('Senior Process Engineer', pharma.orbitTitles) === true, 'the campaign\'s own vocabulary puts the process engineer in orbit');
  assert(inOrbit('CQV Lead', pharma.orbitTitles) === true, 'and the CQV lead');
  assert(inOrbit('Process Engineering Recruiter', pharma.orbitTitles) === false, 'the excludes always stand: a recruiter never orbits');
  const dc = getCampaign('marwin_dc');
  assert(JSON.stringify(dc.orbitTitles.slice(0, 8)) === JSON.stringify(ORBIT_TITLES.slice(0, 8)),
    'the data centre search keys are the same eight as before the wiring');
  const lane = read('src/research/linkedinResearch.mjs');
  assert(/searchRoles\?\.length \? searchRoles/.test(lane) && /orbitExtra/.test(lane),
    'findContacts lets the campaign vocabulary replace the search keys and widen the orbit');
  const disc = read('src/research/peopleDiscovery.mjs');
  assert(/orbitTitles/.test(disc) && /searchRoles: roleWindow\(titles, co\.prior_searches\)/.test(disc), 'the in-cycle search wires the definition\'s titles through the rotating window');
  const s = read('scripts/linkedin-enrich.mjs');
  assert(/lanePeople/.test(s) && /searchRoles: roleWindow\(laneTitles, co\.prior_searches\)/.test(s) && /orbitExtra: laneTitles/.test(s), 'the force lever wires them too');
});

await check('a revisit asks a fresh set of roles, and the first pass is byte-frozen', async () => {
  // John's push, 17 August 2026: the same eight keywords were asked of every
  // account on every pass. Now attempt zero is exactly the keys as before,
  // and each later pass slides the window through the campaign's own
  // vocabulary, wrapping at the end, so a revisit spends the same one call
  // on a question it has not asked.
  const { roleWindow } = await import('./orbitRules.mjs');
  const { getCampaign } = await import('../campaigns/registry.mjs');
  const pharma = getCampaign('pharma_steriflow').orbitTitles;
  assert(JSON.stringify(roleWindow(pharma, 0)) === JSON.stringify(pharma.slice(0, 8)), 'attempt zero is the original keys, byte for byte');
  assert(JSON.stringify(roleWindow(pharma, 1)) === JSON.stringify(pharma.slice(8, 16)), 'attempt one asks the next eight');
  const windows = Math.ceil(pharma.length / 8);
  assert(JSON.stringify(roleWindow(pharma, windows)) === JSON.stringify(pharma.slice(0, 8)), 'the window wraps back to the start');
  assert(JSON.stringify(roleWindow(['a', 'b'], 3)) === JSON.stringify(['a', 'b']), 'a short vocabulary is always itself');
  const srv = read('src/server.mjs');
  assert(/peopleSearch/.test(srv) && /queuePosition/.test(srv) && /interval '30 days'/.test(srv),
    'the account panel is told the search history and the queue position');
  const disc = read('src/research/peopleDiscovery.mjs');
  for (const shape of ["stage = 'researched'", 'in_decision_orbit', 'email_bounced_at IS NULL']) {
    assert(srv.includes(shape) && disc.includes(shape), `the panel's queue ordering mirrors the search's own: ${shape}`);
  }
});

await check('a Findymail miss is recorded and stood down, never re-bought blind', async () => {
  // John's first live spend, 12 August 2026: 25 lookups, 10 resolved, 15
  // not found, 41 credits, and nothing recorded a miss. The not-founds sat
  // at the very top of the score ordering, so every later run, engine cycle
  // or manual, would have re-bought the same misses first, forever. The
  // miss now stamps the contact row and every selection stands it down for
  // ninety days: people move and mailboxes appear, so an eventual retry is
  // right, four a day is not.
  const f = read('src/research/findymail.mjs');
  assert(/email_lookup/.test(f) && /not_found/.test(f), 'the miss is stamped on the contact row at the one spend point');
  const d = read('src/research/emailDiscovery.mjs');
  assert(/email_lookup/.test(d) && /90 days/.test(d), 'the shared selection stands a recorded miss down');
  const s = read('scripts/discover-emails.mjs');
  assert(/email_lookup/.test(s) && /90 days/.test(s), 'the dry-run preview obeys the same rule, so it shows what --apply will spend on');
  const e = read('scripts/linkedin-enrich.mjs');
  assert((e.match(/email_lookup/g) || []).length >= 2, 'the inline enrich spend obeys it in the count and the loop');
});

await check('the email spend can be aimed at one campaign', async () => {
  // The second live spend went entirely to the data centre tail while the
  // pharma wave waited: the global score ordering knows no campaigns. The
  // spend now takes the same --campaign scope as the enrich lever, resolved
  // through the registry, on the preview and the shared selection alike;
  // the engine's own call passes no campaign and is unchanged.
  const s = read('scripts/discover-emails.mjs');
  assert(/--campaign/.test(s) && /requireCampaign\(campArg\)/.test(s), 'the scope resolves through the registry, never free text');
  assert(/campaign: camp\?\.id \|\| null/.test(s), 'the apply run passes the same scope it previewed');
  const d = read('src/research/emailDiscovery.mjs');
  assert(/campaign = null/.test(d) && /m\.campaign = \$/.test(d), 'the shared selection scopes by membership only when asked');
  const server = read('src/server.mjs');
  assert(/discoverEmails\(\{ limit: cap, log/.test(server), 'the engine cycle spend stays campaign-blind, working the global backlog');
});

await check('the unipile check proves every lane, not only the default', async () => {
  // 17 August 2026: the dashboard and the check both said Andy's account
  // was fine while every search through it failed, because the accounts
  // list reports the basic session and searching needs the Sales Navigator
  // one. The check now runs its minimal search through each healthy
  // account, so a dead lane is named before a force run spends cap on it.
  const u = read('scripts/unipile-check.mjs');
  assert(/for \(const a of healthyAccounts\)/.test(u) && /account_id: a\.id/.test(u),
    'the minimal search runs per healthy account, through that account');
  assert(/expired_credentials/i.test(u) && /reconnect, not delete/.test(u),
    'the expired-session shape is named with its exact fix');
  assert(!/UNIPILE_ACCOUNT_ID=\$\{healthy\.id\}/.test(u),
    'the one-account-era advice that promoted the wrong default is gone');
});

await check('people-discovery pacing is untouched', async () => {
  const src = read('src/research/peopleDiscovery.mjs');
  assert(!/party_review|proposal|contractor/i.test(src), 'people discovery knows nothing of proposals');
});

console.log(`\n=== Lead-gen gate: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
