-- Option adders from a customer price list, 11 September 2026. James's
-- first real question configured a base part with options (M12, PCV30, 5P),
-- and his note on the answer: M12 is an option at £62 on the list's own
-- option table, PCV a no-cost option. The list prints options as a label,
-- the codes in brackets and a price, and this table holds them by code so
-- a configured price is the base plus the adders it names, each traceable
-- to the list, and an option the list does not price is said to be not
-- held rather than guessed.
CREATE TABLE IF NOT EXISTS price_options (
  id             bigserial PRIMARY KEY,
  product_line   text NOT NULL,
  code           text NOT NULL,             -- as printed, M12, ALM, TFT
  norm_code      text NOT NULL,             -- upper case, no leading dash, no spaces
  label          text,                      -- the list's own words for the option
  currency       text NOT NULL,
  adder          numeric NOT NULL CHECK (adder >= 0),   -- zero for a no-cost option
  marked_default boolean NOT NULL DEFAULT false,
  list_name      text NOT NULL,
  effective_date date,
  ingested_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_line, norm_code)
);
