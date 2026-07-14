-- Sales pricing, deterministic and separate from the knowledge corpus. Prices
-- never go through the embedding pipeline, and no model ever sits between a
-- part number and its price: the lookup is a plain indexed query. Only
-- customer sell prices are stored. Cost, purchase and supplier list figures
-- are skipped at parse time and reported as skipped, never ingested, the
-- standing rule, since the co-pilot serves the whole team and margins are not
-- team-wide knowledge.
CREATE TABLE IF NOT EXISTS prices (
  id             bigserial PRIMARY KEY,
  product_line   text NOT NULL,           -- workbook tab key: status | ege | king
  part_number    text NOT NULL,           -- as printed on the list
  norm_key       text NOT NULL,           -- upper case, spaces stripped, the lookup key
  description    text,
  currency       text NOT NULL,           -- GBP | EUR | USD
  sell_price     numeric NOT NULL CHECK (sell_price > 0),
  list_name      text NOT NULL,
  source_tab     text NOT NULL,
  effective_date date,
  ingested_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_line, norm_key, currency)
);

CREATE INDEX IF NOT EXISTS prices_norm_prefix_idx ON prices (norm_key text_pattern_ops);
