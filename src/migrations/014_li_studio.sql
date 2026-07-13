-- The LinkedIn studio: post drafts generated from the engine's gated signals,
-- and the invite bookkeeping on contacts. Nothing here posts or connects; a
-- human copies and acts from their own account, and the engine records it.
CREATE TABLE IF NOT EXISTS li_posts (
  id          bigserial PRIMARY KEY,
  signal_id   bigint REFERENCES signals(id),
  topic       text,                              -- the signal headline the post grew from
  body        text NOT NULL,
  grounding   jsonb,                             -- the signal text and source, plus any guardrail flags
  status      text NOT NULL DEFAULT 'draft',     -- draft | posted | rejected
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  posted_at   timestamptz
);

-- One post per signal keeps regeneration tidy; rejecting frees the signal.
CREATE UNIQUE INDEX IF NOT EXISTS li_posts_signal_open_idx
  ON li_posts (signal_id) WHERE status IN ('draft', 'posted');

-- Invite tracking for the connect queue: when a person was invited (marked by
-- hand after the human sends the request) and the note that was suggested.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS li_invited_at timestamptz;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS li_invite_note text;
