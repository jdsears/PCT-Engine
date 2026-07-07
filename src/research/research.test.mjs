// The DC signal pipeline, offline. The matcher is pure; the gate and router run
// against a deterministic stand-in model so the classification logic is tested
// without a network or a key. The live model's judgement is exercised on the
// deploy by reprocessing the real signals.
import { matchOperator, normalizeTokens } from './match.mjs';
import { classifySignal } from './relevance.mjs';

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  pass  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); fail++; }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const fake = (resp) => async () => (typeof resp === 'string' ? resp : JSON.stringify(resp));

console.log('Relevance gate (classify, injected model):');

await check('a school job and a care home are rejected, a real DC build passes', async () => {
  const school = await classifySignal({ title: 'Galliford Try lands Havering school job' }, { callModel: fake({ dcRelevant: false }) });
  assert(school.dcRelevant === false, 'school must be rejected');
  const care = await classifySignal({ title: 'Operator opens new care home' }, { callModel: fake({ dcRelevant: false }) });
  assert(care.dcRelevant === false, 'care home must be rejected');
  const dc = await classifySignal(
    { title: "Glencar lands final phase of Pure DC's Brent Cross data centre campus" },
    { callModel: fake({ dcRelevant: true, geoScope: 'uk_project', operator: 'Pure DC' }) });
  assert(dc.dcRelevant && dc.geoScope === 'uk_project' && dc.operator === 'Pure DC', JSON.stringify(dc));
});

await check('classification defaults to reject on parse failure, and to expansion_watch on a bad scope', async () => {
  const garbled = await classifySignal({ title: 'x' }, { callModel: fake('not json at all') });
  assert(garbled.dcRelevant === false, 'unparseable must reject');
  const safe = await classifySignal({ title: 'Oracle expands' }, { callModel: fake({ dcRelevant: true, geoScope: 'banana', operator: 'Oracle' }) });
  assert(safe.geoScope === 'expansion_watch', `invalid scope must fall to expansion_watch, got ${safe.geoScope}`);
});

console.log('\nGeographic routing:');

await check('a UK project, a foreign expansion, and a foreign-only build route correctly', async () => {
  const uk = await classifySignal({ title: 'Microsoft UK data centre approved' }, { callModel: fake({ dcRelevant: true, geoScope: 'uk_project', operator: 'Microsoft' }) });
  const watch = await classifySignal({ title: 'Oracle global data centre build-out' }, { callModel: fake({ dcRelevant: true, geoScope: 'expansion_watch', operator: 'Oracle' }) });
  const foreign = await classifySignal({ title: 'SoftBank funds France-only data centre' }, { callModel: fake({ dcRelevant: true, geoScope: 'foreign_only', operator: 'SoftBank', foreignLocation: 'France' }) });
  assert(uk.geoScope === 'uk_project' && watch.geoScope === 'expansion_watch' && foreign.geoScope === 'foreign_only', 'three scopes must land correctly');
});

console.log('\nGate and router tuning (regression for the two dry-run errors):');

await check('a residential or generic construction win is rejected, not routed uk_project', async () => {
  const resi = await classifySignal({ title: 'Resi job propels Keady to league summit' }, { callModel: fake({ dcRelevant: false }) });
  assert(resi.dcRelevant === false && resi.geoScope === null, 'a resi job must be rejected, never uk_project');
});

await check('a real DC operator financing with no named location routes expansion_watch, not foreign_only', async () => {
  // DDSP: a data centre financing event, geography unclear, no specific foreign place named.
  const ddsp = await classifySignal({ title: 'DDSP secures green financing for data centre campus' }, { callModel: fake({ dcRelevant: true, geoScope: 'foreign_only', operator: 'DDSP' }) });
  assert(ddsp.geoScope === 'expansion_watch', `unclear-geography DC operator must be expansion_watch, got ${ddsp.geoScope}`);
  const atlas = await classifySignal({ title: 'AtlasEdge lands financing for European expansion' }, { callModel: fake({ dcRelevant: true, geoScope: 'expansion_watch', operator: 'AtlasEdge' }) });
  assert(atlas.geoScope === 'expansion_watch', 'AtlasEdge, the same shape, must land identically');
});

await check('a clear named foreign location still routes foreign_only', async () => {
  const jakarta = await classifySignal({ title: 'STT GDC opens data centre in Jakarta' }, { callModel: fake({ dcRelevant: true, geoScope: 'foreign_only', operator: 'STT GDC', foreignLocation: 'Jakarta' }) });
  assert(jakarta.geoScope === 'foreign_only', 'a named foreign location stays foreign_only');
});

console.log('\nConservative operator matcher (pure):');

await check('a brand headline matches its registered entity', () => {
  const cos = [{ id: 1, name: 'MICROSOFT PROPERTIES UK LIMITED' }, { id: 2, name: 'EQUINIX (UK) LIMITED' }];
  assert(matchOperator('Microsoft', cos)?.id === 1, 'Microsoft must match the registered entity');
  assert(matchOperator('Equinix', cos)?.id === 2, 'Equinix must match the registered entity');
  assert(matchOperator('Pure DC', [{ id: 3, name: 'Pure Data Centres Group Ltd' }])?.id === 3, 'Pure DC must match via tokens/alias');
});

await check('an ambiguous or unknown operator stays unmatched, so no wrong account is linked', () => {
  const cos = [{ id: 1, name: 'Vantage Data Centres UK Ltd' }, { id: 2, name: 'Vantage Towers Ltd' }];
  assert(matchOperator('Vantage', cos) === null, 'ambiguous must stay unmatched');
  assert(matchOperator('Some Unknown Operator', cos) === null, 'unknown must stay unmatched');
  assert(matchOperator('', cos) === null, 'empty must stay unmatched');
  assert(matchOperator('Data Centre', cos) === null, 'all-generic tokens must stay unmatched');
  assert(normalizeTokens('EQUINIX (UK) LIMITED').join(',') === 'equinix', 'corporate suffixes are stripped');
});

console.log('\nEvent gate (regression: mentioning a data centre is not a build event):');

await check('an opposition meeting, a moratorium, and financing chatter are rejected though they name data centres', async () => {
  const opp = await classifySignal({ title: 'New Hampshire data-center opponents planned to pack meeting' }, { callModel: fake({ dcRelevant: false }) });
  const mora = await classifySignal({ title: 'Arkansas county approves data center moratorium' }, { callModel: fake({ dcRelevant: false }) });
  const fin = await classifySignal({ title: 'Bitcoin Miner Kiln Infrastructure Raises $458M in Convertible Notes for Data Center Push' }, { callModel: fake({ dcRelevant: false }) });
  assert(opp.dcRelevant === false && mora.dcRelevant === false && fin.dcRelevant === false, 'non-build events must be rejected');
  assert(opp.geoScope === null && mora.geoScope === null && fin.geoScope === null, 'rejected signals carry no scope');
});

await check('a clear UK build and an operator expansion still pass and route correctly', async () => {
  const brent = await classifySignal({ title: "Glencar lands final phase of Pure DC's Brent Cross data centre campus" }, { callModel: fake({ dcRelevant: true, geoScope: 'uk_project', operator: 'Pure DC' }) });
  const oracle = await classifySignal({ title: 'Oracle to spend $70bn on data centre build-out' }, { callModel: fake({ dcRelevant: true, geoScope: 'expansion_watch', operator: 'Oracle' }) });
  assert(brent.geoScope === 'uk_project', 'a clear UK build must stay uk_project');
  assert(oracle.geoScope === 'expansion_watch', 'an operator build-out must stay expansion_watch');
});

console.log('\nThird-pass boundary (financing OF a data centre keeps, sector commentary rejects):');

await check('financing or expansion of a specific data centre is kept; commentary not tied to a build is rejected', async () => {
  const ddsp = await classifySignal({ title: 'DDSP secures green financing for data centre campus' }, { callModel: fake({ dcRelevant: true, geoScope: 'expansion_watch', operator: 'DDSP' }) });
  const oracle = await classifySignal({ title: 'Oracle to spend $70bn on data centre build-out' }, { callModel: fake({ dcRelevant: true, geoScope: 'expansion_watch', operator: 'Oracle' }) });
  assert(ddsp.dcRelevant && ddsp.geoScope === 'expansion_watch', 'financing of a data centre campus must be kept');
  assert(oracle.dcRelevant && oracle.geoScope === 'expansion_watch', 'an operator build-out must be kept');
  const commentary = await classifySignal({ title: 'Bitcoin Miner Raises $458M in Convertible Notes for Data Center Push' }, { callModel: fake({ dcRelevant: false }) });
  assert(commentary.dcRelevant === false, 'sector financing commentary not tied to a specific build must be rejected');
  const resi = await classifySignal({ title: 'Resi job propels Keady to league summit' }, { callModel: fake({ dcRelevant: false }) });
  assert(resi.dcRelevant === false, 'a residential construction win must fail the subject gate');
});

console.log('\nSubject-gate default (a construction win needs a recognisable data centre subject):');

await check('a residential or unrecognised-subject construction win defaults to reject', async () => {
  const resi = await classifySignal({ title: 'Resi job propels Keady to league summit' }, { callModel: fake({ dcRelevant: false }) });
  const opaque = await classifySignal({ title: 'Contractor wins major fit-out job at an unnamed site' }, { callModel: fake({ dcRelevant: false }) });
  assert(resi.dcRelevant === false, 'a residential construction win must reject on subject');
  assert(opaque.dcRelevant === false, 'an unrecognised-subject construction win must default to reject');
});

console.log('\nAnchor removal (the classifier never sees the search query):');

await check('the search query is not shown to the classifier, so it cannot anchor a verdict', async () => {
  let seenUser = null;
  const capture = async (system, user) => { seenUser = user; return JSON.stringify({ dcRelevant: false }); };
  await classifySignal(
    { title: 'Resi job propels Keady to league summit', content: 'a residential build-to-rent development in Stockport', query: 'UK data centre construction contract awarded' },
    { callModel: capture });
  assert(seenUser !== null, 'the classifier must be called');
  assert(!/search query/i.test(seenUser), 'the prompt must not mention the search query');
  assert(!/UK data centre construction contract awarded/.test(seenUser), 'the query text must not appear in the prompt');
  assert(/Resi job/.test(seenUser) && /Stockport/.test(seenUser), 'title and content are still shown');
});

console.log(`\n=== Research gate: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
