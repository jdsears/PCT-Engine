-- The invite drip, John's decision of 24 August 2026: the autopilot doctrine
-- applied to the touchiest write of all. The human click moves to approval: a
-- person approves a named contact's invite in the connect queue, the note is
-- frozen at that moment, and the drip releases approved invites one at a
-- time, spaced through weekday working hours, within a cap tighter than the
-- hand cap, timed against the email sequence. Nothing unapproved ever
-- invites, and any account-health error stands the drip down.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS li_invite_approved_at timestamptz;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS li_invite_approved_by text;
