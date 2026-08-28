// Guards that matter most: a draft must never reach a prospect by accident. These
// exercise only the refusal paths, which return before any network call, so the
// gate runs offline. The actual delivery path is not tested here, by design.
import { sendMail, sendMailTest, sendInternal, isTestRecipient, digestRecipients, textToHtml, blockedByKillSwitch,
         notifyRecipients, campaignNotifyEmails, internalAllowlist } from '../mail.mjs';
import { renderDigest, renderDigestHtml, humanDate, digestDue, laneSplit } from '../digest.mjs';
import { openerSource, funnelSteps, replyBuckets, bounceWeeks, HUMAN_REPLIES } from './analytics.mjs';
import { provenanceReply, removalConfirmation, sourceLine, SOURCE_LINES, SOURCE_UNKNOWN } from './provenance.mjs';
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
  const blind = renderDigest({ ...data, convo: { ...data.convo, captureOn: false } }, { weekEnding: '2026-08-17' });
  assert(blind.text.includes('Reply capture is switched off'), 'a blind poller says so rather than reading as a quiet week');
  const watching = renderDigest({ ...data, convo: { ...data.convo, captureOn: true } }, { weekEnding: '2026-08-17' });
  assert(!watching.text.includes('switched off'), 'no warning while it is watching');
  const withInterest = { ...data, interest: { gathered: 12, orbit: 4, waiting: 9 } };
  const ih = renderDigestHtml(withInterest, { weekEnding: '2026-08-17', appUrl: '' });
  assert(ih.includes('12 people engaged with the posts this week, 4 in the decision orbit, 9 waiting in the interest queue.'),
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

await check('the digest splits every lane by campaign, and pharma is never invisible again', () => {
  // John's screenshot, 24 August 2026: the digest read as a data centre
  // report, because every figure was a whole-engine total from the
  // single-campaign era and the signals line hardcoded "data centre stories"
  // over both lanes. The totals stay; each lane's share rides beside them.
  const twoLanes = [{ campaign: 'marwin_dc', news: 41 }, { campaign: 'pharma_steriflow', news: 13 }];
  assert(laneSplit(twoLanes, 'news') === ' (Data centres 41, Pharma 13)', 'the split is labelled by display name');
  assert(laneSplit([{ campaign: 'marwin_dc', news: 41 }], 'news') === '', 'one lane renders no bracket; a single-campaign digest reads as before');
  assert(laneSplit(null, 'news') === '' && laneSplit(undefined, 'news') === '', 'absent lanes render nothing, so old-shaped data is untouched');
  const data = {
    questions: { questions: 1, declined: 0, fb_up: 0, fb_down: 0, teams: 0 },
    signals: { news: 54, uk: 17, watch: 37, filings: 29, lanes: twoLanes },
    leads: { created: 6, refreshed: 258, lanes: [
      { campaign: 'marwin_dc', created: 5, refreshed: 240 }, { campaign: 'pharma_steriflow', created: 1, refreshed: 18 }] },
    drafts: { waiting: 39, approved: 0, drafted_this_week: 140, lanes: [
      { campaign: 'marwin_dc', waiting: 31, drafted_this_week: 121 }, { campaign: 'pharma_steriflow', waiting: 8, drafted_this_week: 19 }] },
    convo: { sent: 58, replies: 8, live: 0, closed: 0, meetings: 0, handoffs: 0, lanes: [
      { campaign: 'marwin_dc', sent: 50, replies: 7 }, { campaign: 'pharma_steriflow', sent: 8, replies: 1 }] },
    people: { searches: 128, found: 364, orbit: 135, emails: 103, autoOn: true, lanes: [
      { campaign: 'marwin_dc', found: 300, emails: 90 }, { campaign: 'pharma_steriflow', found: 64, emails: 13 }] },
    posts: { waiting: 10, approved: 3, posted: 2, autoOn: true, lanes: [
      { campaign: 'marwin_dc', waiting: 7, approved: 3, posted: 2 },
      { campaign: 'pharma_steriflow', waiting: 3, approved: 0, posted: 0 }] },
    interest: { gathered: 12, orbit: 4, waiting: 9, lanes: [
      { campaign: 'marwin_dc', gathered: 9, waiting: 7 }, { campaign: 'pharma_steriflow', gathered: 3, waiting: 2 }] },
  };
  const t = renderDigest(data, { weekEnding: '2026-08-24' });
  assert(!/data centre stor/.test(t.text), 'the hardcoded label is gone; the stories were never all data centre');
  assert(t.text.includes('54 stories kept (Data centres 41, Pharma 13)'), 'signals split');
  assert(t.text.includes('across the whole register'), 'the filings stay register-wide and the wording says so');
  assert(t.text.includes('6 new (Data centres 5, Pharma 1), 258 refreshed (Data centres 240, Pharma 18)'), 'leads split');
  assert(t.text.includes('39 drafts awaiting review (Data centres 31, Pharma 8)'), 'outbound split');
  assert(t.text.includes('58 prospect sends (Data centres 50, Pharma 8), 8 replies (Data centres 7, Pharma 1)'), 'conversation split');
  assert(t.text.includes('364 people found (Data centres 300, Pharma 64)'), 'decision makers split through the membership rule');
  assert(t.text.includes('2 posted this week (Data centres 2, Pharma 0)'), 'a quiet lane shows its zero rather than disappearing');
  assert(t.text.includes('The approved queue is empty for Pharma, so its next posting slot will pass silently.'),
    'the warning names the lane whose slot will pass');
  const h = renderDigestHtml(data, { weekEnding: '2026-08-24', appUrl: '' });
  assert(!/data centre stor/.test(h) && h.includes('(Data centres 41, Pharma 13)')
    && h.includes('The approved queue is empty for Pharma'), 'the designed card splits the same way');
  assert(!/[—–!]/.test(t.text) && !/genuinely/i.test(t.text), 'house voice holds with the splits in');
  // The gather needs a database, so its split wiring is frozen as source.
  const ROOT3 = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const dg3 = readFileSync(join(ROOT3, 'src/digest.mjs'), 'utf8');
  assert((dg3.match(/GROUP BY campaign/g) || []).length >= 4, 'signals, leads, drafts and interest split in SQL');
  assert(/GROUP BY d\.campaign/.test(dg3), 'sends and replies split through their drafts');
  assert(/array_agg\(cc\.campaign ORDER BY cc\.campaign\)/.test(dg3), 'contacts derive their lane through the membership rule, never a guess');
  assert(/COALESCE\(lp\.grounding->>'campaign', s2\.campaign, 'marwin_dc'\)/.test(dg3), 'posts derive their lane exactly as the studio does');
});

console.log('\n"Where did you get my email address from?" (the answer is a template):');

await check('the answer describes their own record, and never claims a path we cannot evidence', () => {
  // Chris Wheeler at Pharmaron, 28 August 2026. The classifier could only
  // call it unclear, so it reached a human with no draft and no standard
  // answer. This is that answer, and it is a template because it states how
  // we handle someone's data to the person whose data it is.
  assert(/public LinkedIn profile/.test(sourceLine('linkedin')) && /Findymail/.test(sourceLine('linkedin')),
    'a LinkedIn-found contact is told exactly that');
  assert(/Companies House/.test(sourceLine('ch_officers')), 'a filings-found contact is told that instead');
  assert(/reacted to a post/.test(sourceLine('post_engagement')), 'an engager is told how they came to our attention');
  assert(/colleague of yours passed your name/.test(sourceLine('referral')), 'a referral says so plainly');
  assert(sourceLine(null) === SOURCE_UNKNOWN && sourceLine('something_new') === SOURCE_UNKNOWN,
    'an unknown source says so rather than claiming a path we cannot evidence');
  assert(/I can check the exact record/.test(SOURCE_UNKNOWN), 'and offers to go and look');
  for (const line of [...Object.values(SOURCE_LINES), SOURCE_UNKNOWN]) {
    assert(/Findymail/.test(line), 'every path names where the address itself came from');
  }
});

await check('the reply answers, offers removal, and sells nothing', () => {
  const r = provenanceReply({ firstName: 'Chris', source: 'linkedin', subject: 'Steriflow sanitary valves' });
  assert(r.body.startsWith('Hi Chris,'), 'it greets them by name');
  assert(/Fair question, and a straight answer\./.test(r.body), 'it does not get defensive');
  assert(/We do not buy contact lists/.test(r.body), 'it states the thing people actually want to know');
  assert(/take you off entirely/.test(r.body) && /No reason needed/.test(r.body),
    'removal is offered in the same breath, without asking them to justify it');
  assert(!/\b(meeting|call|demo|quote|pricing|catalogue|datasheet)\b/i.test(r.body),
    'it asks for nothing: no meeting, no call, no next step attached to the answer');
  assert((r.body.match(/valve/gi) || []).length === 1,
    'valves are mentioned exactly once, to explain why they were on the list at all');
  assert(r.subject.startsWith('Re: '), 'it stays on the thread');
  assert(!/[—–!]/.test(r.body) && !/genuinely/i.test(r.body), 'house voice holds');
  const anon = provenanceReply({ source: 'ch_officers' });
  assert(anon.body.startsWith('Hello,'), 'no name on file greets plainly rather than guessing one');
  // Two people asking the same thing get the same answer, which is the point
  // of a template over a prompt.
  assert(provenanceReply({ firstName: 'A', source: 'linkedin' }).body
    === provenanceReply({ firstName: 'A', source: 'linkedin' }).body, 'the answer is identical every time');
});

await check('the removal confirmation promises only what the suppression does', () => {
  const c = removalConfirmation({ firstName: 'Chris' });
  assert(/you are off our list/.test(c.body), 'it confirms plainly');
  assert(/by email or on LinkedIn/.test(c.body), 'and covers both channels, because the suppression does');
  assert(!/[—–!]/.test(c.body), 'house voice holds');
});

await check('the category is classified, drafted from the template, and removable in one act (static)', () => {
  const ROOT6 = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const read6 = rel => readFileSync(join(ROOT6, rel), 'utf8');
  const tri = read6('src/outbound/triage.mjs');
  assert(/data_question \(they ask where we got their details/.test(tri), 'the classifier knows the category');
  assert(/'wrong_person', 'data_question', 'unclear'/.test(tri), 'and it survives the parse rather than falling to unclear');
  assert(/case 'data_question': return \{ notify: true, provenanceAnswer: true \};/.test(tri),
    'it always notifies and always drafts, never branching on confidence');
  assert(/provenanceReply\(\{/.test(tri) && /'template'/.test(tri), 'the draft is the template, never a model');
  assert(!/suppress: true[^}]*data_question/.test(tri), 'asking where the data came from never suppresses anyone by itself');
  const mig = read6('src/migrations/036_data_question.sql');
  assert(/'data_question'/.test(mig) && /DROP CONSTRAINT/.test(mig), 'the category constraint makes room for it');
  const srv = read6('src/server.mjs');
  assert(/remove-and-confirm/.test(srv), 'the removal verb exists');
  assert(/suppressed = true/.test(srv) && /li_invite_skipped_at = COALESCE/.test(srv),
    'removal covers email and LinkedIn, because the confirmation says it does');
  assert(/removalConfirmation\(\{/.test(srv) && /'draft'\)/.test(srv),
    'the confirmation is drafted, not sent: every outbound email keeps its human click');
  const ui = read6('web/src/Outbound.jsx');
  assert(/Remove and confirm/.test(ui) && /Confirm removal/.test(ui), 'the verb is two clicks, arm then confirm');
  assert(/data_question: 'asking where we got their details'/.test(ui), 'the card names the category plainly');
});

console.log('\nReply visibility: each lane hears about its own replies:');

await check('a lane is told about its lane, and the shared list still gets everything', () => {
  const saved = { ...process.env };
  try {
    process.env.DIGEST_RECIPIENTS = 'john@example.com';
    delete process.env.TEAM_EMAILS;
    process.env.CAMPAIGN_NOTIFY_EMAILS = '{"marwin_dc":"james@example.com","pharma_steriflow":"andy@example.com, ops@example.com"}';
    assert(JSON.stringify(campaignNotifyEmails('marwin_dc')) === JSON.stringify(['james@example.com']), 'the lane list parses');
    assert(campaignNotifyEmails('pharma_steriflow').length === 2, 'a comma-separated lane list parses');
    const dc = notifyRecipients('marwin_dc');
    assert(dc.includes('james@example.com') && dc.includes('john@example.com'), 'the lane and the shared list are both told');
    assert(!dc.includes('andy@example.com'), 'and the other lane is not; that was the whole complaint');
    assert(JSON.stringify(notifyRecipients(null)) === JSON.stringify(['john@example.com']),
      'no campaign is the shared list exactly as before, so every other notification is untouched');
    // The allowlist has to know about lane addresses or the routing would be
    // a silent no-op: sendInternal refuses anyone off it.
    const alw = internalAllowlist();
    assert(alw.includes('james@example.com') && alw.includes('andy@example.com') && alw.includes('john@example.com'),
      'lane addresses are internal addresses; they come from service config, never from data');
    process.env.CAMPAIGN_NOTIFY_EMAILS = 'not json';
    assert(notifyRecipients('marwin_dc').length === 1 && internalAllowlist().length === 1,
      'a malformed map falls back to the shared list rather than breaking notifications');
    delete process.env.CAMPAIGN_NOTIFY_EMAILS;
    assert(JSON.stringify(notifyRecipients('marwin_dc')) === JSON.stringify(['john@example.com']), 'no map behaves exactly as before');
  } finally {
    for (const k of ['DIGEST_RECIPIENTS', 'TEAM_EMAILS', 'CAMPAIGN_NOTIFY_EMAILS']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});

await check('the reply surfaces follow the switcher, and a blind poller cannot look quiet (static)', () => {
  const ROOT5 = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const read5 = rel => readFileSync(join(ROOT5, rel), 'utf8');
  const tri = read5('src/outbound/triage.mjs');
  assert(/sendTeamNote\(subject, lines\.join\('\\n'\), \{ campaign: r\.campaign \}\)/.test(tri),
    'a reply notification carries the lane it belongs to');
  const srv = read5('src/server.mjs');
  const rep = srv.slice(srv.indexOf("app.get('/api/outbound/replies'"), srv.indexOf("app.get('/api/outbound/conversations'"));
  assert(/campaignFilter\(req\)/.test(rep) && /\$1::text IS NULL OR d\.campaign = \$1/.test(rep),
    "the replies view filters by the draft's own campaign");
  const conv = srv.slice(srv.indexOf("app.get('/api/outbound/conversations'"));
  assert(/campaignFilter\(req\)/.test(conv.slice(0, 2000)) && /\$1::text IS NULL OR l\.campaign = \$1/.test(conv.slice(0, 4000)),
    'and so does the conversations view');
  const ui = read5('web/src/Outbound.jsx');
  assert(/withCampaign\('\/api\/outbound\/replies', campaign\)/.test(ui) && /withCampaign\('\/api\/outbound\/conversations', campaign\)/.test(ui),
    'both fetches carry the switcher');
  const dg = read5('src/digest.mjs');
  assert(/replycapture_enabled/.test(dg) && /convo\.captureOn = cap === 'on'/.test(dg),
    'the digest reads whether the engine is actually watching for replies');
});

console.log('\nAfter the send: analytics from outcomes, never from pixels:');

await check('a human reply is a person, never a mail server or an autoresponder', () => {
  assert(JSON.stringify(HUMAN_REPLIES) === JSON.stringify(['interested', 'question', 'not_interested', 'wrong_person', 'unclear']),
    'the human categories are exactly the five');
  assert(!HUMAN_REPLIES.includes('bounce') && !HUMAN_REPLIES.includes('out_of_office'),
    'bounces and out-of-office never count as a reply');
});

await check('the opener credits the person before the signal, and no signal is honest profile fit', () => {
  assert(openerSource({ signalType: 'news_dc_build', contactSource: 'post_engagement' }) === 'Post engagement',
    'a contact who exists because they engaged is that source, whatever seasoned the draft');
  assert(openerSource({ signalType: 'ch_filing', contactSource: 'referral' }) === 'Referral',
    'a referred colleague is a referral, not a filing');
  assert(openerSource({ signalType: 'news_contract', contactSource: 'linkedin' }) === 'Project news', 'news signals credit the news');
  assert(openerSource({ signalType: 'ch_director_change', contactSource: null }) === 'Register filing', 'filings credit the register');
  assert(openerSource({ signalType: null, contactSource: 'linkedin' }) === 'Profile fit', 'no signal is profile fit, stated plainly');
  assert(openerSource({}) === 'Profile fit' && openerSource({ signalType: 'something_else' }) === 'Profile fit',
    'unknown shapes fall to profile fit rather than inventing a category');
});

await check('funnel percentages are each step\'s share of the one before, never invented', () => {
  const f = funnelSteps([{ label: 'a', n: 200 }, { label: 'b', n: 100 }, { label: 'c', n: 15 }]);
  assert(f[0].pct === null, 'the first step has no denominator');
  assert(f[1].pct === 50 && f[2].pct === 15, 'shares compute against the previous step');
  const z = funnelSteps([{ label: 'a', n: 0 }, { label: 'b', n: 0 }]);
  assert(z[1].pct === null, 'a zero step yields no percentage for the next, not a division by zero');
  assert(funnelSteps([]).length === 0 && funnelSteps(null).length === 0, 'empty and absent are tolerated');
});

await check('reply timing buckets and medians read honestly', () => {
  const t = replyBuckets([0.2, 0.8, 1.5, 2, 4, 9, -0.5]);
  assert(t.count === 7 && t.sameDay === 3 && t.oneToTwo === 2 && t.threeToSeven === 1 && t.overSeven === 1,
    'buckets split at one, two and seven days, negatives clamp to same day');
  assert(t.medianDays === 1.5, 'the median reads from the sorted middle');
  const none = replyBuckets([]);
  assert(none.count === 0 && none.medianDays === null, 'no replies means no median, never a zero that reads as instant');
});

await check('bounce weeks merge sends and bounces, and a quiet week has no rate', () => {
  const w = bounceWeeks(
    [{ wk: '2026-08-10', sent: 20 }, { wk: '2026-08-17', sent: 10 }],
    [{ wk: '2026-08-17', bounced: 1 }, { wk: '2026-08-03', bounced: 2 }]);
  assert(w.length === 3 && w[0].week === '2026-08-03', 'weeks sort oldest first, bounce-only weeks included');
  assert(w[0].rate === null, 'a week with bounces but no recorded sends shows no rate rather than a lie');
  assert(w[1].rate === 0 && w[2].rate === 10, 'rates compute where sends exist');
});

await check('the analytics stay outcome-only and rehearsal never leaks in (static)', () => {
  const ROOT4 = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const an = readFileSync(join(ROOT4, 'src/outbound/analytics.mjs'), 'utf8');
  assert(/No pixels/.test(an), 'the no-tracking position is stated where the queries live');
  assert((an.match(/<> 'rehearsal'/g) || []).length >= 9, 'every draft, send, reply and lead query excludes the rehearsal lane');
  assert((an.match(/NOT ct\.rehearsal/g) || []).length >= 3, 'every contact query excludes rehearsal contacts');
  assert(/s\.sent AND NOT s\.test_mode/.test(an), 'only real prospect sends count, never internal tests');
  assert(/array_agg\(cc\.campaign ORDER BY cc\.campaign\)/.test(an), 'contacts derive their campaign through the membership rule');
  assert(/to_regclass\('post_engagers'\)/.test(an) && /to_regclass\('li_posts'\)/.test(an),
    'the LinkedIn blocks guard their tables for deploy order');
  const srv4 = readFileSync(join(ROOT4, 'src/server.mjs'), 'utf8');
  assert(/api\/insights\/outbound/.test(srv4) && /gatherOutboundAnalytics/.test(srv4), 'the endpoint serves the gather');
  const ui = readFileSync(join(ROOT4, 'web/src/Insights.jsx'), 'utf8');
  assert(/api\/insights\/outbound/.test(ui) && /After the send/.test(ui), 'the Insights page shows the after-send zone');
  assert(/No open tracking/.test(ui), 'and states the no-tracking position to the reader');
  assert(/Invite acceptance is not observable yet/.test(ui), 'what cannot be measured is said, not guessed');
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
