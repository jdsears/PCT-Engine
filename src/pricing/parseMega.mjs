// The Mega Price List parser, Phase 1: only the tabs that hold explicit
// customer sell prices per part (Status, EGE, King). The calculator tabs hold
// formulas, not lists, and are out of scope here; the hidden Master Formulas
// tab is PCT's commercial policy and is never read at all. Cost, purchase and
// supplier list columns are named in each spec precisely so the parser can
// prove it skipped them: they are excluded and reported, never ingested.

// A cell's realised value: formula cells yield their computed result, rich
// text collapses to its text.
export function cellValue(cell) {
  const v = cell?.value;
  if (v == null) return null;
  if (typeof v === 'object') {
    if ('result' in v) return v.result ?? null;
    if (v.richText) return v.richText.map(t => t.text).join('');
    if (v instanceof Date) return v;
  }
  return v;
}

const text = x => String(x ?? '').trim();
export function priceNumber(x) {
  const n = typeof x === 'number' ? x : parseFloat(text(x).replace(/[£$€,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

// The lookup key: upper case, spaces stripped. Slashes and dashes are part of
// real part numbers (SEM203/P) and are kept.
export const normKey = s => text(s).toUpperCase().replace(/\s+/g, '');

// One spec per ingestable tab: where the part lives, where each currency's
// sell price lives, and which columns are deliberately skipped, by name, so
// the report states exactly what was excluded.
export const TAB_SPECS = [
  {
    tab: 'Status', productLine: 'status', startRow: 2,
    part: 1, description: 2,
    sells: { GBP: 4, USD: 8, EUR: 9 },
    skipColumns: ['Cost Price GBP (col E)', 'List Price GBP (col G)'],
  },
  {
    tab: 'EGE', productLine: 'ege', startRow: 2,
    part: 2, description: null,
    // The EGE headers call columns H and I "EUR List" and "USD List", but
    // their formulas divide the purchase price by one minus margin: they are
    // computed selling prices, mislabelled. Ingested as sells on that
    // evidence, checked with James on the first verification pass.
    sells: { GBP: 3, EUR: 8, USD: 9 },
    skipColumns: ['PCT Purchase Price (col E)', 'List Pricing (col G)'],
  },
  {
    tab: 'King', productLine: 'king', startRow: 2,
    part: 1, description: null,
    sells: { GBP: 5, EUR: 7, USD: 8 },
    skipColumns: ['List Price (col C)'],
  },
];

// Walk one tab to price rows. A row with no part is skipped; a row with a
// part but no sell price in any currency (a section heading, a blank) is
// counted but never invented around.
export function extractTab(ws, spec) {
  const rows = [];
  let parts = 0, skippedNoPrice = 0;
  for (let r = spec.startRow; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const part = text(cellValue(row.getCell(spec.part)));
    if (!part) continue;
    const description = spec.description ? text(cellValue(row.getCell(spec.description))) || null : null;
    let any = false;
    for (const [currency, col] of Object.entries(spec.sells)) {
      const price = priceNumber(cellValue(row.getCell(col)));
      if (price == null) continue;
      any = true;
      rows.push({
        productLine: spec.productLine, partNumber: part, normKey: normKey(part),
        description, currency, sellPrice: price, sourceTab: spec.tab,
      });
    }
    if (any) parts++; else skippedNoPrice++;
  }
  return { rows, parts, skippedNoPrice };
}

export function parseMegaWorkbook(wb) {
  const all = [];
  const report = { tabs: {}, skippedColumns: {}, missingTabs: [] };
  for (const spec of TAB_SPECS) {
    const ws = wb.getWorksheet(spec.tab);
    if (!ws) { report.missingTabs.push(spec.tab); continue; }
    const { rows, parts, skippedNoPrice } = extractTab(ws, spec);
    all.push(...rows);
    report.tabs[spec.productLine] = { rows: rows.length, parts, skippedNoPrice };
    report.skippedColumns[spec.productLine] = spec.skipColumns;
  }
  return { rows: all, report };
}
