// The Richards guide-price transform, read from the mega sheet itself at
// ingest time and never hardcoded: list price in USD, through the two
// compounding discounts to buying price, through the exchange rates and
// margins to the three selling prices, exactly as the Equilibar-Richards
// calculator computes them. The reader validates itself by replaying the
// sheet's own example row and refusing to continue on any mismatch, so a
// restructured sheet fails loudly instead of miscomputing quietly. The raw
// discounts and margins live only inside the ingest process; nothing stores
// or serves them, only the finished guide prices.

const roundup = x => Math.ceil(x - 1e-9);

// Pure: the three guide sells for a USD list price under the given
// parameters. Exported for the offline gate, which proves it against the
// sheet's live example numbers.
export function computeGuide(listUsd, p) {
  const buying = listUsd * (1 - p.d) * (1 - p.e);
  return {
    GBP: roundup((buying / p.usdPerGbp) / (1 - p.margin)),
    EUR: roundup(((buying / p.usdPerGbp) / (1 - p.exportMargin)) * p.eurPerGbp),
    USD: roundup(buying / (1 - p.exportMargin)),
  };
}

// Read the parameters from the workbook and prove them against the sheet's
// own example row before returning. Cell addresses are the contract with the
// sheet; the validation is what makes that contract safe.
export async function readRichardsTransform(workbookPath) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(workbookPath);
  const mf = wb.getWorksheet('Master Formulas');
  if (!mf) throw new Error('the Master Formulas tab is missing from this workbook');
  const val = a => {
    const v = mf.getCell(a).value;
    return v && typeof v === 'object' && 'result' in v ? v.result : v;
  };
  const p = {
    d: Number(val('D25')), e: Number(val('E25')),
    margin: Number(val('H25')), exportMargin: Number(val('J25')),
    usdPerGbp: Number(val('P2')), eurPerGbp: Number(val('P3')),
  };
  for (const [k, v] of Object.entries(p)) {
    if (!Number.isFinite(v) || v <= 0 || v >= 2) throw new Error(`transform parameter ${k} read as ${v}; the sheet layout has changed, stopping`);
  }
  // Replay the sheet's example: quoted A25 must reproduce I25, L25 and M25.
  const example = { quoted: Number(val('A25')), gbp: Number(val('I25')), eur: Number(val('L25')), usd: Number(val('M25')) };
  const check = computeGuide(example.quoted, p);
  for (const c of ['gbp', 'eur', 'usd']) {
    const got = check[c.toUpperCase()];
    if (got !== example[c]) {
      throw new Error(`transform validation failed: recomputed ${c.toUpperCase()} ${got} does not match the sheet's own ${example[c]}; the sheet layout or formulas have changed, stopping`);
    }
  }
  return p;
}
