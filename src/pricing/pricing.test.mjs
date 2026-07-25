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
import { parseRichardsBook, parseSizeColumns } from './parseRichardsPdf.mjs';
import { parseBestobell, parseHex } from './parseBooksSpecial.mjs';
import { parseMarwinMd } from './parseMarwinMd.mjs';
import { decomposePart, buildRangeTree, marwinSeriesOf, renderSeriesSummary } from './marwinRanges.mjs';
import { GUIDE_UPSERT, buildGuideUpsert } from './storeGuide.mjs';
import { superlativeIntent, decodeAcross, cheapestOf, renderCheapestValve } from './cheapest.mjs';
import { allConfigs } from '../configurator/registry.mjs';

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

console.log('\nThe generic Richards book parser (synthetic pages, real layouts):');

// A miniature of the awkward realities: a grouped table with the label above
// its prices, a missing cell without a placeholder, a hyphenated size, an
// orientation qualifier, sidebar prose sharing a line with a row, an adder
// section to skip, and a single-size LowFlow-style table. Fake prices.
const RICHARDS_FIXTURE = [
  '                         MARK 77 SANITARY TEST VALVE',
  '            Body             Vertical Conn     1/2"      3/4"     1-1/2"',
  '                     Tri-clamp                           $100      $300',
  '            Part A',
  '                                               $110      $120     $310',
  '            Body             Horizontal Conns  1/2"      3/4"     1-1/2"',
  '  sidebar words here Tri-clamp                 $200      $210     $400',
  '                             OPTIONS & ADDERS',
  '            Gasket thing                       $999      $999     $999',
  '                         MK55HP FRACTIONAL VALVE',
  '            Body Mat    End Con                1/2"',
  '            SST Cast    Threaded              $4,921',
].join('\n');

await check('grouping, gaps, hyphens, orientation, sidebar prose and adders all behave', async () => {
  const { parts } = parseRichardsBook(RICHARDS_FIXTURE, { line: 'test' });
  const get = k => parts.find(p => p.part === k);
  assert(get('MK77-075-TRICLAMP')?.listUsd === 100 && get('MK77-150-TRICLAMP')?.listUsd === 300,
    `a missing first cell never shifts its neighbours, got ${JSON.stringify(parts.map(p => p.part + '=' + p.listUsd))}`);
  assert(get('MK77-050-TRICLAMP') === undefined, 'the empty half-inch cell never becomes a part');
  assert(get('MK77-050-PARTA')?.listUsd === 110 && get('MK77-150-PARTA')?.listUsd === 310, 'a label above its prices claims them');
  assert(get('MK77-050-TRICLAMP-H')?.listUsd === 200, 'the horizontal group keys apart from the vertical');
  assert(!get('MK77-050-TRICLAMP-H')?.description.includes('sidebar'), 'sidebar prose never enters a label');
  assert(!parts.some(p => /GASKET/.test(p.part) || p.listUsd === 999), 'the adder section is skipped wholesale');
  assert(get('MK55HP-050-SSTCASTTHREADE')?.listUsd === 4921, `the single-size table parses, got ${JSON.stringify(parts.filter(p => p.part.startsWith('MK55')))}`);
});

await check('the size-column primitives: spans, hyphen canon, single-size guard', async () => {
  const cols = parseSizeColumns('     Ends   3/4"    1"   1-1/2"    2"');
  assert(cols?.length === 4 && cols[2].label === '1 1/2"', 'the hyphenated size canonicalises');
  assert(parseSizeColumns('prose mentioning 1/2" once') === null, 'a stray size in prose is not a header');
  assert(parseSizeColumns('   Body Mat  End Con   1/2"')?.length === 1, 'a single-size table header qualifies with header words');
});

console.log('\nThe BestoBell and Hex specs (synthetic pages, real layouts):');

await check('BestoBell pairs prices with real part numbers; spanned prices apply to both sizes', async () => {
  // Placement is computed, not hand-spaced: column centres at fixed offsets,
  // so what is "clearly under a column" and what is "between two" is exact.
  const place = pairs => {
    let s = '';
    for (const [text, at] of pairs) s = s.padEnd(Math.max(0, at - Math.floor(text.length / 2))) + text;
    return s;
  };
  const C = { half: 40, threeq: 60, one: 80 };
  const mid = Math.floor((C.half + C.threeq) / 2);
  const fixture = [
    place([['Model GM9', 10], ['1/2"', C.half], ['3/4"', C.threeq], ['1"', C.one]]),
    place([['NPT', 10], ['$100', C.half], ['$200', C.threeq], ['$300', C.one]]),
    place([['Part Number', 10], ['GM009210', C.half], ['GM009310', C.threeq], ['GM009410', C.one]]),
    place([['DTC', 10], ['$555', mid]]),
    place([['Part Number', 10], ['GM009211', C.half], ['GM009311', C.threeq]]),
    place([['SW', 10], ['CONSULT FACTORY', C.threeq]]),
    place([['Part Number', 10], ['GM009220', C.half], ['GM009320', C.threeq]]),
    place([['FLG', 10], ['$700', C.half], ['$800', C.threeq]]),
    place([['Part Number', 10], ['GM009230', mid]]),
  ].join('\n');
  const { parts, report } = parseBestobell(fixture);
  const get = pn => parts.find(p => p.part === pn);
  assert(get('GM009210')?.listUsd === 100 && get('GM009310')?.listUsd === 200 && get('GM009410')?.listUsd === 300,
    `clear columns pair price with true part number, got ${JSON.stringify(parts)}`);
  // James, July 2026: a price printed between two sizes applies to both.
  assert(get('GM009211')?.listUsd === 555 && get('GM009311')?.listUsd === 555,
    'a price printed between two sizes applies to both part numbers of the pair');
  assert(get('GM009211')?.description.includes('1/2"') && get('GM009311')?.description.includes('3/4"'),
    'each part of the pair keeps its own size in the description');
  assert(report.spanned >= 1, 'the spanned price is counted as spanned, not ambiguous');
  assert(get('GM009230') === undefined && report.ambiguous >= 1,
    'a part number between two columns is still refused and counted; parts never span');
  assert(get('GM009220') === undefined, 'consult-factory rows price nothing');
});

await check('Hex flat rows: model number first, list price last, group code dropped', async () => {
  const fixture = [
    '               HN41     Model Number     Material     Inlet         Outlet       Seat        Packing   Box Quantity   List Price',
    '                      HN412D2FM2C2      316 NACE    1/4" FNPT     1/4" MNPT    Delrin (soft)  TFE        1 each         $195',
    '               HN49   HN490U3131412        SS       1/2" MNPT     1/2" FNPT    Integral (Hard) TFE       1 each         $449',
  ].join('\n');
  const { parts } = parseHex(fixture);
  assert(parts.length === 2, `two parts, got ${JSON.stringify(parts.map(p => p.part))}`);
  assert(parts[0].part === 'HN412D2FM2C2' && parts[0].listUsd === 195, 'the part number is the key');
  assert(parts[1].part === 'HN490U3131412' && parts[1].listUsd === 449, 'a leading group code is dropped');
  assert(parts[1].description.includes('1/2" MNPT'), 'the connections travel in the description');
});

console.log('\nThe Marwin full-book markdown parser (synthetic pages, real layouts):');

// Poison values: weights and adder figures that must never surface as prices.
const W_POISON = 391, ADDER_POISON = 987;

const MW_FIXTURE = `## Page 3 — 9000 Series
Manual Operated List Prices

| Valve Size | 1/2" | 3/4" | 2" |
|---|---|---|---|
| 9923FTRS-xxx (Carbon Steel) | $44 | $61 | CF |
| Weight (lbs.) | 0.71 | 1.32 | $${W_POISON} |

| Full Port |  |  |  |
|---|---|---|---|
| 9933FTRS-xxx | $47 | n/a | $223 |

## Page 4 — 9000 Series - Spring Return

| STAINLESS STEEL |  |  |  |  |  |
|---|---|---|---|---|---|
| SIZE | MODEL | LIST | SIZE | MODEL | LIST |
| 1/2" | DM9900F-050-S6 / AAS18 (UT-0-SR) | $581 | 1/2" | DM9900F-050-S6 / AAS16 (UT-0-SR) | $581 |
| 2" | N/A |  | 2" | N/A |  |

| SOLENOIDS | LIST |
|---|---|
| ASCO 8551A001MS Nema 4 | $${ADDER_POISON} |

## Page 8 — 8700 Series

| Valve Size | 1/2" | 2" |
|---|---|---|
| 8700F-xxx-CS / BAHL | $79 | $324 |

| Special Features Adder | 1/2" | 2" |
|---|---|---|
| Fire Tested | $${ADDER_POISON} | $${ADDER_POISON} |

## Page 9 — 8700 Series - Spring Return

| SIZE | MODEL | LIST |
|---|---|---|
| 1/2" | 8700F-05A-S6 / BAS18 (UT-0-SR) | $527 |

## Page 16 — 3000 Series Pricing

| Carbon Steel Standard Models | 1/2" | 3/4" | 1" |
|---|---|---|---|
| 3000F-xxx-CS / PTS6 (NPT) | $539 | $575 | $740 |
| 3000F-xxx-S6 / F1S6 (150# Flanged) | n/a | $1,859$2,056$2,707 |  |
|  | $197 | $218 | $263 |

## Page 17 — 3000 Series Pricing

| Twice Printed | 1/2" | 3/4" | 1" |
|---|---|---|---|
| 3000F-xxx-CS / PTS6 (NPT) | $539 | $999 | $740 |

## Page 21 — 3000 Series Pricing - Repair Kits

| Kit | 1/2" |
|---|---|
| 3000F-xxx-CS / KIT | $${ADDER_POISON} |

## Page 27 — CV3000 Series

| Valve Size | 1/2" |
|---|---|
| 3000F-xxx-CS / CVONLY | $${ADDER_POISON} |

## Page 90 — UT Pneumatic Actuators

| Model | LIST |
|---|---|
| UT-0-SR-100-CS | $${ADDER_POISON} |
`;

await check('conventions come from the book: numeric evidenced, letter evidenced, defaults confessed', async () => {
  const { parts, report, defaultedSeries, mixedSeries } = parseMarwinMd(MW_FIXTURE);
  const get = pn => parts.find(p => p.part === pn);
  assert(get('9923FTRS-050')?.listUsd === 44 && get('9923FTRS-075')?.listUsd === 61,
    `numeric expansion from the series' own complete codes, got ${JSON.stringify(parts.map(p => p.part))}`);
  assert(get('9933FTRS-200')?.listUsd === 223, 'a continuation table inherits the page size header');
  assert(get('DM9900F-050-S6/AAS18')?.listUsd === 581, 'a doubled SIZE MODEL LIST row parses, and is not a size header');
  assert(get('8700F-05A-CS/BAHL')?.listUsd === 79, 'a letter-evidenced series expands its template to letter codes');
  assert(get('8700F-050-CS/BAHL') === undefined, 'the numeric form of a letter series is never invented');
  assert(report.unevidencedSize >= 1 && get('8700F-20A-CS/BAHL') === undefined,
    'a size with no evidenced letter code is refused and counted, not extrapolated');
  assert(defaultedSeries.includes('3000') && !defaultedSeries.includes('8700'),
    'a series with no complete code is named as defaulted to the stated numeric rule');
  assert(mixedSeries.length === 0, 'no series mixes conventions in the fixture');
});

await check('the refusals hold: collapsed cells, modelless rows, conflicts withdrawn, poisons never price', async () => {
  const { parts, report, conflictParts } = parseMarwinMd(MW_FIXTURE);
  const get = pn => parts.find(p => p.part === pn);
  assert(report.spanRefused >= 1 && get('3000F-075-S6/F1S6') === undefined,
    'a cell holding several prices refuses its whole row');
  assert(report.modelless >= 1, 'a priced row with no part number is counted');
  assert(conflictParts.includes('3000F-075-CS/PTS6') && get('3000F-075-CS/PTS6') === undefined,
    'the same code at two prices is withdrawn entirely and listed');
  assert(get('3000F-050-CS/PTS6')?.listUsd === 539, 'the same code at the same price twice is one part');
  assert(!parts.some(p => p.listUsd === W_POISON), 'a weight figure never becomes a price');
  assert(!parts.some(p => p.listUsd === ADDER_POISON),
    'adder, solenoid, repair-kit, CV-page and accessory-page figures never become prices');
  assert(report.cf >= 1, 'consult-factory cells are counted');
  assert(report.skippedPages.cv === 1 && report.skippedPages.kits === 1 && report.skippedPages.accessories === 1,
    'CV, repair-kit and accessory pages are skipped and counted');
});

console.log('\nThe Marwin range builder, stage one (pure derivation over stored parts):');

await check('a part number decomposes into its choosing axes, numeric and letter sizes alike', async () => {
  assert(JSON.stringify(decomposePart('2000F-050-CS-F1/BFS28')) ===
    JSON.stringify({ model: '2000F', size: '1/2"', material: 'CS', packageCode: 'F1/BFS28' }),
    'end-class and options both land in the package');
  assert(decomposePart('9923FTRS-050')?.model === '9923FTRS' && decomposePart('9923FTRS-050')?.packageCode === null,
    'a catalogue number with nothing after the size has no package');
  assert(decomposePart('3T-3700R-025-S6/AAHL')?.model === '3T-3700R', 'a hyphenated model keeps its hyphen');
  assert(decomposePart('8700F-05A-CS/BAHL')?.size === '3/4"' === false && decomposePart('8700F-05A-CS/BAHL')?.size === '1/2"',
    'letter size codes read as their size');
  assert(decomposePart('UT-0-SR') === null, 'a string with no size segment is not a part');
});

await check('the range tree offers only stored parts, grouped and sorted for choosing', async () => {
  const rows = [
    { part_number: '666FTTS-200', description: 'Marwin 600 series, 2", Full Port (Brass Internals)', prices: { GBP: 130 } },
    { part_number: '666FTTS-025', description: 'Marwin 600 series, 1/4", Full Port (Brass Internals)', prices: { GBP: 11 } },
    { part_number: '633FTRS-025', description: 'Marwin 600 series, 1/4", Full Port (Stainless Steel Internals)', prices: { GBP: 35 } },
    { part_number: 'DM600F-025-BR/AANN', description: 'Marwin 600 series, 1/4", brass, Direct Mount', prices: { GBP: 38 } },
    { part_number: 'garbage', description: 'not a part', prices: {} },
  ];
  const tree = buildRangeTree(rows);
  assert(tree.skipped === 1, 'an undecomposable row is skipped and counted, never guessed into the tree');
  assert(tree.models.map(m => m.model).join(',') === '633FTRS,666FTTS,DM600F', 'models sort');
  const m666 = tree.models.find(m => m.model === '666FTTS');
  assert(m666.sizes.map(s => s.size).join(',') === '1/4",2"', 'sizes sort by size, not text');
  const leaf = m666.sizes[0].materials[0].packages[0];
  assert(leaf.part === '666FTTS-025' && leaf.prices.GBP === 11, 'the leaf is the stored part with its prices');
  assert(leaf.label.includes('Full Port'), 'the package label carries the port and internals gloss');
});

await check('series questions route to their series, and only with intent words plus series or marwin', async () => {
  assert(marwinSeriesOf('what is the cheapest 9000 series valve?') === '9000');
  assert(marwinSeriesOf('marwin 8700 price please') === '8700');
  assert(marwinSeriesOf('fw4700 series cost') === 'FW4700', 'FW4700 beats 4700');
  assert(marwinSeriesOf('ms3000 series pricing') === 'MS3000', 'MS3000 beats 3000');
  assert(marwinSeriesOf('price a 3L-2100 for me') === '3T-2100/3L-2100', 'the three-way families route together');
  assert(marwinSeriesOf('we sold 3000 units last year') === null, 'a bare number without marwin or series is not a series');
  assert(marwinSeriesOf('cv3000 pricing') === null, 'CV3000 stays with the existing whole-line answer');
  assert(marwinSeriesOf('what is the price of SEM203/P') === null, 'part questions are not series questions');
});

await check('the series answer states what is loaded, the cheapest by name, and the honest edges', async () => {
  const text = renderSeriesSummary({ series: '600', count: 96, min: 11, max: 727, minPart: '666FTTS-025', minDesc: 'Marwin 600 series, 1/4", Full Port (Brass Internals)' });
  assert(text.includes('96 parts priced') && text.includes('£11') && text.includes('666FTTS-025'), 'the floor is named');
  assert(text.includes('guide prices') && text.includes('margin is set per customer at quote'), 'the guide caveat holds');
  assert(text.includes('per enquiry'), 'the beyond-the-book edge holds');
  assert(!/[—–!]/.test(text) && !/\bgenuinely\b/i.test(text), 'voice rules hold');
});

await check('the twice-priced ruling lives in the one storage statement: the higher figure stands', async () => {
  // James, July 2026, on codes both book sections price: the parts are
  // identical, go with the higher price. Direction is per code, not per
  // section: the CV pages are higher on some codes, the 3000 pages on others.
  assert(/GREATEST\(prices\.sell_price, EXCLUDED\.sell_price\)/.test(GUIDE_UPSERT),
    'the higher figure stands whichever ingest runs last');
  assert((GUIDE_UPSERT.match(/CASE WHEN EXCLUDED\.sell_price > prices\.sell_price/g) || []).length >= 4,
    'the identity columns follow whichever source won');
  assert(/ON CONFLICT \(product_line, norm_key, currency\)/.test(GUIDE_UPSERT),
    'keyed per code and per currency');
  assert(/'guide'/.test(GUIDE_UPSERT), 'everything through this path is labelled guide');
  const batched = buildGuideUpsert(3);
  assert((batched.match(/\('?\$/g) || []).length === 3 && /\$27\)/.test(batched),
    'the batched form carries one tuple per row with contiguous parameters');
  assert(/GREATEST\(prices\.sell_price, EXCLUDED\.sell_price\)/.test(batched)
    && (batched.match(/'guide'/g) || []).length === 3,
    'the ruling clauses and the guide label are identical at any batch width');
});

console.log('\nThe cheapest-valve tier (superlative questions, matrix read-back):');

await check('superlative words are read narrowly: money superlatives yes, other lowests no', async () => {
  assert(superlativeIntent('what is the lowest cost of a marwin valve?'), 'lowest cost');
  assert(superlativeIntent('cheapest marwin valve please'), 'cheapest');
  assert(superlativeIntent('least expensive 4700 build'), 'least expensive');
  assert(superlativeIntent('best price on a 3000 series'), 'best price');
  assert(!superlativeIntent('lowest temperature rating of the 9700'), 'a lowest temperature is not a price superlative');
  assert(!superlativeIntent('how much does the 4700 cost'), 'a plain price question is not a superlative');
});

await check('the cheapest decodable build reads back slot by slot with the guide caveat', async () => {
  const rows = [{ part_number: '4700F-05A-CS/FAHLNN0000NN', description: 'Marwin 4700 series, 1/2", carbon steel, lever', sell_price: 111 }];
  const c = cheapestOf(allConfigs(), rows);
  assert(c && c.build, 'the book code decodes through the registry');
  const text = renderCheapestValve({ scope: 'Marwin valve', ...c });
  assert(text.includes('The lowest priced Marwin valve in the loaded book is **4700F-05A-CS/FAHLNN0000NN**'), 'the answer names the code');
  assert(text.includes('£111'), 'the synthetic price renders as loaded');
  assert(text.includes('reads through the') && /- .*: .*\(4700F\)/.test(text), 'the spec lists each position with its code');
  assert(text.includes("guide price at the calculator's standard settings") && text.includes('per enquiry'), 'the guide caveat and the enquiry edge hold');
  assert(!/[—–!]/.test(text) && !/\bgenuinely\b/i.test(text), 'voice rules hold');
});

await check('an undecodable head row stays the answer, honestly, never skipped for a runner-up', async () => {
  const rows = [
    { part_number: 'MS3000X-050-CS/PTS3W5GRHL', description: 'Marwin MS3000 series metal seated, 1/2", lever', sell_price: 11 },
    { part_number: '4700F-05A-CS/FAHLNN0000NN', description: 'Marwin 4700 series, 1/2", carbon steel, lever', sell_price: 22 },
  ];
  const c = cheapestOf(allConfigs(), rows);
  assert(c.row.part_number === 'MS3000X-050-CS/PTS3W5GRHL', 'the head row wins even undecodable');
  assert(!c.build, "the book's short form is not the datasheet grammar, so it does not decode");
  const text = renderCheapestValve({ scope: 'Marwin valve', ...c });
  assert(text.includes('no ordering matrix in the engine'), 'the gap is confessed, not papered over');
  assert(text.includes('Marwin MS3000 series metal seated'), "the book's own description carries the spec");
  assert(!text.includes('reads through'), 'no read-back is claimed');
});

await check('matrix cautions ride along on the read-back', async () => {
  const b = decodeAcross(allConfigs(), '9700F-05A-CS/KAHLNN0000NN');
  assert(b, 'the 9700 book form decodes');
  const text = renderCheapestValve({ scope: 'Marwin 9700 series valve', row: { part_number: '9700F-05A-CS/KAHLNN0000NN', description: '', sell_price: 33 }, build: b });
  assert(text.includes('Note:') && /consult factory/i.test(text), "the sheet's consult-factory line rides along");
});

await check('no rows means no answer, so the turn falls through', async () => {
  assert(cheapestOf(allConfigs(), []) === null, 'empty rows');
  assert(decodeAcross(allConfigs(), 'NOT-A-CODE') === null, 'garbage decodes nowhere');
});

console.log(`\n=== Pricing gate: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
