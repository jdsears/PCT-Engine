-- The live sending model: each regional rep sends from a dedicated
-- prospecting mailbox. A send records which mailbox it went from, and a
-- captured reply records which mailbox it was read in, because a Graph
-- message id only means something inside its own mailbox. Null means the
-- single engine mailbox, which keeps every existing row honest.
ALTER TABLE outbound_sends ADD COLUMN IF NOT EXISTS sender_mailbox text;
ALTER TABLE outbound_replies ADD COLUMN IF NOT EXISTS mailbox text;
