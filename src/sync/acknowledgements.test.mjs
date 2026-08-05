// Acknowledged sync failures. The contract this suite defends is the one that
// makes the mechanism safe: a known condition reads as known, and a new
// problem still announces itself. If a future edit ever lets an unknown error
// be swallowed by an acknowledgement, these fail.

import { classifySyncErrors, parseSyncError, loadAcknowledgements } from './acknowledgements.mjs';
import { decisionUpdate, decisionValues } from './reviewDecision.mjs';

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

console.log('\nA review decision survives a schema that has not caught up:');

// The live fault this guards: confirming an account hard-failed because an
// audit-only column was missing, the app having deployed from main before the
// migration was applied by hand. An audit note must never take a human action
// down with it.
check('with the column present the note is written', () => {
  const u = decisionUpdate({ status: 'confirmed', withNote: true });
  assert(/decision_note = \$2/.test(u.sql), 'the note is set');
  assert(/company_id = \$1/.test(u.sql) && /WHERE id = \$3/.test(u.sql), 'and the placeholders are in order');
  const v = decisionValues(u.order, { company: 7, note: 'because', id: 42 });
  assert(JSON.stringify(v) === JSON.stringify([7, 'because', 42]), 'values bind in the declared order');
});

check('with the column absent the decision still records, without the note', () => {
  const u = decisionUpdate({ status: 'confirmed', withNote: false });
  assert(!/decision_note/.test(u.sql), 'no reference to a column that does not exist');
  assert(/status = 'confirmed'/.test(u.sql) && /decided_at = now\(\)/.test(u.sql), 'the decision itself is still recorded');
  assert(/WHERE id = \$2/.test(u.sql), 'and the placeholders renumber, so nothing binds to a missing column');
  const v = decisionValues(u.order, { company: 7, note: 'because', id: 42 });
  assert(JSON.stringify(v) === JSON.stringify([7, 42]), 'the note value is not bound');
});

check('dismiss sets no company, in either schema', () => {
  for (const withNote of [true, false]) {
    const u = decisionUpdate({ status: 'dismissed', setCompany: false, withNote });
    assert(!/company_id/.test(u.sql), 'a dismissal does not claim a company');
    const v = decisionValues(u.order, { note: 'n', id: 5 });
    assert(v[v.length - 1] === 5, 'the id is always the last parameter');
  }
});

check('the deciding person is written only when the schema holds the column', () => {
  const u = decisionUpdate({ status: 'confirmed', withNote: true, withActor: true });
  assert(/decided_by = \$3/.test(u.sql) && /WHERE id = \$4/.test(u.sql), 'the actor slots in before the id');
  const v = decisionValues(u.order, { company: 7, note: 'because', actor: 'andymangell@pctflow.com', id: 42 });
  assert(JSON.stringify(v) === JSON.stringify([7, 'because', 'andymangell@pctflow.com', 42]), 'values bind in the declared order');
  const bare = decisionUpdate({ status: 'confirmed', withNote: false, withActor: false });
  assert(!/decided_by/.test(bare.sql), 'no reference to a column that does not exist');
  const bv = decisionValues(bare.order, { company: 7, note: 'n', actor: 'x', id: 42 });
  assert(JSON.stringify(bv) === JSON.stringify([7, 42]), 'no value binds for an absent column');
});

console.log(`\n=== Sync acknowledgement gate: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
