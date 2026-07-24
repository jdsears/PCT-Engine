// The SharePoint read layer's pure parts: path encoding for Graph's drive
// addressing and the sharepoint: source references the ingest scripts take.
// The network side is proven by scripts/sharepoint-probe.mjs on a machine
// with credentials; nothing here touches the network.
import { spSite, encodeDrivePath, isSharepointRef, sharepointPath } from './sharepoint.mjs';

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

console.log(`\n=== SharePoint gate: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
