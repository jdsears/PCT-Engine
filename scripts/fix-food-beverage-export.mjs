#!/usr/bin/env node
// Correct the food, beverage and cosmetics export before seeding, so nobody
// edits a spreadsheet by hand. John, 9 September 2026, on the first dry run.
//
//   node scripts/fix-food-beverage-export.mjs --file "<export.csv>"
//   node scripts/fix-food-beverage-export.mjs --file "<export.csv>" --set "Kalsec=Milton Keynes"
//
// Writes "<export> (corrected).csv" beside the original and never touches the
// original. Every change is printed with its basis, and every row the seed
// would still hold is named with the flag that would settle it. Nothing here
// touches the database; the seed script reads the corrected file.
//
// The built-in corrections are the CRM artefacts the first dry run surfaced:
// UK subsidiaries filed under a head-office city abroad, a research institute
// with no city, and a company named by its domain. A city set here never
// enters the register (the seed stores name, type and sales region); it only
// tells the seed the row is a UK company. Molson Coors is left held on
// purpose, because Coors Brewers in the same export is the same company.
import { readFile, writeFile } from 'node:fs/promises';
import { parseCsv, writeCsv, holdReason } from '../src/research/hubspotExport.mjs';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? null : (args[i + 1] || null); };
const FILE = flag('--file');
if (!FILE) {
  console.error('Usage: node scripts/fix-food-beverage-export.mjs --file "<export.csv>" [--set "Company=City" ...]');
  process.exit(1);
}

// name → { City, 'Company name' } with the basis printed beside each change.
export const CORRECTIONS = {
  'princes.co.uk': { 'Company name': 'Princes', basis: 'the row is named by its domain; the company is Princes (Liverpool)' },
  'Baker Perkins': { City: 'Peterborough', basis: 'UK subsidiary; Grand Rapids is the parent, the UK works are in Peterborough' },
  'GEA Group': { City: 'Eastleigh', basis: 'UK subsidiary; the row\'s own phone number (023 8026) is the Eastleigh site' },
  'HARIBO': { City: 'Pontefract', basis: 'UK subsidiary; Des Plaines is Haribo of America, the UK factories are in Pontefract and Castleford' },
  'Mowi': { City: 'Fort William', basis: 'UK subsidiary; the Scottish business is run from Fort William, and the sales area already says Scotland' },
  'Nufarm': { City: 'Bradford', basis: 'UK subsidiary; the row\'s own phone number (01274) is Bradford' },
  'Quadram Institute': { City: 'Norwich', basis: 'a research institute on the Norwich Research Park; the row had no city' },
};

// --set "Company=City" for anything the built-in list does not know.
const sets = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--set') continue;
  const m = /^(.+?)=(.+)$/.exec(args[i + 1] || '');
  if (!m) { console.error(`--set wants "Company=City", got ${args[i + 1] || 'nothing'}`); process.exit(1); }
  sets[m[1].trim()] = m[2].trim();
}

const text = await readFile(FILE, 'utf8');
const rows = parseCsv(text);
// Every row carries every header column in header order, so the first row's
// keys are the header.
const header = Object.keys(rows[0] || {});
const key = s => String(s || '').trim().toLowerCase();
const changes = [];
for (const r of rows) {
  const name = r['Company name'];
  const fix = Object.entries(CORRECTIONS).find(([n]) => key(n) === key(name))?.[1];
  const set = Object.entries(sets).find(([n]) => key(n) === key(name))?.[1];
  if (fix) {
    for (const [col, val] of Object.entries(fix)) {
      if (col === 'basis' || r[col] === val) continue;
      changes.push({ name, col, from: r[col], to: val, basis: fix.basis });
      r[col] = val;
    }
  }
  if (set && r['City'] !== set) {
    changes.push({ name, col: 'City', from: r['City'], to: set, basis: 'set on the command line' });
    r['City'] = set;
  }
}
const unknownSets = Object.keys(sets).filter(n => !rows.some(r => key(r['Company name']) === key(n)));

const out = FILE.replace(/\.csv$/i, '') + ' (corrected).csv';
await writeFile(out, writeCsv(rows, header));

console.log(`Read ${rows.length} row(s). Wrote ${out}; the original is untouched.\n`);
if (changes.length) {
  console.log(`${changes.length} change(s):`);
  for (const c of changes) console.log(`  ${c.name}: ${c.col} "${c.from || ''}" -> "${c.to}"  (${c.basis})`);
} else {
  console.log('No changes were needed.');
}
for (const n of unknownSets) console.log(`\n--set ${n}: no row by that name in the export, so nothing was set.`);

const stillHeld = rows.map(r => ({ name: r['Company name'], why: holdReason(r) })).filter(x => x.why);
if (stillHeld.length) {
  console.log(`\n${stillHeld.length} row(s) the seed will still hold:`);
  for (const h of stillHeld) {
    const dup = /molson coors/i.test(h.name) ? '; left held on purpose, Coors Brewers in this export is the same company' : '';
    console.log(`  ${h.name}: ${h.why}${dup || `; settle it with --set "${h.name}=<UK city>" if Andy wants it in`}`);
  }
}
console.log(`\nNext: node --env-file=.env scripts/seed-food-beverage.mjs --file "${out}"`);
