// The Marwin list-price page parser, CV3000 and CV4700 sections. Input is
// pdftotext -layout text of the relevant pages; output is base parts with
// their USD list prices, ready for the Richards transform. Deterministic and
// deliberately narrow: base model tables only, the characterised-plate adder
// applied to produce the CV-prefixed variants the part builder emits, and
// nothing else. Actuator, solenoid and repair-kit adders are quoted per job
// and stay out of this first cut.

const SIZE_CODES = {
  '1/4"': '025', '3/8"': '038', '1/2"': '050', '3/4"': '075', '1"': '100',
  '1 1/4"': '125', '1 1/2"': '150', '2"': '200', '2 1/2"': '250', '3"': '300', '4"': '400',
};
const SIZE_ORDER = Object.keys(SIZE_CODES);

// A header line carries a run of size labels; capture them in order.
export function parseSizeHeader(line) {
  const found = [];
  let rest = line;
  for (const s of SIZE_ORDER) {
    if (rest.includes(s)) found.push(s);
  }
  // Longest labels contain shorter ones ("1 1/4\"" contains "1/4\""), so
  // detect by scanning tokens instead when the crude pass over-matches.
  const tokens = line.match(/\d+\s+\d\/\d"|\d\/\d"|\d+"/g) || [];
  const sizes = tokens.map(t => t.replace(/\s+/g, ' ').trim()).filter(t => SIZE_CODES[t]);
  return sizes.length >= 4 ? sizes : (found.length >= 4 ? found : null);
}

// A model row: 3000F-xxx-CS / PTS6TFTVHL (NPT)  $557  $557 ... or CV4730F-...
const MODEL_ROW = /^\s*((?:CV)?\d{4}[FR])-xxx-(CS|S6)\s*\/\s*([A-Z0-9]+)\s*((?:\([^)]*\)\s*)*)/;
const PRICE_TOKEN = /\$\s?([\d,]+)|n\/a/gi;

export function parseModelRow(line) {
  const m = line.match(MODEL_ROW);
  if (!m) return null;
  const [, model, material, options, endsRaw] = m;
  const prices = [];
  const tail = line.slice(m[0].length);
  for (const t of tail.matchAll(PRICE_TOKEN)) {
    prices.push(t[1] ? parseFloat(t[1].replace(/,/g, '')) : null);
  }
  const ends = (endsRaw.match(/\(([^)]+)\)/g) || []).map(s => s.slice(1, -1)).join(', ') || null;
  return { model, material, options, ends, prices };
}

// The characterised seat adder block on the CV3000 pages: identical per
// designator, split by column position into the standard and large tiers.
// Parsed from the A1 row against its own dual header, full sizes above,
// reduced sizes below, so the tier boundary comes from the sheet, not from us.
export function parseCvAdder(lines) {
  let fullSizes = null, reducedSizes = null, values = null;
  for (let i = 0; i < lines.length; i++) {
    if (/Characterized Seat Adder/i.test(lines[i])) {
      // The dual header spans two lines: the full-port sizes ride the line
      // above, the reduced-port sizes ride the adder line itself.
      fullSizes = parseSizeHeader(lines[i - 1] || '');
      reducedSizes = parseSizeHeader(lines[i]);
      for (let j = i; j < Math.min(i + 8, lines.length); j++) {
        if (/^\s*30 Degree\s+A1\b/.test(lines[j])) {
          values = [...lines[j].matchAll(/\$([\d,]+)/g)].map(x => parseFloat(x[1].replace(/,/g, '')));
          break;
        }
      }
      break;
    }
  }
  if (!fullSizes || !values || values.length < 4) return null;
  const byFull = {}, byReduced = {};
  fullSizes.forEach((s, i) => { if (values[i] != null) byFull[s] = values[i]; });
  (reducedSizes || []).forEach((s, i) => { if (values[i] != null) byReduced[s] = values[i]; });
  return { byFull, byReduced };
}

// Parse the pages into parts. Each priced size on a base row becomes a part
// with the xxx slot filled by its size code; 3000-series rows additionally
// produce the CV variant with the characterised-plate adder priced in, since
// that is the code the part builder emits.
export function parseMarwinPages(text) {
  const lines = String(text || '').split(/\r?\n/);
  const adder = parseCvAdder(lines);
  const parts = [];
  const report = { rows: 0, parts: 0, skippedRows: 0, adder: !!adder };
  let sizes = null;
  for (const line of lines) {
    const header = parseSizeHeader(line);
    const row = parseModelRow(line);
    if (header && !row) { sizes = header; continue; }
    if (!row) continue;
    if (!sizes) { report.skippedRows++; continue; }
    report.rows++;
    const isReduced = row.model.endsWith('R');
    const seriesIsCv = row.model.startsWith('CV');
    row.prices.forEach((p, i) => {
      const size = sizes[i];
      if (p == null || !size || !SIZE_CODES[size]) return;
      const stem = `${row.model}-${SIZE_CODES[size]}-${row.material}/${row.options}`;
      const desc = `${seriesIsCv ? row.model.slice(0, 6) : 'Marwin ' + row.model} ${isReduced ? 'reduced' : 'full'} port ${row.material === 'CS' ? 'carbon steel' : 'stainless steel'}, ${size}${row.ends ? ', ' + row.ends : ''}`;
      parts.push({ part: stem, description: desc, listUsd: p });
      report.parts++;
      if (!seriesIsCv && adder) {
        const a = (isReduced ? adder.byReduced[size] : adder.byFull[size]);
        if (a != null) {
          parts.push({
            part: `CV${stem}`,
            description: `CV${row.model} characterised, ${isReduced ? 'reduced' : 'full'} port ${row.material === 'CS' ? 'carbon steel' : 'stainless steel'}, ${size}${row.ends ? ', ' + row.ends : ''}`,
            listUsd: p + a,
          });
          report.parts++;
        }
      }
    });
  }
  return { parts, report };
}
