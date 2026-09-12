#!/usr/bin/env node
// Ingest the Alicat GBP customer price list into the prices table, from the
// workbook or the PDF, whichever James placed in the customer pricing folder.
// Dry run by default: it reads the list, classifies what it found, and
// prints that for a human to confirm, with samples. --apply writes,
// replacing the Alicat line wholesale so vanished parts vanish here too and
// re-running is always safe.
//
//   node --env-file=.env scripts/ingest-alicat-prices.mjs --file "sharepoint:Pricing/Customer Pricing/Alicat Q1 2026.pdf"
//   node --env-file=.env scripts/ingest-alicat-prices.mjs --file "sharepoint:<path>.xlsx" --sheet "Price list" --gbp-column K --apply
//
// Only selling prices are stored, ever. Alicat's own list is in USD and PCT's
// cost is that list less a discount, so USD figures are set aside and any
// column or line that says cost, discount, margin or supplier is excluded
// outright. A workbook is read by its header row (name a column with
// --gbp-column, --eur-column, --usd-column when the header leaves a currency
// ambiguous); a PDF is read line by line through pdftotext, each price
// belonging to the part number just before it, up to four pairs to a line
// (--currency GBP when the document names no currency for bare figures).
// --apply refuses while anything is unsettled.
//
// --file is required and there is no fallback to PRICE_WORKBOOK, because that
// is the Mega Price List, a different document with different rules.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { parseAlicatWorkbook, applyBlockers, colLetter } from '../src/pricing/parseAlicat.mjs';
import { parseAlicatPdfText, pdfApplyBlockers, parseOptionRows } from '../src/pricing/parseAlicatPdf.mjs';
import { costFrom, parseCostRule, costRuleFor, applyCostRule } from '../src/pricing/supplierPrices.mjs';
import { pool } from '../src/db.mjs';
import { materialiseSource, isSharepointRef } from '../src/sharepoint.mjs';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : (args[i + 1] || null); };
const APPLY = args.includes('--apply');
// --supplier reads the supplier's own list into the supplier table, held
// apart from the sell table and given only on an explicit ask for the
// purchase price. John's rule of 11 September 2026, agreed with James.
//   node --env-file=.env scripts/ingest-alicat-prices.mjs --supplier "sharepoint:Alicat/08-Price-List-101-and-adjustment-OEM-units.pdf" --discount 35
//   ... --net "PCD-100PSIG-D=950" --discount-for "MC-500SCCM-D=20" --apply
const SUPPLIER = flag('--supplier');
const SOURCE = flag('--file') || SUPPLIER;
const SHEET = flag('--sheet');
const LIST_NAME = flag('--list') || (SUPPLIER ? 'Alicat Price List 101' : 'Alicat Q1 2026');
const EFFECTIVE = flag('--effective') || new Date().toISOString().slice(0, 10);
const LINE = 'alicat';
const DISCOUNT = flag('--discount') == null ? 35 : parseFloat(flag('--discount'));

if (!SOURCE) {
  console.error('Usage: node --env-file=.env scripts/ingest-alicat-prices.mjs --file "sharepoint:<path>" [--sheet <name>] [--list <name>] [--effective YYYY-MM-DD] [--gbp-column N] [--eur-column N] [--usd-column N] [--currency GBP] [--price "PART=figure"] [--option "CODE=adder"] [--no-option "CODE"] [--apply]');
  console.error('       node --env-file=.env scripts/ingest-alicat-prices.mjs --supplier "sharepoint:<path>.pdf" [--discount 35] [--rule "PATTERN=pct|partner|list"] [--net "PART=figure"] [--list <name>] [--effective YYYY-MM-DD] [--apply]');
  process.exit(1);
}
if (SUPPLIER && !/\.pdf$/i.test(SUPPLIER)) { console.error('--supplier reads the supplier\'s PDF list; a workbook is not read this way'); process.exit(1); }
if (SUPPLIER && (!Number.isFinite(DISCOUNT) || DISCOUNT < 0 || DISCOUNT >= 100)) { console.error('--discount wants a percentage off list, for example 35'); process.exit(1); }
// Exceptions to the standing discount, James's rules of 11 September 2026,
// as --rule "PATTERN=VALUE", repeatable: an exact code or a prefix with a
// star, and a discount off list, "partner" (cost is the partner price the
// list prints beside the list price) or "list" (cost is the stated price, no
// discount). The first matching rule wins. --net "PART=figure" states a net
// buying price for one part outright.
//   --rule "BASIS*=partner" --rule "EPC*=partner" --rule "CODA*=20" --rule "RECAL*=list"
const rules = [], nets = {}, statedOptions = {}, droppedOptions = [];
for (let i = 0; i < args.length; i++) {
  // --no-option "CODE": a code the parser read as an option and James says
  // is not one, or is wrong; dropped and named, never stored.
  if (args[i] === '--no-option') {
    const c = String(args[i + 1] || '').trim().toUpperCase();
    if (!/^[A-Z0-9-]{1,15}$/.test(c)) { console.error(`--no-option wants a code, got ${args[i + 1] || 'nothing'}`); process.exit(1); }
    droppedOptions.push(c);
  }
  // --option "CODE=adder": an option the list does not print, stated on
  // James's word, for example PCV as a no-cost option.
  if (args[i] === '--option') {
    const m = /^([A-Z0-9-]{1,15})=\s*(-?)£?\$?([\d,]+(?:\.\d+)?)$/i.exec(args[i + 1] || '');
    if (!m) { console.error(`--option wants "CODE=adder", got ${args[i + 1] || 'nothing'}`); process.exit(1); }
    statedOptions[m[1].toUpperCase()] = (m[2] ? -1 : 1) * parseFloat(m[3].replace(/,/g, ''));
  }
  if (args[i] === '--rule' || args[i] === '--discount-for') {
    const r = parseCostRule(args[i + 1]);
    if (!r) { console.error(`${args[i]} wants "PATTERN=pct|partner|list", got ${args[i + 1] || 'nothing'}`); process.exit(1); }
    rules.push(r);
  }
  if (args[i] === '--net') {
    const m = /^(.+?)=\s*£?\$?([\d,]+(?:\.\d+)?)$/.exec(args[i + 1] || '');
    if (!m) { console.error(`--net wants "PART=figure", got ${args[i + 1] || 'nothing'}`); process.exit(1); }
    nets[m[1].trim().toUpperCase().replace(/\s+/g, '')] = parseFloat(m[2].replace(/,/g, ''));
  }
}
// What a supplier row stores: a stated net first, then the first matching
// rule, then the standing discount.
const storedFor = s => (nets[s.normKey] != null
  ? { discountPct: null, netPrice: nets[s.normKey], costRule: 'stated net buying price' }
  : applyCostRule(s, costRuleFor(s.normKey, rules), DISCOUNT));
if (!/^\d{4}-\d{2}-\d{2}$/.test(EFFECTIVE)) {
  console.error(`--effective must be YYYY-MM-DD, got ${EFFECTIVE}`);
  process.exit(1);
}
const CURRENCY = flag('--currency');
if (CURRENCY && !['GBP', 'EUR'].includes(CURRENCY.toUpperCase())) { console.error('--currency wants GBP or EUR; USD is the supplier list and is never stored'); process.exit(1); }
// --price "PART=figure", repeatable: a conflict a human has settled, kept
// only when the document shows that figure for the part.
const resolve = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--price') continue;
  const m = /^(.+?)=\s*£?([\d,]+(?:\.\d+)?)$/.exec(args[i + 1] || '');
  if (!m) { console.error(`--price wants "PART=figure", got ${args[i + 1] || 'nothing'}`); process.exit(1); }
  resolve[m[1].trim()] = m[2];
}
const overrides = {};
for (const cur of ['gbp', 'eur', 'usd']) {
  const v = flag(`--${cur}-column`);
  if (v) overrides[cur.toUpperCase()] = v;
}

if (!isSharepointRef(SOURCE)) {
  console.log(`WARNING: reading the price list from a local file, which may be a stale download: ${SOURCE}`);
  console.log('         The live copy is on SharePoint; pass --file "sharepoint:<path>" to read it there.');
}
let FILE;
try { FILE = await materialiseSource(SOURCE, { log: m => console.log(m) }); }
catch (e) { console.error(`Workbook fetch failed: ${String(e.message).slice(0, 200)}`); process.exit(1); }

const at = c => `column ${c.col} (${colLetter(c.col)}) "${c.header}"`;
const stop = async (code) => { await pool.end(); process.exit(code); };
console.log(SUPPLIER
  ? `\nAlicat supplier list, effective ${EFFECTIVE}, stored as "${LIST_NAME}" on the ${LINE} line, held apart from the sell prices and given only on an explicit ask.`
  : `\nAlicat price list, effective ${EFFECTIVE}, stored as "${LIST_NAME}" on the ${LINE} line.`);

let rows, blockers, sourceNote, optionRows = null;
if (/\.pdf$/i.test(SOURCE)) {
  // The PDF path: pdftotext keeps the columns; the plain extractor is the
  // fallback and keeps the words in order but not the layout.
  let pdfText = null;
  try { pdfText = execFileSync('pdftotext', ['-layout', FILE, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) {
    console.log(`  pdftotext is not available (${String(e.message).slice(0, 80)}); reading the words without the layout. brew install poppler gives the better read.`);
    const { parseOfficeAsync } = await import('officeparser');
    pdfText = String(await parseOfficeAsync(await readFile(FILE)) || '');
  }
  const parsed = parseAlicatPdfText(pdfText, { currency: CURRENCY, resolve, mode: SUPPLIER ? 'supplier' : 'sell' });
  rows = parsed.rows;
  const r = parsed.report;
  console.log(`  read as a PDF: ${r.lines} line(s) of text, currency for bare figures ${r.currency.default || 'unknown'}` +
    ` (symbols seen: £ ${r.currency.seen.GBP}, € ${r.currency.seen.EUR}, $ ${r.currency.seen.USD})`);
  console.log(`\n  ${r.parts} part(s), ${r.rows} price row(s).`);
  const costOf = s => { const st = storedFor(s); return costFrom({ listPrice: s.price, discountPct: st.discountPct, netPrice: st.netPrice }); };
  const sampleRows = SUPPLIER
    // In the supplier read, show one row under each rule in play, then the
    // first few, so every rule's arithmetic is seen before --apply.
    ? [...new Map(rows.map(s => [storedFor(s).costRule, s])).values(), ...rows.slice(0, 6)].filter((s, i, a) => a.indexOf(s) === i).slice(0, 12)
    : rows.slice(0, 8);
  for (const s of sampleRows) {
    const st = SUPPLIER ? storedFor(s) : null;
    console.log(SUPPLIER
      ? `    sample: ${s.partNumber}  list ${s.currency} ${s.price}${s.partnerPrice != null ? `  partner ${s.currency} ${s.partnerPrice}` : ''}  cost ${s.currency} ${costOf(s) ?? 'none'}  (${st.costRule})${s.description ? '  ' + s.description.slice(0, 40) : ''}`
      : `    sample: ${s.partNumber}  ${s.currency} ${s.sellPrice}${s.description ? '  ' + s.description.slice(0, 50) : ''}`);
  }
  const show = (label, list, why) => { if (list.length) { console.log(`  ${label}${why ? `, ${why}` : ''}:`); for (const l of list) console.log(`    ${l}`); } };
  if (SUPPLIER) {
    const counts = {};
    for (const s of rows) { const k = storedFor(s).costRule; counts[k] = (counts[k] || 0) + 1; }
    console.log(`  rows by cost rule: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join('; ')}`);
    const unmatched = rules.filter(rule => !rows.some(s => costRuleFor(s.normKey, [rule]) === rule)).map(rule => `${rule.pattern}=${rule.value}`);
    if (unmatched.length) console.log(`  rules that match no part on this list: ${unmatched.join(', ')}`);
    const noCost = rows.filter(s => costOf(s) == null);
    if (noCost.length) console.log(`  parts that would store no cost: ${noCost.slice(0, 10).map(s => `${s.partNumber} (${storedFor(s).costRule})`).join(', ')}${noCost.length > 10 ? `, and ${noCost.length - 10} more` : ''}`);
    const missing = Object.keys(nets).filter(k => !rows.some(s => s.normKey === k));
    if (missing.length) console.log(`  net prices named for parts the list does not show: ${missing.join(', ')}`);
  }
  if (r.grouped) console.log(`  parts priced from merged groups in the columned layout: ${r.grouped}`);
  if (r.groupedDisagreements?.length) {
    console.log(`  ${r.groupedDisagreements.length} part(s) whose own price disagrees with the group's, own price kept, columns worth a look:`);
    for (const d of r.groupedDisagreements) console.log(`    ${d}`);
  }
  if (r.unpriced?.length) console.log(`  parts in a column past its last price, no price taken: ${r.unpriced.join(', ')}`);
  if (SUPPLIER) {
    const withPartner = rows.filter(x => x.partnerPrice != null);
    console.log(`  partner prices read beside list prices: ${withPartner.length}${withPartner.length ? ` (${withPartner.slice(0, 12).map(x => `${x.partNumber} ${x.price}/${x.partnerPrice}`).join(', ')})` : ''}`);
  }
  if (!SUPPLIER) {
    // The option tables, James's note of 11 September 2026: adders by code,
    // stored with the sell prices so a configured code totals up. --option
    // "CODE=adder" states one the list does not print, on James's word.
    optionRows = parseOptionRows(pdfText, { currency: r.currency.default || 'GBP' });
    // --no-option drops a code James says the parser read wrong, and the
    // drop is printed, never silent.
    const dropped = optionRows.options.filter(o => droppedOptions.includes(o.normCode));
    optionRows.options = optionRows.options.filter(o => !droppedOptions.includes(o.normCode));
    for (const [code, adder] of Object.entries(statedOptions)) {
      const normCode = code.toUpperCase();
      const at = optionRows.options.findIndex(o => o.normCode === normCode);
      const row = { code, normCode, label: 'stated on ingest', currency: r.currency.default || 'GBP', adder, markedDefault: false, line: 'command line' };
      if (at === -1) optionRows.options.push(row); else optionRows.options[at] = row;
    }
    console.log(`\n  option adders read from the list's option tables: ${optionRows.options.length} code(s), each with the line it was read from`);
    for (const o of optionRows.options.slice(0, 60)) {
      console.log(`    ${o.code}: ${o.adder === 0 ? 'no cost' : `${o.currency} ${o.adder}`}  ${o.label || ''}${o.markedDefault ? '  [default]' : ''}`);
      console.log(`        from: ${o.line}`);
    }
    if (optionRows.options.length > 60) console.log(`    and ${optionRows.options.length - 60} more`);
    if (dropped.length) console.log(`  dropped on the command line: ${dropped.map(o => `${o.code} (was ${o.adder})`).join(', ')}`);
    const unknownDrops = droppedOptions.filter(c => !dropped.some(o => o.normCode === c));
    if (unknownDrops.length) console.log(`  --no-option named codes the list does not price: ${unknownDrops.join(', ')}`);
    if (optionRows.conflicts.length) {
      console.log('  option codes at two adders, not stored:');
      for (const c of optionRows.conflicts) console.log(`    ${c.code}: ${c.adders.join(', ')}  lines: ${c.lines.map(l => `"${l}"`).join(' | ')}`);
    }
    show('option rows with more values than codes, per-series tables not read yet, not stored', optionRows.multi);
    show('option rows with no value beside them, not stored', optionRows.skipped);
  }
  show('conflicts settled on the command line', r.resolved);
  show('excluded lines, never ingested', r.excluded, SUPPLIER ? 'discount, margin or revision lines; read them for exceptions to state with --net or --discount-for' : 'cost, discount, margin or the supplier list by name');
  show('USD figures set aside', r.usd, 'the USD list is the supplier\'s');
  show('sterling or euro figures set aside', r.otherCurrency, 'the supplier list is in USD');
  show('adders, not stored', r.adders, 'priced as an addition to a base unit, not a price of a part');
  show('parts mentioned inside a description, not stored as that part\'s price', r.mentions);
  show('option table rows, not stored', r.options, 'the figure is an option\'s, with a cell between the code and it');
  show('figures with no currency, held', r.bareUnknown, 'say which with --currency GBP');
  show('prices with no part number beside them', r.priceNoPart, 'named products without a code are not stored');
  show('part numbers with no price beside them', r.partNoPrice);
  if (!rows.length || !APPLY) {
    console.log('\n  The top of the document reads:');
    for (const l of r.head) console.log(`    | ${l}`);
  }
  blockers = pdfApplyBlockers(r);
  sourceNote = 'pdf';
} else {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);
  const parsed = parseAlicatWorkbook(wb, { sheet: SHEET, overrides });
  rows = parsed.rows;
  const report = parsed.report;
  console.log(`  sheet read: ${report.sheet || 'none'}${report.sheets.length > 1 ? `  (sheets in the file: ${report.sheets.join(', ')}; pick another with --sheet)` : ''}`);
  if (report.header == null) {
    console.log('\n  No header row found in the top rows: nothing names a part number beside a price. The top of the sheet reads:');
    for (const [i, vals] of report.firstRows.entries()) console.log(`    row ${i + 1}: ${vals.filter(Boolean).join(' | ') || '(empty)'}`);
    console.log('\nNothing stored. If the list is on another sheet, pass --sheet; if the headers are unusual, say so and the parser learns them.');
    await stop(2);
  }
  console.log(`  header on row ${report.header}`);
  console.log(`  part number: ${at(report.columns.part)}`);
  console.log(`  description: ${report.columns.description ? at(report.columns.description) : 'none found'}`);
  console.log('  stored as sell prices:');
  for (const [cur, c] of Object.entries(report.columns.sells)) {
    const assumed = report.assumed.find(a => a.col === c.col);
    console.log(`    ${cur}: ${at(c)}${c.named ? '  (named on the command line)' : ''}${assumed ? '  (no currency in the header, read as GBP)' : ''}`);
  }
  if (!Object.keys(report.columns.sells).length) console.log('    none');
  if (report.excluded.length) {
    console.log('  excluded, never ingested:');
    for (const e of report.excluded) console.log(`    ${at(e)}: ${e.why}`);
  }
  if (report.ignored.length) console.log(`  ignored, not a price: ${report.ignored.map(at).join(', ')}`);
  console.log(`\n  ${report.parts} part(s), ${report.rows} price row(s), ${report.skippedNoPrice} row(s) without a sell price skipped (section headings and unpriced parts).`);
  for (const s of rows.slice(0, 5)) console.log(`    sample: ${s.partNumber}  ${s.currency} ${s.sellPrice}${s.description ? '  ' + s.description.slice(0, 50) : ''}`);
  blockers = applyBlockers(report);
  sourceNote = report.sheet;
}

if (blockers.length) {
  console.log('\nNot storing until these are settled:');
  for (const b of blockers) console.log(`  - ${b}`);
  await stop(2);
}
if (!APPLY) {
  console.log('\nDry run, nothing written. Check the read above against the list, then re-run with --apply to store.');
  await stop(0);
}

const client = await pool.connect();
try {
  await client.query('BEGIN');
  if (SUPPLIER) {
    await client.query(`DELETE FROM supplier_prices WHERE product_line = $1`, [LINE]);
    for (const r of rows) {
      const st = storedFor(r);
      await client.query(
        `INSERT INTO supplier_prices (product_line, part_number, norm_key, description, currency, list_price, discount_pct, net_price, partner_price, cost_rule, list_name, effective_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (product_line, norm_key) DO UPDATE
           SET part_number = EXCLUDED.part_number, description = EXCLUDED.description, currency = EXCLUDED.currency,
               list_price = EXCLUDED.list_price, discount_pct = EXCLUDED.discount_pct, net_price = EXCLUDED.net_price,
               partner_price = EXCLUDED.partner_price, cost_rule = EXCLUDED.cost_rule,
               list_name = EXCLUDED.list_name, effective_date = EXCLUDED.effective_date, ingested_at = now()`,
        [r.productLine, r.partNumber, r.normKey, r.description, r.currency, r.price, st.discountPct, st.netPrice, r.partnerPrice ?? null, st.costRule, LIST_NAME, EFFECTIVE]);
    }
    await client.query('COMMIT');
    console.log(`\nStored. ${rows.length} supplier list rows are held apart. The co-pilot gives the purchase price only when someone asks for it in so many words.`);
    client.release();
    await pool.end();
    process.exit(0);
  }
  await client.query(`DELETE FROM prices WHERE product_line = $1`, [LINE]);
  for (const r of rows) {
    await client.query(
      `INSERT INTO prices (product_line, part_number, norm_key, description, currency, sell_price, price_basis, list_name, source_tab, effective_date)
       VALUES ($1, $2, $3, $4, $5, $6, 'sell', $7, $8, $9)
       ON CONFLICT (product_line, norm_key, currency) DO UPDATE
         SET part_number = EXCLUDED.part_number, description = EXCLUDED.description,
             sell_price = EXCLUDED.sell_price, price_basis = 'sell', list_name = EXCLUDED.list_name,
             source_tab = EXCLUDED.source_tab, effective_date = EXCLUDED.effective_date, ingested_at = now()`,
      [r.productLine, r.partNumber, r.normKey, r.description, r.currency, r.sellPrice, LIST_NAME, r.sourceTab || sourceNote, EFFECTIVE]);
  }
  // The option adders ride with the sell prices, replaced wholesale with
  // them, when the list came as a PDF with option tables and the table
  // exists (migration 042).
  let optionsStored = 0;
  if (optionRows?.options?.length) {
    const ready = (await client.query(`SELECT to_regclass('price_options') AS t`)).rows[0]?.t;
    if (ready) {
      await client.query(`DELETE FROM price_options WHERE product_line = $1`, [LINE]);
      for (const o of optionRows.options) {
        const ins = await client.query(
          `INSERT INTO price_options (product_line, code, norm_code, label, currency, adder, marked_default, list_name, effective_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (product_line, norm_code) DO NOTHING`,
          [LINE, o.code, o.normCode, o.label, o.currency, o.adder, o.markedDefault, LIST_NAME, EFFECTIVE]);
        optionsStored += ins.rowCount;
      }
    } else {
      console.log('\n  The option table is not created yet (migration 042); the adders were read but not stored. Run npm run migrate and apply again.');
    }
  }
  await client.query('COMMIT');
  console.log(`\nStored. ${rows.length} Alicat price rows are live${optionsStored ? `, with ${optionsStored} option adder(s) by code` : ''}. The co-pilot answers Alicat part numbers from them once the price lookup switch on the Health page is on.`);
} catch (e) {
  await client.query('ROLLBACK');
  console.error(`\nFailed, nothing changed: ${e.message}`);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
