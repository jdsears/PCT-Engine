-- Renumbered from the brief's 004, since 004_contact_source.sql is already
-- applied. Captures co-pilot usage so there is history before the September
-- review. No user identity is logged: there is none under the shared access
-- gate, and attribution will be a deliberate decision with PCT if Microsoft
-- sign-in arrives, not a drift.
CREATE TABLE IF NOT EXISTS copilot_queries (
  id              bigserial PRIMARY KEY,
  question        text NOT NULL,
  detected_filters jsonb,                 -- the line or application filter the answer layer chose
  declined        boolean NOT NULL,       -- true when the answer cited no sources
  citations_used  jsonb,                  -- the bracket numbers actually referenced, with titles
  sources_offered int,                    -- how many results retrieval returned
  latency_ms      int,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS copilot_queries_created_idx ON copilot_queries (created_at);
CREATE INDEX IF NOT EXISTS copilot_queries_declined_idx ON copilot_queries (declined) WHERE declined;
