-- Who did what. With individual Microsoft sign-in live (migration era of
-- #162), the engine can finally record which person took each human action
-- rather than a bare status change. Every column is the signed-in address at
-- the moment of the click, null when the action came through the shared key
-- or before this migration, which stays honest: an unknown actor is shown as
-- nothing, never guessed.

-- Approve or reject, and the later send click, on an outbound draft.
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS decided_by text;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS sent_by text;

-- Confirm, merge or dismiss on a review queue row.
ALTER TABLE party_reviews ADD COLUMN IF NOT EXISTS decided_by text;

-- Post to LinkedIn, mark as posted, or reject, on a Studio post draft.
ALTER TABLE li_posts ADD COLUMN IF NOT EXISTS decided_by text;

-- The sanctioned invite click, and a contact added by hand from a post's
-- engager list.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS li_invited_by text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS added_by text;
