-- Provenance for outbound drafts: what each draft drew on, and any claim the
-- grounding check could not trace. A draft is explainable, the same principle as
-- an ICP score carrying its breakdown.
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS email_type      text NOT NULL DEFAULT 'cold_open';
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS grounding       jsonb;  -- the exact inputs used: signal, icp reason, product citations, contact role
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS grounding_flags jsonb;  -- claims the check could not trace, empty when clean
