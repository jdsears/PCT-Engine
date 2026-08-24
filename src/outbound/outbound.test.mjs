// Guards that matter most: a draft must never reach a prospect by accident. These
// exercise only the refusal paths, which return before any network call, so the
// gate runs offline. The actual delivery path is not tested here, by design.
import { sendMail, sendMailTest, sendInternal, isTestRecipient, digestRecipients, textToHtml, blockedByKillSwitch } from '../mail.mjs';
import { renderDigest, renderDigestHtml, humanDate, digestDue } from '../digest.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { outboundVoice, voiceClean } from './draft.mjs';
import { canSendReal, matchReply } from './sendDecision.mjs';

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  pass  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); fail++; }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

console.log('Outbound mail guards (no draft may reach a prospect):');

await check('a real send is refused while the kill switch is on (the default)', async () => {
  delete process.env.MAIL_KILL_SWITCH;
  const r = await sendMail({ to: 'buyer@prospect.example', subject: 's', html: '<p>h</p>' });
  assert(r.sent === false && r.reason === 'kill switch on', JSON.stringify(r));
});

await check('a test send is refused while test sends are disabled', async () => {
  delete process.env.OUTBOUND_TEST_SENDS;
  const r = await sendMailTest({ to: 'alice@example.com', subject: 's', html: '<p>h</p>' });
  assert(r.sent === false && r.reason === 'test sends disabled', JSON.stringify(r));
});

await check('a test send is refused for a recipient off the allowlist, even when enabled', async () => {
  process.env.OUTBOUND_TEST_SENDS = 'on';
  process.env.OUTBOUND_TEST_RECIPIENTS = 'alice@example.com';
  const r = await sendMailTest({ to: 'buyer@prospect.example', subject: 's', html: '<p>h</p>' });
  assert(r.sent === false && r.reason === 'recipient not on the internal allowlist', JSON.stringify(r));
});

await check('the allowlist matches case-insensitively and rejects strangers', () => {
  process.env.OUTBOUND_TEST_RECIPIENTS = 'Alice@Example.com, bob@example.com';
  assert(isTestRecipient('alice@example.com'), 'lower-cased match');
  assert(isTestRecipient(' BOB@EXAMPLE.COM '), 'trim and upper match');
  assert(!isTestRecipient('buyer@prospect.example'), 'stranger rejected');
  assert(!isTestRecipient(''), 'empty rejected');
});

await check('the kill switch invariant: on means no prospect is reachable, ever', async () => {
  // With the kill switch on, the real send path can reach only the internal
  // allowlist, and only while test sends are on (the rehearsal lane). A
  // prospect address is refused whatever the other switches say.
  process.env.OUTBOUND_TEST_SENDS = 'on';
  process.env.OUTBOUND_TEST_RECIPIENTS = 'alice@example.com';
  process.env.MAIL_KILL_SWITCH = 'on';
  const r = await sendMail({ to: 'buyer@prospect.example', subject: 's', html: '<p>h</p>' });
  assert(r.sent === false && r.reason === 'kill switch on', JSON.stringify(r));
  assert(!blockedByKillSwitch('alice@example.com'), 'an allowlisted teammate stays reachable for rehearsals');
  process.env.OUTBOUND_TEST_SENDS = 'off';
  const r2 = await sendMail({ to: 'alice@example.com', subject: 's', html: '<p>h</p>' });
  assert(r2.sent === false && r2.reason === 'kill switch on', 'test sends off restores the total block');
});

console.log('\nOutbound voice and rendering:');

await check('the outbound voice strips dashes, exclamation marks and "genuinely"', () => {
  const clean = outboundVoice('Hello — this is genuinely great! Really helpful!');
  assert(voiceClean(clean), `not clean: ${clean}`);
  assert(!/genuinely/i.test(clean) && !/[—–!]/.test(clean), clean);
});

await check('plain text renders to escaped, paragraphed HTML', () => {
  const h = textToHtml('A <b>tag</b>\n\nB line one\nline two');
  assert(h.includes('&lt;b&gt;') && !h.includes('<b>'), 'must escape angle brackets');
  assert(h.includes('<p>') && h.includes('<br>'), 'must wrap paragraphs and keep line breaks');
});

console.log('\nThe weekly digest (internal mail only, provable schedule):');

await check('TEAM_EMAILS is the shared default and the specific lists override it', () => {
  delete process.env.DIGEST_RECIPIENTS;
  delete process.env.OUTBOUND_TEST_RECIPIENTS;
  process.env.TEAM_EMAILS = 'Team@Example.com';
  assert(digestRecipients().includes('team@example.com'), 'the digest falls back to the team list');
  assert(isTestRecipient('team@example.com'), 'test recipients fall back to the team list');
  process.env.DIGEST_RECIPIENTS = 'only@example.com';
  assert(digestRecipients().length === 1 && digestRecipients()[0] === 'only@example.com', 'a specific list overrides the team list');
  delete process.env.DIGEST_RECIPIENTS;
  delete process.env.TEAM_EMAILS;
});

await check('internal digest mail refuses anyone off the digest list', async () => {
  delete process.env.DIGEST_RECIPIENTS;
  delete process.env.TEAM_EMAILS;
  const none = await sendInternal({ to: 'alice@example.com', subject: 's', html: '<p>h</p>' });
  assert(none.sent === false, 'an empty digest list refuses everyone');
  process.env.DIGEST_RECIPIENTS = 'alice@example.com';
  const off = await sendInternal({ to: 'stranger@else.example', subject: 's', html: '<p>h</p>' });
  assert(off.sent === false && /digest list/.test(off.reason), JSON.stringify(off));
});

await check('the digest is due Monday morning and only once', () => {
  const mon8 = Date.UTC(2026, 6, 13, 8);   // Monday 08:00 UTC
  const mon6 = Date.UTC(2026, 6, 13, 6);   // Monday, too early
  const tue = Date.UTC(2026, 6, 14, 9);    // Tuesday
  assert(digestDue({ lastSentAt: null, now: mon8 }), 'first ever digest sends on Monday morning');
  assert(!digestDue({ lastSentAt: null, now: mon6 }), 'not before seven');
  assert(!digestDue({ lastSentAt: null, now: tue }), 'not on other days');
  assert(!digestDue({ lastSentAt: new Date(mon8).toISOString(), now: mon8 + 3600_000 }), 'never twice in a morning');
  assert(digestDue({ lastSentAt: new Date(mon8 - 7 * 86400_000).toISOString(), now: mon8 }), 'due again the following Monday');
});

await check('the digest reads in the house voice and carries the numbers', () => {
  const d = renderDigest({
    questions: { questions: 12, declined: 2, fb_up: 5, fb_down: 1, teams: 4 },
    signals: { news: 6, uk: 2, watch: 3, filings: 9 },
    leads: { created: 3, refreshed: 7 },
    drafts: { waiting: 4, approved: 1, drafted_this_week: 5 },
    posts: { waiting: 2, posted: 1 },
  }, { weekEnding: '2026-07-13' });
  assert(/6 signals, 3 new leads, 4 drafts waiting/.test(d.subject), d.subject);
  assert(/Nothing sends without a person/.test(d.text), 'the safety line is stated');
  assert(!/[—–!]/.test(d.text) && !/genuinely/i.test(d.text), 'house voice holds');
  // John's screenshot, 17 August 2026: "1 drafts waiting". Never again.
  const one = renderDigest({
    questions: { questions: 1, declined: 0, fb_up: 0, fb_down: 0, teams: 0 },
    signals: { news: 1, uk: 1, watch: 0, filings: 0 },
    leads: { created: 1, refreshed: 0 },
    drafts: { waiting: 1, approved: 0, drafted_this_week: 1 },
    posts: null,
  }, { weekEnding: '2026-08-17' });
  assert(/1 signal, 1 new lead, 1 draft waiting/.test(one.subject), one.subject);
  assert(one.text.includes('week to 17 August 2026'), 'the date reads like a person wrote it');
  assert(humanDate('2026-08-17') === '17 August 2026', 'the date helper is exact');
});

await check('the digest email is a designed card, same numbers, same voice', () => {
  const data = {
    questions: { questions: 12, declined: 2, fb_up: 5, fb_down: 1, teams: 4 },
    signals: { news: 83, uk: 25, watch: 58, filings: 20 },
    leads: { created: 169, refreshed: 89 },
    drafts: { waiting: 1, approved: 0, drafted_this_week: 52 },
    posts: { waiting: 14, posted: 1 },
    convo: { sent: 47, replies: 1, live: 0, closed: 0, meetings: 0, handoffs: 0 },
  };
  const html = renderDigestHtml(data, { weekEnding: '2026-08-17', appUrl: 'https://engine.example' });
  assert(html.includes('The week to 17 August 2026'), 'the header carries the human date');
  for (const n of ['>83<', '>169<', '>1<']) assert(html.includes(n), `the hero row carries ${n}`);
  assert(html.includes('Nothing sends without a person.'), 'the safety line survives the redesign');
  assert(html.includes('reply rate of 2 percent'), 'the conversation arithmetic matches the text digest');
  assert(html.includes('Open the engine') && html.includes('https://engine.example'), 'the app link renders when a URL is configured');
  assert(!/[—–!]/.test(html.replace(/<[^>]+>/g, '')) && !/genuinely/i.test(html), 'house voice holds in the card');
  const bare = renderDigestHtml({ ...data, convo: null, posts: null }, { weekEnding: '2026-08-17', appUrl: '' });
  assert(!bare.includes('Conversations') && !bare.includes('Studio') && !bare.includes('Open the engine'),
    'absent lanes and an unset URL render nothing rather than zeros');
  // The decision-maker lane keeps score, and a stood-down switch is loud.
  const withPeople = { ...data, people: { searches: 14, found: 22, orbit: 9, emails: 6, autoOn: false } };
  const ph = renderDigestHtml(withPeople, { weekEnding: '2026-08-17', appUrl: '' });
  assert(ph.includes('14 companies searched') && ph.includes('22 people found') && ph.includes('9 in orbit'),
    'the card counts the decision-maker hunt');
  assert(ph.includes('automatic people search is switched off'), 'a latched-off switch cannot hide for a week');
  const pt = renderDigest(withPeople, { weekEnding: '2026-08-17' });
  assert(pt.text.includes('Decision makers: 14 companies searched') && pt.text.includes('switched off'),
    'the text digest carries the same score');
  const on = renderDigestHtml({ ...withPeople, people: { ...withPeople.people, autoOn: true } }, { weekEnding: '2026-08-17', appUrl: '' });
  assert(!on.includes('switched off'), 'no warning when the switch is on');
  // The studio autopilot's own score and warnings: queue depth beside the
  // counts, an off switch stated plainly, an empty queue loud while the
  // switch is on, and the interest line when the sweeps have a table. Old
  // -shaped posts data (no approved, no switch) renders exactly as before.
  const auto = { ...data, posts: { waiting: 3, approved: 2, posted: 2, autoOn: true } };
  const ah = renderDigestHtml(auto, { weekEnding: '2026-08-17', appUrl: '' });
  assert(ah.includes('2 approved in the queue'), 'the approved queue depth is scored');
  assert(!ah.includes('autopilot is switched off') && !ah.includes('queue is empty'), 'no warning with the switch on and posts queued');
  const thin = renderDigestHtml({ ...data, posts: { waiting: 3, approved: 0, posted: 2, autoOn: true } }, { weekEnding: '2026-08-17', appUrl: '' });
  assert(thin.includes('The approved queue is empty, so the next posting slot will pass silently.'), 'an empty queue is loud while the autopilot is on');
  const off = renderDigest({ ...data, posts: { waiting: 3, approved: 1, posted: 2, autoOn: false } }, { weekEnding: '2026-08-17' });
  assert(off.text.includes('The studio autopilot is switched off; posts publish only by hand.'), 'an off switch cannot hide for a week');
  const withInterest = { ...data, interest: { gathered: 12, orbit: 4, waiting: 9 } };
  const ih = renderDigestHtml(withInterest, { weekEnding: '2026-08-17', appUrl: '' });
  assert(ih.includes('12 people engaged with the posts this week (4 in the decision orbit), 9 waiting in the interest queue.'),
    'the interest line counts the gathering half');
  const it = renderDigest(withInterest, { weekEnding: '2026-08-17' });
  assert(it.text.includes('Interest: 12 people engaged'), 'the text digest carries the same line');
  assert(!renderDigestHtml(data, { weekEnding: '2026-08-17', appUrl: '' }).includes('Interest'),
    'no interest section before the table exists');
  // The gather cannot run offline, so its wiring is frozen as source: the
  // people block is really assembled and really reads the switch.
  const ROOT2 = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const dig = readFileSync(join(ROOT2, 'src/digest.mjs'), 'utf8');
  assert(/people = \{ \.\.\.searched, \.\.\.found, autoOn: sw === 'on' \}/.test(dig) && /autopeople_enabled/.test(dig),
    'gatherDigestData assembles the decision-maker score from the ledger and the switch');
  assert(/studio_autopilot_enabled/.test(dig) && /post_engagers/.test(dig),
    'and the studio block really reads the autopilot switch and the interest table');
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const srv = readFileSync(join(ROOT, 'src/server.mjs'), 'utf8');
  assert(/const html = renderDigestHtml\(data\)/.test(srv), 'the scheduled send posts the designed card');
});

await check('not a prospect is one act: reject, close, remove, remember', () => {
  // John's build, 20 August 2026: the queue had every verb except the one
  // that removes the company itself from a campaign. The close-out is
  // complete in a single server act, and the dismissal memory means the
  // census can never re-propose the same name to the same campaign.
  const ROOT3 = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const srv = readFileSync(join(ROOT3, 'src/server.mjs'), 'utf8');
  assert(/async function removeFromCampaign/.test(srv), 'one shared act behind both routes');
  assert(/stage IN \('replied', 'handed_off'\)/.test(srv) && /a conversation is live on this campaign/.test(srv),
    'a live conversation refuses the act with its reason');
  assert(/SET status = 'rejected', decided_by = \$3\s*\n?\s*WHERE company_id = \$1 AND campaign = \$2/.test(srv),
    'open drafts reject, scoped to the one company and campaign');
  assert(/SET stage = 'closed', updated_at = now\(\)\s*\n?\s*WHERE company_id = \$1 AND campaign = \$2/.test(srv),
    'leads close so drafting and follow-ups end at the source');
  assert(/DELETE FROM company_campaigns WHERE company_id = \$1 AND campaign = \$2/.test(srv),
    'the membership goes, so research cannot re-score it');
  assert(/'dismissed', now\(\)/.test(srv) && /DO UPDATE SET status = 'dismissed'/.test(srv) && /normName\(co\[0\]\.name\)/.test(srv),
    'the dismissal memory is written under the shared normaliser and holds on conflict');
  assert(/remove-prospect/.test(srv) && /a rehearsal is not a prospect to remove/.test(srv),
    'the draft-card route resolves company and campaign and refuses rehearsals');
  assert(/namesake risk\|stated employer differs\|foreign mailbox\|greeting names/.test(srv),
    'the suppress endpoint accepts every recipient-class block, matching the web');
  const ob = readFileSync(join(ROOT3, 'web/src/Outbound.jsx'), 'utf8');
  assert(/Not a prospect/.test(ob) && /Confirm: remove from campaign/.test(ob), 'the card carries the two-click verb');
  const acc = readFileSync(join(ROOT3, 'web/src/Accounts.jsx'), 'utf8');
  assert(/CampaignMemberships/.test(acc) && /Confirm: not a prospect/.test(acc) && /stays on the register/.test(acc),
    'the panel lists memberships with the same two-click verb and says what removal means');
});

check('the thread shows every email in full, with who approved and who sent', () => {
  // John's catch, 20 August 2026: decided_by and sent_by were recorded on
  // every draft since the attribution migration but shown nowhere, so the
  // claim that the thread shows who clicked was untrue in the UI.
  const ROOT4 = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const srv = readFileSync(join(ROOT4, 'src/server.mjs'), 'utf8');
  assert(/d\.decided_by, d\.sent_by, ct\.full_name AS to_name/.test(srv),
    'the thread endpoint carries recipient and both names per email');
  assert(/decidedBy: d\.decided_by \|\| null, sentBy: d\.sent_by \|\| null/.test(srv), 'and maps them into the items');
  const ob = readFileSync(join(ROOT4, 'web/src/Outbound.jsx'), 'utf8');
  assert(/approved by \$\{it\.decidedBy\}/.test(ob) && /sent by \$\{it\.sentBy\}/.test(ob),
    'the card prints the audit line on every sent email');
  assert(/Read in full/.test(ob) && /whiteSpace: 'pre-wrap'/.test(ob),
    'every email expands to its full text and subject');
});

check('a reply card says what the engine did, and an away reply takes a hand-set return', () => {
  // John's ask, 20 August 2026: the replies tab offered only Draft a
  // response, the wrong verb for an away message, and said nothing about
  // the snooze already arranged. The card now states the action, and when
  // the parser could not read the return ("after the christmas break") a
  // human sets the date and the lead sleeps until the day after it.
  const ROOT5 = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const srv = readFileSync(join(ROOT5, 'src/server.mjs'), 'utf8');
  assert(/r\.triage, c\.name AS company,\s*\n?\s*l\.snoozed_until/.test(srv), 'the replies list carries the triage record and the live snooze');
  assert(/replies\/:id\/snooze/.test(srv) && /returns must be a date/.test(srv), 'the return date is a validated hand-set field');
  assert(/getTime\(\) \+ 86_400_000\)/.test(srv) && /the return date must be in the future/.test(srv),
    'the snooze lands the day after the stated return, never in the past');
  assert(/CASE WHEN stage = 'replied' THEN 'outbound' ELSE stage END/.test(srv),
    'setting the return also resumes the sequence stage, as a parsed date would');
  const ob = readFileSync(join(ROOT5, 'web/src/Outbound.jsx'), 'utf8');
  assert(/They return on/.test(ob) && /the next touch drafts itself/.test(ob), 'the away card offers the date and says what follows');
  assert(/actedLine/.test(ob) && /Left for a human read/.test(ob), 'every triaged card states the action taken, including none');
});

console.log('\nReal send gate and reply matching:');

await check('a real send is allowed only for an approved draft with a deliverable recipient', () => {
  assert(canSendReal({ status: 'approved', contactEmail: 'x@co.example', suppressed: false }).ok, 'approved + email + not suppressed should pass');
  assert(!canSendReal({ status: 'draft', contactEmail: 'x@co.example', suppressed: false }).ok, 'a draft must not send');
  assert(!canSendReal({ status: 'approved', contactEmail: null, suppressed: false }).ok, 'no email must not send');
  assert(!canSendReal({ status: 'approved', contactEmail: 'x@co.example', suppressed: true }).ok, 'a suppressed recipient must not send');
});

await check('a reply matches its send by conversation first, then by address', () => {
  const sent = [
    { draft_id: 1, to_email: 'a@co.example', conversation_id: 'CONV1' },
    { draft_id: 2, to_email: 'b@co.example', conversation_id: 'CONV2' },
  ];
  assert(matchReply({ conversationId: 'CONV2', from: 'someone@else.example' }, sent)?.draft_id === 2, 'match by conversation id');
  assert(matchReply({ conversationId: null, from: 'A@CO.EXAMPLE' }, sent)?.draft_id === 1, 'fallback by from address, case-insensitive');
  assert(matchReply({ conversationId: 'NOPE', from: 'stranger@x.example' }, sent) === null, 'no match returns null');
});

console.log(`\n=== Outbound gate: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
