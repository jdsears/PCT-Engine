-- The DC signal pipeline: a relevance gate, geographic routing, and an operator
-- name for matching. All nullable and reversible, so the gate and router can be
-- re-run and tuned without losing data.
ALTER TABLE signals ADD COLUMN IF NOT EXISTS dc_relevant boolean;  -- null unjudged, true passed the data-centre gate, false rejected as not a data centre
ALTER TABLE signals ADD COLUMN IF NOT EXISTS geo_scope   text;     -- uk_project | expansion_watch | foreign_only, for DC-relevant news
ALTER TABLE signals ADD COLUMN IF NOT EXISTS operator    text;     -- the operator or contractor named in the news, for the matcher

CREATE INDEX IF NOT EXISTS signals_geo_idx ON signals (geo_scope) WHERE geo_scope IS NOT NULL;
