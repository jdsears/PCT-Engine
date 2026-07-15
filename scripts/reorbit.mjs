#!/usr/bin/env node
// Re-apply the orbit rules to stored contacts after the rules change, so a
// widened list reaches people already discovered without spending a single
// Unipile call. Dry run by default; --apply writes. Only widening is applied:
// a contact the new rules would drop from orbit is reported for a human eye
// and left untouched, since orbit membership may have been set by a path with
// more evidence than the headline (a verified register director, say).
//
//   node --env-file=.env scripts/reorbit.mjs
//   node --env-file=.env scripts/reorbit.mjs --apply
import { pool } from '../src/db.mjs';
import { inOrbit } from '../src/research/orbitRules.mjs';

const APPLY = process.argv.includes('--apply');

const { rows } = await pool.query(
  `SELECT ct.id, ct.full_name, ct.role_title, ct.in_decision_orbit, c.name AS company
   FROM contacts ct LEFT JOIN companies c ON c.id = ct.company_id
   WHERE ct.role_title IS NOT NULL AND NOT ct.suppressed AND NOT ct.rehearsal`);

const widen = [];
const narrow = [];
for (const c of rows) {
  const now = inOrbit(c.role_title);
  if (now === true && c.in_decision_orbit !== true) widen.push(c);
  else if (now === false && c.in_decision_orbit === true) narrow.push(c);
}

console.log(`Orbit re-score: ${rows.length} titled contact(s) checked against the current rules.\n`);
if (widen.length) {
  console.log(`Now in orbit (${widen.length}):`);
  for (const c of widen) console.log(`  ${c.full_name}  ·  ${String(c.role_title).slice(0, 70)}  ·  ${c.company || ''}`);
} else {
  console.log('No contact newly qualifies.');
}
if (narrow.length) {
  console.log(`\nIn orbit but outside the current rules (${narrow.length}), left untouched, review by hand:`);
  for (const c of narrow) console.log(`  ${c.full_name}  ·  ${String(c.role_title).slice(0, 70)}  ·  ${c.company || ''}`);
}

if (!APPLY) {
  console.log('\nDry run, nothing written. Re-run with --apply to bring the new qualifiers into orbit.');
} else if (widen.length) {
  await pool.query(`UPDATE contacts SET in_decision_orbit = true WHERE id = ANY($1)`, [widen.map(c => c.id)]);
  console.log(`\nApplied: ${widen.length} contact(s) brought into orbit. They appear as decision makers now;`);
  console.log('the next engine cycle resolves their emails if auto discovery is on, and those with');
  console.log('LinkedIn profiles join the studio connect queue.');
} else {
  console.log('\nNothing to apply.');
}
await pool.end();
