// The price parser, exercised offline against a synthetic workbook built in
// memory to mirror the real tabs' shapes. The check that matters most: the
// cost, purchase and list columns carry poison values, and the proof is that
// no poison value survives into the extracted rows. Margin data is excluded
// by construction, not by hope.
import ExcelJS from 'exceljs';
import { parseMegaWorkbook, extractTab, TAB_SPECS, normKey, priceNumber, cellValue } from './parseMega.mjs';
import { quotedLine } from './quotedLines.mjs';
import { priceIntent, partTokens, renderPriceAnswer } from './priceAnswer.mjs';

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

await check('the notes carry the enquiry route and never a margin', async () => {
  const m = quotedLine('cv3000');
  assert(/thessel@richardsind\.com/.test(m.note), 'the Richards enquiry address travels');
  assert(!/\d+\s*%/.test(m.note), 'no percentage appears in any note');
  assert(!/[—–!]/.test(m.note) && !/\bgenuinely\b/i.test(m.note), 'voice rules hold');
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

console.log(`\n=== Pricing gate: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
