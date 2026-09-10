#!/usr/bin/env node
// The identity audit for LinkedIn messages, 10 September 2026, after a
// message from James's profile opened "I'm Patrick, MD at PCT".
//
//   node --env-file=.env scripts/audit-dm-identity.mjs
//   node --env-file=.env scripts/audit-dm-identity.mjs --reject
//
// Two passes. Sent messages are re-read against the identity rule and every
// one that introduced the writer under the wrong name or title is listed
// with the person, their company and their profile, so the correction can be
// sent by hand from the profile that carried the message. Open messages,
// draft or approved, have their flags recomputed with every rule that
// exists today and written back, so a flagged one is held and shows why;
// with --reject those are rejected outright so the queue starts clean. The
// audit never sends anything and never touches a sent message.
import { pool } from '../src/db.mjs';
import { identityFlags, dmSender, recheckMessage } from '../src/studio/liDm.mjs';
import { senderFor } from '../src/outbound/senders.mjs';

const REJECT = process.argv.includes('--reject');

const reg = (await pool.query(`SELECT to_regclass('li_messages') AS t`)).rows[0]?.t;
if (!reg) { console.error('The li_messages table is not created yet; run npm run migrate.'); process.exit(1); }

const { rows: sent } = await pool.query(
  `SELECT m.id, m.body, m.campaign, m.sent_at, m.sent_by, ct.full_name, ct.linkedin_url, c.name AS company, c.region
   FROM li_messages m JOIN contacts ct ON ct.id = m.contact_id
   LEFT JOIN companies c ON c.id = m.company_id
   WHERE m.status = 'sent' ORDER BY m.sent_at ASC`);
const wrong = [];
for (const m of sent) {
  const flags = identityFlags(m.body, dmSender(m.campaign), senderFor(m.region)?.name || null);
  if (flags.length) wrong.push({ ...m, flags });
}
console.log(`${sent.length} message(s) sent so far; ${wrong.length} introduced the writer under the wrong name or title.`);
for (const m of wrong) {
  const sender = dmSender(m.campaign);
  console.log(`\n  ${m.full_name}${m.company ? `, ${m.company}` : ''}  (${m.campaign}, sent ${new Date(m.sent_at).toISOString().slice(0, 16).replace('T', ' ')} by ${m.sent_by || 'unknown'})`);
  console.log(`  profile: ${m.linkedin_url || 'none on file'}`);
  console.log(`  went out from: ${sender ? `${sender.name}, ${sender.title}` : 'no sender named'}`);
  for (const f of m.flags) console.log(`  ${f}`);
  console.log(`  message: ${String(m.body).replace(/\s+/g, ' ').slice(0, 300)}`);
}

const { rows: open } = await pool.query(`SELECT id FROM li_messages WHERE status IN ('draft', 'approved') ORDER BY created_at ASC`);
let held = 0, rejected = 0;
const heldRows = [];
for (const o of open) {
  const r = await recheckMessage(o.id);
  if (!r?.flags?.length) continue;
  held++;
  heldRows.push(r);
  if (REJECT) {
    await pool.query(`UPDATE li_messages SET status = 'rejected', updated_at = now() WHERE id = $1`, [o.id]);
    rejected++;
  }
}
console.log(`\n${open.length} open message(s) rechecked with every rule; ${held} now carry a blocking flag${REJECT ? `, ${rejected} rejected` : ', held in the queue with their flags written back'}.`);
for (const r of heldRows) console.log(`  ${r.name}${r.company ? `, ${r.company}` : ''} (${r.campaign}, ${r.status}): ${r.flags[0]}`);
if (held && !REJECT) console.log('\nRe-run with --reject to reject the held ones outright; the engine drafts afresh under the identity rule.');
await pool.end();
