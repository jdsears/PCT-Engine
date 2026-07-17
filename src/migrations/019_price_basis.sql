-- Guide prices join the stored sells. A 'sell' row is a price as published by
-- the team's own lists; a 'guide' row is computed at ingest from a supplier
-- list through the Richards transform, discount then margin, with the margin
-- set per customer at quote time, so a guide is a starting point and is
-- always labelled as one. The raw discount, margin and rate are read from the
-- mega sheet at ingest and never stored anywhere.
ALTER TABLE prices ADD COLUMN IF NOT EXISTS price_basis text NOT NULL DEFAULT 'sell';

DO $$ BEGIN
  ALTER TABLE prices ADD CONSTRAINT prices_basis_chk CHECK (price_basis IN ('sell', 'guide'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
