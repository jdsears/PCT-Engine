-- The conversation stage: everything between the first send and the handoff.
-- Follow-ups and responses are drafts like any other, so they inherit the
-- review queue, the approval gate and the one-open-draft-per-lead rule; these
-- columns record where each draft sits in its thread.
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS sequence_step   int NOT NULL DEFAULT 1;  -- 1 cold open, 2+ follow-ups
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS parent_draft_id bigint REFERENCES outbound_drafts(id);  -- the sent draft this follows or answers under
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS reply_id        bigint;                  -- the inbound reply a response answers

-- Reply triage: what the classifier decided and what was done about it. The
-- full body is fetched at triage time; the poller keeps storing the snippet.
ALTER TABLE outbound_replies ADD COLUMN IF NOT EXISTS body        text;
ALTER TABLE outbound_replies ADD COLUMN IF NOT EXISTS category    text;         -- interested | question | not_interested | out_of_office | wrong_person | bounce | unclear
ALTER TABLE outbound_replies ADD COLUMN IF NOT EXISTS confidence  text;         -- high | low
ALTER TABLE outbound_replies ADD COLUMN IF NOT EXISTS triaged_at  timestamptz;
ALTER TABLE outbound_replies ADD COLUMN IF NOT EXISTS triage      jsonb;        -- reason, actions taken, notification result

DO $$ BEGIN
  ALTER TABLE outbound_replies
    ADD CONSTRAINT outbound_replies_category_chk
    CHECK (category IS NULL OR category IN
      ('interested','question','not_interested','out_of_office','wrong_person','bounce','unclear'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The engine's goal is a booked meeting, then a clean handoff. Both live on the
-- lead: stage 'qualified' means the meeting is booked, 'handed_off' means a
-- person now owns the conversation. snoozed_until pauses the follow-up sequence
-- (an out-of-office reply sets it).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS meeting_booked_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS meeting_kind      text;              -- video | f2f
ALTER TABLE leads ADD COLUMN IF NOT EXISTS meeting_at        timestamptz;       -- when it happens, if known
ALTER TABLE leads ADD COLUMN IF NOT EXISTS handed_off_at     timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS handoff_note      text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS snoozed_until     timestamptz;

-- A hard bounce means the address is dead: record it and never send to it
-- again until a fresh discovery replaces the address.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_bounced_at timestamptz;

CREATE INDEX IF NOT EXISTS outbound_replies_untriaged_idx ON outbound_replies (id) WHERE triaged_at IS NULL;
