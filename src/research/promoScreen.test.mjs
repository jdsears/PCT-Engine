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

console.log('\nFrom the live reprocess run, the titles as they really arrive:');

// The first cut of this screen caught only one of these, because it was tested
// against titles typed by hand rather than the ones the sweep actually stores.
// These are copied from the 26 July dry run, decoration and all.
const LIVE_KEPT_JUNK = [
  ['\u{1F4CA} 10 UK data centre construction projects to watch The ...', 'listicle'],
  ["It's all systems go at our Hatfield Integration Center, as the ...", 'first-person promotion'],
  ['Instagram', 'page furniture'],
  ['Newsroom', 'page furniture'],
  ['New Data Center Developments: July 2026', 'digest or roundup'],
];
for (const [title, genre] of LIVE_KEPT_JUNK) {
  await check(`screened as ${genre}: ${title.slice(0, 44)}`, () => {
    assert(promoGenre(title) === genre, `expected ${genre}, got ${promoGenre(title)}`);
  });
}

await check('a leading emoji or bullet cannot defeat an anchored pattern', () => {
  // The exact fault: the listicle pattern anchors the count at the start, and
  // a chart emoji pushed it off position zero.
  assert(promoGenre('10 projects to watch') === 'listicle', 'plain');
  assert(promoGenre('\u{1F4CA} 10 projects to watch') === 'listicle', 'with an emoji');
  assert(promoGenre('| 10 projects to watch') === 'listicle', 'with a pipe');
  assert(promoGenre('\u2022 10 projects to watch') === 'listicle', 'with a bullet');
});

await check('a section label is a prefix, not furniture: the story after it survives', () => {
  // From the third live run: "News | Colliers promotes 72 employees in the UK -
  // CoStar" was screened as page furniture because everything after the first
  // separator was stripped. The verdict was right by luck; the same rule would
  // have eaten a real lead carrying the same section prefix.
  assert(promoGenre('News | Colliers promotes 72 employees in the UK - CoStar') === null,
    'a real headline behind a section label is left for the gate');
  assert(promoGenre('News | Skanska wins £158m London data centre fit-out') === null,
    'and so is a real lead behind the same prefix');
  // A trailing publisher suffix is still stripped, so a bare index page is
  // still caught, and an index page IS furniture however it is labelled.
  assert(promoGenre('Newsroom - CoStar') === 'page furniture', 'a bare section with a publisher suffix');
  assert(promoGenre('Press releases | Ark Data Centres') === 'page furniture', 'an index page with no story');
});

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

await check('"awards" as a verb is a contract win, not a ceremony', () => {
  // From the live research run: "UK awards $26m hypersonic target contract to
  // Lockheed Martin" was screened as a marketing item. The word is a verb
  // there, and the same rule would have eaten a real data centre contract award.
  assert(promoGenre('UK awards $26m hypersonic target contract to Lockheed Martin') === null,
    'a government awarding a contract is not a ceremony');
  assert(promoGenre('MoD awards £200m data centre contract to Skanska') === null,
    'nor is the shape that would have cost a real lead');
  assert(promoGenre('Council awards contract for Slough data centre') === null, 'nor this one');
  // The ceremony sense still screens, through phrasings a verb cannot take.
  assert(promoGenre('Kao Data shortlisted for regional awards') === 'marketing or calendar item', 'a shortlist');
  assert(promoGenre('Data centre industry awards open for entries') === 'marketing or calendar item', 'a named awards programme');
  assert(promoGenre('Awards ceremony celebrates the year in construction') === 'marketing or calendar item', 'a ceremony');
});

console.log('\nThe half that matters more: real signals are untouched:');

// Every one of these is the shape of a signal the engine exists to find, and
// several are near misses for the patterns above on purpose.
const MUST_NOT_SCREEN = [
  // The 34 genuine signals from the same live run that must stay untouched.
  "Glencar lands final phase of Pure DC's £1bn Brent Cross data centre campus",
  'VIRTUS Expands Slough Campus With New 32.5MW AI-ready Data Centre',
  'IIAs 2026 | QTS data centre campus in Northumberland, England',
  'Former Unilever factory to become data centre',
  'Green Mountain: East is the New West - Bolstering UK Growth',
  'Skanska wins £158m London data centre fit-out',
  'Hochtief lands £250m Blackpool data centre - Construction News',
  'Brookfield wants to build AI data centers in London\u2019s answer to Wall Street - CNBC',
  'Pure DC Receives Additional €1.3 Billion in Senior Debt',
  'Polar Data Centers announces DRA02 Expansion in Norway - Techerati',
  'Meta commits $50B to Louisiana data center and surrounding area',
  "Australia's Macquarie DC acquires 34,200 sqm site in Sydney for 200MW data centre",
  'Plug Power sells Texas site to Stream Data Centers - DCD',
  'ON.Energy and Crusoe Partner for 5GW AI UPS Deployment Across US Hyperscale Campuses',
  'Crusoe secures 5 gigawatts of data center contracts, pauses Wyoming project',
  'MIS may develop data centres in three Saudi cities - Developing Telecoms',
  'Maharashtra announces possible data centre deal with AirTrunk - Developing Telecoms',
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
