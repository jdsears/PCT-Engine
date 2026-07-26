-- Why a review was decided the way it was, so a later reader knows a confirm
-- without a Companies House entity was a considered decision, not an oversight.
-- The confirm queue offers pick-an-entity or confirm-as-printed; the second
-- carries no record of why no entity was chosen, which reads later as a gap.
ALTER TABLE party_reviews ADD COLUMN IF NOT EXISTS decision_note text;
