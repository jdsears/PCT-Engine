// The quote basket, exercised offline with synthetic figures only. The turn
// handler talks to the database, so the gate proves the pure layer: intent
// parsing, line folding, currency totals and the rendered wording, including
// the honesty edges. A per-enquiry line must never gain a number, a guide
// line must carry its mark, and the basis text must say where the margin
// comes from, the master sheet's own transform at ingest, and nothing else.
import { emptyQuote, quoteIntent, addLine, removeLine, computeTotals, renderQuote } from './quote.mjs';

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  pass  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); fail++; }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

// Synthetic matches, shaped as lookup.mjs groups them. Poison-free by
// construction: only invented sell figures appear anywhere in this file.
const SELL = {
  partNumber: 'SEM203/P', description: 'Head transmitter', prices: { GBP: 100, EUR: 115, USD: 125 },
  basis: 'sell', listName: 'Synthetic list', effectiveDate: '2026-01-01',
};
const GUIDE = {
  partNumber: '7100TE11', description: 'Synthetic ball valve', prices: { GBP: 200, EUR: 230, USD: 250 },
  basis: 'guide', listName: 'Synthetic book', effectiveDate: '2026-02-01',
};
const GBP_ONLY = {
  partNumber: 'X9', description: 'Sterling only line', prices: { GBP: 50 },
  basis: 'sell', listName: 'Synthetic list', effectiveDate: null,
};

await check('the basket engages on its own verbs alone', async () => {
  assert(quoteIntent('start a quote for Acme rebuild', false)?.kind === 'start', 'start');
  assert(quoteIntent('start a quote for Acme rebuild', false)?.reference === 'Acme rebuild', 'reference captured');
  assert(quoteIntent('new quote', false)?.kind === 'start', 'bare new quote');
  assert(quoteIntent('what is the price of the 7100?', false) === null, 'a price question is not basket business');
  assert(quoteIntent('can you quote the DM40', false) === null, 'quote as a verb stays with the price path');
  assert(quoteIntent('add 2 x 7100TE11', false) === null, 'no basket, no add');
  assert(quoteIntent('add 2 x 7100TE11', true)?.kind === 'add', 'add with a basket open');
  assert(quoteIntent('add 2 x 7100TE11', true)?.qty === 2, 'quantity read');
  assert(quoteIntent('3 of SEM203/P', true)?.part === 'SEM203/P', 'bare qty-of-part reads');
  assert(quoteIntent('add a X9', true)?.qty === 1, 'add without a quantity is one');
  assert(quoteIntent('remove line 2', true)?.line === 2, 'remove by line');
  assert(quoteIntent('drop the 7100TE11', true)?.part === '7100TE11', 'remove by part');
  assert(quoteIntent('switch the quote to euros', true)?.currency === 'EUR', 'currency switch');
  assert(quoteIntent('add 2 x 7100TE11 please', true)?.kind === 'add', 'an add mentioning nothing else stays an add');
  assert(quoteIntent('show the quote', true)?.kind === 'show', 'show');
  assert(quoteIntent('discard the quote', true)?.kind === 'discard', 'discard');
  assert(quoteIntent('how does the 7100 seat work?', true) === null, 'an ordinary question falls through mid-quote');
});

await check('lines fold in, merge by part and remove both ways', async () => {
  let q = emptyQuote('Acme rebuild');
  q = addLine(q, { part: '7100TE11', qty: 2, match: GUIDE });
  q = addLine(q, { part: 'SEM203/P', qty: 1, match: SELL });
  q = addLine(q, { part: '7100te11', qty: 1, match: GUIDE });
  assert(q.lines.length === 2, 'same part merged');
  assert(q.lines[0].qty === 3, 'merge adds quantity');
  const less = removeLine(q, { line: 2 });
  assert(less.lines.length === 1 && less.lines[0].part === '7100TE11', 'remove by line number');
  const byPart = removeLine(q, { part: '7100TE11' });
  assert(byPart.lines.length === 1 && byPart.lines[0].part === 'SEM203/P', 'remove by part');
  assert(q.lines.length === 2, 'removal never mutates the old basket');
});

await check('totals are per currency and a per-enquiry line never gains a number', async () => {
  let q = emptyQuote();
  q = addLine(q, { part: '7100TE11', qty: 2, match: GUIDE });   // 400 GBP
  q = addLine(q, { part: 'SEM203/P', qty: 1, match: SELL });    // 100 GBP
  q = addLine(q, { part: 'MYSTERY9', qty: 5, match: null });    // per enquiry
  const t = computeTotals(q);
  assert(t.total === 500, 'GBP total sums qty times unit');
  assert(t.priced === 2, 'two priced lines');
  assert(t.enquiry.length === 1 && t.enquiry[0].part === 'MYSTERY9', 'enquiry listed, excluded');
  const eur = computeTotals({ ...q, currency: 'EUR' });
  assert(eur.total === 2 * 230 + 115, 'EUR total uses EUR units');
});

await check('a priced line missing the chosen currency is excluded and said plainly', async () => {
  let q = emptyQuote();
  q = addLine(q, { part: '7100TE11', qty: 1, match: GUIDE });
  q = addLine(q, { part: 'X9', qty: 2, match: GBP_ONLY });
  const eur = computeTotals({ ...q, currency: 'EUR' });
  assert(eur.total === 230 && eur.priced === 1, 'only the euro-priced line counts');
  assert(eur.missing.length === 1 && eur.missing[0].part === 'X9', 'the sterling-only line is named');
  const text = renderQuote({ ...q, currency: 'EUR' });
  assert(/not in EUR/.test(text), 'the exclusion is said plainly');
});

await check('the rendered quote is itemised, marked and honest about its basis', async () => {
  let q = emptyQuote('Acme rebuild');
  q = addLine(q, { part: '7100TE11', qty: 2, match: GUIDE });
  q = addLine(q, { part: 'SEM203/P', qty: 1, match: SELL });
  q = addLine(q, { part: 'MYSTERY9', qty: 5, match: null });
  const text = renderQuote(q);
  assert(/\*\*Quote, Acme rebuild\*\*/.test(text), 'the reference heads the quote');
  assert(/\| 1 \| 7100TE11 \|/.test(text), 'line one itemised');
  assert(/£400\*/.test(text), 'a guide line total carries its mark');
  assert(/£100(?!\*)/.test(text), 'a sell line carries no mark');
  assert(/\*\*Total £500\*\*/.test(text), 'the total is the priced lines alone');
  assert(/Per enquiry.*5 x MYSTERY9/.test(text), 'the enquiry line is listed beneath, quantity and all');
  assert(!/MYSTERY9[^|]*£/.test(text), 'no figure is invented for the enquiry line');
  assert(/Richards transform/.test(text), 'the basis names the master sheet transform');
  assert(/margin as the sheet sets it/.test(text), 'the margin is the sheet’s, said so');
  assert(/effective 2026-01-01, 2026-02-01|effective 2026-02-01, 2026-01-01/.test(text), 'effective dates surface');
  assert(!/[–—]/.test(text), 'no dashes of the forbidden kinds');
  assert(!/genuinely/i.test(text), 'the forbidden word stays out');
});

await check('an empty quote renders an invitation, not a table', async () => {
  const text = renderQuote(emptyQuote());
  assert(/The quote is empty/.test(text), 'empty state said plainly');
  assert(!/\| Line \|/.test(text), 'no empty table');
});

console.log(`\n=== Quote gate: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
