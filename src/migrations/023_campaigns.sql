-- Campaign becomes a first-class dimension.
--
-- Signals gain a campaign, because a sweep belongs to the campaign that ran it,
-- and a neutral relevance column. dc_relevant was the general "passed the gate"
-- flag wearing a data centre name; renaming in place would leave a window where
-- a mid-deploy restart met a half-migrated schema, so this is additive: the new
-- column is backfilled, both are written for one release, and a later migration
-- retires the old one once nothing reads it.
ALTER TABLE signals ADD COLUMN IF NOT EXISTS campaign text NOT NULL DEFAULT 'marwin_dc';
ALTER TABLE signals ADD COLUMN IF NOT EXISTS relevant boolean;  -- null unjudged, true passed the campaign's gate, false rejected

UPDATE signals SET relevant = dc_relevant WHERE relevant IS NULL AND dc_relevant IS NOT NULL;

CREATE INDEX IF NOT EXISTS signals_campaign_idx ON signals (campaign);

-- Companies are shared across campaigns; membership is not. An M&E contractor
-- may build both data centres and pharmaceutical plants, and should be one
-- account with two memberships rather than two rows. Scores are per campaign,
-- since the same company scores differently against different plays.
CREATE TABLE IF NOT EXISTS company_campaigns (
  company_id   bigint REFERENCES companies(id) ON DELETE CASCADE,
  campaign     text NOT NULL,
  score        numeric,
  score_reason text,
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, campaign)
);

-- Every company currently on the register belongs to the campaign that seeded
-- it, which until today was the only one.
INSERT INTO company_campaigns (company_id, campaign, score, score_reason)
SELECT id, 'marwin_dc', score, score_reason FROM companies
ON CONFLICT (company_id, campaign) DO NOTHING;

-- Cross-campaign contact protection. A contact must never receive cold opens
-- from two campaigns in close succession; from the recipient's side that is one
-- company mailing them twice about different things, which reads as spam. The
-- window is enforced at contact level, across campaigns, and a draft held for
-- it is surfaced in the review queue rather than silently dropped.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_cold_open_at timestamptz;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_cold_open_campaign text;

CREATE INDEX IF NOT EXISTS contacts_last_cold_open_idx
  ON contacts (last_cold_open_at) WHERE last_cold_open_at IS NOT NULL;
