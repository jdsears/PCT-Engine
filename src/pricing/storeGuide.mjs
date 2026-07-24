// One storage path for every guide-price ingest, so James's July 2026 ruling
// on twice-priced codes lives in exactly one statement: where two sections of
// a book price the identical code, the parts are identical and the higher
// figure stands ("so we have some wiggle room"). GREATEST applies it
// per code and per currency, in whichever order the ingests run, so a re-run
// of one source can never lower a price below the ruling. The identity
// columns follow whichever source won.
export const GUIDE_UPSERT = `
  INSERT INTO prices (product_line, part_number, norm_key, description, currency, sell_price, price_basis, list_name, source_tab, effective_date)
  VALUES ($1, $2, $3, $4, $5, $6, 'guide', $7, $8, $9)
  ON CONFLICT (product_line, norm_key, currency) DO UPDATE SET
    sell_price = GREATEST(prices.sell_price, EXCLUDED.sell_price),
    part_number = CASE WHEN EXCLUDED.sell_price > prices.sell_price THEN EXCLUDED.part_number ELSE prices.part_number END,
    description = CASE WHEN EXCLUDED.sell_price > prices.sell_price THEN EXCLUDED.description ELSE prices.description END,
    list_name   = CASE WHEN EXCLUDED.sell_price > prices.sell_price THEN EXCLUDED.list_name ELSE prices.list_name END,
    source_tab  = CASE WHEN EXCLUDED.sell_price > prices.sell_price THEN EXCLUDED.source_tab ELSE prices.source_tab END,
    effective_date = CASE WHEN EXCLUDED.sell_price > prices.sell_price THEN EXCLUDED.effective_date ELSE prices.effective_date END,
    ingested_at = now()`;

// Store one ingest's priced rows through the ruling statement. normKey is
// passed in so this module stays free of parser imports.
export async function storeGuideRows(client, { line, priced, normKey, listName, sourceTab, effective }) {
  for (const r of priced) {
    for (const [currency, sell] of Object.entries(r.guide)) {
      await client.query(GUIDE_UPSERT,
        [line, r.part, normKey(r.part), r.description, currency, sell, listName, sourceTab, effective]);
    }
  }
}
