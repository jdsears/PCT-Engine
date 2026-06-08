-- Build indexes serially. A parallel index build asks for a large shared
-- memory segment, and the database container cannot grow it, so it fails with
-- "could not resize shared memory segment ... No space left on device". Serial
-- is slower but stays within the container limits.
SET max_parallel_maintenance_workers = 0;
SET max_parallel_workers_per_gather = 0;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE kb_chunks
  ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(content, '') || ' ' || coalesce(metadata->>'title', ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS kb_chunks_tsv_gin   ON kb_chunks USING gin (content_tsv);
CREATE INDEX IF NOT EXISTS kb_chunks_title_trgm ON kb_chunks USING gin ((metadata->>'title') gin_trgm_ops);
