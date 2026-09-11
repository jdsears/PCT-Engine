-- People found on a company's own website, 11 September 2026. John's
-- instruction when the data centre lane starved at the people step: the
-- LinkedIn search had stood down for a month after one empty pass, and the
-- accounts that score highest carried no decision makers at all. The engine
-- now reads a company's own team, leadership and contact pages as a second
-- route to its people, needing no LinkedIn call, and remembers when it last
-- looked and what it found so the pass repeats on a cadence, not forever.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS site_people_checked_at timestamptz;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS site_people_found int;
