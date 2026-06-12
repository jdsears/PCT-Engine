-- Records which channel a co-pilot question came through. Defaults to web, so
-- existing rows and the web /ask path need no change; Teams logs 'teams'. This
-- only makes a channel split available later; Insights is unchanged this pass.
ALTER TABLE copilot_queries ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'web';
