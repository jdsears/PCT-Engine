// One storage path for every guide-price ingest, so James's July 2026 ruling
// on twice-priced codes lives in exactly one statement: where two sections of
// a book price the identical code, the parts are identical and the higher
// figure stands ("so we have some wiggle room"). GREATEST applies it per code
// and per currency, in whichever order the ingests run, so a re-run of one
// source can never lower a price below the ruling. The identity columns
// follow whichever source won, and everything through this path is labelled
// guide by construction, the literal sits in the statement.
//
// Rows are written in batches of hundreds per statement rather than one
// statement per row: over the public database proxy, the row-at-a-time form
// took a quarter of an hour for a full book and looked indistinguishable
// from a hang. The statement is generated for however many rows a batch
// holds; its ruling clauses are identical at any width.
const COLS = 9;
export function buildGuideUpsert(rows) {
  const values = Array.from({ length: rows }, (_, r) => {
    const p = n => `$${r * COLS + n}`;
    return `(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, 'guide', ${p(7)}, ${p(8)}, ${p(9)})`;
  }).join(', ');
  return `
  INSERT INTO prices (product_line, part_number, norm_key, description, currency, sell_price, price_basis, list_name, source_tab, effective_date)
  VALUES ${values}
  ON CONFLICT (product_line, norm_key, currency) DO UPDATE SET
    sell_price = GREATEST(prices.sell_price, EXCLUDED.sell_price),
    part_number = CASE WHEN EXCLUDED.sell_price > prices.sell_price THEN EXCLUDED.part_number ELSE prices.part_number END,
    description = CASE WHEN EXCLUDED.sell_price > prices.sell_price THEN EXCLUDED.description ELSE prices.description END,
    list_name   = CASE WHEN EXCLUDED.sell_price > prices.sell_price THEN EXCLUDED.list_name ELSE prices.list_name END,
    source_tab  = CASE WHEN EXCLUDED.sell_price > prices.sell_price THEN EXCLUDED.source_tab ELSE prices.source_tab END,
    effective_date = CASE WHEN EXCLUDED.sell_price > prices.sell_price THEN EXCLUDED.effective_date ELSE prices.effective_date END,
    ingested_at = now()`;
}

// The single-row form, kept for the gate's inspection of the ruling clauses.
export const GUIDE_UPSERT = buildGuideUpsert(1);

// A batch must never contain the same (norm_key, currency) twice: Postgres
// refuses to update one row twice in one statement. Duplicate keys within an
// ingest are deduplicated keeping the higher figure, the same ruling applied
// early.
const BATCH = 400;
export async function storeGuideRows(client, { line, priced, normKey, listName, sourceTab, effective }) {
  const byKey = new Map();
  for (const r of priced) {
    for (const [currency, sell] of Object.entries(r.guide)) {
      const key = `${normKey(r.part)}|${currency}`;
      const prev = byKey.get(key);
      if (!prev || sell > prev.sell) {
        byKey.set(key, { part: r.part, description: r.description, currency, sell });
      }
    }
  }
  const flat = [...byKey.values()];
  for (let i = 0; i < flat.length; i += BATCH) {
    const chunk = flat.slice(i, i + BATCH);
    const params = [];
    for (const row of chunk) {
      params.push(line, row.part, normKey(row.part), row.description, row.currency,
        row.sell, listName, sourceTab, effective);
    }
    await client.query(buildGuideUpsert(chunk.length), params);
  }
  return { rows: flat.length, statements: Math.ceil(flat.length / BATCH) };
}
