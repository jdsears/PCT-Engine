-- Two LinkedIn accounts, one ledger. With Andy's account joining James's,
-- every Unipile call records which connected account made it, so the posts
-- and invites caps can be counted per account, the way LinkedIn itself
-- limits them. Null covers every call made before this migration and any
-- call where the account is not known; the cap counters treat null
-- conservatively by falling back to the shared count.
ALTER TABLE unipile_calls ADD COLUMN IF NOT EXISTS account_id text;
