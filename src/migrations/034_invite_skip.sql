-- The veto that makes automatic invite selection defensible, John's decision
-- of 24 August 2026 with James's and Andy's word for their own accounts: when
-- the drip may pick from the whole eligible queue, a person needs a way to
-- say "not this one" that is lighter than suppression (which stops email too)
-- and permanent for LinkedIn: skipped contacts never enter the connect queue
-- or the drip again, and who skipped is recorded.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS li_invite_skipped_at timestamptz;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS li_invite_skipped_by text;
