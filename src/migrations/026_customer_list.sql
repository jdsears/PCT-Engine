-- The register learns who is already a customer.
--
-- James's segmented CRM export (August 2026) carries a fact the engine never
-- held: whether a company already trades with PCT, and at what grade. Without
-- it the engine can only treat every account as a stranger, and the worst
-- expression of that is a cold introduction drafted to a company that buys
-- from PCT every month. The data itself never enters the repository; this
-- migration adds the columns and scripts/import-customer-list.mjs loads the
-- workbook on a machine that has the database.

-- a | b | c: an existing customer at the CRM's grade. prospect: named in the
-- CRM as a target with no trading history. NULL: the engine has no record
-- either way, which covers everything research discovers on its own. Unknown
-- stays unknown; the import never guesses a grade.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS customer_status text;

-- Read-only provenance from the CRM export: record id, suggested segment,
-- segmentation rationale, sales area label, activity dates, import date.
-- Enrichment for humans, never an input the engine reasons from.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS crm jsonb;
