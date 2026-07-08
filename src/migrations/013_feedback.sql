-- Reader feedback on co-pilot answers, for the testing window and beyond: a
-- thumbs up or down against the logged query, so testing produces structured
-- data rather than anecdotes. No identity, same as the rest of the log.
ALTER TABLE copilot_queries ADD COLUMN IF NOT EXISTS feedback    text;         -- 'up' | 'down', null until given
ALTER TABLE copilot_queries ADD COLUMN IF NOT EXISTS feedback_at timestamptz;
