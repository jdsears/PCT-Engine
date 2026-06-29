-- Correlation fields on the send audit, captured when a real prospect send goes
-- out, so an inbound reply can be matched back to the draft it answers.
ALTER TABLE outbound_sends ADD COLUMN IF NOT EXISTS graph_message_id    text;
ALTER TABLE outbound_sends ADD COLUMN IF NOT EXISTS conversation_id     text;
ALTER TABLE outbound_sends ADD COLUMN IF NOT EXISTS internet_message_id text;

-- Captured replies from prospects to our outbound mail. The mailbox poller writes
-- here, deduping on the Graph message id, and advances the lead to replied.
CREATE TABLE IF NOT EXISTS outbound_replies (
  id                bigserial PRIMARY KEY,
  draft_id          bigint REFERENCES outbound_drafts(id),
  from_email        text,
  subject           text,
  snippet           text,
  conversation_id   text,
  graph_message_id  text UNIQUE,            -- dedup key, one row per inbound message
  received_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS outbound_replies_draft_idx ON outbound_replies (draft_id);
