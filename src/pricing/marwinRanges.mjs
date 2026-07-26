// Stage one of builders for every Marwin range: a chooser over the priced
// book, not a grammar. Each range's tree is derived from the part numbers
// the ingest stored, model then size then material then option package, and
// every leaf is a stored part with its guide prices. By construction it
// cannot invent a code, because it only ever offers what the book prices.
// Stage two, real slot-by-slot builders with constraints like the CV3000
// one, needs each series' ordering matrix from its data sheet.
//
// Pure over rows so the gate can prove the derivation offline; the server
// feeds it the prices table.

const SIZE_ORDER = ['1/4"', '3/8"', '1/2"', '3/4"', '1"', '1 1/4"', '1 1/2"', '2"', '2 1/2"', '3"', '4"', '6"', '8"'];
const NUM_CODE = { '025': '1/4"', '038': '3/8"', '050': '1/2"', '075': '3/4"', '100': '1"', '125': '1 1/4"', '150': '1 1/2"', '200': '2"', '250': '2 1/2"', '300': '3"', '400': '4"', '600': '6"', '800': '8"' };
const LET_CODE = { '05A': '1/2"', '07A': '3/4"', '10A': '1"', '12A': '1 1/4"', '15A': '1 1/2"', '20A': '2"', '25A': '2 1/2"', '30A': '3"', '40A': '4"' };
const MATERIAL = { CS: 'carbon steel', S6: '316 stainless steel', BR: 'brass' };

// Split a stored part number into its choosing axes. The size segment is the
// anchor: everything before it is the model, a known material segment after
// it is the material, and whatever else remains (end-class segments, the
// option string) is the package that tells sibling parts apart.
export function decomposePart(partNumber) {
  const [head, opts] = String(partNumber || '').split('/');
  const segs = head.split('-');
  const at = segs.findIndex(s => NUM_CODE[s] || LET_CODE[s]);
  if (at < 1) return null;
  const size = NUM_CODE[segs[at]] || LET_CODE[segs[at]];
  const model = segs.slice(0, at).join('-');
  const rest = segs.slice(at + 1);
  const material = MATERIAL[rest[0]] ? rest[0] : null;
  const tail = material ? rest.slice(1) : rest;
  const packageCode = [tail.join('-'), opts || ''].filter(Boolean).join('/') || null;
  return { model, size, material, packageCode };
}

// What is left of a description once the series, size and material words are
// accounted for; it carries the port, variant and actuator glosses and makes
// the package label a human can choose by.
export function packageLabel(description, { size, material } = {}) {
  let d = String(description || '').replace(/^Marwin\s+\S+\s+series(\s+[a-z0-9() ]+?)?,\s*/i, '');
  for (const drop of [size, material ? MATERIAL[material] : null]) {
    if (drop) d = d.split(', ').filter(b => b.trim().toLowerCase() !== drop.toLowerCase()).join(', ');
  }
  return d.trim() || 'standard';
}

// rows: { part_number, description, prices: {GBP, EUR, USD} } for one series.
// The tree is model -> size -> material -> packages, sorted for choosing.
export function buildRangeTree(rows) {
  const models = new Map();
  let skipped = 0;
  for (const r of rows || []) {
    const d = decomposePart(r.part_number);
    if (!d) { skipped++; continue; }
    const m = models.get(d.model) || new Map();
    const s = m.get(d.size) || new Map();
    const matKey = d.material || '';
    const packages = s.get(matKey) || [];
    packages.push({
      part: r.part_number,
      label: packageLabel(r.description, { size: d.size, material: d.material }),
      code: d.packageCode,
      prices: r.prices || {},
      description: r.description || '',
    });
    s.set(matKey, packages);
    m.set(d.size, s);
    models.set(d.model, m);
  }
  const bySize = (a, b) => SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b);
  return {
    skipped,
    models: [...models.keys()].sort().map(model => ({
      model,
      sizes: [...models.get(model).keys()].sort(bySize).map(size => ({
        size,
        materials: [...models.get(model).get(size).keys()].sort().map(mat => ({
          material: mat || null,
          materialLabel: mat ? MATERIAL[mat] : null,
          packages: models.get(model).get(size).get(mat)
            .sort((a, b) => (a.prices.GBP ?? 0) - (b.prices.GBP ?? 0)),
        })),
      })),
    })),
  };
}

// Which Marwin series a price question names. Longest names first so FW4700
// beats 4700 and MS3000 beats 3000; a bare number only qualifies alongside
// the word marwin or the word series, so part numbers and years do not
// trigger it. CV3000 and CV4700 stay with the existing whole-line answer.
const SERIES_TOKENS = [
  ['MS11000', ['ms11000', '11000']], ['FW4700', ['fw4700']], ['CF8901', ['cf8901', '8901']],
  ['MS3000', ['ms3000']], ['10000', ['10000']], ['9700', ['9700']], ['9000', ['9000']],
  ['8700', ['8700']], ['5801', ['5801']], ['6801', ['6801']], ['4700', ['4700']],
  ['4600', ['4600']], ['3000', ['3000']], ['2000', ['2000']], ['600', ['600']],
  ['3T-3700/3L-3800', ['3t-3700', '3l-3800', '3700', '3800']],
  ['3T-2100/3L-2100', ['3t-2100', '3l-2100', '2100']],
  ['3T-3300/3L-3400', ['3t-3300', '3l-3400', '3300', '3400']],
  ['3T-3100/3L-3200', ['3t-3100', '3l-3200', '3100', '3200']],
];
export function marwinSeriesOf(question) {
  const q = String(question || '').toLowerCase();
  const hasMarwin = /\bmarwin\b/.test(q);
  for (const [series, tokens] of SERIES_TOKENS) {
    for (const t of tokens) {
      const bare = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (/[a-z]/.test(t)) {
        if (new RegExp(`\\b${bare}\\b`).test(q)) return series;
      } else if (new RegExp(`\\b${bare}\\s*series\\b|\\bseries\\s*${bare}\\b`).test(q)
          || (hasMarwin && new RegExp(`\\b${bare}\\b`).test(q))) {
        return series;
      }
    }
  }
  return null;
}

const SYM = { GBP: '£', EUR: '€', USD: '$' };
// The wording matches the whole-line summary: what is loaded, the cheapest
// by name, the guide caveat, and the honest edge for everything beyond it.
export function renderSeriesSummary(s) {
  return `**Marwin ${s.series} series**, from the loaded book: ${s.count} part${s.count === 1 ? '' : 's'} priced, ` +
    `from ${SYM.GBP}${Number(s.min).toLocaleString('en-GB')} (${s.minPart}${s.minDesc ? ', ' + s.minDesc : ''}) ` +
    `to ${SYM.GBP}${Number(s.max).toLocaleString('en-GB')}. These are guide prices at the standard margin ` +
    'the master price sheet sets, the single source for margin.\n\n' +
    'Combinations beyond the loaded book are priced per enquiry.';
}
