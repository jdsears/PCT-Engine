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

- [ ] End rehearsal and wipe, from the Outbound banner. Removes every
      rehearsal lead, draft, send, reply and stand-in contact.
- [ ] Set `REPLY_CAPTURE_TEST_SENDS=off` on Railway (testing-window flag).
- [ ] Reject any drafts left over from the testing window and regenerate
      fresh ones, so nothing goes out on stale grounding.
- [ ] Sanity-check no real contact was suppressed or marked bounced during
      testing: the rehearsal lane could not do it, but check before trusting.
      From a machine with `.env`:
      `SELECT full_name, email, suppressed, email_bounced_at FROM contacts WHERE suppressed OR email_bounced_at IS NOT NULL;`

## B. Mailboxes and sending identity

- [ ] Decide the live sending model: regional mailboxes or per-rep addresses
      (agreed direction; the engine currently sends everything from one
      `ENGINE_MAILBOX`). Once the addresses are decided, MoonBoots builds the
      per-region or per-rep sender selection; it is a contained change, the
      whole conversation machinery sits behind one send function.
- [ ] Create the live mailbox or mailboxes in Microsoft 365. Real mailboxes,
      not distribution lists; shared mailboxes are free and work.
- [ ] Move `ENGINE_MAILBOX` off johnsears@pctflow.com to the live mailbox.
- [ ] Set `SENDER_NAME` and `SENDER_TITLE` (or a whole `SENDER_SIGNATURE`) to
      the agreed live identity. The opt-out line is appended automatically.
- [ ] Set `MEETING_LINK` to the live booking page (Microsoft Bookings or
      similar) so response drafts can carry the meeting ask.
- [ ] Re-run `node scripts/check-mail-dns.mjs` if the sending domain or DNS
      has changed. pctflow.com passed SPF, DKIM and DMARC in July 2026.
- [ ] Keep the first fortnight on any brand-new mailbox gentle: small volumes.
      The approval-per-send model and caps already enforce this; do not raise
      them for launch week.

## C. Configuration on the day

- [ ] `INTEL_SENDERS`: delete the variable so it falls back to the whole
      `TEAM_EMAILS` list (it was narrowed to John's moonboots address while
      the engine used his personal mailbox).
- [ ] `TEAM_EMAILS`: confirm the live list (James, Andy, John during the
      transition). This drives the digest, intel senders, test recipients and
      the reply and meeting notifications.
- [ ] Health page: signal engine on, email discovery on if Findymail spend is
      agreed, auto-draft as desired.
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
