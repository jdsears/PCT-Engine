# PCT Knowledge Co-Pilot

A minimal service that holds the PCT knowledge base as vector chunks in
Postgres. This first phase stands up the service and ingests the Richards
corpus. Retrieval, the chat interface, and the answer-side voice gate are out
of scope here and come in a later brief.

The sales-engine components are expected to join this same repository in later
phases.

## What is here

- `src/server.mjs` is a small Express service with a single `/health` route.
- `src/db.mjs` holds the Postgres pool.
- `src/migrate.mjs` applies the SQL files in `src/migrations` and records them
  in a `schema_migrations` table.
- `src/migrations/001_init.sql` creates the `pgvector` extension and the
  `kb_chunks` table with an `embedding` column at `vector(1024)`, plus an HNSW
  cosine index and a GIN index on metadata.
- `src/embeddings.mjs` calls Voyage AI to embed text at 1024 dimensions.
- `ingestion/` walks a local corpus folder, extracts text, splits it into
  prose and table chunks, embeds them, and writes them to `kb_chunks`.

## Environment

The service expects these variables. See `.env.example`.

- `DATABASE_URL`, provided by Railway for the Postgres service.
- `VOYAGE_API_KEY`, used by the embedding step.
- `ANTHROPIC_API_KEY`, reserved for the later retrieval and chat phases.
- `VOYAGE_MODEL`, optional, defaults to `voyage-3.5`.
- `NODE_ENV`, set to `production` in the deployed environment.

## Standing up the service

1. Create a Railway project, a service from this repository, and a Postgres
   database. Capture the `DATABASE_URL`.
2. Set the service variables listed above.
3. Apply the migration against the database, with `DATABASE_URL` pointing at
   the Railway Postgres connection string:

   ```
   npm install
   npm run migrate
   ```

4. Deploy, then request `/health`. It should report `pgvector`, a migration
   count of 1, and `kb_chunks` of 0.

A healthy response looks like this:

```
{ "ok": true, "pgvector": "0.7.0", "migrations": 1, "kb_chunks": 0 }
```

## Ingesting the Richards corpus

The ingestion step reads PDFs, Word files, and PowerPoint files from a local
folder. It needs two command line tools for PDFs:

- `pdftotext` from poppler, used with `-layout` for table fidelity.
- `ocrmypdf`, used as a fallback for scanned PDFs with no text layer.

On a Mac these install through Homebrew. The `officeparser` dependency handles
the Word and PowerPoint files and installs with `npm install`.

With `DATABASE_URL` and `VOYAGE_API_KEY` available in the shell, run from the
repository root:

```
node ingestion/run.mjs "<path to the Richards folder>"
```

The run prints a report: the corpus, documents seen, documents skipped as
unchanged, new and updated documents, chunks written, chunks by product line,
application or folder, and any files with no extractable text. Re-running is
safe. Each document is keyed by a content hash, so unchanged documents are
skipped and changed ones are replaced.

## Two corpora

The knowledge base holds two corpora in the same `kb_chunks` table, kept apart
by the `corpus` field in metadata and the `segment` column.

- `richards` is product knowledge: the datasheets, specs and manuals for the
  Richards product lines. This is the default corpus.
- `pct` is company knowledge: material about PCT itself, drawn from the PCT
  Information folder.

Choose the corpus with the `--corpus` flag. It defaults to `richards`:

```
node ingestion/run.mjs "<path to the Richards folder>"
node ingestion/run.mjs "<path to the PCT Information folder>" --corpus pct
```

Each corpus manages only its own rows. Running one does not touch the other, so
the two can be ingested and re-ingested independently.

## Folder mapping

`ingestion/folderMap.mjs` maps the top-level Richards folders to product lines
and metadata. Customer lists, example customer communications, and the January
2026 meeting notes are excluded for now. Files at the corpus root are treated as
overview material.

`ingestion/pctFolderMap.mjs` handles the PCT Information corpus. Its internal
structure is not yet known here, so every included file is tagged as company
material under the `company` segment. The walker records each top-level subfolder
name in metadata, so the structure is kept and the mapping can be enriched once
the folders are known. The same protected folders are excluded.

## Checking the result

Two read-only scripts help confirm the chunks look right. They read from the
database and change nothing. Both need `DATABASE_URL` in the shell, and
`spotcheck.mjs` also needs `VOYAGE_API_KEY` to embed the query.

```
node scripts/status.mjs
node scripts/spotcheck.mjs "CV3000 pressure rating"
node scripts/spotcheck.mjs "who is PCT"
```

`status.mjs` prints totals and breakdowns by corpus, segment, sourceType,
Richards line, PCT folder, and content type. `spotcheck.mjs` runs the hybrid
search and prints the top results with title, section, line, source type and a
short preview.

## Search

`src/retrieve.mjs` provides hybrid search over `kb_chunks`. It runs three
candidate queries and fuses them with Reciprocal Rank Fusion:

- vector similarity on the embedding,
- lexical full text search on `content_tsv`,
- a model-code match, for example CV3000, weighted up so a code in the query
  lifts the right datasheet.

It accepts metadata `filters`, for example `{ line: 'marwin' }`, and every
result carries citation fields: title, page, section, source id, line, and the
`nameable` and `manufacturer` flags for the later answer layer. Filter keys are
restricted to plain identifiers so a request cannot inject SQL. No single
document may take more than three of the returned slots, so a keyword-heavy
document cannot crowd out the rest.

The search is served over HTTP:

```
POST /search   { "query": "CV3000 pressure rating", "filters": {}, "k": 8 }
```

Lexical search needs the second migration, which adds the `content_tsv` column
and the text and trigram indexes. Apply it with `npm run migrate`.

## Corpus cleanup

One-off maintenance scripts, all needing `DATABASE_URL`:

- `scripts/dedup.mjs [corpus]` removes byte-identical documents filed under more
  than one path, keeping one copy. Defaults to the richards corpus.
- `scripts/remove-sales-areas.mjs` removes the sales-areas postcode map, which
  is held as a structured region lookup rather than embedded.
- `scripts/inspect.mjs "<substring>"` reports the chunk count per matching
  document and samples a few chunks, to judge an oversized document.
- `scripts/remove-doc.mjs "<source_id>"` deletes one document by source id.

Re-ingestion no longer reintroduces byte-identical copies, since the walker
skips a content hash it has already seen in the same run.

## Research stage

The front of the sales funnel: signal sourcing and research feeding a `leads`
table for the outbound stage to draw from. Migration 003 adds `companies`,
`contacts`, `signals`, `leads` and a small `kv` store.

- `src/research/region.mjs` maps UK postcodes to the six sales areas. The
  table is a draft for Andy to verify, plain data so corrections are one-line
  edits, and unknown postcodes return null.
- `src/research/companiesHouse.mjs` searches and profiles companies and polls
  filings into `signals`, rate limited and deduped.
- `src/research/newsResearch.mjs` sweeps Tavily news for data centre build and
  contract signals; the query list is editable data.
- `src/research/findymail.mjs` resolves and verifies contact emails, logging
  every call and never spending a credit on an already verified contact.
- `src/research/icp.mjs` scores companies against the Marwin DC campaign ICP.
  Thresholds and weights are drafts for James and Andy, and every score stores
  an explainable breakdown.
- `src/research/linkedinResearch.mjs` is the socket for the Sales Navigator
  lane via Unipile. It reports unavailable until the accounts are live.

Two commands, both needing `DATABASE_URL` plus the research keys:

```
node --env-file=.env scripts/seed-accounts.mjs
node --env-file=.env scripts/research-run.mjs
```

The first seeds the named-account list and writes `NAMED_ACCOUNTS_DRAFT.md`
for Andy to curate. The second polls signals, refreshes ICP scores, and
upserts leads at stage researched; it is idempotent and safe to repeat.
Nothing in the research stage sends mail, and the kill switch stays on.

Contact discovery does not depend on LinkedIn. The research run resolves each
named account's official web domain (`src/research/domains.mjs`, conservative,
null rather than a guess) and pulls current directors from the public register
into `contacts` with provenance (`src/research/officerContacts.mjs`), skipping
secretaries and corporate officers and marking the decision orbit. Findymail
is never called automatically; spending credits on email resolution is a
decision for the outbound stage. `scripts/merge-duplicate-accounts.mjs` is the
one-off cleanup for the duplicated first seed, dry run by default.

## Usage logging and insights

Every co-pilot question is logged to `copilot_queries` (migration 005) after the
answer is sent, so logging never delays or fails a reply. Each row records the
question, the line or application filter the answer layer chose, whether the
answer declined (cited no sources, an honest proxy for a knowledge gap), the
citations actually used with their titles, how many sources retrieval offered,
and the latency. No user identity is logged, since there is none under the
shared access gate.

Three read-only endpoints summarise it. They are open, like the rest of the
API; when an access gate arrives they sit behind it with the other routes.

- `GET /api/insights/summary?days=30`: questions, decline count and rate, daily
  counts for a sparkline, top detected lines, and average latency.
- `GET /api/insights/gaps?days=90`: declined questions, newest first, with a
  repeat count for identical questions. Each is a candidate for knowledge capture.
- `GET /api/insights/top-docs?days=90`: the most-cited document titles.

The Insights section of the web app reads these three endpoints and renders
only live data; there are no sample values in the build.

## Web app

The web app is the approved design's full shell: a navy sidebar on desktop, a
bottom tab bar on mobile, and seven sections that each read live data.

- Co-Pilot is the chat. Answers arrive as cards with their sources as chips,
  and the thinking state shows the brand wave.
- Insights renders the usage log: reading cards with a thirty-day sparkline
  and answer-rate gauge, demand by line, knowledge gaps, most cited documents,
  and a young-log line while the log is small.
- Pipeline shows the funnel stages with live counts and the leads at each
  stage, with the qualification gate marked on the track.
- Accounts lists the named accounts with ICP scores, domains and Companies
  House matches, amber-flagged where either is missing. The detail panel holds
  the explainable score breakdown, recent signals, and register directors.
- Signals is the observation feed, filterable by kind, each linking to its
  account.
- Outbound is the designed placeholder for the next stage and reads the kill
  switch state from the API.
- Health shows corpus size, documents by line, last ingestion, database state,
  Graph connectivity, and the kill switch.
- The access gate screen is a visual preview; there is no server-side gate
  yet, and the screen becomes its front door when one arrives.

Six read-only endpoints feed the research sections: `/api/pipeline`,
`/api/accounts`, `/api/accounts/:id`, `/api/signals`, `/api/outbound/status`
and `/api/health/cards`. They are open like the rest of the API and sit
behind the access gate with everything else when it arrives.

## A note on this build

The code in this repository was written and verified to load in a clean
container. The deploy to Railway, the migration against the live database, and
the corpus ingestion all need access that the build container does not have:
the Railway project, the database connection string, the Voyage key, the PDF
tooling, and the local corpus folder. Run those four steps from a machine that
has them, using the instructions above.
