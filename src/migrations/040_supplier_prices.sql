-- Supplier prices, held apart, 11 September 2026. John's rule, agreed with
-- James: the co-pilot may give both prices, but the supplier's price only
-- when someone explicitly asks for the purchase price; every other price
-- question answers with the sell price. So the supplier's list never joins
-- the sell table. It lives here, with the standing discount or a stated net
-- buying price beside it, the cost is arithmetic over the two, and the
-- lookup reads this table only on an explicit ask. Alicat's USD list is the
-- first; the admin team runs a part number through it to confirm a costing
-- before raising a purchase order.
CREATE TABLE IF NOT EXISTS supplier_prices (
  id             bigserial PRIMARY KEY,
  product_line   text NOT NULL,
  part_number    text NOT NULL,             -- as printed on the supplier's list
  norm_key       text NOT NULL,             -- upper case, spaces stripped, the lookup key
  description    text,
  currency       text NOT NULL,             -- the supplier's currency, USD for Alicat
  list_price     numeric NOT NULL CHECK (list_price > 0),
  discount_pct   numeric,                   -- the standing discount off list; null when a net price applies
  net_price      numeric,                   -- a stated net buying price, when the list price does not apply
  list_name      text NOT NULL,
  effective_date date,
  ingested_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_line, norm_key)
);

CREATE INDEX IF NOT EXISTS supplier_prices_norm_idx ON supplier_prices (norm_key);
