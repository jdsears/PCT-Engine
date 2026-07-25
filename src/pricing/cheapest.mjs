import { decode, checkCautions } from '../configurator/engine.mjs';

// The cheapest-valve tier answers the question the builder work was for: not
// the cheapest part in the abstract but the cheapest complete valve the book
// prices, with its build read back slot by slot through the range's own
// ordering matrix. Where a series has no matrix in the engine the answer
// stays honest: the price stands, and the spec is the book's own description
// rather than a read-back we cannot prove. Pure over rows and configs so the
// gate can prove the wording offline; the server feeds it the prices table.

// Narrower than the price-intent gate that runs first: these words claim a
// superlative, not merely a price. Bare "lowest" stays out so a question
// about a lowest temperature or flow never lands here.
const SUPERLATIVE = /\b(cheapest|least expensive|most affordable|lowest[ -]?(?:cost|price[sd]?)|best[ -]?price[sd]?)\b/i;
export const superlativeIntent = q => SUPERLATIVE.test(String(q || ''));

// The first config whose grammar accepts the code, with its per-position
// read-back and any cautions the matrix attaches to the decoded state. The
// configurator gate proves no book code decodes under two models, so first
// found is the only one.
export function decodeAcross(configs, partNumber) {
  for (const config of configs || []) {
    const r = decode(config, String(partNumber || ''));
    if (r.ok) return { config, state: r.state, spec: r.decode, cautions: checkCautions(config, r.state) };
  }
  return null;
}

// Rows arrive price-ascending from the store, so the head row is the answer
// whether or not it decodes. Skipping an undecodable head for a decodable
// runner-up would misreport the cheapest, so it never happens.
export function cheapestOf(configs, rows) {
  if (!rows || !rows.length) return null;
  const row = rows[0];
  return { row, build: decodeAcross(configs, row.part_number) };
}

const GBP = n => `£${Number(n).toLocaleString('en-GB')}`;

// scope reads like "Marwin valve" or "Marwin 4700 series valve"; the caller
// sets it from what the question named.
export function renderCheapestValve({ scope, row, build }) {
  const lines = [
    `The lowest priced ${scope} in the loaded book is **${row.part_number}**` +
    `${row.description ? `, ${row.description}` : ''}: ${GBP(row.sell_price)}.`,
  ];
  if (build) {
    lines.push('', `The code reads through the ${build.config.displayName} matrix as:`);
    for (const p of build.spec) lines.push(`- ${p.label}: ${p.choice || p.code} (${p.code})`);
    for (const c of build.cautions || []) lines.push('', `Note: ${c.note}`);
  } else {
    lines.push('',
      'This series has no ordering matrix in the engine, so the spec is the book\'s own description for the code rather than a slot by slot read-back.');
  }
  lines.push('',
    "This is a guide price at the calculator's standard settings; the final margin is set per customer at quote, confirm with Andy or your area sales manager. Combinations beyond the loaded book are priced per enquiry.");
  return lines.join('\n');
}
