-- Contacts gain provenance: where the record came from (ch_officers, linkedin,
-- news) and the raw payload it was built from. Provenance matters for outbound
-- compliance, every contact should be traceable to its public source.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS payload jsonb;

-- One row per person per company for register-sourced contacts, which have no
-- LinkedIn URL to dedupe on.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_company_name_idx
  ON contacts (company_id, lower(full_name));
