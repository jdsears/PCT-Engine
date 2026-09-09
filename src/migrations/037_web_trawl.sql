-- The website trawl's memory, 9 September 2026: the sites the engine reads
-- into the corpus, one row per host, and the pages it holds from each, so a
-- refresh can tell an unchanged page from a changed one by content hash and
-- can notice a page gone from the site and withdraw its chunks. Alicat's
-- site is the first; a prospect's site is read by the research funnel
-- without ever landing here, because research evidence is not corpus.
CREATE TABLE IF NOT EXISTS web_sites (
  id             bigserial PRIMARY KEY,
  url            text NOT NULL,                     -- the start page, canonical
  host           text NOT NULL UNIQUE,              -- one trawl per host
  line           text NOT NULL DEFAULT 'general',   -- the corpus line its pages file under
  max_pages      int NOT NULL DEFAULT 150,
  include_pdfs   boolean NOT NULL DEFAULT false,
  enabled        boolean NOT NULL DEFAULT true,
  added_by       text,
  added_at       timestamptz NOT NULL DEFAULT now(),
  last_trawl_at  timestamptz,
  last_report    jsonb
);

CREATE TABLE IF NOT EXISTS web_docs (
  url            text PRIMARY KEY,
  site_id        bigint NOT NULL REFERENCES web_sites(id) ON DELETE CASCADE,
  title          text,
  content_hash   text,
  chunks         int NOT NULL DEFAULT 0,
  fetched_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS web_docs_site_idx ON web_docs (site_id);
