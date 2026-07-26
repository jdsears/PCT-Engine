-- The lead-gen unlock: the engine may propose what it discovers, a human
-- decides what enters the register.

-- Two parties per signal. A contractor-appointment headline names the operator
-- whose facility it is and the contractor who won the work; both are sellable
-- and only one was being kept. company_id keeps its meaning, the matched
-- operator-side account; the contractor gets its own name and linkage, so one
-- signal can feed two accounts' scoring.
ALTER TABLE signals ADD COLUMN IF NOT EXISTS contractor text;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS contractor_company_id bigint REFERENCES companies(id);

CREATE INDEX IF NOT EXISTS signals_contractor_company_idx
  ON signals (contractor_company_id) WHERE contractor_company_id IS NOT NULL;

-- The review queue: proposals from unknown parties and ambiguities the matcher
-- refuses to resolve alone. Proposals are not companies. A proposed name holds
-- printed text, the signal that produced it and read-only enrichment; it does
-- not score, does not enter the pipeline, receives no contact research and is
-- never an outbound target. Only the confirm and merge actions create or touch
-- an account, and both are human actions.
--
-- One row per normalised name per campaign, whatever its fate: a dismissed row
-- stays and blocks re-proposal, because a dismissal is a decision, not a
-- deferral.
CREATE TABLE IF NOT EXISTS party_reviews (
  id                 bigserial PRIMARY KEY,
  kind               text NOT NULL,             -- proposal | ambiguous
  printed_name       text NOT NULL,             -- as the story printed it
  name_norm          text NOT NULL,             -- matcher-normalised, the dedupe key
  party              text NOT NULL,             -- operator | contractor
  campaign           text NOT NULL,
  signal_id          bigint REFERENCES signals(id),
  ch_candidates      jsonb,                     -- Companies House entities, for proposals
  account_candidates jsonb,                     -- register accounts, for ambiguous rows
  domain             text,                      -- read-only resolution at proposal time
  status             text NOT NULL DEFAULT 'open', -- open | confirmed | merged | dismissed
  company_id         bigint REFERENCES companies(id), -- set by confirm or merge
  created_at         timestamptz NOT NULL DEFAULT now(),
  decided_at         timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS party_reviews_name_campaign_idx
  ON party_reviews (name_norm, campaign);

-- Aliases learned through the queue. The matcher's seeded map stays in code as
-- the floor; every alias a human confirms lands here as data, which is how the
-- matcher improves without an edit. alias is the printed form lowered,
-- canonical the registered name it resolves to.
CREATE TABLE IF NOT EXISTS matcher_aliases (
  alias      text PRIMARY KEY,
  canonical  text NOT NULL,
  source     text,                              -- queue_merge | queue_resolve
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Every unmatched party name, counted. Unknown is a lead-generation
-- opportunity and ambiguous is a data-quality problem; both were invisible.
-- The counter makes the next alias worth adding always visible.
CREATE TABLE IF NOT EXISTS unmatched_parties (
  name_norm  text NOT NULL,
  printed    text NOT NULL,                     -- most recent printed form
  campaign   text NOT NULL,
  n          int NOT NULL DEFAULT 1,
  last_seen  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name_norm, campaign)
);
