CREATE TABLE IF NOT EXISTS companies (
  id              bigserial PRIMARY KEY,
  name            text NOT NULL,
  ch_number       text UNIQUE,            -- Companies House number, null until matched
  domain          text,
  company_type    text,                   -- dc_developer | me_contractor | end_client | oem | other
  region          text,                   -- RA-1 .. RA-6, null until assigned
  postcode        text,
  named_account   boolean NOT NULL DEFAULT false,
  icp_score       numeric,
  icp_breakdown   jsonb,
  ch_profile      jsonb,                  -- cached Companies House profile
  source          text,                   -- seed_research | manual | signal
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contacts (
  id              bigserial PRIMARY KEY,
  company_id      bigint REFERENCES companies(id),
  full_name       text,
  role_title      text,
  linkedin_url    text UNIQUE,
  email           text,
  email_confidence numeric,               -- Findymail confidence, 0 to 100
  email_verified_at timestamptz,
  in_decision_orbit boolean,              -- specifier, M&E lead, procurement, per the funnel's account layer
  suppressed      boolean NOT NULL DEFAULT false,  -- opt-outs land here and are never contacted again
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS signals (
  id              bigserial PRIMARY KEY,
  company_id      bigint REFERENCES companies(id), -- nullable, a signal may precede the company record
  signal_type     text NOT NULL,          -- ch_incorporation | ch_filing | ch_director_change | news_dc_build | news_contract | planning
  title           text,
  url             text,
  url_hash        text UNIQUE,            -- sha256 of url, dedup key
  payload         jsonb,
  observed_at     timestamptz NOT NULL DEFAULT now(),
  processed       boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS leads (
  id              bigserial PRIMARY KEY,
  company_id      bigint REFERENCES companies(id) NOT NULL,
  contact_id      bigint REFERENCES contacts(id), -- nullable until contact discovery
  stage           text NOT NULL DEFAULT 'sourced', -- sourced | researched | outbound | replied | qualified | handed_off | closed | suppressed
  campaign        text NOT NULL DEFAULT 'marwin_dc',
  score           numeric,
  score_breakdown jsonb,
  region          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Small key-value store for poller state, for example the last Companies House poll time.
CREATE TABLE IF NOT EXISTS kv (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leads_stage_idx ON leads (stage);
CREATE INDEX IF NOT EXISTS signals_processed_idx ON signals (processed) WHERE NOT processed;

-- One lead per company per campaign keeps the orchestrator's upsert simple and safe to repeat.
CREATE UNIQUE INDEX IF NOT EXISTS leads_company_campaign_idx ON leads (company_id, campaign);
