-- One lead per company per campaign is the production dedupe rule, and it
-- stays. The rehearsal campaign deliberately breaks it: John, James and Andy
-- each run their own lane, and all three may rehearse the same company's
-- draft at the same time, so a second rehearsal lead for a company must not
-- collide with the first. The unique rule now excludes the rehearsal
-- campaign; rehearsal lanes stay apart by their stand-in contacts.
DROP INDEX IF EXISTS leads_company_campaign_idx;
CREATE UNIQUE INDEX IF NOT EXISTS leads_company_campaign_idx
  ON leads (company_id, campaign) WHERE campaign <> 'rehearsal';
