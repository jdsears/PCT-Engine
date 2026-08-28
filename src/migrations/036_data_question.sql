-- "Where did you get my email address from?", Chris Wheeler at Pharmaron,
-- 28 August 2026. The classifier could only call it unclear, so it reached a
-- human with no draft and no standard answer. It deserves its own category:
-- the reply is a factual statement about our own data handling, a person
-- asking is entitled to a straight answer, and the answer must be identical
-- and exact every time, which is why it is written from a template rather
-- than by a model.
DO $$ BEGIN
  ALTER TABLE outbound_replies DROP CONSTRAINT outbound_replies_category_chk;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

ALTER TABLE outbound_replies
  ADD CONSTRAINT outbound_replies_category_chk
  CHECK (category IS NULL OR category IN
    ('interested','question','not_interested','out_of_office','wrong_person','bounce','unclear','data_question'));
