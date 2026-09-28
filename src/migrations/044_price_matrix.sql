-- Prices by table rather than by part number, 28 September 2026. The Alicat
-- lists price their OEM and Coriolis series (Basis MEMS Thermal, EPC,
-- Standard and High Accuracy CODA) by a flow or pressure band against the
-- series code, and recalibration and cleaning by flow range or product
-- family against Standard and High Accuracy. None of those cells names a
-- part, so a part in one of those series resolves to its band at lookup.
-- The customer list's figure is the sell price (side 'sell'); the
-- supplier's list price, partner price and the cost rule James stated per
-- table are held apart (side 'supplier') and read only on an explicit ask
-- for the purchase price, John's rule of 11 September 2026. The list's own
-- words that no discount applies to recalibrations ride with those rows.
CREATE TABLE IF NOT EXISTS price_matrix (
  id             bigserial PRIMARY KEY,
  product_line   text NOT NULL,
  side           text NOT NULL CHECK (side IN ('sell', 'supplier')),
  section        text NOT NULL,             -- the table's heading as printed
  row_label      text NOT NULL,             -- the band or the row's own words
  col_label      text NOT NULL,             -- the series code or the column's words
  quantity       text,                      -- gas flow, liquid flow, mass flow, pressure
  unit           text,                      -- sccm, ccm, g/h, psi, torr, bar
  range_min      numeric,
  range_max      numeric,
  currency       text NOT NULL,
  price          numeric,                   -- sell price, or the supplier's list price
  partner_price  numeric,                   -- supplier side only
  discount_pct   numeric,                   -- supplier side: the rule's discount, 0 for none
  net_price      numeric,                   -- supplier side: the partner price under a partner rule
  cost_rule      text,                      -- supplier side: the rule in words
  list_name      text NOT NULL,
  effective_date date,
  source_line    text,
  ingested_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_line, side, section, row_label, col_label)
);
CREATE INDEX IF NOT EXISTS price_matrix_col ON price_matrix (product_line, side, col_label);
