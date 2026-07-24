// The SharePoint read layer's pure parts: path encoding for Graph's drive
// addressing and the sharepoint: source references the ingest scripts take.
// The network side is proven by scripts/sharepoint-probe.mjs on a machine
// with credentials; nothing here touches the network.
import { spSite, encodeDrivePath, isSharepointRef, sharepointPath } from './sharepoint.mjs';
import { lineForPath, syncDecision, chunkText } from './sharepointSync.mjs';

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  pass  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); fail++; }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

console.log('The SharePoint read layer (pure):');

await check('drive paths encode per segment and keep their slashes', async () => {
  assert(encodeDrivePath('Richards/77. Marwin/Technical Information') === 'Richards/77.%20Marwin/Technical%20Information',
    'spaces encode, dots survive, slashes separate');
  assert(encodeDrivePath('/lead/trail/') === 'lead/trail', 'leading and trailing slashes strip');
  assert(encodeDrivePath('a&b/c#d') === 'a%26b/c%23d', 'ampersands and hashes encode');
  assert(encodeDrivePath('') === '', 'empty stays empty');
});

await check('sharepoint: references parse and plain paths pass through', async () => {
  assert(isSharepointRef('sharepoint:Richards/file.pdf') && isSharepointRef(' SharePoint:x '),
    'the prefix is case-insensitive and tolerates padding');
  assert(!isSharepointRef('/Users/jssup/Downloads/file.pdf') && !isSharepointRef(null),
    'local paths and empties are not references');
  assert(sharepointPath('sharepoint: Richards/77. Marwin/DM600.pdf') === 'Richards/77. Marwin/DM600.pdf',
    'the path comes out clean');
});

await check('the site defaults to the Sales Engine team site and can be overridden', async () => {
  const old = process.env.SHAREPOINT_SITE;
  delete process.env.SHAREPOINT_SITE;
  assert(spSite() === 'pctflow.sharepoint.com:/sites/SalesEngine', 'the default is the team site');
  process.env.SHAREPOINT_SITE = 'pctflow.sharepoint.com:/sites/Other';
  assert(spSite() === 'pctflow.sharepoint.com:/sites/Other', 'the override wins');
  if (old === undefined) delete process.env.SHAREPOINT_SITE; else process.env.SHAREPOINT_SITE = old;
});

console.log('\nThe document sync rules (pure):');

await check('folders map to their canonical corpus lines', async () => {
  assert(lineForPath('Richards/7. Marwin/Technical Information/DM600.pdf') === 'marwin', 'Marwin folder is line marwin');
  assert(lineForPath('Richards/3. Steriflow Food and Beverage/x.pdf') === 'steriflow_fb', 'the F&B folder maps');
  assert(lineForPath('PCT Information/About.pdf') === 'general', 'PCT information files under general');
  assert(lineForPath('Richards/Something New/y.pdf') === 'general', 'an unknown folder files under general, never guesses a line');
});

await check('price material and spreadsheets never enter the corpus', async () => {
  assert(syncDecision('DM600 (1).pdf').sync, 'a data sheet syncs');
  assert(syncDecision('Installation notes.docx').sync && syncDecision('readme.md').sync, 'documents sync');
  assert(syncDecision('Marwin_NA_Price_List_REV1.pdf').why === 'price rule', 'a price list is refused by name');
  assert(syncDecision('STERIFLOW-FY26-PL_rev1.pdf').why === 'price rule', 'the PL shorthand is refused');
  assert(syncDecision('Costing summary.docx').why === 'price rule', 'cost material is refused');
  assert(syncDecision('Mega Price List.xlsx').why !== undefined, 'the workbook is refused');
  assert(syncDecision('Sizes.xlsx').why === 'type', 'every spreadsheet is refused by type');
  assert(syncDecision('Richards Presentation.pptx').sync, 'a presentation syncs');
});

await check('chunking splits on paragraphs, hard-splits monsters, and caps the flood', async () => {
  const { chunks } = chunkText('First paragraph.\n\nSecond paragraph.\n\n' + 'x'.repeat(4000));
  assert(chunks[0].includes('First paragraph.') && chunks[0].includes('Second paragraph.'), 'small paragraphs share a chunk');
  assert(chunks.length >= 3 && chunks.every(c => c.length <= 1500), 'an oversized paragraph hard-splits within the size');
  const flood = chunkText(Array.from({ length: 900 }, (_, i) => `Para ${i} ${'y'.repeat(1400)}`).join('\n\n'));
  assert(flood.chunks.length === 400 && flood.truncated, 'one enormous document cannot flood the corpus');
  assert(chunkText('').chunks.length === 0, 'empty text yields nothing');
});

console.log(`\n=== SharePoint gate: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
