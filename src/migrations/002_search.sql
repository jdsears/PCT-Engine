CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE kb_chunks
  ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(content, '') || ' ' || coalesce(metadata->>'title', ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS kb_chunks_tsv_gin   ON kb_chunks USING gin (content_tsv);
CREATE INDEX IF NOT EXISTS kb_chunks_title_trgm ON kb_chunks USING gin ((metadata->>'title') gin_trgm_ops);
