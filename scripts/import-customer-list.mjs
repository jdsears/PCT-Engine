import ExcelJS from 'exceljs';
import { pool } from '../src/db.mjs';
import { requireCampaign } from '../src/campaigns/registry.mjs';
import { cellValue } from '../src/pricing/parseMega.mjs';
import {
  SHEET_PLANS, shapeCustomerRow, groupRows, planImport, updateSets,
} from '../src/research/customerImport.mjs';

// Loads James's segmented customer list into the register. Runs on a machine
// that has the database; the workbook itself never enters the repository.
//
//   node --env-file=.env scripts/import-customer-list.mjs --file "PCT Segmented Customer List.xlsx"
//   node --env-file=.env scripts/import-customer-list.mjs --file "<xlsx>" --tab Pharma_Steriflow_Jordan
//   node --env-file=.env scripts/import-customer-list.mjs --file "<xlsx>" --apply
//
// Dry run by default: it prints every create, update and skip and changes
// nothing. --apply writes, one transaction per company so a fault in one row
// cannot half-write it or roll back the rest. Safe to re-run; a second pass
// finds its own rows and reports no changes.
//
// What it will never do: touch leads or contacts, run scoring, or send
// anything. Scoring happens on the next research run, and only pharma tab
// rows join a campaign at all.

const APPLY = process.argv.includes('--apply');
const argAfter = (flag) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
};
const FILE = argAfter('--file');
const ONLY_TAB = argAfter('--tab');
if (!FILE) {
  console.error('usage: node --env-file=.env scripts/import-customer-list.mjs --file "<xlsx>" [--tab <sheet>] [--apply]');
  process.exit(1);
}
if (ONLY_TAB && !SHEET_PLANS[ONLY_TAB]) {
  console.error(`Unknown tab "${ONLY_TAB}". Known tabs: ${Object.keys(SHEET_PLANS).join(', ')}.`);
  process.exit(1);
}
// A typo'd campaign id in SHEET_PLANS must refuse here, before any read.
for (const plan of Object.values(SHEET_PLANS)) if (plan.campaign) requireCampaign(plan.campaign);

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(FILE);

// Every sheet into header-keyed records. Unknown sheets are reported and left
// alone rather than guessed at.
const shaped = [];
for (const ws of wb.worksheets) {
  if (ONLY_TAB && ws.name !== ONLY_TAB) continue;
  if (!SHEET_PLANS[ws.name]) {
    console.log(`Skipping unknown tab "${ws.name}"; known tabs: ${Object.keys(SHEET_PLANS).join(', ')}.`);
    continue;
  }
  const headers = [];
  ws.getRow(1).eachCell((cell, col) => { headers[col] = String(cellValue(cell) ?? '').trim(); });
  let count = 0;
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const rec = {};
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      if (headers[col]) rec[headers[col]] = cellValue(cell);
    });
    const r = shapeCustomerRow(ws.name, rec);
    if (r) { shaped.push(r); count++; }
  });
  console.log(`${ws.name}: ${count} rows`);
}

const { rows, internal } = groupRows(shaped);
console.log(`\n${shaped.length} rows, ${rows.length} companies after branch folding, ${internal.length} internal records set aside.`);
for (const r of internal) console.log(`  internal, not imported: ${r.name}`);
for (const r of rows) if (r.members) console.log(`  folded ${r.members.length} branch rows into ${r.name}: ${r.members.join(', ')}`);

// Rows of different identities sharing one domain are worth a human's glance:
// usually a parent and subsidiary, occasionally a CRM data error.
const domCount = new Map();
for (const r of rows) if (r.domain) domCount.set(r.domain, (domCount.get(r.domain) || 0) + 1);
for (const [d, n] of domCount) if (n > 1) {
  console.log(`  note, ${n} companies share the domain ${d}: ${rows.filter(r => r.domain === d).map(r => r.name).join(', ')}`);
}

const { rows: register } = await pool.query(
  `SELECT id, name, domain, region, postcode, customer_status, named_account FROM companies`);
const aliases = Object.fromEntries(
  (await pool.query(`SELECT alias, canonical FROM matcher_aliases`)).rows.map(r => [r.alias, r.canonical]));

const plan = planImport(rows, register, { aliases });

const creates = plan.filter(p => p.action === 'create');
const updates = plan.filter(p => p.action === 'update');
const skips = plan.filter(p => p.action === 'skip');

console.log(`\nPlan: ${creates.length} create, ${updates.length} update, ${skips.length} skip.\n`);
const tag = (r) => [r.customerStatus || 'no grade', r.region || 'no region', r.domain || 'no domain',
  r.campaign ? `${r.campaign}${r.namedAccount ? ', named' : ''}` : null].filter(Boolean).join(', ');
for (const p of creates) {
  console.log(`  create  ${p.row.name}  [${tag(p.row)}]${p.folded.length ? ` (also folded: ${p.folded.join(', ')})` : ''}`);
}
for (const p of updates) {
  const sets = updateSets(p.existing, p.row);
  const parts = Object.entries(sets).map(([k, v]) => `${k}=${v}`);
  if (p.row.campaign) parts.push(`+${p.row.campaign} membership`);
  console.log(`  update  #${p.companyId} ${p.existing.name} (by ${p.matchedBy})  ${parts.length ? parts.join(', ') : 'crm payload only'}`);
}
for (const p of skips) {
  console.log(`  skip    ${p.row.name}  ${p.reason} against: ${(p.candidates || []).map(c => `#${c.id} ${c.name}`).join(', ')}`);
}

if (!APPLY) {
  console.log('\nDry run. Nothing written. Re-run with --apply to write.');
  await pool.end();
  process.exit(0);
}

let created = 0, updated = 0, failed = 0;
for (const p of plan) {
  if (p.action === 'skip') continue;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let companyId = p.companyId;
    if (p.action === 'create') {
      const { rows: ins } = await client.query(
        `INSERT INTO companies (name, domain, region, postcode, customer_status, crm, named_account, source)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'crm_import') RETURNING id`,
        [p.row.name, p.row.domain, p.row.region, p.row.postcode, p.row.customerStatus,
         JSON.stringify(p.row.crm), p.row.namedAccount]);
      companyId = ins[0].id;
      created++;
    } else {
      const sets = updateSets(p.existing, p.row);
      const cols = Object.keys(sets);
      const assign = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      await client.query(
        `UPDATE companies SET crm = $${cols.length + 2}::jsonb, updated_at = now()${assign ? ', ' + assign : ''}
         WHERE id = $1`,
        [companyId, ...cols.map(c => sets[c]), JSON.stringify(p.row.crm)]);
      updated++;
    }
    if (p.row.campaign) {
      await client.query(
        `INSERT INTO company_campaigns (company_id, campaign) VALUES ($1, $2)
         ON CONFLICT (company_id, campaign) DO NOTHING`, [companyId, p.row.campaign]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    failed++;
    console.log(`  failed on ${p.row.name}: ${String(e.message).slice(0, 140)}`);
  } finally {
    client.release();
  }
}
console.log(`\nApplied: ${created} created, ${updated} updated, ${skips.length} skipped, ${failed} failed.`);
console.log('Scoring is untouched; the next research run scores any new campaign members.');
await pool.end();
