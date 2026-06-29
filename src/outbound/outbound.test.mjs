// Guards that matter most: a draft must never reach a prospect by accident. These
// exercise only the refusal paths, which return before any network call, so the
// gate runs offline. The actual delivery path is not tested here, by design.
import { sendMail, sendMailTest, isTestRecipient, textToHtml } from '../mail.mjs';
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

await check('the two gates are independent: a real send never bypasses the kill switch', async () => {
  // Test sends are enabled and this address is on the allowlist, yet a real
  // prospect send to it is still refused by the kill switch.
  process.env.OUTBOUND_TEST_SENDS = 'on';
  process.env.OUTBOUND_TEST_RECIPIENTS = 'alice@example.com';
  process.env.MAIL_KILL_SWITCH = 'on';
  const r = await sendMail({ to: 'alice@example.com', subject: 's', html: '<p>h</p>' });
  assert(r.sent === false && r.reason === 'kill switch on', JSON.stringify(r));
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
