CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS kb_chunks (
  id           bigserial PRIMARY KEY,
  content      text NOT NULL,
  embedding    vector(1024) NOT NULL,
  "sourceType" text,
  segment      text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Cosine similarity index. HNSW can be built on an empty table.
CREATE INDEX IF NOT EXISTS kb_chunks_embedding_hnsw
  ON kb_chunks USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS kb_chunks_metadata_gin
  ON kb_chunks USING gin (metadata);
