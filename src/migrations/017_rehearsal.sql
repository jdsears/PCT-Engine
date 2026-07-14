-- The rehearsal lane: the full conversation journey exercised on cloned,
-- tagged rows that wipe clean afterwards. Leads and drafts are tagged through
-- their existing campaign column ('rehearsal'); contacts need their own marker
-- so the stand-in recipient rows can be deleted with certainty and nothing
-- else can be.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS rehearsal boolean NOT NULL DEFAULT false;
