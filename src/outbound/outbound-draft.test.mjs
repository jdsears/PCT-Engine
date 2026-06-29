// The grounded drafter and its safety pass, exercised offline. A deterministic
// stand-in model is injected so the full draft -> check -> revise pipeline runs
// without a network or a key. The case that matters most is the planted
// fabrication being caught and surfaced, never stored as clean.
import { composeDraft, findUnsupported, applySupplierGuardrail, outboundVoice, voiceClean } from './draft.mjs';

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  pass  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); fail++; }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

// Route a fake reply by which system prompt it is. check/revise may be arrays for
// sequential calls. Objects are JSON-encoded, mimicking the model's raw reply.
function fakeModel(responses) {
  const n = { draft: 0, check: 0, revise: 0 };
  return async (system) => {
    const phase = /fact-checker/.test(system) ? 'check' : /^Revise the cold-open/.test(system) ? 'revise' : 'draft';
    const r = responses[phase];
    const val = Array.isArray(r) ? r[Math.min(n[phase], r.length - 1)] : r;
    n[phase]++;
    return typeof val === 'string' ? val : JSON.stringify(val);
  };
}

const grounding = {
  leadId: 1, companyId: 1, contactId: 1, campaign: 'marwin_dc',
  company: { name: 'Aery Data Centres Ltd', type: 'dc_developer', region: 'RA-5' },
  contact: { id: 1, name: 'Sam Lee', role: 'M&E Lead', email: 's@aery.example' },
  signal: { id: 9, type: 'news_dc_build', text: 'Aery secured planning for a 40MW data centre in Slough', source: 'https://x.example/a' },
  icpReason: 'type dc_developer fits the campaign',
  product: [{ title: 'Marwin CV3000 datasheet', page: 3, sourceId: 'cv3000', snippet: 'characterized control ball valve for chilled water service' }],
  blockedSuppliers: [], missing: [],
};

console.log('Grounded cold-open drafter:');

await check('a fully grounded draft passes the check clean', async () => {
  const model = fakeModel({
    draft: { subject: 'Flow control for the Slough scheme', body: 'You secured planning in Slough.\n\nMarwin valves suit chilled water cooling.', claims: [{ text: 'Aery secured planning in Slough.', supportedBy: 'signal' }] },
    check: { claims: [{ text: 'Aery secured planning in Slough.', supported: true, by: 'signal' }] },
  });
  const out = await composeDraft(grounding, { callModel: model });
  assert(out.flags.length === 0, `expected no flags, got ${JSON.stringify(out.flags)}`);
  assert(out.subject && out.body, 'subject and body present');
});

await check('a planted fabrication is CAUGHT and surfaced, never stored clean', async () => {
  // The drafter invents a second site; the revision fails to remove it; the
  // re-check still flags it, so it must come back as a flag, not as clean.
  const model = fakeModel({
    draft: { subject: 'Slough and Dublin', body: 'You secured planning in Slough. You have also broken ground on a second site in Dublin.', claims: [{ text: 'broken ground in Dublin', supportedBy: 'signal' }] },
    check: { claims: [{ text: 'You have also broken ground on a second site in Dublin.', supported: false, by: null }] },
    revise: { subject: 'Slough and Dublin', body: 'You secured planning in Slough. You have also broken ground on a second site in Dublin.', claims: [] },
  });
  const out = await composeDraft(grounding, { callModel: model });
  assert(out.flags.length > 0, 'the fabrication must be flagged');
  assert(out.flags.some(f => /Dublin/.test(f)), `the Dublin fabrication must be surfaced, got ${JSON.stringify(out.flags)}`);
});

await check('a successful revision clears the flag and drops the invented claim', async () => {
  const model = fakeModel({
    draft: { subject: 'Slough', body: 'You secured planning in Slough. You have also broken ground in Dublin.', claims: [] },
    check: [
      { claims: [{ text: 'You have also broken ground in Dublin.', supported: false, by: null }] },
      { claims: [{ text: 'You secured planning in Slough.', supported: true, by: 'signal' }] },
    ],
    revise: { subject: 'Slough', body: 'You secured planning in Slough.', claims: [] },
  });
  const out = await composeDraft(grounding, { callModel: model });
  assert(out.flags.length === 0, `expected clean after revision, got ${JSON.stringify(out.flags)}`);
  assert(!/Dublin/.test(out.body), 'the fabrication must be gone from the body');
});

await check('findUnsupported returns only the claims marked unsupported, quoted', () => {
  const got = findUnsupported([{ text: 'a', supported: true }, { text: 'b', supported: false }, { text: '', supported: false }]);
  assert(JSON.stringify(got) === JSON.stringify(['b']), JSON.stringify(got));
});

console.log('\nGuardrail and voice on the final text:');

await check('the supplier guardrail redacts a blocked name and records it', () => {
  const g = applySupplierGuardrail('We work with FooOEM and Marwin.', ['FooOEM']);
  assert(!/FooOEM/.test(g.text) && /our supplier/.test(g.text), `redacted: ${g.text}`);
  assert(g.removed.includes('FooOEM'), 'records the removed name');
  const noop = applySupplierGuardrail('Marwin valves for cooling.', []);
  assert(noop.text === 'Marwin valves for cooling.' && noop.removed.length === 0, 'no blocked names is a no-op');
});

await check('composeDraft redacts a blocked supplier and flags the redaction', async () => {
  const model = fakeModel({
    draft: { subject: 'Valves', body: 'We supply FooOEM valves for cooling.', claims: [] },
    check: { claims: [] },
  });
  const out = await composeDraft({ ...grounding, blockedSuppliers: ['FooOEM'] }, { callModel: model });
  assert(!/FooOEM/.test(out.body), 'blocked supplier must be redacted from the body');
  assert(out.flags.some(f => /redacted/.test(f)), 'the redaction must be surfaced as a flag');
});

await check('the outbound voice strips dashes, exclamation marks and "genuinely"', () => {
  const v = outboundVoice('Great news — this is genuinely useful! Really useful!');
  assert(voiceClean(v), `not clean: ${v}`);
});

console.log(`\n=== Outbound draft gate: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
