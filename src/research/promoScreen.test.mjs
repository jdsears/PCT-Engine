// The promotional and roundup screen, and the far more important half: proof
// that it does not eat real leads. A false positive here silently drops a
// prospect, which is worse than the noise the screen prevents, so the
// must-not-match set is deliberately longer than the must-match set and is
// drawn from the shapes real signals actually take.

import { promoGenre, isPromoOrRoundup } from './promoScreen.mjs';
import { classifySignal } from './relevance.mjs';
import { buildGateSystem } from '../campaigns/prompts.mjs';
import { requireCampaign } from '../campaigns/registry.mjs';

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  pass  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); fail++; }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

console.log('The three that got through the live sweeps:');

const LIVE_ESCAPES = [
  ['Our Lighting and Acoustics teams were pleased to support the Hatfield scheme', 'first-person promotion'],
  ['10 UK data centre construction projects to watch', 'listicle'],
  ["Gabriel Morelli's Post", 'social post'],
];

for (const [title, genre] of LIVE_ESCAPES) {
  await check(`screened as ${genre}: ${title.slice(0, 44)}`, () => {
    assert(promoGenre(title) === genre, `expected ${genre}, got ${promoGenre(title)}`);
  });
}

console.log('\nThe genres, each named so a rejection can be judged:');

const SHOULD_SCREEN = [
  ['Top 5 data centre trends ranked for 2027', 'listicle'],
  ['We are delighted to have delivered the cooling package', 'first-person promotion'],
  ['Data centre weekly round-up', 'digest or roundup'],
  ['This week in construction: the schemes that moved', 'digest or roundup'],
  ['Join our webinar on liquid cooling', 'marketing or calendar item'],
  ['Kao Data shortlisted for regional awards', 'marketing or calendar item'],
  ['We are hiring: data centre project managers', 'marketing or calendar item'],
];
for (const [title, genre] of SHOULD_SCREEN) {
  await check(`screened as ${genre}: ${title.slice(0, 44)}`, () => {
    assert(promoGenre(title) === genre, `expected ${genre}, got ${promoGenre(title)}`);
  });
}

console.log('\nThe half that matters more: real signals are untouched:');

// Every one of these is the shape of a signal the engine exists to find, and
// several are near misses for the patterns above on purpose.
const MUST_NOT_SCREEN = [
  "Glencar lands final phase of Pure DC's Brent Cross data centre campus",
  'Mace wins fit-out contract on Stellium Newcastle campus',
  'Ark Data Centres awarded contract for Farnborough expansion',
  'Contract awarded for £200m Slough data centre',            // "awarded", never "awards"
  'Winvic appointed to deliver 100MW campus',
  'Oracle to spend $70bn on data centre build-out',
  'DDSP secures green financing for data centre campus',
  '10 Downing Street announces data centre investment plan',   // leading number, no listicle cue
  '5 Broadgate data centre scheme approved',                   // leading number, real address
  'BeOne announces $1bn US manufacturing expansion',
  'Evonik invests $100m in US API production',
  'Bachem expands peptide site at Sisslerfeld',
  'OXB selected as GMP manufacturing partner for gene therapy programme',
  'Thermo Fisher opens new China plant',
  'The team completed the Slough fit-out ahead of schedule',   // no first-person pronoun with a pleasure word
  'Sponsors of the scheme confirm funding',                    // "sponsors" as a noun, not sponsorship marketing
];
for (const title of MUST_NOT_SCREEN) {
  await check(`kept for the gate to judge: ${title.slice(0, 48)}`, () => {
    assert(promoGenre(title) === null, `wrongly screened as ${promoGenre(title)}`);
  });
}

await check('an empty or missing title is not a genre match', () => {
  assert(promoGenre('') === null && promoGenre(null) === null && promoGenre(undefined) === null,
    'nothing to judge is not a rejection reason here; the gate handles it');
  assert(isPromoOrRoundup('Data centre weekly round-up') === true, 'the boolean form agrees');
});

console.log('\nThe screen sits in front of the gate and costs no model call:');

await check('a screened title is rejected without the model being called', async () => {
  let called = false;
  const model = async () => { called = true; return JSON.stringify({ dcRelevant: true, geoScope: 'uk_project', operator: 'Someone' }); };
  const r = await classifySignal({ title: '10 UK data centre construction projects to watch' }, { callModel: model });
  assert(r.dcRelevant === false, 'the listicle is rejected');
  assert(r.screened === 'listicle', 'and says which genre it matched');
  assert(r.geoScope === null && r.operator === null, 'a rejected signal carries no scope or operator');
  assert(called === false, 'the model was never called, so the screen costs nothing');
});

await check('an ordinary title still reaches the model and can pass', async () => {
  let called = false;
  const model = async () => { called = true; return JSON.stringify({ dcRelevant: true, geoScope: 'uk_project', operator: 'Pure DC' }); };
  const r = await classifySignal({ title: "Glencar lands final phase of Pure DC's Brent Cross data centre campus" }, { callModel: model });
  assert(called === true, 'the model judged it');
  assert(r.dcRelevant && r.geoScope === 'uk_project' && r.operator === 'Pure DC', 'and its verdict stands');
});

console.log('\nThe prompt rule accompanies the screen, on both campaigns:');

await check('the title-only path carries the genre bar in both gates', () => {
  for (const id of ['marwin_dc', 'pharma_steriflow']) {
    const g = buildGateSystem(requireCampaign(id));
    assert(/Judging on the title alone does not lower the genre bar/.test(g), `${id} carries the guard`);
    assert(/numbered or ranked list/.test(g) && /first-person supplier/.test(g), `${id} names the genres`);
    assert(/cannot be told apart from these genres, reject rather than pass/.test(g), `${id} defaults to reject`);
  }
});

console.log(`\n=== Promo screen gate: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
