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

## A note on this build

The code in this repository was written and verified to load in a clean
container. The deploy to Railway, the migration against the live database, and
the corpus ingestion all need access that the build container does not have:
the Railway project, the database connection string, the Voyage key, the PDF
tooling, and the local corpus folder. Run those four steps from a machine that
has them, using the instructions above.
