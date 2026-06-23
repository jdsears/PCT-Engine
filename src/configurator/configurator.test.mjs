import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { emptySlots, applyValue, checkConstraints, assemble, decode } from './engine.mjs';

// The acceptance gate. The PricingLevel exercises carry no worked answers, so
// the test is round-trip: build a spec, assemble the code, decode it, and
// assert the decoded choices match the spec. A configurator that cannot rebuild
// the spec from its own output is wrong. The refusal and constraint cases prove
// it would rather decline than guess.
//
// Run: node src/configurator/configurator.test.mjs

const here = dirname(fileURLToPath(import.meta.url));
const mk601 = JSON.parse(readFileSync(join(here, 'models', 'mk601.json'), 'utf8'));

let pass = 0, fail = 0;
const unsatisfiable = [];
function check(name, fn) {
  try { fn(); pass++; console.log(`  pass  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}: ${e.message}`); }
}

// Resolve a spec of slot -> human phrase into codes via applyValue, the same
// path the conversational layer uses, then return the full state.
function buildState(config, spec, fillers) {
  let state = {};
  for (const [slot, phrase] of Object.entries(spec)) {
    const r = applyValue(config, state, slot, phrase);
    assert.ok(r.accepted, `spec value "${phrase}" did not map to a ${slot} option`);
    state = r.state;
  }
  for (const [slot, phrase] of Object.entries(fillers || {})) {
    const r = applyValue(config, state, slot, phrase);
    assert.ok(r.accepted, `filler "${phrase}" did not map to a ${slot} option`);
    state = r.state;
  }
  return state;
}

console.log('MK601 part-number-build exercises (round-trip):');

// PricingLevel11: "2" MK601, 50Cv, SST Body, BSPP Ends, 20-45 Range, SST Diaphragm"
check('PricingLevel11: 2" MK601, 50Cv, SST, BSPP, 20-45, SST diaphragm', () => {
  const spec = {
    model: 'MK601', size: '2"', body: 'SST', ends: 'BSPP',
    cv: '50', spring: '20-45', diaphragm: 'SST diaphragm',
  };
  // The five the spec leaves open, chosen with valid values to complete the build.
  const fillers = { trim: '316SS', seat: '316SS/Jorcote', actuator: 'SM', bolting: '00', accessories: '0' };
  const state = buildState(mk601, spec, fillers);

  // The pinned slots resolved to the matrix codes the spec intends.
  assert.equal(state.model, '601');
  assert.equal(state.size, '200');
  assert.equal(state.body, 'S6');
  assert.equal(state.ends, 'BP');
  assert.equal(state.cv, 'C');
  assert.equal(state.spring, '53');
  assert.equal(state.diaphragm, 'S6');

  const built = assemble(mk601, state);
  assert.ok(built.ok, 'assembly should succeed for a complete, valid spec');
  assert.equal(built.code, '601200S6BPS6WC53S6SM000');

  // Round-trip: the code decodes back to exactly the state it was built from.
  const back = decode(mk601, built.code);
  assert.ok(back.ok, `decode failed: ${back.error}`);
  assert.deepEqual(back.state, state, 'decoded state must match the built state');
});

console.log('\nRefusals (declines rather than guesses):');

check('invalid Cv is rejected with the valid options', () => {
  const r = applyValue(mk601, {}, 'cv', '999');
  assert.equal(r.accepted, false);
  assert.ok(r.options.length > 0, 'a rejection lists the valid options');
  assert.ok(r.options.some(o => o.code === 'C'), 'the valid Cv options are returned');
});

check('an unlisted body material is rejected', () => {
  const r = applyValue(mk601, {}, 'body', 'titanium');
  assert.equal(r.accepted, false);
});

check('assemble refuses while required slots are unfilled', () => {
  const partial = { model: '601', size: '200', body: 'S6' };
  const built = assemble(mk601, partial);
  assert.equal(built.ok, false);
  assert.equal(built.reason, 'incomplete');
  assert.ok(built.missing.length > 0);
});

console.log('\nConstraints (matrix rules enforced):');

check('50 Cv in a 1-1/2" body is blocked', () => {
  const state = { model: '601', size: '150', cv: 'C' };
  const v = checkConstraints(mk601, state);
  assert.ok(v.length > 0, '50 Cv is 2" only, so a 1-1/2" choice must clash');
});

check('a stainless body with an FE (ductile/bronze) flange is blocked', () => {
  const state = { body: 'S6', ends: 'F5' };
  const v = checkConstraints(mk601, state);
  assert.ok(v.length > 0, 'FE flanges are ductile iron or bronze only');
});

check('65 Cv on a 601 (it is a 602 Cv) is blocked', () => {
  const state = { model: '601', cv: 'Y' };
  const v = checkConstraints(mk601, state);
  assert.ok(v.length > 0, '65 Cv is Mark 602 only');
});

check('a fully valid 601 spec has no constraint clash', () => {
  const state = { model: '601', size: '200', body: 'S6', ends: 'BP', cv: 'C' };
  assert.equal(checkConstraints(mk601, state).length, 0);
});

console.log('\nDecode (round-trip primitive):');

check('decode parses a full code into the right slots', () => {
  const back = decode(mk601, '601200S6BPS6WC53S6SM000');
  assert.ok(back.ok, back.error);
  assert.equal(back.state.model, '601');
  assert.equal(back.state.cv, 'C');
  assert.equal(back.state.spring, '53');
  assert.equal(back.decode.length, 12);
});

console.log(`\n=== Configurator gate: ${pass} passed, ${fail} failed ===`);
if (unsatisfiable.length) {
  console.log('Unsatisfiable exercises:');
  for (const u of unsatisfiable) console.log(`  - ${u}`);
}
process.exit(fail ? 1 : 0);
