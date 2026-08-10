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

await check('people-discovery pacing is untouched', async () => {
  const src = read('src/research/peopleDiscovery.mjs');
  assert(!/party_review|proposal|contractor/i.test(src), 'people discovery knows nothing of proposals');
});

console.log(`\n=== Lead-gen gate: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
