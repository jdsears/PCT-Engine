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

const SPREADSHEET_EXT = /\.(xlsx|xlsm|xls)$/i;

const KEY_HINTS = /\b(part|model|code|item|sku|ref|product\s*(no|number|code)?|catalogue)\b/i;
const PRICE_HINTS = /\b(price|list|sell|selling|retail|rrp|net\b|amount|each|unit|gbp|eur|usd)\b|£|€|\$/i;
const CURRENCY_HINTS = /\b(currency|curr|ccy)\b/i;
const DATE_HINTS = /\b(date|valid|effective|from|until|expiry|review)\b/i;
const COST_HINTS = /\b(cost|purchase|buy|nett?\s*buy|margin|markup|discount|disc\.?%?|supplier\s*price|transfer)\b/i;

async function resolveDrive() {
  const site = await graphJson(`/sites/${process.env.SP_HOSTNAME}:${process.env.SP_SITE_PATH}`);
  const drive = await graphJson(`/sites/${site.id}/drive`);
  return { siteName: site.displayName || site.name, driveId: drive.id };
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

const { siteName, driveId } = await resolveDrive();
console.log(`Site: ${siteName}\n`);

// Pass 1: find every spreadsheet in the library.
const sheetsFound = [];
for await (const top of pageItems(`/drives/${driveId}/root/children?$top=200`)) {
  const entries = top.folder
    ? walkItems(driveId, top.id, top.name)
    : (async function* () { yield { item: top, rel: top.name }; })();
  for await (const { item, rel } of entries) {
    if (SPREADSHEET_EXT.test(item.name)) {
      sheetsFound.push({ id: item.id, rel, size: item.size, modified: item.lastModifiedDateTime, by: item.lastModifiedBy?.user?.displayName || '' });
    }
  }
}

if (!sheetsFound.length) {
  console.log('No spreadsheet files (.xlsx, .xlsm, .xls) found in the document library.');
  process.exit(0);
}

console.log(`Spreadsheets in the library: ${sheetsFound.length}`);
for (const f of sheetsFound) {
  console.log(`  - ${f.rel}  [${Math.round((f.size || 0) / 1024)} KB, modified ${String(f.modified).slice(0, 10)}${f.by ? ' by ' + f.by : ''}]`);
}

if (!FILE) {
  console.log('\nRe-run with --file "<name substring>" to inspect sheets, headers and sample rows. Read-only, nothing is written.');
  process.exit(0);
}

const matches = sheetsFound.filter(f => f.rel.toLowerCase().includes(FILE.toLowerCase())).slice(0, 2);
if (!matches.length) { console.log(`\nNo spreadsheet matches "${FILE}".`); process.exit(1); }

for (const f of matches) {
  console.log(`\n===== ${f.rel} =====`);
  const res = await graph(`/drives/${driveId}/items/${f.id}/content`);
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
