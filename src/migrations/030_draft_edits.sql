-- The system learns from edits, and the first requirement of learning is
-- keeping what was there before the hand moved. John, 10 August 2026, editing
-- the drafted reply to the first live technical conversation: "I'll do it as
-- I want to ensure that the system learns too."
--
-- original_subject and original_body capture the drafted text the first time
-- a human edits, lazily inside the edit itself, so every email type and every
-- historical draft is covered without touching the drafters. edited_by is the
-- last editing hand when signed in. The pairs are the raw material; the loop
-- stays human: repeated edit patterns become proposed positioning changes in
-- the campaign definitions, reviewed like every voice change, never silently
-- fed back into prompts.
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS original_subject text;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS original_body text;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS edited_by text;
