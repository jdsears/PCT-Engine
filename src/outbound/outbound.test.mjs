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
  // The gather cannot run offline, so its wiring is frozen as source: the
  // people block is really assembled and really reads the switch.
  const ROOT2 = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const dig = readFileSync(join(ROOT2, 'src/digest.mjs'), 'utf8');
  assert(/people = \{ \.\.\.searched, \.\.\.found, autoOn: sw === 'on' \}/.test(dig) && /autopeople_enabled/.test(dig),
    'gatherDigestData assembles the decision-maker score from the ledger and the switch');
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const srv = readFileSync(join(ROOT, 'src/server.mjs'), 'utf8');
  assert(/const html = renderDigestHtml\(data\)/.test(srv), 'the scheduled send posts the designed card');
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
