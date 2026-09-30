-- The notes a band-priced table prints beside its prices, 30 September 2026.
-- EPC's heading carries "min. qty 50", and the High Accuracy CODA table says
-- to quote only the non-display variant until the CODA display is released.
-- A quote that dropped either would say less than the list does, so each
-- priced cell carries its table's notes and the co-pilot repeats them.
ALTER TABLE price_matrix ADD COLUMN IF NOT EXISTS note text;
