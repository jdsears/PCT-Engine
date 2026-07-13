-- The intel inbox: newsletters forwarded to the engine mailbox by the team,
-- split into items and routed through the same relevance gate as the news
-- sweep. This table is the dedup ledger, one row per processed email, so a
-- forward is never processed twice.
CREATE TABLE IF NOT EXISTS intel_emails (
  id                bigserial PRIMARY KEY,
  graph_message_id  text UNIQUE,
  subject           text,
  from_email        text,
  items_found       int NOT NULL DEFAULT 0,
  signals_added     int NOT NULL DEFAULT 0,
  posts_drafted     int NOT NULL DEFAULT 0,
  processed_at      timestamptz NOT NULL DEFAULT now()
);
