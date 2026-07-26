// Acknowledged sync failures. The contract this suite defends is the one that
// makes the mechanism safe: a known condition reads as known, and a new
// problem still announces itself. If a future edit ever lets an unknown error
// be swallowed by an acknowledgement, these fail.

import { classifySyncErrors, parseSyncError, loadAcknowledgements } from './acknowledgements.mjs';

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  pass  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); fail++; }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

// The live error set that prompted this work: fifteen image-only scans and the
// policy document OfficeParser refuses, in the shape the sync stores them.
const SCANS = [
  '7. Marwin/Marwin Brass Valves.pdf',
  '7. Marwin/Marwin Three Way Valves.pdf',
  '2. Steriflow/Steriflow White Paper.pdf',
];
const LIVE_ERRORS = [
  ...SCANS.map(p => `${p}: no extractable text`),
  'PCT Information/Policies/External Sales Process Policy.docx: Unsupported file format',
];

console.log('Parsing and classification:');

check('an error line splits into its path and message', () => {
  const a = parseSyncError('7. Marwin/Marwin Brass Valves.pdf: no extractable text');
  assert(a.path === '7. Marwin/Marwin Brass Valves.pdf', 'the path is the part before the first colon-space');
  assert(a.message === 'no extractable text', 'the message is the rest');
  // A message carrying its own colon must not be truncated.
  const b = parseSyncError('a/b.pdf: Graph 429: too many requests');
  assert(b.path === 'a/b.pdf' && b.message === 'Graph 429: too many requests', 'only the first separator splits');
});

check('the shipped registry acknowledges the two known classes', () => {
  const acks = loadAcknowledgements();
  assert(acks.length >= 2, 'the registry loads');
  assert(acks.some(a => a.errorMatch === 'no extractable text'), 'the image-only scan class');
  assert(acks.some(a => String(a.path || '').includes('External Sales Process Policy.docx')), 'the policy document');
  for (const a of acks) {
    assert(a.reason && a.reason.length > 20, 'every acknowledgement carries a real reason');
    assert(a.summary && a.summary.length > 3, 'and a short summary for the calm line');
  }
});

check('the live error set classifies as entirely acknowledged', () => {
  const r = classifySyncErrors(LIVE_ERRORS);
  assert(r.counts.unacknowledged === 0, 'nothing is left in amber');
  assert(r.counts.acknowledged === LIVE_ERRORS.length, 'and every one is counted, not dropped');
  assert(r.acknowledged.every(a => a.reason), 'each carries its reason for the disclosure');
  // The calm line groups by summary: so many scans, one ingested separately.
  const scans = r.summary.find(s => /scan/i.test(s.summary));
  assert(scans && scans.count === SCANS.length, 'the scans group with the right count');
  assert(r.summary.some(s => /separately/i.test(s.summary)), 'and the policy document is its own group');
});

console.log('\nThe point of the page: a new failure still announces itself:');

check('an unacknowledged failure survives classification and stays visible', () => {
  const withNew = [...LIVE_ERRORS, 'Data Centres/New Cooling Spec.pdf: Graph 500 on download'];
  const r = classifySyncErrors(withNew);
  assert(r.counts.unacknowledged === 1, 'the new failure is not swallowed');
  assert(r.unacknowledged[0].path === 'Data Centres/New Cooling Spec.pdf', 'and is named');
  assert(r.counts.acknowledged === LIVE_ERRORS.length, 'while the known ones stay acknowledged');
});

check('an acknowledgement covers only its own class, never a different error on the same file', () => {
  // The same document failing for a new reason is a new problem.
  const r = classifySyncErrors(['7. Marwin/Marwin Brass Valves.pdf: Graph 403 forbidden']);
  assert(r.counts.unacknowledged === 1, 'a different error on an acknowledged path still surfaces');
});

check('an acknowledged document that syncs clean spends its acknowledgement', () => {
  // Only the current error set is classified, so a document no longer failing
  // is simply absent; the entry cannot hide anything that is not broken.
  const r = classifySyncErrors([]);
  assert(r.counts.acknowledged === 0 && r.counts.unacknowledged === 0, 'no errors means nothing acknowledged');
  const partial = classifySyncErrors([`${SCANS[0]}: no extractable text`]);
  assert(partial.counts.acknowledged === 1, 'and only what is still failing is reported');
});

check('an empty registry acknowledges nothing, so the fallback is amber not silence', () => {
  const r = classifySyncErrors(LIVE_ERRORS, []);
  assert(r.counts.unacknowledged === LIVE_ERRORS.length, 'with no registry every error surfaces');
  assert(r.counts.acknowledged === 0, 'nothing is quietly acknowledged by default');
});

console.log(`\n=== Sync acknowledgement gate: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
