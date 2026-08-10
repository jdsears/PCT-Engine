-- The second prize. James, 7 August 2026: getting Marwin onto a data centre
-- design earns a commission from Richards even when the eventual purchase
-- never touches PCT, so specified-on-design is a win in its own right, not a
-- consolation. The pipeline records it as its own outcome alongside the
-- meeting; the commercial arrangement behind it is internal and never
-- appears in outbound wording.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS design_in_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS design_in_note text;
