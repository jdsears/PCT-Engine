-- LinkedIn replies to the message stage, 10 September 2026. A message sent
-- through Unipile now remembers the chat it opened and the person's provider
-- id, so a reply sweep can read the conversation back through the account
-- that sent it. A reply, once seen, is recorded here and ends the machine's
-- initiative on the thread the way an email reply does: no break-up email
-- follows an answer, and the lane's owner is told.
ALTER TABLE li_messages ADD COLUMN IF NOT EXISTS chat_id text;
ALTER TABLE li_messages ADD COLUMN IF NOT EXISTS attendee_id text;
ALTER TABLE li_messages ADD COLUMN IF NOT EXISTS replied_at timestamptz;
ALTER TABLE li_messages ADD COLUMN IF NOT EXISTS reply_text text;
ALTER TABLE li_messages ADD COLUMN IF NOT EXISTS reply_checked_at timestamptz;
