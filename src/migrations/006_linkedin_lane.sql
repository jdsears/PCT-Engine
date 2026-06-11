-- The LinkedIn lane's call ledger. One row per Unipile API call, so the daily
-- cap is counted from the same record that audits it and the two cannot drift.
CREATE TABLE IF NOT EXISTS unipile_calls (
  id          bigserial PRIMARY KEY,
  endpoint    text NOT NULL,
  target      text,
  outcome     text,                      -- ok | http_<code> | refused_cap | network_error
  called_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS unipile_calls_called_idx ON unipile_calls (called_at);

-- Enrichment provenance on contacts: when the LinkedIn lane last filled a row.
-- Rows with a recent enriched_at are never overwritten, which protects edits.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS enriched_at timestamptz;
