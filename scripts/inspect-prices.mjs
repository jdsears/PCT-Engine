import { graphJson, graph } from '../src/msgraph.mjs';
import ExcelJS from 'exceljs';

// Phase 0 of the price lookup: read-only inspection of the pricing spreadsheet
// in SharePoint, so the parser is designed from the sheet's real structure and
// never from assumptions. It writes nothing, to SharePoint or the database.
//
//   node --env-file=.env scripts/inspect-prices.mjs
//       walk the document library and list every spreadsheet file found.
//
//   node --env-file=.env scripts/inspect-prices.mjs --file "price"
//       download the matching workbook(s) and report, per sheet: the header
//       row, the first data rows, the row count, and which columns look like
//       the part/model key, the sales price, currency and dates.
//
//   --sheet "<name>"  limit the dive to one sheet;  --rows N  sample rows (default 5)
//
// Cost or purchase pricing is out of scope by standing decision. Any column
// whose header looks like cost, purchase or margin is flagged and its values
// are masked in the preview, so cost data never lands in this session.

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const FILE = get('--file');
const SHEET = get('--sheet');
const ROWS = /^\d+$/.test(get('--rows') || '') ? Number(get('--rows')) : 5;

const SPREADSHEET_EXT = /\.(xlsx|xlsm|xlsb|xls|csv)$/i;
const LOADABLE_EXT = /\.(xlsx|xlsm)$/i; // what the exceljs dive can open; others are listed and flagged

const KEY_HINTS = /\b(part|model|code|item|sku|ref|product\s*(no|number|code)?|catalogue)\b/i;
const PRICE_HINTS = /\b(price|list|sell|selling|retail|rrp|net\b|amount|each|unit|gbp|eur|usd)\b|£|€|\$/i;
const CURRENCY_HINTS = /\b(currency|curr|ccy)\b/i;
const DATE_HINTS = /\b(date|valid|effective|from|until|expiry|review)\b/i;
const COST_HINTS = /\b(cost|purchase|buy|nett?\s*buy|margin|markup|discount|disc\.?%?|supplier\s*price|transfer)\b/i;

// Every document library on the site, not just the default one the corpus
// ingestion reads: an upload can land in another library entirely.
async function resolveDrives() {
  const site = await graphJson(`/sites/${process.env.SP_HOSTNAME}:${process.env.SP_SITE_PATH}`);
  const drives = await graphJson(`/sites/${site.id}/drives`);
  let subsites = [];
  try {
    const subs = await graphJson(`/sites/${site.id}/sites`);
    subsites = (subs.value || []).map(s => s.displayName || s.name);
  } catch { /* subsite listing is best-effort */ }
  return { siteName: site.displayName || site.name, drives: drives.value || [], subsites };
}

async function* pageItems(url) {
  while (url) {
    const page = await graphJson(url);
    for (const it of page.value) yield it;
    url = page['@odata.nextLink'] ? page['@odata.nextLink'].replace('https://graph.microsoft.com/v1.0', '') : null;
  }
}

async function* walkItems(driveId, itemId, prefix) {
  for await (const it of pageItems(`/drives/${driveId}/items/${itemId}/children?$top=200`)) {
    const rel = prefix ? `${prefix}/${it.name}` : it.name;
    if (it.folder) yield* walkItems(driveId, it.id, rel);
    else yield { item: it, rel };
  }
}

// One plain string from whatever exceljs holds in a cell: formula results, rich
// text, dates and hyperlinks all collapse to their display value.
function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.result != null) return cellText(v.result);
    if (v.richText) return v.richText.map(t => t.text).join('');
    if (v.text != null) return String(v.text);
    if (v.error) return String(v.error);
    return JSON.stringify(v);
  }
  return String(v);
}
const trunc = (s, n = 24) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function classifyHeader(h) {
  const kinds = [];
  if (COST_HINTS.test(h)) kinds.push('COST-LIKE, out of scope, values masked');
  if (KEY_HINTS.test(h)) kinds.push('key candidate');
  if (PRICE_HINTS.test(h) && !COST_HINTS.test(h)) kinds.push('sales price candidate');
  if (CURRENCY_HINTS.test(h)) kinds.push('currency');
  if (DATE_HINTS.test(h)) kinds.push('date/validity');
  return kinds;
}

const { siteName, drives, subsites } = await resolveDrives();
console.log(`Site: ${siteName}  (${drives.length} document librar${drives.length === 1 ? 'y' : 'ies'})`);
if (subsites.length) console.log(`Subsites (not searched by this script): ${subsites.join(', ')}`);

// Pass 1: walk every library, list every spreadsheet, and tally what else is
// there so an empty result still says what the walk actually saw.
const sheetsFound = [];
for (const d of drives) {
  const extTally = new Map();
  let fileCount = 0;
  for await (const top of pageItems(`/drives/${d.id}/root/children?$top=200`)) {
    const entries = top.folder
      ? walkItems(d.id, top.id, top.name)
      : (async function* () { yield { item: top, rel: top.name }; })();
    for await (const { item, rel } of entries) {
      fileCount++;
      const ext = (item.name.match(/\.[A-Za-z0-9]+$/) || ['(none)'])[0].toLowerCase();
      extTally.set(ext, (extTally.get(ext) || 0) + 1);
      if (SPREADSHEET_EXT.test(item.name)) {
        sheetsFound.push({ id: item.id, driveId: d.id, library: d.name, rel, size: item.size, modified: item.lastModifiedDateTime, by: item.lastModifiedBy?.user?.displayName || '' });
      }
    }
  }
  const tally = [...extTally.entries()].sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e} ${n}`).join(', ');
  console.log(`\nLibrary "${d.name}": ${fileCount} file(s)${tally ? '  [' + tally + ']' : ''}`);
}

if (!sheetsFound.length) {
  console.log('\nNo spreadsheet files (.xlsx, .xlsm, .xlsb, .xls, .csv) found in any library on this site.');
  console.log('If the pricing file was uploaded to a subsite listed above, or a different site, say which and the script can be pointed at it.');
  process.exit(0);
}

console.log(`\nSpreadsheets found: ${sheetsFound.length}`);
for (const f of sheetsFound) {
  const loadable = LOADABLE_EXT.test(f.rel) ? '' : '  (listed only; save as .xlsx for the dive)';
  console.log(`  - [${f.library}] ${f.rel}  [${Math.round((f.size || 0) / 1024)} KB, modified ${String(f.modified).slice(0, 10)}${f.by ? ' by ' + f.by : ''}]${loadable}`);
}

if (!FILE) {
  console.log('\nRe-run with --file "<name substring>" to inspect sheets, headers and sample rows. Read-only, nothing is written.');
  process.exit(0);
}

const matches = sheetsFound.filter(f => f.rel.toLowerCase().includes(FILE.toLowerCase())).slice(0, 2);
if (!matches.length) { console.log(`\nNo spreadsheet matches "${FILE}".`); process.exit(1); }

for (const f of matches) {
  console.log(`\n===== [${f.library}] ${f.rel} =====`);
  if (!LOADABLE_EXT.test(f.rel)) {
    console.log('  this format cannot be opened by the dive (.xlsb, .xls and .csv are listed only); save it as .xlsx in SharePoint and re-run');
    continue;
  }
  const res = await graph(`/drives/${f.driveId}/items/${f.id}/content`);
  if (!res.ok) { console.log(`  download failed: ${res.status}`); continue; }
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`  downloaded ${Math.round(buf.length / 1024)} KB`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);

  for (const ws of wb.worksheets) {
    if (SHEET && ws.name.toLowerCase() !== SHEET.toLowerCase()) continue;
    console.log(`\n--- sheet "${ws.name}"  (${ws.actualRowCount} rows x ${ws.actualColumnCount} columns${ws.state !== 'visible' ? ', ' + ws.state : ''}) ---`);

    // The header is the first row in the opening stretch with at least two
    // filled cells, so a merged-cell title row above the table is skipped.
    let headerRowNum = null;
    for (let r = 1; r <= Math.min(10, ws.actualRowCount); r++) {
      const vals = (ws.getRow(r).values || []).slice(1).map(cellText).filter(s => s.trim());
      if (vals.length >= 2) { headerRowNum = r; break; }
    }
    if (!headerRowNum) { console.log('  no header row found in the first 10 rows'); continue; }

    const headerRow = ws.getRow(headerRowNum);
    const headers = [];
    headerRow.eachCell({ includeEmpty: false }, (cell, col) => headers.push({ col, text: cellText(cell.value).trim() }));
    console.log(`  header row ${headerRowNum}:`);
    const costCols = new Set();
    for (const h of headers) {
      const kinds = classifyHeader(h.text);
      if (kinds.some(k => k.startsWith('COST'))) costCols.add(h.col);
      console.log(`    col ${String(h.col).padStart(2)}: ${h.text}${kinds.length ? '   <-- ' + kinds.join('; ') : ''}`);
    }

    console.log(`  first ${ROWS} data rows${costCols.size ? ' (cost-like columns masked)' : ''}:`);
    let shown = 0;
    for (let r = headerRowNum + 1; r <= ws.actualRowCount && shown < ROWS; r++) {
      const row = ws.getRow(r);
      const cells = headers.map(h => {
        if (costCols.has(h.col)) return '[masked]';
        return trunc(cellText(row.getCell(h.col).value).trim());
      });
      if (cells.every(c => !c)) continue; // skip blank spacer rows in the preview
      console.log(`    row ${r}: ${cells.join(' | ')}`);
      shown++;
    }

    // A quick shape check on the key candidates: how code-like their values are.
    for (const h of headers.filter(x => KEY_HINTS.test(x.text))) {
      let sampled = 0, codeLike = 0;
      for (let r = headerRowNum + 1; r <= ws.actualRowCount && sampled < 50; r++) {
        const v = cellText(ws.getRow(r).getCell(h.col).value).trim();
        if (!v) continue;
        sampled++;
        if (/\d/.test(v) && /^[A-Za-z0-9\-\/. ]+$/.test(v)) codeLike++;
      }
      console.log(`  key check, col ${h.col} ("${h.text}"): ${codeLike}/${sampled} sampled values look like part or model codes`);
    }
  }
}

console.log('\nRead-only inspection complete. Nothing was written. Paste this output back for the parser design.');
