import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { emptySlots, applyValue, checkConstraints, checkCautions, assemble, decode } from './engine.mjs';
import { looksLikeBuild, extractModel, completionText } from './converse.mjs';

// The acceptance gate. The PricingLevel exercises carry no worked answers, so
// the test is round-trip: build a spec, assemble the code, decode it, and
// assert the decoded choices match the spec. A configurator that cannot rebuild
// the spec from its own output is wrong. The refusal and constraint cases prove
// it would rather decline than guess.
//
// Run: node src/configurator/configurator.test.mjs

const here = dirname(fileURLToPath(import.meta.url));
const mk601 = JSON.parse(readFileSync(join(here, 'models', 'mk601.json'), 'utf8'));
const cv3000 = JSON.parse(readFileSync(join(here, 'models', 'cv3000.json'), 'utf8'));
const cv4700 = JSON.parse(readFileSync(join(here, 'models', 'cv4700.json'), 'utf8'));
const jr = JSON.parse(readFileSync(join(here, 'models', 'jr.json'), 'utf8'));
const mark96 = JSON.parse(readFileSync(join(here, 'models', 'mark96.json'), 'utf8'));

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

console.log('\nMarwin CV3000 (the showpiece: round-trip and enforced couplings):');

check('a reduced-port CV3000 build round-trips', () => {
  // A 4" reduced-port valve with a spring-return actuator, a matching spring-return
  // 2-IQ positioner, and a fail-closed position: every coupling satisfied.
  const spec = {
    model: 'CV3000R', size: '400', body: 'S6', ends: 'F3', insert: 'A1', seat: 'TF',
    packing: 'TV', handle: 'HL', operation: 'S5', positioner: 'A5', fail: '002',
  };
  const state = buildState(cv3000, spec, {});
  const built = assemble(cv3000, state);
  assert.ok(built.ok, 'a valid, fully coupled CV3000 spec assembles');
  assert.equal(built.code, 'CV3000R400S6F3A1TFTVHLS5A5002');
  const back = decode(cv3000, built.code);
  assert.ok(back.ok, `decode failed: ${back.error}`);
  assert.deepEqual(back.state, state, 'decoded state must match the built state');
});

check('4 inch is blocked on a full-port CV3000', () => {
  assert.ok(checkConstraints(cv3000, { model: 'CV3000F', size: '400' }).length > 0,
    '4 inch is reduced port only');
});

check('a fail position needs a spring-return actuator', () => {
  assert.ok(checkConstraints(cv3000, { operation: 'P6', fail: '001' }).length > 0,
    'double-acting actuator with a fail-open position must clash');
  assert.equal(checkConstraints(cv3000, { operation: 'S5', fail: '001' }).length, 0,
    'a spring-return actuator with a fail-open position is valid');
});

check('the 2-IQ positioner must match the actuator', () => {
  assert.ok(checkConstraints(cv3000, { positioner: 'A1', operation: 'S5' }).length > 0,
    'a double-acting positioner with a spring-return actuator must clash');
  assert.ok(checkConstraints(cv3000, { positioner: 'A5', operation: 'P6' }).length > 0,
    'a spring-return positioner with a double-acting actuator must clash');
});

console.log('\nIntent detection (a question about a product is not a build request):');

check('knowledge questions that name a configurable product do not enter the configurator', () => {
  for (const q of [
    'what is the marwin cv3000 and what applications is it for?',
    'What is the pressure rating of the Marwin CV3000?',
    'What materials is the CV3000 available in?',
    'Tell me about the Jordan Mark 708',
  ]) assert.equal(looksLikeBuild(q), false, `must be answered as knowledge, not a build: "${q}"`);
});

check('explicit build requests still enter the configurator', () => {
  for (const q of [
    'Build a Marwin CV3000 part number',
    'Configure a CV3000',
    'I need a part number for the CV3000',
    'Generate a code for a Jordan Mark 601',
  ]) assert.ok(looksLikeBuild(q), `must enter the configurator: "${q}"`);
});

// Direct-code builds for the three new models: set every slot by its matrix
// code, assemble, and decode back. No worked examples exist in the corpus for
// these, so the round-trip is the gate, exactly as it was for the CV3000.
function buildByCodes(config, codes) {
  let state = {};
  for (const [slot, code] of Object.entries(codes)) {
    const r = applyValue(config, state, slot, code);
    assert.ok(r.accepted, `code "${code}" was not accepted for ${slot}`);
    state = r.state;
  }
  return state;
}
function roundTrip(config, codes, expected) {
  const state = buildByCodes(config, codes);
  const built = assemble(config, state);
  assert.ok(built.ok, `assembly failed: ${JSON.stringify(built)}`);
  assert.equal(built.code, expected);
  const back = decode(config, built.code);
  assert.ok(back.ok, `decode failed: ${back.error}`);
  assert.deepEqual(back.state, state, 'decoded state must match the built state');
}

console.log('\nMarwin CV4700 (round-trip and enforced couplings):');

check('a lever CV4700 round-trips', () => {
  roundTrip(cv4700, {
    model: 'CV4730F', size: '05A', body: 'CS', packingSeatEnds: 'FA', operation: 'HL',
    actuatorPressure: 'NN', solenoid: '00', limitSwitch: '00', fail: 'NN', positioner: '00',
  }, 'CV4730F05ACSFAHLNN0000NN00');
});

check('a spring-return CV4700 with solenoid, limit switch, fail closed and SR positioner round-trips', () => {
  roundTrip(cv4700, {
    model: 'CV4760F', size: '20A', body: 'S6', packingSeatEnds: 'FB', operation: 'S5',
    actuatorPressure: '60', solenoid: '3A', limitSwitch: 'AA', fail: '01', positioner: 'AQ',
  }, 'CV4760F20AS6FBS5603AAA01AQ');
});

check('a double-acting CV4700 round-trips', () => {
  roundTrip(cv4700, {
    model: 'CV4730F', size: '10A', body: 'S6', packingSeatEnds: 'FA', operation: 'P6',
    actuatorPressure: '80', solenoid: '4B', limitSwitch: 'AC', fail: 'NN', positioner: 'AE',
  }, 'CV4730F10AS6FAP6804BACNNAE');
});

check('CV4700 couplings are enforced and unlisted options refused', () => {
  for (const bad of [
    { operation: 'P6', fail: '01' },
    { operation: 'HL', fail: '02' },
    { operation: 'S5', fail: 'NN' },
    { solenoid: '3A', operation: 'P6' },
    { solenoid: '4B', operation: 'S5' },
    { operation: 'S5', actuatorPressure: 'NN' },
    { operation: 'HL', actuatorPressure: '60' },
    { positioner: 'AE', operation: 'S5' },
    { positioner: 'AQ', operation: 'P6' },
  ]) assert.ok(checkConstraints(cv4700, bad).length > 0, `must refuse ${JSON.stringify(bad)}`);
  assert.equal(checkConstraints(cv4700, { operation: 'S5', fail: '01', actuatorPressure: '60' }).length, 0);
  assert.equal(applyValue(cv4700, {}, 'operation', 'P9').accepted, false, 'P9 is not in the matrix');
  assert.equal(applyValue(cv4700, {}, 'size', '25A').accepted, false, '25A is not in the matrix');
});

console.log('\nLowFlow JR Series (round-trip, couplings, and the gauge-span caution):');

check('a minimal JR round-trips', () => {
  roundTrip(jr, {
    model: 'JR', size: '025', material: '6L', endConnection: 'A', portConfig: 'A',
    trim: '1S', seat: 'T1', rangeSpring: 'E1', diaphragm: 'JL', actuator: 'SK',
    inletGauge: 'AA', outletGauge: 'A', sep: '0', accessories: '0',
  }, 'JR0256LAA1ST1E1JLSKAAA00');
});

check('a self-relieving JR round-trips', () => {
  roundTrip(jr, {
    model: 'JR', size: '050', material: '6L', endConnection: 'C', portConfig: 'R',
    trim: '3R', seat: 'T3', rangeSpring: 'E3', diaphragm: 'JL', actuator: 'CV',
    inletGauge: 'NN', outletGauge: 'N', sep: 'G', accessories: 'S',
  }, 'JR0506LCR3RT3E3JLCVNNNGS');
});

check('JR couplings are enforced and unlisted options refused', () => {
  assert.ok(checkConstraints(jr, { size: '025', endConnection: 'C' }).length > 0, 'the end connection must match the size');
  assert.ok(checkConstraints(jr, { trim: '1R', seat: 'P1' }).length > 0, 'self-relieving trim needs a PTFE seat');
  assert.ok(checkConstraints(jr, { trim: '1S', seat: 'T3' }).length > 0, 'the seat Cv must match the trim Cv');
  assert.equal(checkConstraints(jr, { trim: '3R', seat: 'T3' }).length, 0, 'a matching PTFE seat is valid');
  assert.equal(applyValue(jr, {}, 'seat', 'T5').accepted, false, 'T5 is not in the matrix');
});

check('the JR gauge-span liability note is a stated caution, never a refusal', () => {
  assert.equal(checkCautions(jr, { rangeSpring: 'E3', outletGauge: 'A' }).length, 1, 'an under-spanned outlet gauge cautions');
  assert.equal(checkCautions(jr, { rangeSpring: 'E3', outletGauge: 'D' }).length, 0, 'a covering outlet gauge is silent');
  assert.equal(checkCautions(jr, { rangeSpring: 'E6', inletGauge: 'AA' }).length, 1, 'an under-spanned inlet gauge cautions');
  const state = buildByCodes(jr, {
    model: 'JR', size: '050', material: '6L', endConnection: 'C', portConfig: 'R',
    trim: '3S', seat: 'T3', rangeSpring: 'E3', diaphragm: 'JL', actuator: 'SK',
    inletGauge: 'NN', outletGauge: 'A', sep: '0', accessories: '0',
  });
  const built = assemble(jr, state);
  assert.ok(built.ok, 'a cautioned combination still assembles, the matrix permits it');
  const done = completionText(jr, state);
  assert.equal(done.cautions.length, 1, 'the completion carries the caution');
  assert.ok(/caution from the datasheet/i.test(done.text), 'the caution is stated plainly in the completion text');
});

console.log('\nSteriflow Mark 96 (round-trip and the restriction tables):');

check('a 1 inch Mark 96 round-trips', () => {
  roundTrip(mark96, {
    model: '96', size: '100', material: '6L', bodyConfig: '', bodyFinish: 'A', bodyCv: 'H',
    trimFinish: 'A', trim: 'K', oringDiaphragm: 'EP', adjustingScrewFinish: 'A',
    range: 'H', diaphragm: 'JL', actuatorFinish: 'AA', ped: '00',
  }, '961006LAHAKEPAHJLAA00');
});

check('a DIN Mark 96 with gauge port, aluminium housing and CE category 1 round-trips', () => {
  roundTrip(mark96, {
    model: '96D', size: '40', material: '6L', bodyConfig: '180', bodyFinish: 'A', bodyCv: 'M',
    trimFinish: 'A', trim: 'R', oringDiaphragm: 'EE', adjustingScrewFinish: 'A',
    range: 'E', diaphragm: 'JL', actuatorFinish: 'EA', ped: '0F',
  }, '96D406L180AMAREEAEJLEA0F');
});

check('a 3-8 range Mark 96 with ultra-thin Jorlon round-trips', () => {
  roundTrip(mark96, {
    model: '96T', size: '075', material: '6L', bodyConfig: '', bodyFinish: 'B', bodyCv: 'A',
    trimFinish: 'B', trim: '2', oringDiaphragm: 'EE', adjustingScrewFinish: 'A',
    range: 'A', diaphragm: 'UJ', actuatorFinish: 'AA', ped: '0G',
  }, '96T0756LBAB2EEAAUJAA0G');
});

check('Mark 96 restriction tables are enforced and unlisted options refused', () => {
  for (const bad of [
    { size: '100', trim: 'S' },
    { range: 'A', diaphragm: 'JL' },
    { range: 'A', diaphragm: '6L' },
    { size: '15N', model: '96' },
    { size: '20N', model: '96S' },
    { actuatorFinish: 'EA', size: '075' },
    { size: '15', trim: 'A' },
    { bodyCv: 'K', trim: 'P' },
    { oringDiaphragm: 'TS', size: '075' },
    { trim: 'N', diaphragm: '6L' },
    { ped: '0F', size: '075' },
    { range: 'M', size: '200' },
  ]) assert.ok(checkConstraints(mark96, bad).length > 0, `must refuse ${JSON.stringify(bad)}`);
  assert.equal(checkConstraints(mark96, { range: 'A', diaphragm: 'UJ' }).length, 0, 'the documented pairing is valid');
  assert.equal(checkConstraints(mark96, { size: '15N', model: '96D' }).length, 0, '15N on a 96D is valid');
  assert.equal(applyValue(mark96, {}, 'trim', 'Z').accepted, false, 'Z is not a trim in the matrix');
});

console.log('\nIntent and routing for the new models:');

check('new model names do not enter the build on a question, and resolve on build intent', () => {
  for (const q of ['Tell me about the Mark 96', 'what is the JR series used for?', 'what sizes does the CV4700 come in?'])
    assert.equal(looksLikeBuild(q), false, `must stay a knowledge question: "${q}"`);
  assert.equal(extractModel('build a mark 96 part number'), 'MARK96');
  assert.equal(extractModel('configure a cv4700'), 'CV4700');
  assert.equal(extractModel('i need a part number for the jr series'), 'JR');
});

console.log(`\n=== Configurator gate: ${pass} passed, ${fail} failed ===`);
if (unsatisfiable.length) {
  console.log('Unsatisfiable exercises:');
  for (const u of unsatisfiable) console.log(`  - ${u}`);
}
process.exit(fail ? 1 : 0);
