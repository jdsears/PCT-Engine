# CLAUDE.md

Working notes for Claude Code on the PCT Engine repo: the knowledge co-pilot, the
part-number configurator, the research funnel, and the outbound stage.

## Voice (all generated text: replies, prose, UI strings, emails)

- British English, calm and plain, closer to an engineer writing to a peer than
  to marketing copy.
- No em dashes or en dashes. Use commas or full stops.
- Never the word "genuinely".
- No exclamation marks.
- Sentence case for UI labels and headings, not title case.
- The answer layer runs prose through a voice gate and outbound drafts through a
  stricter one. Match that register by hand as well.

## Honesty (the spine)

- The co-pilot answers only from the documents and cites them; when something is
  not in the corpus it says so rather than guessing.
- The configurator never invents a part-number code.
- An outbound draft may state only what the lead's research supports; an
  untraceable claim is flagged before a human ever sees the draft as clean.
- The nameable-supplier guardrail holds: name the lines that may be named
  (Richards, Marwin, Equilibar and the like), never the white-label OEMs.
- Prospecting geography: the Republic of Ireland is out of scope (John, August
  2026, stated for Richards prospecting; the live campaign gates are UK-scoped
  anyway). Northern Ireland is in scope. Republic companies stay on the
  register as customers, served when they come to us, never prospected. One
  carve-out (John, 7 August 2026, after James's design-in note): Irish
  engineering houses that design UK facilities are in scope as consultant
  targets, because the spec decision for a UK project can sit in Dublin. The
  rule stands unchanged for Republic companies as end targets.

## Git workflow

- `main` is the single source of truth and the deploy branch. The live service
  reads `main`.
- All work happens on short-lived branches taken from `main`, opened as pull
  requests, reviewed, and merged only by John, then deleted. There is no
  long-lived working branch.
- Push your branch and open a PR. Do not merge to `main` yourself unless John
  explicitly authorises a specific one-off.
- Keep the migration sequence contiguous (`NNN_name.sql`, no gaps) and run the
  gate before pushing.

## Verification gate

- `npm test` runs the configurator, outbound, research and Teams-state gates,
  seventy-plus checks.
- `npm run build` in `web/` must stay clean; `npm run migrate` applies pending
  migrations in order.
- Secrets live in `.env` and Railway only, never in the repo. `.env` is ignored.

## Environment note

The build container has no database, no Voyage or Anthropic key, and no live
mailbox. Anything needing those (migrations against the live database, generating
real drafts, sending) runs on a machine that has `.env`, not in the container.
