// scripts/export-curation-pack.mjs
// Builds the named-account curation pack for Andy as an Excel workbook,
// straight from the live database so nothing is copied by hand.
import ExcelJS from 'exceljs';
import { pool } from '../src/db.mjs';

const today = new Date().toISOString().slice(0, 10);
const OUT = `CURATION_PACK_${today}.xlsx`;

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F386B' } };
const HEADER_FONT = { color: { argb: 'FFFFFFFF' }, bold: true };
const BLANK_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3B0' } };

function styleHeader(sheet) {
  const row = sheet.getRow(1);
  row.eachCell((c) => { c.fill = HEADER_FILL; c.font = HEADER_FONT; });
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

const wb = new ExcelJS.Workbook();
wb.creator = 'MoonBoots Consultancy';

// Sheet 1: Accounts
const accounts = wb.addWorksheet('Accounts');
accounts.columns = [
  { header: 'Decision', key: 'decision', width: 12 },
  { header: 'Company', key: 'name', width: 38 },
  { header: 'Type', key: 'type', width: 16 },
  { header: 'CH number', key: 'ch', width: 12 },
  { header: 'Region', key: 'region', width: 10 },
  { header: 'Domain (fill blanks if known)', key: 'domain', width: 28 },
  { header: 'ICP score', key: 'score', width: 10 },
  { header: 'Why included', key: 'why', width: 46 },
  { header: 'Your notes', key: 'notes', width: 40 },
];

const { rows: companies } = await pool.query(`
  SELECT id, name, company_type, ch_number, region, domain, icp_score, icp_breakdown, source
  FROM companies WHERE named_account ORDER BY company_type, name
`);

for (const c of companies) {
  const isAtlasEdge = /^atlasedge/i.test(c.name || '');
  const why = c.icp_breakdown?.reason
    || c.icp_breakdown?.summary
    || (c.source === 'seed_research' ? 'Seeded from DC market research' : c.source || '');
  const row = accounts.addRow({
    decision: isAtlasEdge ? 'RE-POINT' : 'KEEP',
    name: c.name,
    type: c.company_type || '',
    ch: c.ch_number || 'unmatched',
    region: c.region || '',
    domain: c.domain || '',
    score: c.icp_score == null ? '' : Number(c.icp_score),
    why,
    notes: isAtlasEdge ? 'Looks like the wrong company on the register (consulting ltd, single director), please point us at the right one' : '',
  });
  if (!c.domain) row.getCell('domain').fill = BLANK_FILL;
  if (!c.ch_number) row.getCell('ch').fill = BLANK_FILL;
}

accounts.dataValidations.add(`A2:A${accounts.rowCount}`, {
  type: 'list', allowBlank: false, formulae: ['"KEEP,STRIKE,RE-POINT"'],
  showErrorMessage: true, error: 'Choose KEEP, STRIKE or RE-POINT',
});
styleHeader(accounts);

// Sheet 2: People
const people = wb.addWorksheet('People');
people.columns = [
  { header: 'Decision', key: 'decision', width: 12 },
  { header: 'Company', key: 'company', width: 38 },
  { header: 'Name', key: 'name', width: 30 },
  { header: 'Role (from the register)', key: 'role', width: 24 },
  { header: 'Your notes (right person? who instead?)', key: 'notes', width: 48 },
];

const { rows: contacts } = await pool.query(`
  SELECT ct.full_name, ct.role_title, co.name AS company
  FROM contacts ct JOIN companies co ON co.id = ct.company_id
  WHERE co.named_account AND NOT ct.suppressed
  ORDER BY co.name, ct.full_name
`);
for (const p of contacts) {
  people.addRow({ decision: 'KEEP', company: p.company, name: p.full_name, role: p.role_title || 'Director', notes: '' });
}
people.dataValidations.add(`A2:A${people.rowCount}`, {
  type: 'list', allowBlank: false, formulae: ['"KEEP,STRIKE"'],
  showErrorMessage: true, error: 'Choose KEEP or STRIKE',
});
styleHeader(people);

// Sheet 3: Thresholds
const thresholds = wb.addWorksheet('Thresholds');
thresholds.columns = [
  { header: 'Setting', key: 'setting', width: 40 },
  { header: 'Current draft', key: 'value', width: 28 },
  { header: 'Agree? (YES / change below)', key: 'agree', width: 26 },
  { header: 'Change to', key: 'change', width: 28 },
];
const t = [
  ['Smallest project worth chasing', '10 MW or larger'],
  ['Build stages that trigger interest', 'Planning granted, construction, fit-out'],
  ['Contract value floor for M&E signals', '£250,000'],
  ['Geography', 'UK only'],
  ['Company types in scope', 'DC developers, M&E contractors, end clients'],
];
for (const [setting, value] of t) thresholds.addRow({ setting, value, agree: '', change: '' });
thresholds.dataValidations.add(`C2:C${thresholds.rowCount}`, {
  type: 'list', allowBlank: true, formulae: ['"YES,CHANGE"'],
});
styleHeader(thresholds);

accounts.getCell('A1').note =
  'KEEP = on the list. STRIKE = remove. RE-POINT = right company, wrong register match, tell us in notes. Yellow cells are blanks we could not fill confidently.';

await wb.xlsx.writeFile(OUT);
console.log(`Written ${OUT}`);
console.log(`Accounts: ${companies.length}  People: ${contacts.length}`);
await pool.end();
