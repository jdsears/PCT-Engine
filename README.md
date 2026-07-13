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
- `src/research/linkedinResearch.mjs` is the Sales Navigator lane via Unipile,
  described in its own section below. The research run never calls it; the
  lane has its own orchestrator and daily cap.

Two commands, both needing `DATABASE_URL` plus the research keys:

```
node --env-file=.env scripts/seed-accounts.mjs
node --env-file=.env scripts/research-run.mjs
```

The first seeds the named-account list and writes `NAMED_ACCOUNTS_DRAFT.md`
for Andy to curate. The second polls signals, refreshes ICP scores, and
upserts leads at stage researched; it is idempotent and safe to repeat.
Nothing in the research stage sends mail, and the kill switch stays on.

The same run also lives in the service as the signal engine
(`src/research/runResearch.mjs`), switched on and off from the Health page.
When on, the service runs it every `ENGINE_RUN_INTERVAL_HOURS` hours (default
six), with a Run now button for an immediate pass. The switch and the last
run's summary live in the `kv` store, so toggling needs no redeploy and
survives restarts, and the card shows which research keys are missing on the
service. The engine only finds signals and pulls leads: drafting and sending
stay manual and gated, and the LinkedIn lane keeps its own capped orchestrator,
untouched by the engine.

`scripts/export-curation-pack.mjs` writes `CURATION_PACK.md`, the single brief
that goes to Andy for sign-off: the named accounts with their scores and the
count of likely decision-makers found, the region table, the decision-orbit
job titles, and the ICP thresholds and contactability draft for him and James.
It reads the live database and is grounded with the current score
distribution. Read-only, safe to re-run, and the document is regenerated each
time so it always reflects the latest data and rules.

Contact discovery does not depend on LinkedIn. The research run resolves each
named account's official web domain (`src/research/domains.mjs`, conservative,
null rather than a guess) and pulls current directors from the public register
into `contacts` with provenance (`src/research/officerContacts.mjs`), skipping
secretaries and corporate officers. A register director counts in the decision
orbit only when the stated occupation names a specifier role, the same title
test (`src/research/orbitRules.mjs`) the LinkedIn lane uses, so a board with no
stated trades does not inflate the count. Findymail
is never called automatically; spending credits on email resolution is a
decision for the outbound stage. That deliberate step is
`scripts/discover-emails.mjs`: dry run by default, listing which decision makers
would be looked up and by which route (LinkedIn profile, or name and company
domain), and `--apply --limit N` spends the credits for the best accounts
first. A verified contact is never looked up again, and resolved emails feed
the outbound drafts and the staged contactability scoring. `scripts/merge-duplicate-accounts.mjs` is the
one-off cleanup for the duplicated first seed, dry run by default.

## Signal relevance, routing and the BD watchlist

News results only become signals through a relevance gate
(`src/research/relevance.mjs`): a result must be about a data centre
specifically, and about that data centre being built, contracted, financed for
a build or expanded. The classifier judges the story's primary subject from the
title and content, never sees the search query that found the result, judges a
clear title on its own when the content is paywall boilerplate, and rejects on
any doubt. A confirmed signal is routed by its UK dimension, not the operator's
nationality: `uk_project` is lead fuel, `expansion_watch` is business
development intelligence, and a build wholly abroad is dropped as context.
`foreign_only` requires a specific named foreign location.

UK-project signals are matched to named accounts by a conservative matcher
(`src/research/match.mjs`, tolerant brand-to-registered-entity tokens, a unique
confident candidate links, anything ambiguous stays unmatched), run as a step in
`research-run.mjs`. Matched project events drive leads and event-led openers
through the opener-grade rules in `src/outbound/openerGrade.mjs`: only a real
project event opens a cold email, an administrative filing never does.

`scripts/reprocess-signals.mjs` re-judges stored signals through the gate, dry
run by default and reversible with `--apply`. The Watchlist section of the web
app lists `expansion_watch` operators, the engine feeding targets back to the
team, distinct from the lead pipeline.

## LinkedIn research lane

Sales Navigator through Unipile, reading through James's account. Research
only, permanently: the lane discovers and enriches contacts and writes to our
own `contacts` table. It contains no messaging, no connection requests, no
posting and no profile edits, and the client (`src/research/unipile.mjs`)
exposes no write-capable route. The build environment cannot reach the Unipile
docs site, so the routes are centralised in that client's `ROUTES` map and
`scripts/unipile-check.mjs` verifies them against the live API first.

Rate discipline is structural: calls are sequential with a randomised 4 to 9
second pause, every call is logged to `unipile_calls` (migration 006), and the
same ledger enforces `LINKEDIN_DAILY_CAP` per UTC day. Any account-health error
from Unipile stops the run immediately, no retry.

Setting up:

1. Set `UNIPILE_DSN` and `UNIPILE_API_KEY`, then run
   `node --env-file=.env scripts/unipile-check.mjs`. It diagnoses key versus
   DSN, reports the LinkedIn account's health, prints the `account_id` to set
   as `UNIPILE_ACCOUNT_ID`, and confirms Sales Navigator with one minimal
   search.
2. `node --env-file=.env scripts/linkedin-enrich.mjs` is a dry run: it prints
   what it would search and write, calling nothing. `--apply` does the work,
   `--company "Name"` scopes to one account, `--limit` sets companies per run
   (default 5, deliberately small), and `--new` advances coverage by skipping
   accounts already people-searched in the last thirty days, so each run picks
   up the next untouched accounts by score rather than redoing the done ones.

Per company it runs the people search. The decision-makers for flow
instrumentation are the design, mechanical, building services, controls and
HVAC engineers, the project managers, the water and cooling specialists, and
the estimators, contracts and preconstruction people who select and buy the
kit at the M&E contractors, not the statutory company director, so the search
keys on those roles. The orbit titles in `src/research/orbitRules.mjs` lead
with the chilled-water cooling roles PCT sells into and are plain data for Andy
to refine. The people search is scoped to the UK (`LINKEDIN_COUNTRY`, default uk):
it over-fetches, drops results that name another country, and keeps UK and
unstated locations, so a hyperscaler's worldwide staff do not crowd the batch.

Register-director enrichment is opt-in, behind `--directors`. The statutory
directors are not the specifiers, and across the first runs the enrichment
wrote nothing while consuming the daily cap, so it is off by default. With the
flag, a write needs exactly one confident match: surname and first name
agreement plus a verified employer and a real job title (a headline that only
names the company is not a title, so it yields no write). Those searches use
first and last name and the core company name, not the register strings, and
spend one more call on the profile when the row does not prove the employer, so
a director costs at most two Unipile calls.

Rows enriched in the last thirty days are never overwritten. Findymail email
discovery inside the run requires `EMAIL_DISCOVERY=on` and stays off until
Andy's curated pack is applied.

Because discovered rows are not re-touched for thirty days, a change to the
orbit titles does not re-classify the contacts already on file. After editing
`orbitRules.mjs`, run `node scripts/remark-orbit.mjs` to recompute the orbit
flag from the stored titles, dry run by default and `--apply` to write it. It
makes no external calls, so a tuning cycle costs nothing.

The ICP contactability component is staged as a draft alongside this lane:
`ICP_CONTACTABILITY=on` rebalances the weights (named account 20, type fit 20,
signals 30, CH health 20, contactability 10) so reachable accounts score
higher. It stays off until James and Andy approve; the curation pack prints
the proposal.

## Outbound testing harness

The outbound stage drafts a first-touch email per researched lead, queues it for
a human to approve, and can send a test copy to internal mailboxes only. Nothing
reaches a prospect in this phase, and two independent gates see to that.

- `scripts/draft-coldopen.mjs` generates grounded cold-open (Email 1) drafts for
  the highest-scoring researched leads and queues them as `draft` for approval.
  `--lead <id>` scopes to one lead, `--limit N` caps the batch. One open draft per
  lead, so re-running never duplicates, and the lead stays at the researched stage
  since nothing here sends.

  ```
  node --env-file=.env scripts/draft-coldopen.mjs
  node --env-file=.env scripts/draft-coldopen.mjs --lead 42
  ```

  The same generation runs from the Outbound page's Generate drafts button,
  and, when the auto-draft switch on that page is on, at the end of each signal
  engine cycle for newly researched leads. A generated draft always lands as
  draft for human review; approval and sending are unchanged, and the banner
  shows the last drafting run's numbers.

- A draft may state only what the lead's research supports, the outbound twin of
  the configurator refusing to invent a code. `gatherGrounding` assembles the only
  allowed inputs: the triggering signal, the ICP reason, the contact record (name
  and role only if recorded), and Marwin product facts retrieved from the corpus
  with citations. Thin grounding is handled by writing less, never by inventing.

- `draftColdOpen` writes a short, plain, peer-to-peer email from that grounding,
  then `checkGrounding`, a separate strict pass, lists any factual claim the
  grounding does not support. If anything is unsupported it attempts one revision
  and re-checks; whatever remains is stored in `grounding_flags` and shown
  prominently in the review queue, so a draft is never silently stored as clean.
  The text then passes the outbound voice gate (no em or en dashes, no "genuinely",
  no exclamation marks) and the supplier guardrail before storage.

- Each draft stores its `grounding` (the signal, ICP reason, product citations and
  contact role) alongside its `grounding_flags`, so the reviewer sees exactly what
  it drew on and what could not be traced.

- The Outbound section of the web app is the review queue. Each draft shows its
  lead, the evidence behind it and the recipient, with the subject and body
  editable in place. A human approves, rejects or edits before anything sends.

- Two gates, by design, both off by default:
  - `MAIL_KILL_SWITCH` governs real prospect sends. While it is on, no email
    goes to a prospect. This phase exposes no prospect-send action at all; the
    path exists in `mail.mjs` for a later phase.
  - `OUTBOUND_TEST_SENDS` plus `OUTBOUND_TEST_RECIPIENTS` govern internal test
    sends. A test send is refused unless test sends are enabled and the recipient
    is on the allowlist, so the send mechanism can be exercised while the kill
    switch stays on, with no chance of reaching a prospect. Every attempt, test
    or real, sent or refused, is logged to `outbound_sends`.

Once the testing window closes, a real prospect send is available behind the kill
switch. The Outbound tab shows a send action only on an approved draft; it is
allowed only when the recipient has a deliverable, non-suppressed email, and
`sendMail` is the final gate, so while `MAIL_KILL_SWITCH` is on the send is
refused and nothing changes. A real send is logged, marks the draft sent, and
advances the lead to the outbound stage. The send is made in two steps, create
then send, so the conversation id is captured for reply matching.

`scripts/outbound-replies.mjs` polls the engine mailbox for prospect replies,
matches each to the send it answers (by conversation first, then by address),
records it and advances that lead to replied. Dry run by default, `--apply`
writes; it dedupes on the Graph message id and keeps the last poll time in `kv`.

```
node --env-file=.env scripts/outbound-replies.mjs
node --env-file=.env scripts/outbound-replies.mjs --apply
```

During the internal testing window, `REPLY_CAPTURE_TEST_SENDS=on` widens the
poller to match replies to internal test sends too, so the replied stage can be
demonstrated end to end without a prospect. Leave it off in normal running.

Migration 009 adds `outbound_drafts` and the `outbound_sends` audit log; migration
010 adds the reply-correlation columns and the `outbound_replies` table; migration
011 adds the `grounding` and `grounding_flags` columns. Apply them with
`npm run migrate`.

## Usage logging and insights

Every co-pilot question is logged to `copilot_queries` (migration 005). Each row
records the question, the line or application filter the answer layer chose,
whether the answer declined (cited no sources, an honest proxy for a knowledge
gap), the citations actually used with their titles, how many sources retrieval
offered, the latency, and the channel (web or teams). No user identity is
logged, since there is none under the shared access gate. The insert happens
just before the reply so the answer can carry its row id; a logging failure
still never fails the answer.

Each web answer carries quiet thumbs up and down chips (migration 013). A
verdict posts to `POST /api/feedback` against the logged row, one verdict per
answer, no identity. The insights summary reports the feedback counts and the
web versus Teams split, so a testing week produces structured data rather than
anecdotes.

Three read-only endpoints summarise it. They sit behind the access gate with
the other data routes.

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

- Co-Pilot is the chat. Its empty state is four shortcut cards (build a part
  number, product and spec questions, how PCT sells, and a price card held as
  Coming until pricing loads), so a first-time user sees what it can do.
  Answers arrive as cards with their sources as chips and quiet feedback
  thumbs, the thinking state shows the brand wave, and a guided part-number
  build runs in the same conversation.
- Insights renders the usage log: reading cards with a thirty-day sparkline
  and answer-rate gauge, demand by line, knowledge gaps, most cited documents,
  and a young-log line while the log is small.
- Pipeline shows the funnel stages with live counts and the leads at each
  stage, with the qualification gate marked on the track. The list searches
  companies and contacts, sorts by score, company or region, and shows 10 to
  100 rows. Analytics beneath cover the median score, register-contact and
  domain coverage, signal momentum, leads by region, and the score spread.
- Accounts lists the named accounts with ICP scores, domains and Companies
  House matches, amber-flagged where either is missing. The detail panel holds
  the explainable score breakdown, recent signals, and register directors.
- Signals is the observation feed, filterable by kind, each linking to its
  account. Gate-rejected news never shows.
- Watchlist is the business development list: data centre operators the engine
  has spotted expanding, where a UK move is plausible but not yet a project.
- Outbound is the designed placeholder for the next stage and reads the kill
  switch state from the API.
- Health shows corpus size, documents by line, last ingestion, database state,
  Graph connectivity, and the kill switch.
- The access gate is the shared-key sign in. It shows on a 401 and up front
  for an unauthed visitor, and the sidebar button opens it any time.

Seven read-only endpoints feed the research sections: `/api/pipeline`,
`/api/pipeline/analytics`,
`/api/accounts`, `/api/accounts/:id`, `/api/signals`, `/api/outbound/status`
and `/api/health/cards`. Like `/ask`, `/search` and the insights endpoints,
they sit behind the access gate.

## Access gate

A single shared key guards the data for the pilot. Set `APP_ACCESS_KEY` to a
strong value in the environment, for example `openssl rand -base64 32`.

- When the key is set, `/ask`, `/search` and everything under `/api` require a
  valid session. The static app shell stays public; the data does not. The
  one exception is `/health`, kept open for the platform health check.
- The gate screen posts the key to `POST /api/access`. On a match the server
  sets an httpOnly cookie holding a hash of the key, never the key itself, and
  compares it in constant time. `GET /api/access/status` reports whether the
  gate is on and whether this request is authed, so the UI can show the gate
  up front. A failed attempt waits a short moment so the key cannot be
  brute-forced cheaply.
- When `APP_ACCESS_KEY` is not set the gate is open and a warning is logged, so
  local runs and the existing deploy keep working until the key is configured.
  Set the key in Railway to turn the gate on.

## Co-Pilot in Teams

The Co-Pilot also answers inside Microsoft Teams in personal, one to one chat,
reusing the same `ask()` pipeline (`src/teams.mjs`). A Teams message gets a
typing indicator, the answer, then one compact `Sources:` line from the cited
documents, with nothing shown when the answer declines. Short-term conversation
state is held in memory per Teams conversation (`src/teamsState.mjs`), so
follow-up questions keep their thread and a guided part-number build works
across turns; nothing is persisted, the conversation id is an in-memory routing
key only, and state expires after thirty minutes.

- The endpoint is `POST /api/teams/messages`. It is the one path under `/api`
  that the access gate does not cover, on purpose: its protection is Bot
  Framework token validation inside the adapter, not the shared key. Until
  `TEAMS_BOT_APP_ID` and `TEAMS_BOT_APP_PASSWORD` are set it reports not
  configured and the rest of the service is unaffected.
- Migration 007 adds a `channel` column to `copilot_queries`, defaulting to
  `web`; Teams questions log as `teams`. No user identity is stored, not the
  name, the directory id, nor the conversation id. Attribution stays a future
  decision to take with PCT.
- The bot is a separate, single-tenant app registration from the Graph app, so
  its reach is its own. The brief's registration route is the Teams Developer
  Portal bound to an Entra app, no Azure subscription needed. Confirm the
  current portal steps and manifest version against the Microsoft docs when
  registering; the manifest version lives in `teams/manifest.template.json` for
  a one-line change.

The app package is built reproducibly. The icons in `teams/icons` are committed
PNGs from the brand logo, so building needs only Node and `zip`:

```
TEAMS_BOT_APP_ID=<the bot app id> node scripts/build-teams-package.mjs
```

That writes `pct-copilot-teams.zip` at the repo root for upload in the Teams
admin centre. `JAMES_TEAMS_STEPS.md` is the plain-English runbook for PCT's
admin to register the bot and allow the app.

## A note on this build

The code in this repository was written and verified to load in a clean
container. The deploy to Railway, the migration against the live database, and
the corpus ingestion all need access that the build container does not have:
the Railway project, the database connection string, the Voyage key, the PDF
tooling, and the local corpus folder. Run those four steps from a machine that
has them, using the instructions above.
