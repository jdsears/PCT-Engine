# Going live and handing over

The engine currently runs in its testing shape: John's personal mailbox as the
engine mailbox, the kill switch on, test sends to internal addresses, and the
rehearsal lane for walking the journey end to end. This file is the memory of
everything that has to change to go live and to hand the day to day to James
and Andy. Tick things off in place; the file is part of the repo so the list
is versioned like everything else.

Owners are suggestions to be agreed at handover. MoonBoots (John) stays the
engineering contact throughout.

## A. The reset, so live starts from zero

- [ ] End every rehearsal lane, from the Outbound banner. Each teammate's
      rehearsal runs on its own lane and can be ended alone; for the reset use
      End all rehearsals (or End this rehearsal on the last remaining lane),
      which removes every rehearsal lead, draft, send, reply and stand-in
      contact across all lanes.
- [ ] Set `REPLY_CAPTURE_TEST_SENDS=off` on Railway (testing-window flag).
- [ ] Reject any drafts left over from the testing window and regenerate
      fresh ones, so nothing goes out on stale grounding.
- [ ] Sanity-check no real contact was suppressed or marked bounced during
      testing: the rehearsal lane could not do it, but check before trusting.
      From a machine with `.env`:
      `SELECT full_name, email, suppressed, email_bounced_at FROM contacts WHERE suppressed OR email_bounced_at IS NOT NULL;`

## B. Mailboxes and sending identity

The live sending model, decided with James in July 2026: each regional rep
gets a dedicated prospecting address, separate from their actual mailbox so
campaign mail stays out of HubSpot and the day-to-day inbox, and personal
from the first touch. The distinguishing feature is the dot in the local
part, not the capitalisation (capitals in email addresses are cosmetic):

| Sales areas | Rep | Actual | Prospecting |
| --- | --- | --- | --- |
| 1 (Scotland) | Guy Beavan | guybeavan@pctflow.com | guy.beavan@pctflow.com |
| 2 + 3 (West) | Craig Downs | craigdowns@pctflow.com | craig.downs@pctflow.com |
| 4 + 6 (East) | Patrick Mangell | patrickmangell@pctflow.com | patrick.mangell@pctflow.com |

- [ ] Ask James which rep owns sales area 5; it is not in his mapping, and
      until it is, area 5 leads send from `ENGINE_MAILBOX` with the single
      `SENDER_*` identity.
- [ ] James: create the three prospecting mailboxes with Exchange Online
      (plan 1) licences. Real licensed mailboxes so Graph can send and read
      as each of them; the app permissions already granted apply org-wide.
- [ ] Set `OUTBOUND_SENDERS` on Railway (one JSON line; titles optional):
      `[{"areas":["1"],"name":"Guy Beavan","mailbox":"guy.beavan@pctflow.com"},{"areas":["2","3"],"name":"Craig Downs","mailbox":"craig.downs@pctflow.com"},{"areas":["4","6"],"name":"Patrick Mangell","mailbox":"patrick.mangell@pctflow.com"}]`
      With it set, each lead sends from its area's rep, the signature carries
      the rep's name, replies are captured from every rep mailbox, and
      responses thread from the mailbox the reply arrived in. Unset, or for
      an unmapped area, everything falls back to the single `ENGINE_MAILBOX`.
- [ ] Run `npm run migrate` (020 records sender per send and mailbox per
      reply).
- [ ] Move `ENGINE_MAILBOX` off johnsears@pctflow.com to a neutral live
      mailbox; it remains the fallback sender and the intel inbox.
- [ ] Set `SENDER_NAME` and `SENDER_TITLE` (or a whole `SENDER_SIGNATURE`) as
      the fallback identity. The opt-out line is appended automatically.
- [ ] Set `MEETING_LINK` to the live booking page (Microsoft Bookings or
      similar) so response drafts can carry the meeting ask.
- [ ] Re-run `node scripts/check-mail-dns.mjs` if the sending domain or DNS
      has changed. pctflow.com passed SPF, DKIM and DMARC in July 2026.
- [ ] Keep the first fortnight on every brand-new mailbox gentle: the three
      prospecting addresses start with no sending history, so small volumes
      per address matter even more than they did with one mailbox. The
      approval-per-send model and caps already enforce this; do not raise
      them for launch week.

## C. Configuration on the day

- [ ] `INTEL_SENDERS`: delete the variable so it falls back to the whole
      `TEAM_EMAILS` list (it was narrowed to John's moonboots address while
      the engine used his personal mailbox).
- [ ] SharePoint read access, optional but recommended: the app needs
      `Sites.Selected` plus a read grant on the Sales Engine site, and then
      every ingest source flag takes `sharepoint:<path>` so pricing and data
      sheets always read the current file. `scripts/sharepoint-probe.mjs`
      tests the access and prints the exact grant steps for James when it is
      missing. `SHAREPOINT_SITE` overrides the default site if it is ever
      renamed.
- [ ] `PRICE_WORKBOOK`: the customer pricing workbook's `sharepoint:` path, so
      every price ingest reads the live sheet rather than someone's download.
      Find the exact path with `scripts/sharepoint-probe.mjs --path "..."`. The
      Richards and Equilibar margins live on its Equilibar-Richards tab, which
      reads through to the hidden Master Formulas rows the ingest parses.
- [ ] `TEAM_EMAILS`: confirm the live list (James, Andy, John during the
      transition). This drives the digest, intel senders, test recipients and
      the reply and meeting notifications.
- [ ] Health page: signal engine on, email discovery on if Findymail spend is
      agreed, people search on if James is happy with the background cadence
      on his LinkedIn account, auto-draft as desired.
- [ ] Outbound page: Reply capture on, Follow-ups on.
- [ ] `FOLLOWUP_DAYS`: confirm the live cadence (default 4,7).
- [ ] LinkedIn caps sane: `LINKEDIN_DAILY_CAP` (default 40) and
      `LINKEDIN_INVITE_DAILY_CAP` (default 10). Invites remain one per human
      click from the Studio connect queue.

## D. The one deliberate act

- [ ] Set `MAIL_KILL_SWITCH=off` on Railway. This is the go-live moment:
      before it, no prospect is reachable whatever else is on; after it,
      approved drafts send to real prospects when a person clicks send.
      Agree in advance who is authorised to flip it, and flip it last.
- [ ] Decide whether `OUTBOUND_TEST_SENDS` stays on for the team's test
      button. It is safe either way; it only ever reaches the internal list.

## E. Handing the day to day to James and Andy

The daily surfaces, and a suggested split:

- [ ] Outbound review queue and Conversations tab (suggested: Andy).
      Approve, edit or reject drafts; a blocking flag means a named end
      customer and cannot be approved, rewrite instead. Send is one click per
      email. Replies are triaged automatically; ambiguous ones need a human
      read. Meeting booked and Hand off are one click each; the handoff pack
      email carries the whole story.
- [ ] Studio: post drafts and the connect queue (suggested: James, it is his
      LinkedIn account). Posts are copy and publish by hand, never automatic.
      Send invite sends one invitation per click through the connected
      account, with the note editable first.
- [ ] Signals and Watchlist (suggested: Andy). The watchlist is the engine
      feeding accounts back to the team; the orbit titles in
      `src/research/orbitRules.mjs` are plain data for Andy to refine.
- [ ] Co-pilot and configurator: everyone; the insights page shows what it
      could and could not answer, feed gaps back to MoonBoots.
- [ ] Walk James and Andy through the honesty rules once: the engine only
      states what research supports, end customers are never named, opt-outs
      are honoured automatically and forever, and nothing outward happens
      without a human click.
- [ ] Confirm both have the app URL and access key, and the Teams bot.
- [ ] Agree the escalation path: anything erroring or behaving oddly goes to
      John (MoonBoots) with a screenshot or the exact error text.

## F. Secrets to rotate at handover

These were shared over ordinary channels during the build and should be
rotated once the team takes over, each lives in Railway (and `.env` on the
one machine that runs migrations), never in the repo:

- [ ] `APP_ACCESS_KEY` (was emailed during testing). Rotate and re-share.
- [ ] The Teams bot client secret (was shared by screenshot during setup).
      Rotate in the Azure app registration and update Railway.
- [ ] `MS_CLIENT_SECRET` if it was ever shared outside Railway and `.env`.
- [ ] Review API key ownership: Anthropic, Voyage, Tavily, Findymail and
      Unipile keys are MoonBoots accounts today; move billing to PCT if that
      is the long-term arrangement.
- [ ] John's Mac has the database public URL in `~/.zshrc`; remove it when
      migration duty moves, and note migrations must run from a machine with
      `.env` against the public database URL.

## G. Parked work, decide before or shortly after go-live

- [ ] Regional or per-rep sending (see section B; small build once addresses
      are decided).
- [ ] Price lookup: parked until James locates the price spreadsheet on the
      Sales Engine SharePoint site. Phase 0 inspection script is ready on the
      `claude/price-lookup` branch. Cost and purchase pricing stays excluded
      and masked, standing rule.
- [ ] Email 3 proof piece for the outbound sequence (deferred from the
      original brief).
- [ ] Keep foreign stories for named accounts as account intel rather than
      rejecting them (offered, not yet approved).
- [ ] A proper off switch for the intel inbox on the Health page (stopgap
      today is a dummy `INTEL_SENDERS` address).
- [ ] Andy's curated contact pack, to sharpen the decision-orbit targeting.

## H. First live week

- [ ] Start with a handful of approved sends, not the whole queue.
- [ ] Watch the Monday digest: sends, replies, reply rate, meetings, handoffs
      are the scoreboard, there are no open rates by design.
- [ ] Read every triage notification in week one to confirm the verdicts
      match human judgement; anything misclassified goes to John with the
      reply text.
- [ ] Confirm the first handoff pack reaches the right person and reads
      correctly before relying on it.
