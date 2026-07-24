-- The SharePoint document sync's memory: one row per synced file, so a
-- cycle can tell unchanged from updated by etag and size, and can notice a
-- file removed from the site and withdraw its chunks from the corpus.
CREATE TABLE IF NOT EXISTS sharepoint_docs (
  path       text PRIMARY KEY,
  etag       text,
  size       bigint,
  modified   timestamptz,
  line       text,
  chunks     int NOT NULL DEFAULT 0,
  synced_at  timestamptz NOT NULL DEFAULT now()
);
