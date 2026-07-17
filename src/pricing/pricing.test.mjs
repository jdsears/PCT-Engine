// The price parser, exercised offline against a synthetic workbook built in
// memory to mirror the real tabs' shapes. The check that matters most: the
// cost, purchase and list columns carry poison values, and the proof is that
// no poison value survives into the extracted rows. Margin data is excluded
// by construction, not by hope.
import ExcelJS from 'exceljs';
import { parseMegaWorkbook, extractTab, TAB_SPECS, normKey, priceNumber, cellValue } from './parseMega.mjs';
import { quotedLine } from './quotedLines.mjs';
import { priceIntent, partTokens, renderPriceAnswer, renderLineSummary } from './priceAnswer.mjs';
import { computeGuide } from './richardsTransform.mjs';
import { parseMarwinPages, parseModelRow, parseSizeHeader } from './parseMarwinPdf.mjs';

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  pass  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); fail++; }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

// Poison values: if any of these appear as a sell price, a forbidden column leaked.
const COST = 666.66, PURCHASE = 777.77, LIST = 888.88;

function buildWorkbook() {
  const wb = new ExcelJS.Workbook();
  const st = wb.addWorksheet('Status');
  st.addRow(['Part Number', 'Description', 'Nett', 'Sell  Price GBP', 'Cost  Price GBP', 'HMS Code', 'List Price GBP', 'USD Sales price', 'Euro Sales price']);
  st.addRow(['IN HEAD TRANSMITTERS']); // section heading, no prices
  st.addRow(['SEM203/P ', 'Push button config', null, 101, COST, '90251900', LIST, 138, 121]);
  st.addRow(['SEM206  ', 'No sell price on this row', null, null, COST, '90251900', LIST, null, null]);
  const ege = wb.addWorksheet('EGE');
  ege.addRow(['ID Number', 'Stock Reference', 'PCT Selling price', 'PCT Selling price', 'PCT Purchase Price', null, 'List Pricing', 'EUR List', 'USD List']);
  ege.addRow([null, 'AGKU 1500 GI', 645, 645, PURCHASE, null, LIST, 758, 856]);
  const king = wb.addWorksheet('King');
  king.addRow(['Series', null, 'List Price', null, '£ NET SELLING', null, '€NET SELLING', '$ NET SELLING']);
  king.addRow([7100, null, LIST, null, 3869, null, 3441, 3890]);
  king.addRow(['7610/7650', null, LIST, null, 728, null, 647, 732]);
  return wb;
}

console.log('The price parser (synthetic workbook, poison-value proof):');

await check('every sell price extracts, with its currency and part', async () => {
  const { rows, report } = parseMegaWorkbook(buildWorkbook());
  assert(report.tabs.status.parts === 1 && report.tabs.status.rows === 3, `status: ${JSON.stringify(report.tabs.status)}`);
  assert(report.tabs.ege.parts === 1 && report.tabs.ege.rows === 3, `ege: ${JSON.stringify(report.tabs.ege)}`);
  assert(report.tabs.king.parts === 2 && report.tabs.king.rows === 6, `king: ${JSON.stringify(report.tabs.king)}`);
  const sem = rows.filter(r => r.normKey === 'SEM203/P');
  assert(sem.length === 3, 'three currencies for SEM203/P');
  assert(sem.find(r => r.currency === 'GBP')?.sellPrice === 101, 'GBP sell as printed');
  const series = rows.find(r => r.normKey === '7100' && r.currency === 'GBP');
  assert(series && series.sellPrice === 3869, 'a numeric series still keys as text');
});

await check('no cost, purchase or list value survives into the rows', async () => {
  const { rows } = parseMegaWorkbook(buildWorkbook());
  for (const poison of [COST, PURCHASE, LIST]) {
    assert(!rows.some(r => r.sellPrice === poison), `poison ${poison} leaked into the extracted rows`);
  }
});

await check('rows without a sell price are counted, never invented around', async () => {
  const { report } = parseMegaWorkbook(buildWorkbook());
  assert(report.tabs.status.skippedNoPrice === 2, 'the section heading and the priceless row are both skipped');
});

await check('the skip report names the excluded columns per tab', async () => {
  const { report } = parseMegaWorkbook(buildWorkbook());
  assert(report.skippedColumns.status.some(c => /Cost/.test(c)), 'status names its cost column');
  assert(report.skippedColumns.ege.some(c => /Purchase/.test(c)), 'ege names its purchase column');
  assert(report.skippedColumns.king.some(c => /List/.test(c)), 'king names its list column');
});

await check('a missing tab is reported, not fatal', async () => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Status').addRow(['Part Number', 'Description', 'Nett', 'Sell  Price GBP']);
  const { report } = parseMegaWorkbook(wb);
  assert(report.missingTabs.includes('EGE') && report.missingTabs.includes('King'), 'missing tabs listed');
});

console.log('\nNormalisation and cell plumbing (pure):');

await check('the lookup key strips spaces and cases, keeps slashes and dashes', async () => {
  assert(normKey(' sem203/p ') === 'SEM203/P');
  assert(normKey('7610 / 7650') === '7610/7650');
  assert(normKey('AGKU 1500 GI') === 'AGKU1500GI');
  assert(normKey('') === '');
});

await check('price numbers parse currency clutter and refuse junk', async () => {
  assert(priceNumber('£1,234.50') === 1234.5);
  assert(priceNumber(101) === 101);
  assert(priceNumber(0) === null, 'zero is not a price');
  assert(priceNumber(-5) === null, 'negative is not a price');
  assert(priceNumber('CF') === null, 'consult-factory is not a number');
  assert(priceNumber(null) === null);
});

await check('formula cells yield their computed result', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('t');
  ws.getCell('A1').value = { formula: 'B1*2', result: 42 };
  ws.getCell('A2').value = { richText: [{ text: 'SEM' }, { text: '203' }] };
  assert(cellValue(ws.getCell('A1')) === 42, 'formula result');
  assert(cellValue(ws.getCell('A2')) === 'SEM203', 'rich text collapses');
  assert(TAB_SPECS.length === 3, 'three specs in phase 1');
});

console.log('\nQuoted lines route to process, never to a guessed number:');

await check('the configurator models route to their lines', async () => {
  assert(quotedLine('cv3000')?.line === 'Marwin', 'CV3000 is Marwin');
  assert(quotedLine('CV4700')?.line === 'Marwin', 'CV4700 is Marwin');
  assert(quotedLine('marwin cv3861')?.line === 'Marwin', 'a brand word routes too');
  assert(quotedLine('mark 96')?.line === 'Steriflow', 'Mark 96 is Steriflow');
  assert(quotedLine('MK96AA')?.line === 'Steriflow', 'MK96AA is Steriflow');
  assert(quotedLine('equilibar bpr')?.line === 'Equilibar', 'Equilibar routes to its own note');
});

await check('the notes point inward only: no supplier contacts, no team-notepad detail', async () => {
  // Per James, the mega sheet's note pad is the internal team's scratchpad
  // and the co-pilot must not repeat it: no supplier names or addresses, no
  // order rules, no margins. The only pointer is the internal one.
  for (const q of ['cv3000', 'equilibar bpr', 'steriflow', 'MK601']) {
    const m = quotedLine(q);
    assert(m, `${q} still routes`);
    assert(!/@/.test(m.note), `no email address in the ${m.line} note`);
    assert(!/tara|simon|thessel|swaring|inquiry/i.test(m.note), `no supplier contact in the ${m.line} note`);
    assert(!/MOV|minimum order|0055|0012/i.test(m.note), `no notepad rule in the ${m.line} note`);
    assert(!/\d+\s*%/.test(m.note), 'no percentage appears in any note');
    assert(/Andy|area sales manager/.test(m.note), 'the internal route is the pointer');
    assert(!/[—–!]/.test(m.note) && !/\bgenuinely\b/i.test(m.note), 'voice rules hold');
  }
});

await check('real parts and unknown queries never route to a quoted line', async () => {
  assert(quotedLine('SEM203/P') === null, 'a stored instrument part is not shadowed');
  assert(quotedLine('7100') === null, 'a King series is not shadowed');
  assert(quotedLine('random words') === null, 'nonsense stays an honest nothing');
  assert(quotedLine('') === null, 'empty stays empty');
});

console.log('\nThe co-pilot price turn (pure pieces):');

await check('price intent is money words only, a spec question is never hijacked', async () => {
  assert(priceIntent('what is the lowest cost of a marwin valve?'), "James's exact question qualifies");
  assert(priceIntent('what does the CV3000 cost'), 'cost qualifies');
  assert(priceIntent('can you quote SEM203/P'), 'quote qualifies');
  assert(!priceIntent('how much flow can the CV3000 pass'), 'a flow question is a spec question');
  assert(!priceIntent('what is the pressure rating of the CV3000'), 'a rating question is a spec question');
  assert(!priceIntent(''), 'empty is nothing');
});

await check('part tokens extract with digits, most specific first', async () => {
  const t = partTokens('can you price SEM203/P against the 7100 series');
  assert(t[0] === 'SEM203/P' && t.includes('7100'), `got ${JSON.stringify(t)}`);
  assert(partTokens('price of a marwin valve').length === 0, 'plain words are not part tokens');
});

await check('a stored price renders with its source and never as an estimate', async () => {
  const text = renderPriceAnswer({
    partNumber: 'SEM203/P', description: 'Push button config',
    prices: { GBP: 63, USD: 75, EUR: 66 }, sourceTab: 'Status', listName: 'Mega Price List', effectiveDate: '2026-07-14',
  });
  assert(text.includes('£63') && text.includes('$75') && text.includes('€66'), 'all three currencies');
  assert(text.includes('Status tab') && text.includes('2026-07-14'), 'the source and date travel');
  assert(/never estimated/.test(text), 'the promise is stated');
  assert(!/[—–!]/.test(text) && !/\bgenuinely\b/i.test(text), 'voice rules hold');
});

console.log('\nThe Richards guide transform (pure, synthetic parameters only):');

await check('the guide arithmetic compounds discounts, converts, margins and rounds up', async () => {
  // Synthetic parameters, never the real ones: the commercial figures live
  // only in the workbook and are read transiently at ingest.
  const p = { d: 0.1, e: 0.2, margin: 0.5, exportMargin: 0.5, usdPerGbp: 2, eurPerGbp: 1.5 };
  const g = computeGuide(1000, p);
  // buying = 1000*0.9*0.8 = 720; GBP = (720/2)/0.5 = 720; USD = 720/0.5 = 1440; EUR = 720*1.5 = 1080.
  assert(g.GBP === 720 && g.USD === 1440 && g.EUR === 1080, `got ${JSON.stringify(g)}`);
  const r = computeGuide(1001, p);
  assert(r.GBP === 721, 'rounds up to the next whole unit, never down');
  assert(!('buying' in g) && !('d' in g), 'only the three sells come out; the chain stays inside');
});

await check('a guide price renders labelled as a guide, never as a firm sell', async () => {
  const text = renderPriceAnswer({
    partNumber: 'CV3861-10', description: null, basis: 'guide',
    prices: { GBP: 3433, EUR: 3948, USD: 4463 }, sourceTab: 'guide', listName: 'Marwin NA price list via Richards transform', effectiveDate: '2026-07-17',
  });
  assert(/Guide price at the standard margin/.test(text), 'the guide label leads');
  assert(/margin is set per customer/.test(text), 'the per-customer caveat travels');
  assert(/Andy|area sales manager/.test(text), 'the internal confirmation route travels');
  assert(!/never estimated/.test(text), 'the firm-sell promise is not made for a guide');
});

await check('a whole-line question answers with the loaded range and its honest edge', async () => {
  const text = renderLineSummary({
    line: 'Marwin', count: 740, min: 181, max: 12138, anyGuide: true,
    minPart: 'CV4730F-050-CS/FAHLNN0000NN', minDesc: 'CV4730 full port carbon steel, 1/2"',
  });
  assert(text.includes('740 parts priced'), 'the count states the coverage');
  assert(text.includes('from £181 (CV4730F-050-CS/FAHLNN0000NN'), 'the cheapest loaded part answers "lowest" by name');
  assert(text.includes('to £12,138'), 'the top of the range travels');
  assert(/guide prices at the standard margin/.test(text), 'the guide caveat travels when any row is a guide');
  assert(/beyond the loaded lists are priced per enquiry/.test(text), 'the honest edge is stated');
  assert(!/[—–!]/.test(text) && !/\bgenuinely\b/i.test(text), 'voice rules hold');
});

console.log('\nThe Marwin page parser (synthetic table, real layout):');

// A miniature of the real pages: a size header, a model row with n/a
// alignment, the dual-header adder block, and a CV4700 row. Fake prices.
const MARWIN_FIXTURE = [
  '    Carbon Steel FULL PORT Standard Models                           1/4"       3/8"     1/2"     3/4"     1"',
  '    3000F-xxx-CS / PTS6TFTVHL (NPT)                                  $100       $100    $120     $140     $160',
  '    3000F-xxx-CS / F1S6TFTVHL (150# Flanged) (RF or RTJ)              n/a        n/a    $500     $600     $700',
  '                                                                       Full         1/4"   3/8"   1/2"   3/4"      1"',
  'Characterized Seat Adder (316 SS)                   Designator         Reduced             1/2"   3/4"    1"     1 1/4"',
  '30 Degree                                           A1                              $50   $50   $50   $50     $90',
  '           Handle Operated Part Number (NPT)                                                      1/2"         3/4"           1"     1 1/2"       2"',
  '           CV4730F-xxx-CS / FAHLNN0000NN                                                          $316         $349          $432     $719     $1,060',
].join('\n');

await check('the header, the rows, the n/a alignment and the adder all parse', async () => {
  const { parts, report } = parseMarwinPages(MARWIN_FIXTURE);
  assert(report.adder, 'the adder block is found');
  const half = parts.find(p => p.part === '3000F-050-CS/PTS6TFTVHL');
  assert(half?.listUsd === 120, `the half-inch NPT lands on its column, got ${JSON.stringify(half)}`);
  const cvHalf = parts.find(p => p.part === 'CV3000F-050-CS/PTS6TFTVHL');
  assert(cvHalf?.listUsd === 170, `the CV variant carries the plate adder, got ${JSON.stringify(cvHalf)}`);
  const flangedQuarter = parts.find(p => p.part === '3000F-025-CS/F1S6TFTVHL');
  assert(flangedQuarter === undefined, 'an n/a cell never becomes a part');
  const flangedHalf = parts.find(p => p.part === '3000F-050-CS/F1S6TFTVHL');
  assert(flangedHalf?.listUsd === 500, 'prices after n/a cells stay on their columns');
  const cv47 = parts.find(p => p.part === 'CV4730F-100-CS/FAHLNN0000NN');
  assert(cv47?.listUsd === 432, `CV4700 parses at its five-column width, got ${JSON.stringify(cv47)}`);
  assert(parts.every(p => !('buying' in p)), 'list prices only; no computed chain leaks from the parser');
});

await check('the row and header primitives hold their shapes', async () => {
  const r = parseModelRow('    3000R-xxx-S6 / PTS6TFTVHL (NPT)   n/a   $543   $563');
  assert(r.model === '3000R' && r.material === 'S6' && r.prices[0] === null && r.prices[1] === 543, JSON.stringify(r));
  assert(parseSizeHeader('some words 1/4" 3/8" 1/2" 3/4" 1"')?.length === 5, 'five sizes found');
  assert(parseSizeHeader('no sizes here') === null, 'prose is not a header');
});

console.log(`\n=== Pricing gate: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
