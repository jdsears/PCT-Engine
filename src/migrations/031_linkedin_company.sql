-- The company's own LinkedIn identity, resolved once and cached, so the
-- people search can search WITHIN the company (the Sales Navigator company
-- scope) instead of keyword-matching headlines across all of LinkedIn,
-- which is where every namesake and misattached contact came from. The
-- literal 'none' records a lookup that found no confident match, so the
-- walk never re-spends that call.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS linkedin_company_id text;
