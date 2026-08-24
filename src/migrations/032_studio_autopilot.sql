-- The studio autopilot, John's decision of 24 August 2026: the human click
-- moves ahead of time rather than disappearing. A person approves a draft into
-- the queue; the scheduler releases approved posts at the standing slots.
-- Nothing unapproved ever publishes.

-- li_posts gains the approved state between draft and posted. The one-open-post
-- -per-signal index must treat an approved post as open, or regeneration would
-- draft a second post for a signal whose first is already queued.
DROP INDEX IF EXISTS li_posts_signal_open_idx;
CREATE UNIQUE INDEX IF NOT EXISTS li_posts_signal_open_idx
  ON li_posts (signal_id) WHERE status IN ('draft', 'approved', 'posted');

-- Interest, gathered and sorted: every engager the automatic sweeps read from
-- our own published posts, one row per person per post, analysed once (orbit
-- fit, register match) and kept, so the studio shows a queue instead of a
-- click-per-post snapshot. Acting on a row stays human: added, proposed or
-- dismissed, with who decided. Engagement never enters email wording; this
-- table informs targeting only.
CREATE TABLE IF NOT EXISTS post_engagers (
  id                 bigserial PRIMARY KEY,
  li_post_id         bigint NOT NULL REFERENCES li_posts(id),
  campaign           text NOT NULL,
  person_key         text NOT NULL,              -- profile url, else the name, lowered: the dedupe key
  name               text NOT NULL,
  headline           text,
  role_title         text,
  company_guess      text,                       -- from the headline, never invented
  linkedin_url       text,
  reaction           text,
  orbit_fit          boolean NOT NULL DEFAULT false,
  matched_company_id bigint REFERENCES companies(id),
  status             text NOT NULL DEFAULT 'new', -- new | added | proposed | dismissed
  decided_by         text,
  decided_at         timestamptz,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS post_engagers_person_idx
  ON post_engagers (li_post_id, person_key);
CREATE INDEX IF NOT EXISTS post_engagers_queue_idx
  ON post_engagers (campaign, status);

-- A proposal can now say where it came from: research rows leave these null
-- (the original meaning), an engager proposal carries its provenance so the
-- reviewer sees who engaged and on which post before deciding.
ALTER TABLE party_reviews ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE party_reviews ADD COLUMN IF NOT EXISTS evidence jsonb;
