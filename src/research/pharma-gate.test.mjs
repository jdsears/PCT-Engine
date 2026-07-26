// The pharma gate's first calibration tune, frozen as an acceptance contract
// from the first live sweep of 26 July 2026 (40 seen, 6 stored, 34 rejected).
//
// Two things are provable without a model key, and both matter:
//
//   1. The three tuned instructions are in the assembled gate prompt. If a
//      later edit drops one, these fail loudly. This is where the changes have
//      teeth in the container.
//   2. Given the verdict the tuned gate is expected to reach, the pipeline
//      routes it correctly. The model is injected, exactly as the DC research
//      suite does, so these fix the routing half of the contract, a foreign
//      facility kept as context rather than dropped, a UK award landing
//      uk_project, every reject carrying no scope.
//
// What no in-container test can prove is that the real model reaches those
// verdicts on the live copy. That is John's dry re-sweep, read line by line;
// this suite is the contract that sweep is checked against.

import { classifySignal } from './relevance.mjs';
import { buildGateSystem } from '../campaigns/prompts.mjs';
import { requireCampaign } from '../campaigns/registry.mjs';

const PH = requireCampaign('pharma_steriflow');
const fake = payload => async () => (typeof payload === 'string' ? payload : JSON.stringify(payload));
const classify = (title, payload) => classifySignal({ title }, { callModel: fake(payload), campaign: PH });

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  pass  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); fail++; }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

console.log('The three tuned instructions are in the pharma gate prompt:');

const GATE = buildGateSystem(PH);

await check('change 1: geography is never a reason to fail the subject', async () => {
  assert(/[Gg]eography is never a reason to fail/.test(GATE), 'the geography-never-fails line is present');
  assert(/anywhere in the world passes the subject/.test(GATE), 'a real facility anywhere passes the subject');
  assert(/judges what and whether, the routing judges where/.test(GATE), 'the what/whether vs where split is stated');
});

await check('change 3a: a CDMO or GMP manufacturing-partner award is an event', async () => {
  assert(/contract manufacturing \(CDMO\) or GMP manufacturing-partner award/.test(GATE), 'the award-is-an-event rule is present');
  assert(/with that manufacturer as the operator/.test(GATE), 'the operator is the named manufacturer');
  assert(/[Ss]ector or market commentary about the CDMO industry[\s\S]*still fails/.test(GATE), 'CDMO market commentary still fails');
  assert(/purely[\s\S]*regulatory selection[\s\S]*not a facility event/.test(GATE), 'a regulatory selection is still not a facility event');
});

await check('change 3b: a research or R&D campus of laboratories stays out', async () => {
  assert(/research or discovery campus, a laboratory or R&D building, or a science park/.test(GATE), 'the lab-campus exclusion is present');
  assert(/does not pass even under a life-sciences banner/.test(GATE), 'a life-sciences label does not widen the subject');
  assert(/a decision, not an oversight/.test(GATE), 'and it is recorded as decided');
});

await check('the tune did not loosen the standing rejections', async () => {
  for (const phrase of ['default to reject', 'hospital', 'university', 'warehouse', 'pure research',
                        'drug approval', 'clinical trial results', 'company financial results', 'merger, acquisition']) {
    assert(GATE.toLowerCase().includes(phrase.toLowerCase()), `the gate still names ${phrase}`);
  }
});

console.log('\nMust KEEP, routed expansion_watch (unchanged from the live run):');

// Each keep is given the verdict the gate reached live; the pipeline must carry
// it through to expansion_watch.
const WATCH_KEEPS = [
  ['Eli Lilly and Octapharma expand production', 'Eli Lilly'],
  ['Thermo Fisher opens new China plant', 'Thermo Fisher'],
  ['Evonik invests $100m in US API production', 'Evonik'],
  ['BeOne announces $1bn US manufacturing expansion', 'BeOne'],
  ['BeOne to expand manufacturing capacity in the US', 'BeOne'], // second framing
  ['Bachem expands peptide site at Sisslerfeld', 'Bachem'],
];
for (const [title, operator] of WATCH_KEEPS) {
  await check(`keep, expansion_watch: ${title.slice(0, 46)}`, async () => {
    const r = await classify(title, { dcRelevant: true, geoScope: 'expansion_watch', operator });
    assert(r.dcRelevant && r.geoScope === 'expansion_watch', JSON.stringify(r));
    assert(r.operator === operator, 'the operator is carried');
  });
}

console.log('\nMust now KEEP under the tuned gate (the fixes proving themselves):');

await check('geography fix: BeOne Mercer County framing keeps, expansion_watch', async () => {
  const r = await classify('BeOne breaks ground on Mercer County manufacturing expansion',
    { dcRelevant: true, geoScope: 'expansion_watch', operator: 'BeOne' });
  assert(r.dcRelevant && r.geoScope === 'expansion_watch', `the third framing must match the other two, got ${JSON.stringify(r)}`);
});

await check('geography fix: Nigeria eleven pharmaceutical plants keep, foreign_only with the location named', async () => {
  // The heart of change 1: a real foreign facility is kept as context, placed
  // by its geography, never dropped as "not a facility".
  const r = await classify("Nigeria's eleven pharmaceutical plants near completion",
    { dcRelevant: true, geoScope: 'foreign_only', operator: 'Federal Government of Nigeria', foreignLocation: 'Nigeria' });
  assert(r.dcRelevant === true, 'a genuine overseas plant is kept, not rejected for being foreign');
  assert(r.geoScope === 'foreign_only', `and routed foreign_only with the location, got ${r.geoScope}`);
});

await check('geography fix: a foreign facility with no named location falls to expansion_watch, never dropped', async () => {
  // The routing invariant that makes the geography fix safe: even if the model
  // reaches for foreign_only without evidence, the signal is kept, not lost.
  const r = await classify('Overseas biotech expands drug substance capacity',
    { dcRelevant: true, geoScope: 'foreign_only', operator: 'A biotech' });
  assert(r.dcRelevant && r.geoScope === 'expansion_watch', `unclear geography must be expansion_watch, got ${r.geoScope}`);
});

await check('event fix: OXB selected as GMP manufacturing partner keeps, operator OXB, UK ties route uk_project', async () => {
  const r = await classify('OXB selected as GMP manufacturing partner for gene therapy programme',
    { dcRelevant: true, geoScope: 'uk_project', operator: 'OXB' });
  assert(r.dcRelevant === true, 'a manufacturing-partner award is a keep');
  assert(r.operator === 'OXB', 'with OXB as the operator');
  assert(r.geoScope === 'uk_project', `a UK manufacturer's UK programme lands uk_project, got ${r.geoScope}`);
});

console.log('\nThe Fujifilm item, placed on evidence (FDA PreCheck selection, 8 July 2026):');

await check('Fujifilm PreCheck selection rejects: a regulatory selection is not a facility event', async () => {
  // Investigated, not assumed. The primary subject is selection into the FDA
  // PreCheck pilot programme, a regulatory decision; the Holly Springs plant
  // and its ongoing expansion are context in the body, not the reported event.
  // The primary-subject rule and the regulatory rejection both hold, so the
  // correct verdict under the tuned gate is still reject. The genuine Fujifilm
  // lead fuel is the separate Teesside GBP 400m UK expansion, which the UK
  // queries are built to surface and which would pass as uk_project.
  const r = await classify('FUJIFILM Biotechnologies selected in FDA PreCheck pilot program to advance US drug manufacturing',
    { dcRelevant: false });
  assert(r.dcRelevant === false, 'a regulatory programme selection is rejected');
  assert(r.geoScope === null, 'and carries no scope');
});

console.log('\nMust still REJECT (the tune loosens nothing):');

const REJECTS = [
  'MustardSeed expands its PMO consultancy team',
  'UK biotech venture investment buoyant in the first half',
  'Lifecore Biomedical announces Nasdaq inducement grant',
  'Airkey launches new modular cleanroom product range',
  'Guardtech delivers cleanroom for aerospace manufacturer',
  'Pharma facilities roundup: this week in construction',
  "Gabriel Morelli's Post",
  'Harlow health security campus of laboratories takes shape',
  'Sisk lands major mixed-use construction contract',
  'Balfour Beatty wins highways framework',
  'Thames Water awards treatment works upgrade',
  'BAE lands defence manufacturing contract',
];
for (const title of REJECTS) {
  await check(`reject: ${title.slice(0, 52)}`, async () => {
    const r = await classify(title, { dcRelevant: false });
    assert(r.dcRelevant === false, 'must reject');
    assert(r.geoScope === null && r.operator === null, 'a rejected signal carries no scope and no operator');
  });
}

console.log(`\n=== Pharma gate calibration: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
