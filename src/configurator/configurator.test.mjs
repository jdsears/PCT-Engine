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
const t2100 = JSON.parse(readFileSync(join(here, 'models', '2100.json'), 'utf8'));
const s3000 = JSON.parse(readFileSync(join(here, 'models', '3000.json'), 'utf8'));
const ms3000 = JSON.parse(readFileSync(join(here, 'models', 'ms3000.json'), 'utf8'));
const f2000 = JSON.parse(readFileSync(join(here, 'models', '2000.json'), 'utf8'));
const f5801 = JSON.parse(readFileSync(join(here, 'models', '5801.json'), 'utf8'));
const f6801 = JSON.parse(readFileSync(join(here, 'models', '6801.json'), 'utf8'));
const dm9900 = JSON.parse(readFileSync(join(here, 'models', 'dm9900.json'), 'utf8'));
const dm600 = JSON.parse(readFileSync(join(here, 'models', 'dm600.json'), 'utf8'));
const s8700 = JSON.parse(readFileSync(join(here, 'models', '8700.json'), 'utf8'));
const s4700 = JSON.parse(readFileSync(join(here, 'models', '4700.json'), 'utf8'));
const s10000 = JSON.parse(readFileSync(join(here, 'models', '10000.json'), 'utf8'));
const s9700 = JSON.parse(readFileSync(join(here, 'models', '9700.json'), 'utf8'));

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

console.log('\nThe 3T/3L-2100 three-way family (built from the FF and FA ordering matrices):');

check('the price book\'s own code round-trips through assemble and decode, separators and all', () => {
  const state = { model: '3L-2100F', size: '050', body: 'S6', ends: 'BF', operation: 'M2', pressure: 'NN', solenoid: '00', limitSwitch: '00', startPosition: 'A2' };
  const a = assemble(t2100, state);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.code, '3L-2100F-050-S6/BFM2NN0000A2', 'exactly as the price book prints it');
  const d = decode(t2100, a.code);
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.deepEqual(d.state, state, 'decode rebuilds the exact choices');
  const d2 = decode(t2100, '3T-2100F-150-CS/BFS68000003A');
  assert.equal(d2.ok, true, 'the spring return book code decodes too');
  assert.equal(d2.state.operation, 'S6', 'UT-3.5 spring return');
  assert.equal(d2.state.pressure, '80', '80 psi supply');
});

check('the matrix\'s own rules refuse the combinations it never printed', () => {
  const base = { size: '100', body: 'CS', ends: 'BA', pressure: 'NN', solenoid: '00', limitSwitch: '00' };
  for (const bad of [
    { ...base, model: '3T-2100F', operation: 'HL', startPosition: 'A2' },
    { ...base, model: '3L-2100F', operation: 'HL', startPosition: '3A' },
    { model: '3L-2100F', size: '600', body: 'S6', ends: 'BA', operation: 'HL', pressure: 'NN', solenoid: '00', limitSwitch: '00', startPosition: 'A2' },
    { ...base, model: '3L-2100F', operation: 'M2', pressure: '60', startPosition: 'A2' },
    { ...base, model: '3L-2100F', operation: 'S3', pressure: 'NN', startPosition: 'A2' },
    { ...base, model: '3L-2100F', operation: 'P4', pressure: '60', solenoid: '3A', startPosition: 'A2' },
    { ...base, model: '3L-2100F', operation: 'S9', pressure: '60', solenoid: '3A', startPosition: 'A2' },
    { ...base, model: '3L-2100F', operation: 'S5', pressure: '60', solenoid: '3J', startPosition: 'A2' },
    { ...base, model: '3L-2100F', operation: 'S6', pressure: '60', limitSwitch: 'AA', startPosition: 'A2' },
    { ...base, model: '3L-2100F', operation: 'S3', pressure: '60', limitSwitch: 'AD', startPosition: 'A2' },
  ]) assert.ok(checkConstraints(t2100, bad).length > 0, `must refuse ${JSON.stringify(bad)}`);
  const clean = { model: '3T-2100F', size: '150', body: 'CS', ends: 'BF', operation: 'S6', pressure: '80', solenoid: '00', limitSwitch: '00', startPosition: '3A' };
  assert.equal(checkConstraints(t2100, clean).length, 0, 'the book\'s own spring return build is valid');
  const withKit = { ...clean, solenoid: '3A', limitSwitch: 'AB' };
  assert.equal(checkConstraints(t2100, withKit).length, 0, 'solenoid and switch within their printed spans are valid');
});

check('the Nema 7 electric gap is a caution, never a code', () => {
  const notes = checkCautions(t2100, { operation: 'M2' });
  assert.ok(notes.some(n => /Nema 7/.test(n.note) && /per enquiry/.test(n.note)), 'the caution states the book evidence and the route');
  assert.ok(!t2100.slots.find(s => s.id === 'operation').options.some(o => /ER.*-7\b/.test(o.label)), 'no Nema 7 electric designator is invented');
  assert.equal(decode(t2100, '3L-2100F-050-S6/XXM2NN0000A2').ok, false, 'an unlisted ends code refuses to decode');
});

console.log('\nThe 3000 series family (built from the full and reduced port matrices):');

check('a full eighteen-position build round-trips, and the book\'s manual code is its printed head', () => {
  const bare = { prefix: '', model: '3000F', size: '050', body: 'CS', ends: 'PT', trim: 'S6', seat: 'TF', packing: 'TV', handle: 'HL', actuator: '00', solenoid: '00', limitSwitch: '0', positioner: '0', fail: '0', accessory: '0' };
  const a = assemble(s3000, bare);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.ok(a.code.startsWith('3000F-050-CS/PTS6TFTVHL'),
    'the price book\'s manual row is the full code\'s printed head, zeros stated');
  const d = decode(s3000, a.code);
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.deepEqual(d.state, bare, 'decode rebuilds the exact choices');
  const fs = { prefix: 'FS', model: '3000F', size: '150', body: 'CS', ends: 'F1', trim: 'S6', seat: 'TG', packing: 'GV', handle: 'NN', actuator: 'S6', solenoid: '3A', limitSwitch: 'B', positioner: 'R', fail: '2', accessory: '4' };
  const af = assemble(s3000, fs);
  assert.equal(af.ok, true, JSON.stringify(af));
  const df = decode(s3000, af.code);
  assert.equal(df.ok, true && af.code.startsWith('FS3000F-150-CS/'), 'the firesafe prefix leads the code');
  assert.deepEqual(df.state, fs, 'the automated firesafe build round-trips');
});

check('the 3000 matrix\'s own couplings refuse what it never printed', () => {
  const base = { prefix: '', body: 'CS', ends: 'PT', trim: 'S6', seat: 'TF', packing: 'TV', handle: 'HL', actuator: '00', solenoid: '00', limitSwitch: '0', positioner: '0', fail: '0', accessory: '0' };
  for (const bad of [
    { ...base, model: '3000F', size: '400' },
    { ...base, model: '3000R', size: '025' },
    { ...base, model: '3000F', size: '100', seat: 'PK' },
    { ...base, model: '3000F', size: '100', prefix: 'FS' },
    { ...base, model: '3000F', size: '100', prefix: 'FS', seat: 'TG', packing: 'TV' },
    { ...base, model: '3000F', size: '100', handle: 'NN', actuator: 'S9', solenoid: '3A' },
    { ...base, model: '3000F', size: '100', handle: 'NN', actuator: 'P4', positioner: 'Q' },
    { ...base, model: '3000F', size: '100', handle: 'NN', actuator: 'SJ', limitSwitch: 'B' },
    { ...base, model: '3000F', size: '100', fail: '2' },
    { ...base, model: '3000F', size: '100', actuator: 'M2', accessory: '4' },
  ]) assert.ok(checkConstraints(s3000, bad).length > 0, `must refuse ${JSON.stringify(bad)}`);
  const clean = { prefix: '', model: '3000R', size: '400', body: 'S6', ends: 'F3', trim: '6P', seat: 'PK', packing: 'GV', handle: 'NN', actuator: 'S8', solenoid: '3A', limitSwitch: 'D', positioner: 'R', fail: '2', accessory: '4' };
  assert.equal(checkConstraints(s3000, clean).length, 0, 'a fully coupled automated build within every span is valid');
  assert.ok(checkCautions(s3000, { actuator: 'M2' }).some(n => /Nema 7/.test(n.note)), 'the electric caution carries over');
});

console.log('\nThe MS3000 metal seated family (built from its ordering schematic):');

check('a metal seated build round-trips with the sheet\'s fixed standards', () => {
  const bare = { model: 'MS3000X', size: '100', body: 'CS', ends: 'PT', trim: 'S3', seat: 'W5', packing: 'GR', handle: 'HL', operation: 'NN', solenoid: '00', limitSwitch: '0', positioner: '0', fail: '0', accessory: '00' };
  const a = assemble(ms3000, bare);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.ok(a.code.startsWith('MS3000X-100-CS/PTS3W5GRHL'), 'the code carries the metal seated standards as printed');
  assert.deepEqual(decode(ms3000, a.code).state, bare, 'decode rebuilds the exact choices');
  const auto = { ...bare, handle: 'NN', operation: 'S8', solenoid: '3A', limitSwitch: 'D', positioner: '0', fail: '2', accessory: '04' };
  const aa = assemble(ms3000, auto);
  assert.equal(aa.ok, true, JSON.stringify(aa));
  assert.deepEqual(decode(ms3000, aa.code).state, auto, 'an automated build round-trips too');
});

check('the MS3000 couplings and cautions hold as printed', () => {
  const base = { model: 'MS3000X', size: '100', body: 'CS', ends: 'PT', trim: 'S3', seat: 'W5', packing: 'GR', handle: 'NN', operation: 'NN', solenoid: '00', limitSwitch: '0', positioner: '0', fail: '0', accessory: '00' };
  for (const bad of [
    { ...base, operation: 'S9', solenoid: '3A' },
    { ...base, operation: 'P4', solenoid: '3A' },
    { ...base, operation: 'S3', positioner: 'E' },
    { ...base, operation: 'M2', accessory: '04' },
    { ...base, fail: '2' },
  ]) assert.ok(checkConstraints(ms3000, bad).length > 0, `must refuse ${JSON.stringify(bad)}`);
  assert.ok(checkCautions(ms3000, { size: '300' }).some(n => /consult factory/i.test(n.note)), 'the starred sizes carry their consult factory caution');
  assert.ok(checkCautions(ms3000, { positioner: 'R' }).some(n => /DA where the pattern says SR/.test(n.note)), 'the printed R label discrepancy is held, not corrected');
  assert.equal(checkConstraints(ms3000, { operation: 'PB', positioner: 'R' }).length, 0, 'R is not asserted SR-only, since its own label prints DA');
});

console.log('\nThe flanged trio, 2000, 5801 and 6801 (built from their ordering matrices):');

check('the book\'s own automated codes decode letter for letter across the trio', () => {
  const d2 = decode(f2000, '2000F-050-CS-F1/BFS280000001');
  assert.equal(d2.ok, true, JSON.stringify(d2));
  assert.equal(d2.state.operation, 'S2', 'UT-1 spring return');
  assert.equal(d2.state.fail, '01', 'fail closed, exactly the book\'s trailing 01');
  assert.deepEqual(assemble(f2000, d2.state).code, '2000F-050-CS-F1/BFS280000001', 'and assembles back identically');
  const d5 = decode(f5801, '5801F-800-S6/FFSJ80000001');
  assert.equal(d5.ok, true, JSON.stringify(d5));
  assert.equal(d5.state.operation, 'SJ', 'the UT-7.5 spring return the eight inch carries');
  const d6 = decode(f6801, '6801F-600-S6/FGZZNN0000NN');
  assert.equal(d6.ok, true, JSON.stringify(d6));
  assert.equal(d6.state.operation, 'ZZ', 'the withheld dual-priced codes carry the non-standard operation, as printed');
  assert.ok(checkCautions(f6801, { operation: 'ZZ' }).some(n => /per enquiry/.test(n.note)),
    'and the builder says so as a caution');
});

check('the trio\'s couplings hold and their printed absences refuse', () => {
  assert.equal(applyValue(f2000, {}, 'size', '8"').accepted, false, 'the 2000 has no eight inch');
  assert.equal(applyValue(f2000, {}, 'operation', 'MC').accepted, false, 'the 2000 electrics stop at MA');
  assert.equal(applyValue(f5801, {}, 'size', '1-1/4"').accepted, false, 'no 1-1/4 inch anywhere in the trio');
  assert.equal(applyValue(f6801, {}, 'operation', 'PJ').accepted, false, 'the 6801 has no UT-7.5 double acting');
  const base5 = { model: '5801F', size: '800', body: 'S6', packingSeat: 'F', ends: 'F', operation: 'SJ', pressure: '80', solenoid: '00', limitSwitch: '00', fail: '01' };
  assert.equal(checkConstraints(f5801, base5).length, 0, 'the book\'s own eight inch build is valid');
  for (const bad of [
    { ...base5, solenoid: '3A' },
    { ...base5, limitSwitch: 'AB' },
    { ...base5, operation: 'M2', pressure: '80' },
    { ...base5, operation: 'HL', fail: '01' },
  ]) assert.ok(checkConstraints(f5801, bad).length > 0, `must refuse ${JSON.stringify(bad)}`);
});

console.log('\nThe direct mounts, DM9900 and DM600 (built from their ordering matrices):');

check('the book\'s automated direct mount codes decode, and the unprinted L electrics stay out', () => {
  const d = decode(dm9900, 'DM9900F-025-S6/AAS180000001');
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.state.operation, 'S1', 'the UT-0 spring return package');
  assert.equal(decode(dm9900, 'DM9900F-025-S6/AAL1NN0000NN').ok, false,
    'the book\'s L-coded Nema 7 electric is not in this matrix and does not decode; it lives in the priced chooser');
  assert.ok(checkCautions(dm9900, { operation: 'M1' }).some(n => /L-coded/.test(n.note)), 'and the caution says where it lives');
  const d6 = decode(dm600, 'DM600F-025-BR/AANNNN0000NN');
  assert.equal(d6.ok, true, JSON.stringify(d6));
  assert.equal(d6.state.operation, 'NN', 'the bare direct mount valve the book prices');
  assert.ok(checkCautions(dm9900, { size: '025' }).some(n => /reducer bushings/.test(n.note)),
    'the starred small sizes carry the sheet\'s bushing note');
  assert.equal(applyValue(dm9900, {}, 'operation', 'S6').accepted, false, 'DM9900 springs stop at UT-3');
  assert.equal(applyValue(dm600, {}, 'operation', 'M9').accepted, false, 'DM600 electrics stop at M5');
  assert.ok(checkConstraints(dm600, { operation: 'S6', limitSwitch: 'AA' }).length > 0, 'switch spans hold');
});

console.log('\nThe 8700 3-piece family (built from its ordering schematic):');

check('the 8700 keeps its letter sizes, decodes the book, and swaps BA for BB exactly as its note says', () => {
  const d = decode(s8700, '8700F-05A-CS/BAHLNN0000NN');
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.state.packingSeat, 'B', 'standard PTFE/RPTFE');
  assert.equal(d.state.ends, 'A', 'FNPT');
  const fsw = assemble(s8700, { ...d.state, ends: 'B' });
  assert.ok(fsw.code.includes('/BBHL'), 'replace BA with BB for FSW ends, the book\'s own instruction');
  assert.equal(applyValue(s8700, {}, 'size', '050').accepted, false, 'numeric size codes do not exist in this family');
  assert.ok(checkConstraints(s8700, { operation: 'EB', pressure: '80' }).length > 0, 'the stem extension takes no air supply');
  assert.ok(checkConstraints(s8700, { operation: 'S6', limitSwitch: 'AA' }).length > 0, 'switch spans hold');
});

console.log('\nThe last three matrices from the drop, 4700, 10000 and 9700:');

check('the 4700 decodes the book, and the SF reading is flagged rather than trusted', () => {
  const d = decode(s4700, '4700F-05A-CS/FAHLNN0000NN');
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.state.packingSeat, 'F', 'the firesafe standard Grafoil/RPTFE');
  assert.ok(checkCautions(s4700, { operation: 'SF' }).some(n => /verified against the PDF/.test(n.note)),
    'the twice-printed S6 is held as a flagged SF, not silently corrected');
  assert.equal(applyValue(s4700, {}, 'size', '6"').accepted, false, 'the 4700 stops at 4 inch');
});

check('the 10000 runs the full eighteen positions with its hard seats and barstock bodies', () => {
  const bare = { model: '10000F', size: '100', body: 'SB', ends: 'PT', trim: 'S6', seat: 'PK', packing: 'TV', handle: 'HL', operation: '00', solenoid: '00', limitSwitch: '0', positioner: '0', fail: '0', accessory: '00' };
  const a = assemble(s10000, bare);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.deepEqual(decode(s10000, a.code).state, bare, 'the bare high pressure build round-trips');
  assert.equal(applyValue(s10000, {}, 'seat', 'TF').accepted, false, 'soft PTFE seats do not exist at 6000 psi');
  assert.equal(applyValue(s10000, {}, 'ends', 'F1').accepted, false, 'flanges start at 900#');
  assert.ok(checkConstraints(s10000, { operation: 'SA', solenoid: '3A' }).length > 0, 'solenoid spans hold at the top of the range');
  assert.ok(checkCautions(s10000, { positioner: 'R' }).some(n => /same misprint as the MS3000/.test(n.note)), 'the repeated R misprint is flagged');
});

check('the 9700 keeps its port split and its consult-factory carbon steel', () => {
  assert.ok(checkConstraints(s9700, { model: '9700F', size: '20A' }).length > 0, 'the 2 inch belongs to the reduced port');
  assert.ok(checkConstraints(s9700, { model: '9700R', size: '05A' }).length > 0, 'and the reduced port is the 2 inch alone');
  assert.ok(checkCautions(s9700, { body: 'CS' }).some(n => /consult factory/i.test(n.note)), 'carbon steel carries the sheet\'s own special-order line');
  const d = decode(s9700, '9700F-05A-S6/KAHLNN0000NN');
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.state.packingSeat, 'K', 'Grafoil/Delrin, the only listed pair');
});

console.log(`\n=== Configurator gate: ${pass} passed, ${fail} failed ===`);
if (unsatisfiable.length) {
  console.log('Unsatisfiable exercises:');
  for (const u of unsatisfiable) console.log(`  - ${u}`);
}
process.exit(fail ? 1 : 0);
