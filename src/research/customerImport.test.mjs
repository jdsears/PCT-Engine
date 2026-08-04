// The customer list import, proven offline on synthetic rows. The real
// workbook is CRM data and never enters the repository, so every name here is
// invented; the shapes are the ones the live export showed: branch rows in
// brackets, internal web-shop records under PCT's own domain, a domain shared
// by a parent and subsidiary, and grades A to C plus prospects.
import {
  SHEET_PLANS, INTERNAL_DOMAIN, salesAreaToRegion, customerStatusFrom, cleanDomain,
  identityKey, shapeCustomerRow, groupRows, planImport, updateSets,
} from './customerImport.mjs';
import { cellValue } from '../pricing/parseMega.mjs';
import { requireCampaign } from '../campaigns/registry.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = rel => readFileSync(join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  pass  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); fail++; }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

console.log('Sales areas, grades and domains:');

await check('sales areas map to register regions, junk stays null', async () => {
  assert(salesAreaToRegion('4 - South East') === 'RA-4', 'labelled area');
  assert(salesAreaToRegion('1 - Scotland') === 'RA-1', 'area one');
  assert(salesAreaToRegion('RA-3') === 'RA-3', 'already register form');
  assert(salesAreaToRegion('5') === 'RA-5', 'bare digit');
  assert(salesAreaToRegion('10 - Nowhere') === null, 'two digits are not an area');
  assert(salesAreaToRegion('North') === null && salesAreaToRegion('') === null && salesAreaToRegion(null) === null, 'junk is null');
});

await check('CRM grades map to the register vocabulary, anything else is null', async () => {
  assert(customerStatusFrom('A Customer') === 'a' && customerStatusFrom('B Customer') === 'b' && customerStatusFrom('C Customer') === 'c', 'grades');
  assert(customerStatusFrom('b customer') === 'b', 'case insensitive');
  assert(customerStatusFrom('Prospect') === 'prospect', 'prospect');
  assert(customerStatusFrom('VIP') === null && customerStatusFrom('') === null, 'unknown grades stay null, never guessed');
});

await check('domains come out as bare lowercase hosts or null', async () => {
  assert(cleanDomain('www.Example.com') === 'example.com', 'www and case stripped');
  assert(cleanDomain('https://example.co.uk/path?q=1') === 'example.co.uk', 'protocol and path stripped');
  assert(cleanDomain('example.com.') === 'example.com', 'trailing dot stripped');
  assert(cleanDomain('nodot') === null && cleanDomain('') === null && cleanDomain(null) === null, 'not a domain is null');
});

await check('cellValue realises hyperlink cells to their display text', async () => {
  assert(cellValue({ value: { text: 'example.com', hyperlink: 'https://example.com' } }) === 'example.com', 'hyperlink text');
  assert(cellValue({ value: { hyperlink: 'https://example.com' } }) === 'https://example.com', 'bare hyperlink falls back to the target');
  assert(cellValue({ value: { richText: [{ text: 'Exam' }, { text: 'ple' }] } }) === 'Example', 'rich text joins');
  const d = new Date('2026-04-01T00:00:00Z');
  assert(cellValue({ value: d }) === d, 'dates pass through');
});

console.log('\nRow shaping:');

const rec = (over = {}) => ({
  'Company name': 'Example Bioprocess', 'Postal Code': 'AB1 2CD', 'Customer Type': 'Prospect',
  'Sales Area': '4 - South East', 'Company Domain Name': 'examplebioprocess.com',
  'Suggested Segment': 'Pharmaceutical (Steriflow + Jordan)', 'Segmentation Rationale': 'Matched by sector',
  'City': 'Testtown', 'Country/Region': 'United Kingdom',
  'Last Engagement Date': new Date('2026-04-14T12:14:00Z'), 'Last Activity Date': new Date('2026-04-15T13:27:00Z'),
  ...over,
});

await check('a pharma tab row joins the pharma campaign as a named account', async () => {
  const r = shapeCustomerRow('Pharma_Steriflow_Jordan', rec());
  assert(r.campaign === 'pharma_steriflow' && r.namedAccount === true, 'campaign and named');
  assert(r.name === 'Example Bioprocess' && r.region === 'RA-4' && r.customerStatus === 'prospect', 'fields shaped');
  assert(r.crm.lastEngagementAt === '2026-04-14T12:14:00.000Z', 'dates become ISO strings');
  assert(r.crm.sheet === 'Pharma_Steriflow_Jordan' && r.crm.segment.includes('Steriflow'), 'provenance carried');
});

await check('the data centre tab loads register truth without campaign membership', async () => {
  const r = shapeCustomerRow('Datacentres_EPC_Marwin', rec({ 'Customer Type': 'B Customer' }));
  assert(r.campaign === null && r.namedAccount === false, 'trade customers are not hunting-list accounts');
  assert(r.customerStatus === 'b', 'grade still carried');
});

await check('unknown sheets and nameless rows shape to null', async () => {
  assert(shapeCustomerRow('Mystery_Tab', rec()) === null, 'unknown tab refused');
  assert(shapeCustomerRow('Unassigned', rec({ 'Company name': '  ' })) === null, 'no name, no row');
});

await check('the pharma tab campaign id resolves through the registry', async () => {
  for (const plan of Object.values(SHEET_PLANS)) if (plan.campaign) requireCampaign(plan.campaign);
  assert(SHEET_PLANS.Pharma_Steriflow_Jordan.campaign === 'pharma_steriflow', 'pharma tab');
  assert(Object.values(SHEET_PLANS).filter(p => p.campaign).length === 1, 'only the pharma tab joins a campaign');
});

console.log('\nBranch folding and internal records:');

const shaped = (name, over = {}) => shapeCustomerRow('Unassigned', rec({ 'Company name': name, ...over }));

await check('branch rows fold to one company under the shared name', async () => {
  const { rows } = groupRows([
    shaped('Example Hydraulics (Aberdeen)', { 'Sales Area': '1 - Scotland', 'Customer Type': 'C Customer' }),
    shaped('Example Hydraulics (Cardiff)', { 'Sales Area': '3 - South West', 'Customer Type': 'B Customer' }),
    shaped('Example Hydraulics (Head Office)', { 'Sales Area': '4 - South East', 'Customer Type': 'C Customer' }),
  ]);
  assert(rows.length === 1, 'one identity');
  assert(rows[0].name === 'Example Hydraulics', 'bracket qualifier dropped from the group name');
  assert(rows[0].customerStatus === 'b', 'the strongest grade wins');
  assert(rows[0].region === null, 'disagreeing branch regions leave region null, no wrong rep');
  assert(rows[0].crm.branches.length === 3, 'every branch recorded in provenance');
});

await check('an identical duplicate folds and agreement keeps the region', async () => {
  const { rows } = groupRows([
    shaped('Example Digital', { 'Customer Type': 'B Customer' }),
    shaped('Example Digital', { 'Customer Type': 'C Customer' }),
  ]);
  assert(rows.length === 1 && rows[0].customerStatus === 'b', 'one row, best grade');
  assert(rows[0].region === 'RA-4', 'agreeing regions survive the fold');
});

await check('distinct identities sharing words stay separate', async () => {
  const { rows } = groupRows([
    shaped('Example Matthey Plc'),
    shaped('Example Matthey Hydrogen Technologies'),
  ]);
  assert(rows.length === 2, 'a subsidiary is not its parent');
});

await check('internal web-shop records are set aside, never imported', async () => {
  const { rows, internal } = groupRows([
    shaped('Web Shop East', { 'Company Domain Name': INTERNAL_DOMAIN }),
    shaped('Example Bioprocess'),
  ]);
  assert(rows.length === 1 && rows[0].name === 'Example Bioprocess', 'only the real company remains');
  assert(internal.length === 1 && internal[0].name === 'Web Shop East', 'the internal record is reported, not silently dropped');
});

console.log('\nThe merge plan:');

const REGISTER = [
  { id: 1, name: 'EXAMPLE BIOPROCESS LIMITED', domain: 'examplebioprocess.com', region: 'RA-4', postcode: null, customer_status: null, named_account: true },
  { id: 2, name: 'Sample Controls', domain: null, region: null, postcode: null, customer_status: null, named_account: false },
  { id: 3, name: 'Twin Valves North', domain: 'twinvalves.example', region: null, postcode: null, customer_status: null, named_account: false },
  { id: 4, name: 'Twin Valves South', domain: 'twinvalves.example', region: null, postcode: null, customer_status: null, named_account: false },
];

await check('a domain held by exactly one register row matches on domain', async () => {
  const plan = planImport([shaped('Renamed Bioprocess Co', { 'Company Domain Name': 'examplebioprocess.com' })], REGISTER);
  assert(plan.length === 1 && plan[0].action === 'update' && plan[0].companyId === 1 && plan[0].matchedBy === 'domain', 'domain beats the printed name');
});

await check('a domain the register holds twice proves nothing and falls to names', async () => {
  const plan = planImport([shaped('Unrelated Pumps', { 'Company Domain Name': 'twinvalves.example' })], REGISTER);
  assert(plan[0].action === 'create', 'a shared domain never merges a stranger into either holder');
});

await check('names match through the party matcher, suffixes and case ignored', async () => {
  const plan = planImport([shaped('Example Bioprocess', { 'Company Domain Name': '' })], REGISTER);
  assert(plan[0].action === 'update' && plan[0].companyId === 1 && plan[0].matchedBy === 'name', 'matcher merge');
});

await check('an ambiguous name is skipped for a human, never guessed', async () => {
  const plan = planImport([shaped('Twin Valves', { 'Company Domain Name': '' })], REGISTER);
  assert(plan[0].action === 'skip' && plan[0].reason === 'ambiguous', 'skip recorded');
  assert(plan[0].candidates.length === 2, 'both candidates named for the report');
});

await check('aliases learned by the queue are honoured', async () => {
  const plan = planImport([shaped('SC Brand', { 'Company Domain Name': '' })], REGISTER,
    { aliases: { 'sc brand': 'Sample Controls' } });
  assert(plan[0].action === 'update' && plan[0].companyId === 2, 'alias resolves to the account');
});

await check('a later row naming a pending creation folds into it, no twin', async () => {
  const plan = planImport([
    shapeCustomerRow('Unassigned', rec({ 'Company name': 'Fresh Discovery', 'Company Domain Name': 'freshdiscovery.example', 'Customer Type': 'C Customer' })),
    shapeCustomerRow('Pharma_Steriflow_Jordan', rec({ 'Company name': 'Fresh Discovery Ltd', 'Company Domain Name': '', 'Customer Type': 'B Customer' })),
  ], REGISTER);
  const creates = plan.filter(p => p.action === 'create');
  assert(creates.length === 1, 'one creation for one identity');
  assert(creates[0].row.customerStatus === 'b', 'the stronger grade wins the fold');
  assert(creates[0].row.campaign === 'pharma_steriflow' && creates[0].row.namedAccount === true, 'campaign membership survives the fold');
  assert(creates[0].folded.length === 1, 'the folded printed name is reported');
});

console.log('\nUpdate rules:');

await check('customer status refreshes, gaps fill, nothing set is overwritten', async () => {
  const existing = { id: 9, name: 'Example Bioprocess', domain: 'examplebioprocess.com', region: 'RA-2', postcode: 'ZZ9 9ZZ', customer_status: 'c', named_account: false };
  const row = shaped('Example Bioprocess', { 'Customer Type': 'A Customer', 'Sales Area': '4 - South East', 'Postal Code': 'AB1 2CD' });
  const sets = updateSets(existing, row);
  assert(sets.customer_status === 'a', 'the CRM grade is its own truth and refreshes');
  assert(!('domain' in sets) && !('region' in sets) && !('postcode' in sets), 'held fields are never overwritten');
});

await check('a blank never overwrites and named_account is never unset', async () => {
  const existing = { id: 9, name: 'Example Bioprocess', domain: null, region: null, postcode: null, customer_status: 'b', named_account: true };
  const row = { ...shaped('Example Bioprocess', { 'Company Domain Name': '', 'Sales Area': 'unknown', 'Postal Code': '' }), customerStatus: null, namedAccount: false };
  const sets = updateSets(existing, row);
  assert(Object.keys(sets).length === 0, 'no grade, no area, no domain means no change');
});

await check('named_account can be granted by the pharma tab, once', async () => {
  const existing = { id: 9, name: 'X', domain: null, region: null, postcode: null, customer_status: null, named_account: false };
  const sets = updateSets(existing, { ...shaped('X'), namedAccount: true });
  assert(sets.named_account === true, 'granted');
  const again = updateSets({ ...existing, named_account: true }, { ...shaped('X'), namedAccount: true });
  assert(!('named_account' in again), 'already held, not rewritten');
});

console.log('\nThe script and the migration:');

await check('the import script is dry by default and confined to its tables', async () => {
  const src = read('scripts/import-customer-list.mjs');
  assert(/Dry run\. Nothing written\./.test(src), 'dry run is the default');
  assert(/--apply/.test(src) && /APPLY/.test(src), 'writing requires the flag');
  assert(!/INSERT INTO leads|INSERT INTO contacts|UPDATE leads|UPDATE contacts/i.test(src), 'the import never touches leads or contacts');
  assert(/ON CONFLICT \(company_id, campaign\) DO NOTHING/.test(src), 'membership upsert keeps existing scores');
  assert(/BEGIN/.test(src) && /ROLLBACK/.test(src), 'per-company transactions');
  assert(!/icp_score|scoreCompany/.test(src), 'the import never scores');
  assert(/Republic of Ireland/.test(src) && /Northern Ireland/.test(src),
    'the Ireland prospecting policy is stated in the plan a human reviews');
});

await check('migration 026 adds columns idempotently and carries no data', async () => {
  const sql = read('src/migrations/026_customer_list.sql');
  assert(/ADD COLUMN IF NOT EXISTS customer_status/.test(sql), 'status column');
  assert(/ADD COLUMN IF NOT EXISTS crm/.test(sql), 'provenance column');
  assert(!/INSERT INTO/i.test(sql), 'no customer data in the repository');
});

await check('grounding tolerates the column not existing yet', async () => {
  const src = read('src/outbound/grounding.mjs');
  assert(/hasColumn\('companies', 'customer_status'\)/.test(src), 'asks the schema before selecting');
});

console.log(`\n=== Customer import gate: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
