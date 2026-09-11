// The price parser, exercised offline against a synthetic workbook built in
// memory to mirror the real tabs' shapes. The check that matters most: the
// cost, purchase and list columns carry poison values, and the proof is that
// no poison value survives into the extracted rows. Margin data is excluded
// by construction, not by hope.
import ExcelJS from 'exceljs';
import { parseMegaWorkbook, extractTab, TAB_SPECS, normKey, priceNumber, cellValue } from './parseMega.mjs';
import { quotedLine } from './quotedLines.mjs';
import { priceIntent, partTokens, renderPriceAnswer, renderLineSummary, baseKeys, optionsAfter, asksCost, familyKey, renderFamilyAnswer } from './priceAnswer.mjs';
import { readFileSync } from 'node:fs';
import { computeGuide } from './richardsTransform.mjs';
import { parseMarwinPages, parseModelRow, parseSizeHeader } from './parseMarwinPdf.mjs';
import { parseRichardsBook, parseSizeColumns } from './parseRichardsPdf.mjs';
import { parseBestobell, parseHex } from './parseBooksSpecial.mjs';
import { parseMarwinMd } from './parseMarwinMd.mjs';
import { decomposePart, buildRangeTree, marwinSeriesOf, renderSeriesSummary } from './marwinRanges.mjs';
import { GUIDE_UPSERT, buildGuideUpsert } from './storeGuide.mjs';
import { superlativeIntent, decodeAcross, cheapestOf, renderCheapestValve } from './cheapest.mjs';
import { classifyHeader, pickSheet, parseAlicatWorkbook, applyBlockers, columnIndex, colLetter, LIST_WHY } from './parseAlicat.mjs';
import { parseAlicatPdfText, pdfApplyBlockers, detectCurrency, PART_TOKEN } from './parseAlicatPdf.mjs';
import { costFrom, renderCostLine, surchargePct, SURCHARGE_SERIES, parseCostRule, costRuleFor, applyCostRule } from './supplierPrices.mjs';
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
  assert(quotedLine('cheapest alicat mass flow controller')?.line === 'Alicat', 'the Alicat brand word routes to its line');
  assert(quotedLine('price of an MC-500SCCM-D') === null, 'an Alicat model code alone claims nothing; the stored key answers it');
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

await check('a configured code finds its base part, names its options, and cost is refused plainly', async () => {
  // James's test, 11 September 2026: a fully configured Alicat code.
  const q = 'Alicat part number PCD-100PSIG-D-M12-PCV30/5P, RIN, 5IN, GAS: AIR, P1: 6-8 BARG, P2: 3-4 BARG, VOL: ~50CC, HC. What is our sales price and the suppliers cost price?';
  assert(priceIntent(q) && asksCost(q), 'money words on both sides');
  assert(partTokens(q)[0] === 'PCD-100PSIG-D-M12-PCV30/5P', `the configured code is the first token: ${JSON.stringify(partTokens(q))}`);
  const keys = baseKeys('PCD-100PSIG-D-M12-PCV30/5P');
  assert(JSON.stringify(keys) === JSON.stringify(['PCD-100PSIG-D-M12-PCV30', 'PCD-100PSIG-D-M12', 'PCD-100PSIG-D', 'PCD-100PSIG']),
    `the code shortens one segment at a time down to the range: ${JSON.stringify(keys)}`);
  assert(JSON.stringify(optionsAfter('PCD-100PSIG-D-M12-PCV30/5P', 'PCD-100PSIG-D')) === JSON.stringify(['M12', 'PCV30', '5P']), 'the options are what came off');
  assert(baseKeys('SEM203/P').length === 0 && baseKeys('7100').length === 0, 'a code without a hyphen has no base to fall back to');
  const text = renderPriceAnswer(
    { partNumber: 'PCD-100PSIG-D', description: 'Pressure controller, 100 psig', prices: { GBP: 1328 }, basis: 'sell', sourceTab: 'pdf', listName: 'Alicat Q1 2026', effectiveDate: '2026-09-10' },
    { configured: 'PCD-100PSIG-D-M12-PCV30/5P', options: ['M12', 'PCV30', '5P'], askedCost: true });
  assert(/reads as the base part PCD-100PSIG-D with the options M12, PCV30, 5P/.test(text), 'the read-back names the base and the options');
  assert(/\*\*PCD-100PSIG-D\*\*, Pressure controller, 100 psig: £1,328\./.test(text), 'the base price renders');
  assert(/Sell price from the Alicat Q1 2026 list, effective 2026-09-10/.test(text) && !/pdf tab/.test(text), 'a PDF source reads as the list, not a tab');
  // A date from the database is a Date, and it must still read as a day.
  const dated = renderPriceAnswer({ partNumber: 'PCD-100PSIG-D', description: null, prices: { GBP: 1410 }, basis: 'sell', sourceTab: 'pdf', listName: 'Alicat Q1 2026', effectiveDate: new Date('2026-09-11T00:00:00Z') });
  assert(/effective 2026-09-11\./.test(dated) && !/Fri Sep/.test(dated), `a Date renders as a day, not a weekday: ${dated}`);
  assert(/options are priced as additions and are not held in the engine yet/.test(text), 'the options are named as additions, honestly');
  assert(/Purchase price: not held for this part/.test(text), 'an ask for cost with nothing held says so in a sentence');
  assert(!/[—–!]/.test(text) && !/\bgenuinely\b/i.test(text), 'voice rules hold');
  const plain = renderPriceAnswer({ partNumber: 'MC-500SCCM-D', description: null, prices: { GBP: 1071 }, basis: 'sell', sourceTab: 'pdf', listName: 'Alicat Q1 2026', effectiveDate: null });
  assert(!/reads as the base part|additions|Purchase price|purchase/i.test(plain), 'a plain part carries none of the configured or cost lines');
  const ans = readFileSync(new URL('../answer.mjs', import.meta.url), 'utf8');
  assert(/priceIntent\(question\) && !\(configState && configState\.active\)\s*\?\s*\{ handled: false/.test(ans),
    'a price question with no build in progress never goes to the configurator');
});

await check('when nothing matches as written or shortened, the family\'s stored parts answer, never a guess', async () => {
  // James's second run, 11 September 2026: the list spells its pressure
  // controllers another way, so the whole-line summary came back instead.
  assert(familyKey('PCD-100PSIG-D-M12-PCV30/5P') === 'PCD-100PSIG' && familyKey('MC-500SCCM-D') === 'MC-500SCCM' && familyKey('P-10TORRA-D-SAE4') === 'P-10TORRA', 'series and range');
  assert(familyKey('SEM203/P') === null && familyKey('7100') === null && familyKey('BB3') === null, 'a code without a hyphenated range has no family');
  const matches = [
    { partNumber: 'PCD-100PSIG-D-PCV30', description: 'Pressure controller, 100 psig, PCV30', prices: { GBP: 1520 }, listName: 'Alicat Q1 2026' },
    { partNumber: 'PCD-100PSIG-D-PCV65', description: null, prices: { GBP: 1610 }, listName: 'Alicat Q1 2026' },
  ];
  const text = renderFamilyAnswer('PCD-100PSIG-D-M12-PCV30/5P', 'PCD-100PSIG', matches, { askedCost: true, costs: { 'PCD-100PSIG-D-PCV30': { cost: 988.5, currency: 'USD' } } });
  assert(/\*\*PCD-100PSIG-D-M12-PCV30\/5P\*\* is not in the loaded list as written\. The list holds these PCD-100PSIG parts:/.test(text), 'the miss is stated first');
  assert(/- PCD-100PSIG-D-PCV30, Pressure controller, 100 psig, PCV30: £1,520; purchase \$988\.50/.test(text), 'each stored part with its sell price, and the purchase price where held and asked');
  assert(/- PCD-100PSIG-D-PCV65: £1,610$/m.test(text) && !/PCV65.*purchase/.test(text), 'no purchase figure is invented for a part without one');
  assert(/Sell prices from the Alicat Q1 2026, never estimated\. The part after PCD-100PSIG in what was asked, D, M12, PCV30, 5P, reads as options or a variant/.test(text), 'the tail is named as options or a variant');
  const unasked = renderFamilyAnswer('PCD-100PSIG-D-M12-PCV30/5P', 'PCD-100PSIG', matches, { askedCost: false, costs: { 'PCD-100PSIG-D-PCV30': { cost: 988.5, currency: 'USD' } } });
  assert(!/purchase/i.test(unasked), 'not asked: no purchase figure, even with one to hand');
  const none = renderFamilyAnswer('PCD-100PSIG-D-M12-PCV30/5P', 'PCD-100PSIG', matches, { askedCost: true, costs: {} });
  assert(/Purchase price: not held for these parts\./.test(none), 'asked with nothing held: said plainly');
  assert(!/[—–!]/.test(text) && !/\bgenuinely\b/i.test(text), 'voice rules hold');
});

await check('the purchase price is held apart, worked out from the list, and given only on an explicit ask', async () => {
  // John's rule, 11 September 2026, agreed with James: both prices may be
  // given, the supplier's only when asked for in so many words.
  assert(costFrom({ listPrice: 1000, discountPct: 35 }) === 650 && costFrom({ listPrice: 1000, discountPct: 20 }) === 800, 'list less the discount');
  assert(costFrom({ listPrice: 1000, discountPct: 35, netPrice: 700 }) === 700, 'a stated net buying price wins');
  assert(costFrom({ listPrice: 1000 }) === null && costFrom({ listPrice: 0, discountPct: 35 }) === null && costFrom({ listPrice: 1000, discountPct: 100 }) === null, 'a cost is never guessed');
  const cost = { partNumber: 'PCD-100PSIG-D', currency: 'USD', listPrice: 1899.32, discountPct: 35, netPrice: null, cost: 1234.56, listName: 'Alicat Price List 101', effectiveDate: '2026-01-01' };
  const line = renderCostLine(cost);
  assert(/Purchase price, given because you asked for it: \$1,234\.56, the supplier's list \$1,899\.32 less 35%, from the Alicat Price List 101, effective 2026-01-01/.test(line), line);
  assert(/Never a figure to quote; the sell price is the one for customers/.test(line), 'the line says what the figure is for');
  assert(/a stated net buying price/.test(renderCostLine({ ...cost, netPrice: 700, cost: 700 })), 'a net price says so');
  assert(renderCostLine(null) === 'Purchase price: not held for this part.', 'nothing held is said plainly');
  // Alicat's rev 101 notice: the low-volume surcharge on BASIS and EP/C/D
  // units, (51 minus quantity) times 2%, stated only for those series.
  assert(surchargePct(10) === 82 && surchargePct(1) === 100 && surchargePct(51) === 0 && surchargePct(60) === 0, 'the notice\'s own example, ten units at 82%');
  assert(SURCHARGE_SERIES.test('EPC-100PSI') && SURCHARGE_SERIES.test('EPD-500SCCM-D') && SURCHARGE_SERIES.test('EP-1SLPM') && SURCHARGE_SERIES.test('BASIS-2-100SCCM'), 'the series the notice names');
  assert(!SURCHARGE_SERIES.test('PCD-100PSIG-D') && !SURCHARGE_SERIES.test('MC-500SCCM-D') && !SURCHARGE_SERIES.test('EPIC-1'), 'mainline units carry no surcharge');
  assert(/Low-volume surcharge applies to BASIS and EP\/C\/D units, per Alicat's rev 101 notice/.test(renderCostLine({ ...cost, partNumber: 'EPC-100PSI' })) && /82% at ten units and 100% for a single unit/.test(renderCostLine({ ...cost, partNumber: 'EPC-100PSI' })), 'an EPC costing carries the surcharge');
  assert(!/surcharge/i.test(line), 'a mainline costing does not');
  const m = { partNumber: 'PCD-100PSIG-D', description: 'Pressure controller', prices: { GBP: 1328 }, basis: 'sell', sourceTab: 'pdf', listName: 'Alicat Q1 2026', effectiveDate: null };
  const asked = renderPriceAnswer(m, { askedCost: true, cost });
  assert(/£1,328/.test(asked) && /Purchase price, given because you asked for it: \$1,234\.56/.test(asked), 'asked: the sell price first, then the purchase price');
  const unasked = renderPriceAnswer(m, { askedCost: false, cost });
  assert(/£1,328/.test(unasked) && !/1,234|purchase|supplier's list/i.test(unasked), 'not asked: the sell price only, even with a cost to hand');
  assert(asksCost('what do we buy the MC-500SCCM-D for') && asksCost('confirm our costings on PCD-100PSIG-D') && asksCost('purchase price please'), 'buying, costings and purchase are explicit asks');
  assert(!asksCost('what is the price of an MC-500SCCM-D') && !asksCost('how much is the PCD-100PSIG-D'), 'a plain price question is not an ask for cost');
  assert(!/[—–!]/.test(asked) && !/\bgenuinely\b/i.test(asked), 'voice rules hold');
});

await check('the supplier list reads in its own mode: USD is the price, sterling is set aside, and the sell mode still refuses it', async () => {
  const usd = [
    'Alicat Scientific Price List 101                List Price      Partner Price',
    'MC-500SCCM-D          Mass flow controller, 500 sccm           $1,650',
    'MCR-5SLPM-D           $2,900 MCS-5SLPM-D           $3,200',
    'FP-25                 $4,100',
    'BASIS-2-100SCCM       $520          $420',
    'EPC-100PSI            $400          $300',
    'UK partner list reference   PC-15PSIG-D             £845',
  ].join('\n');
  const s = parseAlicatPdfText(usd, { mode: 'supplier' });
  const get = k => s.rows.find(r => r.normKey === k);
  assert(s.report.mode === 'supplier' && s.report.currency.default === 'USD', 'the supplier read expects USD');
  assert(get('MC-500SCCM-D')?.price === 1650 && get('MC-500SCCM-D').currency === 'USD' && get('MCS-5SLPM-D')?.price === 3200 && get('FP-25')?.price === 4100, `USD figures are the prices: ${JSON.stringify(s.rows.map(r => r.partNumber + '=' + r.price))}`);
  assert(!get('PC-15PSIG-D') && s.report.otherCurrency.some(l => /PC-15PSIG-D £845/.test(l)), 'a sterling figure is set aside in the supplier read');
  // The partner price beside the list price, James's rule for BASIS and EPC.
  assert(get('BASIS-2-100SCCM')?.price === 520 && get('BASIS-2-100SCCM').partnerPrice === 420 && get('EPC-100PSI')?.partnerPrice === 300, `a second figure straight after the first is the partner price: ${JSON.stringify(s.rows.filter(r => r.partnerPrice != null))}`);
  assert(get('MC-500SCCM-D').partnerPrice === null && s.report.partnerPrices === 2 && !s.report.priceNoPart.some(l => /\$420|\$300/.test(l)), 'a part with one figure has no partner price, and partner figures are not prices with no part');
  assert(pdfApplyBlockers(s.report).length === 0, 'a clean supplier read has no blockers');
  // The rules, by code: the specific before the general, the first match wins.
  const rules = ['BASIS*=partner', 'EPC*=partner', 'CODA*=20', 'RECAL*=list', 'CLEAN*=list'].map(parseCostRule);
  assert(rules.every(Boolean) && parseCostRule('nonsense') === null && parseCostRule('X=') === null, 'rules parse, junk does not');
  assert(costRuleFor('BASIS-2-100SCCM', rules)?.value === 'partner' && costRuleFor('EPC-100PSI', rules)?.value === 'partner', 'BASIS and EPC take the partner price');
  assert(costRuleFor('CODA-KC-500SCCM', rules)?.value === 20 && costRuleFor('RECAL-MC', rules)?.value === 'list' && costRuleFor('MC-500SCCM-D', rules) === null, 'CODA at 20%, recalibration at list, the mainline on the standing rule');
  const basis = applyCostRule(get('BASIS-2-100SCCM'), costRuleFor('BASIS-2-100SCCM', rules), 35);
  assert(basis.netPrice === 420 && basis.discountPct === null && basis.costRule === 'partner price' && costFrom(basis) === 420, 'a partner rule stores the partner price as the net');
  const noPartner = applyCostRule(get('MC-500SCCM-D'), parseCostRule('MC*=partner'), 35);
  assert(noPartner.netPrice === null && /none printed/.test(noPartner.costRule) && costFrom({ listPrice: 1650, ...noPartner }) === null, 'a partner rule with no partner price on the row stores no cost, and says so');
  const listRule = applyCostRule(get('FP-25'), parseCostRule('FP-25=list'), 35);
  assert(listRule.discountPct === 0 && costFrom({ listPrice: 4100, ...listRule }) === 4100, 'a list rule is the stated price with no discount');
  const standing = applyCostRule(get('MC-500SCCM-D'), null, 35);
  assert(standing.discountPct === 35 && standing.costRule === 'list less 35%' && costFrom({ listPrice: 1650, ...standing }) === 1072.5, 'no rule is the standing discount');
  assert(/the supplier's partner price as printed/.test(renderCostLine({ partNumber: 'EPC-100PSI', currency: 'USD', listPrice: 400, netPrice: 300, cost: 300, costRule: 'partner price', listName: 'Alicat Price List 101' })), 'the answer names the partner price for what it is');
  assert(/the supplier's stated price \$50\.00 with no discount/.test(renderCostLine({ partNumber: 'RECAL-MC', currency: 'USD', listPrice: 50, discountPct: 0, netPrice: null, cost: 50, costRule: 'list price, no discount', listName: 'Alicat Price List 101' })), 'and a no-discount price for what it is');
  const sell = parseAlicatPdfText(usd.split('\n').slice(0, 4).join('\n'));
  assert(sell.rows.length === 0 && pdfApplyBlockers(sell.report).some(b => /every price is in USD, which reads as the supplier list, never a sell/.test(b)), 'the same document in sell mode stores nothing and says why');
  const wrongWay = parseAlicatPdfText('Prices in GBP\nMC-500SCCM-D  £1,071\n', { mode: 'supplier' });
  assert(wrongWay.rows.length === 0 && pdfApplyBlockers(wrongWay.report).some(b => /reads as the customer list, not the supplier's/.test(b)), 'the customer list in supplier mode stores nothing and says why');
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
  assert(/single source for margin/.test(text), 'the single-source margin line travels');
  assert(!/confirm with Andy|per customer/.test(text), 'no per-customer margin caveat survives');
  assert(!/manufacturer|supplier|factory/i.test(text), 'pricing never routes outward');
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
  assert(text.includes('guide prices') && text.includes('single source for margin'), 'the guide basis names the single source');
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
  assert(text.includes('guide price at the standard margin the master price sheet sets') && text.includes('per enquiry'), 'the single-source margin line and the enquiry edge hold');
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

await check('a sell-list row closes with the sell wording, never the guide caveat', async () => {
  const c = cheapestOf(allConfigs(), [{ part_number: 'MC-500SCCM-D', description: '500 sccm mass flow controller', sell_price: 1234, price_basis: 'sell', list_name: 'Alicat Q1 2026' }]);
  const text = renderCheapestValve({ scope: 'Alicat part', ...c });
  assert(text.includes('in the loaded list is **MC-500SCCM-D**') && text.includes('£1,234'), 'the list row is named and priced');
  assert(text.includes('sell price as loaded from the Alicat Q1 2026') && text.includes('never estimated'), 'the sell basis is stated');
  assert(!/guide price|standard margin/.test(text), 'no margin caveat is claimed for a sell list');
  assert(text.includes('per enquiry'), 'the beyond-the-list edge holds');
  assert(!/[—–!]/.test(text) && !/\bgenuinely\b/i.test(text), 'voice rules hold');
});

console.log('\nThe Alicat customer list parser (synthetic sheet, header detected, poison-value proof):');

// Poison values: the supplier's USD list, PCT's cost and the discount that
// links them. None may ever surface as a sell price.
const A_LIST_USD = 555.55, A_COST = 444.44, A_DISCOUNT = 35;

function buildAlicatWorkbook(headers = null) {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Notes').addRow(['Read me first']);
  const ws = wb.addWorksheet('Alicat Q1 2026');
  ws.addRow(['Alicat customer price list']);
  ws.addRow(['Q1 2026, prices in GBP']);
  ws.addRow(headers || ['Part Number', 'Description', 'List Price USD', 'Discount %', 'Cost GBP', 'Sales Price GBP', 'Sales Price EUR', 'Lead time']);
  ws.addRow(['MASS FLOW CONTROLLERS']);
  ws.addRow(['MC-500SCCM-D', '500 sccm mass flow controller', A_LIST_USD, A_DISCOUNT, A_COST, 1234.5, 1420, '2 weeks']);
  ws.addRow(['MC-500SCCM-D/5M ', 'with 5m cable', A_LIST_USD, A_DISCOUNT, A_COST, '£1,300.00', null, '2 weeks']);
  ws.addRow(['PC-15PSIG-D', 'no sell on this row', A_LIST_USD, A_DISCOUNT, A_COST, null, null, null]);
  return wb;
}

await check('the header is found under the title rows and every column is classified', async () => {
  const { report } = parseAlicatWorkbook(buildAlicatWorkbook());
  assert(report.sheet === 'Alicat Q1 2026' && report.header === 3, `sheet and header: ${report.sheet} row ${report.header}`);
  assert(report.columns.part.col === 1 && report.columns.description.col === 2, 'part and description columns');
  assert(report.columns.sells.GBP?.col === 6 && report.columns.sells.EUR?.col === 7, `sells: ${JSON.stringify(report.columns.sells)}`);
  assert(!('USD' in report.columns.sells), 'the USD list column is not a sell');
  const excluded = report.excluded.map(e => e.col).sort().join(',');
  assert(excluded === '3,4,5', `excluded columns are the list, the discount and the cost: got ${excluded}`);
  assert(report.excluded.find(e => e.col === 3)?.hard === false && report.excluded.find(e => e.col === 5)?.hard === true,
    'the USD list is set aside softly, the cost and discount columns hard');
  assert(report.ignored.length === 1 && report.ignored[0].col === 8, 'lead time is ignored, not a price');
  assert(applyBlockers(report).length === 0, `a clean sheet has no blockers: ${JSON.stringify(applyBlockers(report))}`);
});

await check('only sells extract, as printed, keyed by the normalised part', async () => {
  const { rows, report } = parseAlicatWorkbook(buildAlicatWorkbook());
  assert(report.parts === 2 && report.rows === 3 && report.skippedNoPrice === 2, `counts: ${JSON.stringify([report.parts, report.rows, report.skippedNoPrice])}`);
  const mc = rows.filter(r => r.normKey === 'MC-500SCCM-D');
  assert(mc.find(r => r.currency === 'GBP')?.sellPrice === 1234.5 && mc.find(r => r.currency === 'EUR')?.sellPrice === 1420, 'GBP and EUR as printed');
  const cable = rows.find(r => r.normKey === 'MC-500SCCM-D/5M');
  assert(cable?.currency === 'GBP' && cable.sellPrice === 1300, 'a sterling-formatted cell parses and a trailing space keys away');
  assert(rows.every(r => r.productLine === 'alicat' && r.sourceTab === 'Alicat Q1 2026' && r.description), 'line, tab and description travel');
});

await check('no supplier list, cost or discount value survives into the rows', async () => {
  const { rows } = parseAlicatWorkbook(buildAlicatWorkbook());
  for (const poison of [A_LIST_USD, A_COST, A_DISCOUNT]) {
    assert(!rows.some(r => r.sellPrice === poison), `poison ${poison} leaked into the extracted rows`);
  }
  assert(!rows.some(r => r.currency === 'USD'), 'no USD row exists when the only USD column is the supplier list');
});

await check('a USD column stores only with a sell marker, and a named override can bring it back but never a cost', async () => {
  assert(!('USD' in classifyHeader(['Part', 'Price USD']).sells), 'unmarked USD is set aside');
  assert(classifyHeader(['Part', 'PCT sell USD']).sells.USD === 2, 'marked USD is a sell');
  const brought = parseAlicatWorkbook(buildAlicatWorkbook(), { overrides: { USD: 'C' } });
  assert(brought.report.columns.sells.USD?.col === 3 && brought.report.columns.sells.USD.named, 'a named USD column is accepted by letter');
  assert(brought.rows.some(r => r.currency === 'USD' && r.sellPrice === A_LIST_USD), 'the named column then stores, on the human\'s say so');
  const cost = parseAlicatWorkbook(buildAlicatWorkbook(), { overrides: { GBP: 5 } });
  assert(cost.report.overrides.refused.length === 1 && /never ingested/.test(cost.report.overrides.refused[0].why), 'naming the cost column is refused');
  assert(!cost.rows.some(r => r.sellPrice === A_COST), 'the refused override stores nothing from the cost column');
  assert(applyBlockers(cost.report).some(b => /refused/.test(b)), 'a refused override blocks --apply');
  const part = parseAlicatWorkbook(buildAlicatWorkbook(), { overrides: { EUR: 1 } });
  assert(part.report.overrides.refused[0]?.why.includes('part or description'), 'naming the part column is refused');
});

await check('two unmarked GBP columns are ambiguous until one is named, and a lone list column asks too', async () => {
  const two = classifyHeader(['Model', 'Description', 'GBP', 'GBP 2025']);
  assert(!('GBP' in two.sells) && two.ambiguous[0]?.currency === 'GBP' && two.ambiguous[0].candidates.length === 2, 'two unmarked GBP columns are ambiguous');
  const wb = buildAlicatWorkbook(['Part Number', 'Description', 'List Price USD', 'Discount %', 'Cost GBP', 'GBP', 'GBP 2025', 'Lead time']);
  const open = parseAlicatWorkbook(wb);
  assert(open.rows.length === 0 && applyBlockers(open.report).some(b => /GBP is ambiguous/.test(b)), 'ambiguity stores nothing and blocks --apply');
  const named = parseAlicatWorkbook(wb, { overrides: { GBP: 6 } });
  assert(named.report.ambiguous.length === 0 && named.rows.find(r => r.normKey === 'MC-500SCCM-D')?.sellPrice === 1234.5, 'naming the column resolves it');
  const list = classifyHeader(['Part No', 'List Price GBP']);
  assert(list.ambiguous[0]?.why === LIST_WHY, "'list' with no sell marker is a question, not a sell");
  assert(classifyHeader(['Part No', 'GBP sales list price']).sells.GBP === 2, "James's own phrase, sales list price, is a sell");
  assert(classifyHeader(['Part No', 'Price']).sells.GBP === 2 && classifyHeader(['Part No', 'Price']).assumed[2] === 'GBP', 'an unlabelled price is read as GBP and marked assumed');
});

await check('a part priced two ways is withdrawn and named; the same price twice is one row', async () => {
  const wb = buildAlicatWorkbook();
  const ws = wb.getWorksheet('Alicat Q1 2026');
  ws.addRow(['MC-500SCCM-D', 'again, same price', A_LIST_USD, A_DISCOUNT, A_COST, 1234.5, 1420, null]);
  ws.addRow(['mc-500sccm-d/5m', 'again, different price', A_LIST_USD, A_DISCOUNT, A_COST, 1350, null, null]);
  const { rows, report } = parseAlicatWorkbook(wb);
  assert(rows.filter(r => r.normKey === 'MC-500SCCM-D').length === 2, 'the identical repeat collapses to one row per currency');
  assert(!rows.some(r => r.normKey === 'MC-500SCCM-D/5M'), 'the conflicting part is withdrawn entirely');
  assert(report.conflicts.length === 1 && report.conflicts[0].prices.join(',') === '1300,1350', `the conflict is named with both prices: ${JSON.stringify(report.conflicts)}`);
  assert(applyBlockers(report).some(b => /priced 2 ways/.test(b)), 'a conflict blocks --apply');
});

await check('no header means nothing stored and the top rows reported for a human', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['Alicat', 'prices', 'somewhere']);
  ws.addRow(['MC-500SCCM-D', 1234.5]);
  const { rows, report } = parseAlicatWorkbook(wb);
  assert(rows.length === 0 && report.header === null, 'nothing is guessed from a sheet with no header');
  assert(report.firstRows.length === 2 && report.firstRows[0][0] === 'Alicat', 'the top rows travel verbatim');
  assert(applyBlockers(report).some(b => /no header row/.test(b)), 'no header blocks --apply');
});

await check('sheet choice and column letters are plain and provable', async () => {
  const wb = buildAlicatWorkbook();
  assert(pickSheet(wb).name === 'Alicat Q1 2026', 'the price-like sheet is preferred over the first');
  assert(pickSheet(wb, 'notes').name === 'Notes' && pickSheet(wb, 'nope') === null, 'a named sheet wins, a missing name is null');
  assert(columnIndex('K') === 11 && columnIndex('AA') === 27 && columnIndex('6') === 6 && columnIndex('k') === 11, 'letters and numbers both read');
  assert(columnIndex('') === null && columnIndex('0') === null && columnIndex('1A') === null, 'junk is null');
  assert(colLetter(1) === 'A' && colLetter(26) === 'Z' && colLetter(27) === 'AA' && colLetter(0) === '', 'letters render');
});

console.log('\nThe Alicat customer list as a PDF (synthetic layout text, poison-value proof):');

// The same poisons as the workbook: cost, the USD list, and a discount, none
// of which may surface as a sell. The layout is the real document's, as
// John's first dry run printed it: four series columns to a line, adders
// priced as an addition, series headings, a part mentioned in a
// description, and accessories with and without a hyphen.
const P_COST = 444.44, P_USD = 555.55;
const PDF_FIXTURE = [
  'Effective January 2026                                              DOC-PRICE Rev 101',
  '                     Alicat Scientific, Inc. Price List',
  'Power Supplies and Communication Cables NOT INCLUDED (except portable meters and FP-25)',
  'Gas Flow',
  '           M-Series                 MS-Series                 MQ-Series                 MW-Series',
  'M-0.5SCCM-D        £1,526 MS-0.5SCCM-D        £1,923                          MW-0.5SCCM-D        £1,849',
  'M-5SCCM-D          £1,071 MS-5SCCM-D          £1,468 MQ-5SCCM-D        £1,175 MW-5SCCM-D          £1,394',
  'MCR-500SLPM-D      Mass flow controller, 500 slpm      £2,159',
  'MCP-Series MCRS-Series MCQ-50SLPM-D £1,812',
  '10/32 5μ Brass/Buna ILFE20 £8',
  'PC-EXTSEN-D-ISC £964',
  'PCD-100PSIA-D or PCD-100PSIG-D or PCD-100PSID-D                 £1,410',
  'IP66 or IP67                                                   £538',
  'IP67 Rating                                                    £347',
  'FP-25              £2,689',
  'Carrying case for FP-25                                 £430',
  'FP-25              N/A                                  £430',
  'MCD £579 + MC MCDS £579 + MC MCDQ £579 + MC MCDW £579 + MC',
  'MCE-SFF-Series MCES-SFF-Series MCV-Series MCVS-Series',
  'Communication DB15 + USB-C M12 dual RJ45 + USB-C Notes',
  'BB3 £145 £248 USB £83 Any mainline connector, 232/485 (Ex: USB-MD8-232)',
  'Partner Price / Discount determined by accuracy level above          £999.00',
  `Cost basis for MC-500SCCM-D                                          £${P_COST}`,
  `MC-1SLPM-D         Mass flow controller, 1 slpm                     $${P_USD}`,
  'MCR-500SLPM-D      Mass flow controller, 500 slpm      £2,159',
  'PC-15PSIG-D        Pressure controller                  £845',
  'PC-15PSIG-D        Pressure controller, repeat          £860',
  'M-20SLPM-D         Mass flow meter, 20 slpm',
].join('\n');

await check('four series columns to a line: each price belongs to the part just before it', async () => {
  const { rows, report } = parseAlicatPdfText(PDF_FIXTURE);
  const get = k => rows.find(r => r.normKey === k);
  assert(get('M-0.5SCCM-D')?.sellPrice === 1526 && get('MS-0.5SCCM-D')?.sellPrice === 1923 && get('MW-0.5SCCM-D')?.sellPrice === 1849, `a three-pair line reads as three rows: ${JSON.stringify(rows.map(r => r.partNumber + '=' + r.sellPrice))}`);
  assert(get('M-5SCCM-D')?.sellPrice === 1071 && get('MQ-5SCCM-D')?.sellPrice === 1175 && get('MW-5SCCM-D')?.sellPrice === 1394, 'a four-pair line reads as four rows');
  assert(get('MCR-500SLPM-D')?.sellPrice === 2159 && get('MCR-500SLPM-D').description === 'Mass flow controller, 500 slpm', 'a description between the part and its price travels');
  assert(rows.filter(r => r.normKey === 'MCR-500SLPM-D').length === 1, 'the identical repeat is one row');
  assert(rows.every(r => r.currency === 'GBP' && r.sourceTab === 'pdf' && r.productLine === 'alicat'), 'rows carry the currency, the line and the source');
  assert(report.currency.default === 'GBP' && report.parts === 16 && report.rows === 16, `counts: ${JSON.stringify([report.currency.default, report.parts, report.rows])}`);
  // The list's alternates: one price for the absolute, gauge and
  // differential references, each stored as its own key.
  assert(get('PCD-100PSIA-D')?.sellPrice === 1410 && get('PCD-100PSIG-D')?.sellPrice === 1410 && get('PCD-100PSID-D')?.sellPrice === 1410, `alternates each take the price: ${JSON.stringify(rows.filter(r => /^PCD-100/.test(r.partNumber)))}`);
  assert(get('PCD-100PSIA-D').description === null && get('PCD-100PSIG-D').description === 'listed with PCD-100PSIA-D', 'the first carries no "or" text as a description, the others say where they were listed');
  assert(report.alternates === 2, 'the alternates are counted');
  // Ingress ratings are option rows, never parts, and never a conflict.
  assert(!rows.some(r => /^IP\d\d$/.test(r.partNumber)) && !report.conflicts.some(c => /^IP/.test(c.partNumber)), 'IP66 and IP67 are not parts');
  assert(report.priceNoPart.some(l => /IP66 or IP67 £538/.test(l)) && report.priceNoPart.some(l => /IP67 Rating £347/.test(l)), 'the rating options are listed as prices with no part');
  assert(report.head.length >= 10 && /Alicat Scientific/.test(report.head[1]), 'the top of the document travels for a human');
  assert(get('MCQ-50SLPM-D')?.sellPrice === 1812 && get('MCQ-50SLPM-D').description === null, 'a series heading sharing the line with the first pair is ignored, not a mention');
  assert(get('ILFE20')?.sellPrice === 8 && get('ILFE20').description === '10/32 5μ Brass/Buna', 'a specification before the code is its description');
  assert(get('PC-EXTSEN-D-ISC')?.sellPrice === 964, 'a code with no digit but several segments is a part');
});

await check('a mention is not a row, an adder is not a price, a heading is not a part', async () => {
  const { rows, report } = parseAlicatPdfText(PDF_FIXTURE);
  const get = k => rows.find(r => r.normKey === k);
  assert(get('FP-25')?.sellPrice === 2689 && !report.conflicts.some(c => c.partNumber === 'FP-25'), 'FP-25 keeps its own price and the case is not a second price for it');
  assert(report.mentions.length === 1 && /Carrying case for FP-25 £430/.test(report.mentions[0]), `the mention is named: ${JSON.stringify(report.mentions)}`);
  assert(report.options.length === 1 && report.options[0] === 'FP-25 N/A £430', `an options table row is named and not the part's price: ${JSON.stringify(report.options)}`);
  assert(report.adders.includes('MCD £579 + MC') && report.adders.includes('MCDS £579 + MC') && !rows.some(r => /^MCD/.test(r.partNumber)), `adders are named by their code and never stored: ${JSON.stringify(report.adders)}`);
  assert(!rows.some(r => /^MCE|^USB|^DB15|^RJ45/.test(r.partNumber)), 'series headings and connector names are not parts');
  assert(!report.partNoPrice.some(l => /MCE-SFF-Series/.test(l)) && report.partNoPrice.some(l => /M-20SLPM-D/.test(l)), 'a heading line is not listed as a code without a price; a real code without a price is');
  assert(get('BB3')?.sellPrice === 145, 'an accessory code without a hyphen is a part when a price follows it');
  assert(report.priceNoPart.some(l => /USB £83/.test(l)) && report.priceNoPart.some(l => /£248/.test(l)), 'a price with nothing coded before it is named');
  assert(!get('PC-15PSIG-D') && report.conflicts[0]?.partNumber === 'PC-15PSIG-D' && report.conflicts[0].prices.join(',') === '845,860', 'a part priced two ways is withdrawn and named');
  assert(report.conflicts[0].lines.length === 2 && /Pressure controller, repeat £860/.test(report.conflicts[0].lines[1]), `the conflicting lines travel for a human: ${JSON.stringify(report.conflicts[0].lines)}`);
});

await check('a conflict settled on the command line keeps the stated figure, only when the document shows it', async () => {
  const settled = parseAlicatPdfText(PDF_FIXTURE, { resolve: { 'pc-15psig-d': '860' } });
  assert(settled.rows.find(r => r.normKey === 'PC-15PSIG-D')?.sellPrice === 860 && settled.report.conflicts.length === 0, 'the stated figure stands and the conflict is gone');
  assert(settled.report.resolved.length === 1 && /PC-15PSIG-D GBP 860, stated on the command line; the document also shows 845/.test(settled.report.resolved[0]), settled.report.resolved[0]);
  assert(pdfApplyBlockers(settled.report).length === 0, 'nothing blocks once the conflict is settled');
  const wrong = parseAlicatPdfText(PDF_FIXTURE, { resolve: { 'PC-15PSIG-D': '900' } });
  assert(!wrong.rows.some(r => r.normKey === 'PC-15PSIG-D') && wrong.report.conflicts[0]?.statedNotSeen === 900, 'a figure the document does not show settles nothing');
  assert(pdfApplyBlockers(wrong.report).some(b => /stated 900, which the document does not show/.test(b) && /--price "PC-15PSIG-D=/.test(b)), 'the blocker says so and how to settle it');
});

await check('no cost, discount or USD list figure survives, and the lines are named once', async () => {
  const { rows, report } = parseAlicatPdfText(PDF_FIXTURE);
  for (const poison of [P_COST, P_USD, 999]) assert(!rows.some(r => r.sellPrice === poison), `poison ${poison} leaked`);
  assert(report.excluded.length === 3 && report.excluded.every(l => /Rev 101|Discount|Cost basis/.test(l)), `the footer, the discount line and the cost line are excluded by name: ${JSON.stringify(report.excluded)}`);
  assert(report.usd.length === 1 && /MC-1SLPM-D/.test(report.usd[0]) && !rows.some(r => r.currency === 'USD'), 'the USD figure is set aside and never a row');
});

await check('bare figures with no currency named are a question, and the blockers are honest', async () => {
  const bare = parseAlicatPdfText('Model  Price\nMC-500SCCM-D  Mass flow controller  1,234.00\n');
  assert(bare.rows.length === 0 && bare.report.bareUnknown.length === 1 && bare.report.currency.default === null, 'no currency anywhere means nothing is assumed');
  assert(pdfApplyBlockers(bare.report).some(b => /--currency GBP/.test(b)), 'the blocker says how to settle it');
  assert(parseAlicatPdfText('Model  Price\nMC-500SCCM-D  Mass flow controller  1,234.00\n', { currency: 'gbp' }).rows[0]?.currency === 'GBP', '--currency settles it');
  const blockers = pdfApplyBlockers(parseAlicatPdfText(PDF_FIXTURE).report);
  assert(blockers.length === 1 && /PC-15PSIG-D is priced 2 ways/.test(blockers[0]), `only the conflict blocks the fixture: ${JSON.stringify(blockers)}`);
  const usdOnly = parseAlicatPdfText('Price List USD Rev 101\nMC-500SCCM-D  Mass flow controller  $1,234.00\n');
  assert(usdOnly.rows.length === 0 && pdfApplyBlockers(usdOnly.report).some(b => /USD, which reads as the supplier list/.test(b)), 'the supplier list is recognised as such');
  assert(pdfApplyBlockers({ lines: 0, rows: 0, bareUnknown: [], conflicts: [], currency: { seen: {} } }).some(b => /no text came out/.test(b)), 'a scan is named as one');
  assert(detectCurrency('prices in EUR') === 'EUR' && detectCurrency('nothing here') === null && detectCurrency('$ only') === null, 'currency detection never defaults to USD');
  const parts = s => (s.match(PART_TOKEN) || []);
  assert(parts('see MC-500SCCM-D/5P here')[0] === 'MC-500SCCM-D/5P' && parts('M-0.5SCCM-D £1')[0] === 'M-0.5SCCM-D' && parts('P-10TORRA-D-SAE4')[0] === 'P-10TORRA-D-SAE4', 'the part grammar keeps decimals and long tails');
  assert(parts('BB9-232 cable')[0] === 'BB9-232' && parts('BB3 £145')[0] === 'BB3', 'accessories with and without a hyphen');
  assert(parts('PC-EXTSEN-D-ISC £964')[0] === 'PC-EXTSEN-D-ISC' && parts('PCD-EXTSEN-D-ISC')[0] === 'PCD-EXTSEN-D-ISC', 'three segments make a part without a digit');
  assert(parts('MCE-SFF-Series MCV-Series USB-C M12 no code here').length === 0, 'headings, connector names and prose are not parts');
});

console.log(`\n=== Pricing gate: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
