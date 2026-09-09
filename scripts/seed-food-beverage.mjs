#!/usr/bin/env node
// Seed the food, beverage and cosmetics campaign's named-account list from
// James's curated HubSpot export, 9 September 2026.
//
//   node --env-file=.env scripts/seed-food-beverage.mjs --file "/path/Food_Beverage_and_Cosmetics_List.csv"
//   node --env-file=.env scripts/seed-food-beverage.mjs --file "..." --apply
//
// Dry by default: it prints what it would create, what it would join to the
// campaign, and, more importantly, everything it refuses to decide on its own.
// The export is a CRM extract, so it carries CRM problems, and this script's
// job is to surface them rather than launder them into the register:
//
//   - Republic of Ireland companies are seeded as accounts but NEVER joined to
//     the campaign, because the Republic is out of scope for prospecting and
//     stays a place we serve when approached. Northern Ireland is in scope,
//     and Craigavon and Belfast are read as Northern Ireland, not Ireland,
//     whatever the sales area says.
//   - A row whose city sits outside the UK while the country column says
//     United Kingdom is held for a human, because that is a CRM artefact and
//     the honest answers differ: a UK subsidiary belongs, a US parent does not.
//   - A row with no owner and no city is held: it is a stub, not a company.
//   - The type is guessed from the name and industry and PRINTED, never
//     silently trusted, so Andy can correct the guesses in one pass.
//
// Safe to re-run: accounts upsert by normalised name, memberships upsert.
import { readFile } from 'node:fs/promises';
import { pool } from '../src/db.mjs';
import { normName } from '../src/research/partyActions.mjs';
import { salesAreaToRegion } from '../src/research/customerImport.mjs';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? null : (args[i + 1] || null); };
const APPLY = args.includes('--apply');
const FILE = flag('--file');
const CAMPAIGN = 'food_beverage';

if (!FILE) {
  console.error('Usage: node --env-file=.env scripts/seed-food-beverage.mjs --file "<export.csv>" [--apply]');
  process.exit(1);
}

// A CSV reader good enough for a HubSpot export: quoted fields with commas,
// doubled quotes inside them. No dependency, and the shapes it cannot read it
// reports rather than mangles.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const src = String(text).replace(/\r\n/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = (rows.shift() || []).map(h => h.trim());
  return rows
    .filter(r => r.some(v => String(v).trim()))
    .map(r => Object.fromEntries(header.map((h, i) => [h, String(r[i] ?? '').trim()])));
}

// Northern Ireland reads as in scope however the CRM filed it: the sales area
// column puts Craigavon under Ireland, and the prospecting rule is about the
// Republic, not the island.
const NI_CITIES = ['belfast', 'craigavon', 'lisburn', 'newry', 'derry', 'londonderry',
  'ballymena', 'coleraine', 'armagh', 'omagh', 'enniskillen', 'antrim', 'bangor', 'dungannon'];
// Cities that are plainly not in these islands. A CRM row can say United
// Kingdom and carry a head-office city abroad; that is a question for a human,
// not a silent include or a silent drop.
const FOREIGN_CITIES = ['duesseldorf', 'dusseldorf', 'des plaines', 'kalamazoo', 'grand rapids',
  'miami', 'boulder', 'laverton north'];

export function placeOf(row) {
  const city = String(row['City'] || '').trim().toLowerCase();
  const country = String(row['Country/Region'] || '').trim().toLowerCase();
  if (NI_CITIES.includes(city)) return 'northern_ireland';
  if (country === 'ireland') return 'republic_of_ireland';
  if (city && FOREIGN_CITIES.includes(city)) return 'foreign_city';
  if (country && country !== 'united kingdom') return 'foreign_country';
  return 'uk';
}

// The type guess. Equipment makers and process engineering houses are a
// different target from the plants they build for, and research institutes are
// different again, so each is guessed and printed for correction.
// Matched on whole words, not substrings. The first dry run typed Britvic and
// British Sugar as research bodies because "bri" sat inside "Brit", and
// Pro-Pack Foods as an equipment maker because "pack" sat inside its name. A
// guess that silly costs more trust than the guess saves, so every term here
// is bounded and the loose ones are gone.
const OEM_WORDS = ['systems', 'machinery', 'equipment', 'engineering', 'mech',
  'gea', 'perkins', 'norris', 'fabcon', 'polar', 'silo', 'daleflow'];
const RESEARCH_WORDS = ['institute', 'research', 'bri', 'teagasc', 'science', 'sciences',
  'quadram', 'rothamsted', 'fera', 'biosciences'];
const hasWord = (haystack, word) =>
  new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(haystack);
export function guessType(name, industry) {
  const n = String(name || '').toLowerCase();
  const ind = String(industry || '').toLowerCase();
  if (RESEARCH_WORDS.some(w => hasWord(n, w))) return 'other';
  if (OEM_WORDS.some(w => hasWord(n, w))) return 'oem';
  if (ind.includes('cosmetic')) return 'fb_manufacturer';
  return 'fb_manufacturer';
}

const rows = parseCsv(await readFile(FILE, 'utf8'));
console.log(`Read ${rows.length} row(s) from the export.${APPLY ? '' : ' Dry run: nothing changes without --apply.'}\n`);

const seed = [], held = [], serveOnly = [];
for (const r of rows) {
  const name = String(r['Company name'] || '').trim();
  if (!name) continue;
  const place = placeOf(r);
  const owner = String(r['Company owner'] || '').trim();
  const city = String(r['City'] || '').trim();
  const type = guessType(name, r['Industry']);
  const region = salesAreaToRegion(r['Sales Area']) || null;
  const entry = { name, type, region, city, owner, industry: r['Industry'] || '', place };
  if (place === 'republic_of_ireland') { serveOnly.push(entry); continue; }
  if (place === 'foreign_city' || place === 'foreign_country') {
    held.push({ ...entry, why: `city ${city || 'unknown'} is outside the UK while the export says ${r['Country/Region'] || 'no country'}` });
    continue;
  }
  if (!owner && !city) { held.push({ ...entry, why: 'no owner and no city; a stub row rather than a company' }); continue; }
  seed.push(entry);
}

console.log(`Seeding ${seed.length} account(s) into ${CAMPAIGN}:`);
for (const e of seed) console.log(`  ${e.name}  [${e.type}${e.region ? `, ${e.region}` : ', no region'}]${e.place === 'northern_ireland' ? '  (Northern Ireland, in scope)' : ''}`);

if (serveOnly.length) {
  console.log(`\n${serveOnly.length} Republic of Ireland compan(y/ies) seeded as accounts but NOT joined to the campaign:`);
  for (const e of serveOnly) console.log(`  ${e.name}  (${e.city}); the Republic is out of scope for prospecting and stays a place we serve when approached`);
}
if (held.length) {
  console.log(`\n${held.length} row(s) held for a human, nothing written for them:`);
  for (const e of held) console.log(`  ${e.name}: ${e.why}`);
}

const oem = seed.filter(e => e.type === 'oem').map(e => e.name);
const other = seed.filter(e => e.type === 'other').map(e => e.name);
console.log(`\nType guesses to check: ${oem.length} read as equipment or engineering houses` +
  `${oem.length ? ` (${oem.join(', ')})` : ''}; ${other.length} read as research bodies` +
  `${other.length ? ` (${other.join(', ')})` : ''}. Everything else is a food, drink or cosmetics manufacturer.`);

if (!APPLY) {
  console.log('\nRun again with --apply to write the accounts and campaign memberships.');
  await pool.end();
  process.exit(0);
}

let created = 0, joined = 0;
for (const e of [...seed, ...serveOnly]) {
  const { rows: ex } = await pool.query(
    `SELECT id FROM companies WHERE lower(name) = lower($1) OR name_norm = $2 LIMIT 1`,
    [e.name, normName(e.name)]).catch(async () => pool.query(
      `SELECT id FROM companies WHERE lower(name) = lower($1) LIMIT 1`, [e.name]));
  let id = ex[0]?.id;
  if (!id) {
    const ins = await pool.query(
      `INSERT INTO companies (name, company_type, named_account, region, created_at, updated_at)
       VALUES ($1, $2, true, $3, now(), now()) RETURNING id`, [e.name, e.type, e.region]);
    id = ins.rows[0].id;
    created++;
  } else {
    await pool.query(
      `UPDATE companies SET named_account = true, company_type = COALESCE(company_type, $2),
         region = COALESCE(region, $3), updated_at = now() WHERE id = $1`, [id, e.type, e.region]);
  }
  // The membership is the campaign join, and it is exactly what a Republic of
  // Ireland company does not get.
  if (e.place !== 'republic_of_ireland') {
    const j = await pool.query(
      `INSERT INTO company_campaigns (company_id, campaign) VALUES ($1, $2)
       ON CONFLICT (company_id, campaign) DO NOTHING`, [id, CAMPAIGN]);
    joined += j.rowCount;
  }
}
console.log(`\nApplied: ${created} account(s) created, ${joined} joined to ${CAMPAIGN}.`);
console.log('The campaign status is manual, so nothing sweeps until its first run is reviewed by hand.');
await pool.end();
