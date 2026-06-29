-- Outbound drafts: one proposed first-touch email per lead, generated from the
-- research and held for a human to approve. Nothing here sends on its own.
CREATE TABLE IF NOT EXISTS outbound_drafts (
  id              bigserial PRIMARY KEY,
  lead_id         bigint REFERENCES leads(id) NOT NULL,
  company_id      bigint REFERENCES companies(id) NOT NULL,
  contact_id      bigint REFERENCES contacts(id),      -- the chosen recipient, null until one is resolved
  campaign        text NOT NULL DEFAULT 'marwin_dc',
  subject         text NOT NULL,
  body            text NOT NULL,                        -- plain text, editable, rendered to HTML on send
  rationale       jsonb,                                -- why this lead: the score, the signal that flagged it, the angle
  model           text,                                 -- the model that drafted it
  status          text NOT NULL DEFAULT 'draft',        -- draft | approved | rejected | sent | failed
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);

-- One open draft per lead per campaign, so re-running the drafter never piles up
-- duplicates. Rejecting or sending a draft frees the slot for a fresh one.
CREATE UNIQUE INDEX IF NOT EXISTS outbound_drafts_lead_open_idx
  ON outbound_drafts (lead_id, campaign)
  WHERE status IN ('draft', 'approved');

CREATE INDEX IF NOT EXISTS outbound_drafts_status_idx ON outbound_drafts (status);

-- Append-only send audit. Every attempt lands here, test or real, sent or refused,
-- so there is always a record of what went where and why it did or did not go.
CREATE TABLE IF NOT EXISTS outbound_sends (
  id              bigserial PRIMARY KEY,
  draft_id        bigint REFERENCES outbound_drafts(id),
  to_email        text NOT NULL,
  subject         text,
  test_mode       boolean NOT NULL DEFAULT true,        -- true for an internal test send, false for a real prospect send
  sent            boolean NOT NULL,
  reason          text,                                 -- why it did not send, when sent is false
  created_at      timestamptz NOT NULL DEFAULT now()
);
