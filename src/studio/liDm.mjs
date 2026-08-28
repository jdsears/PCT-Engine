import { pool, hasColumn } from '../db.mjs';
import { requireCampaign } from '../campaigns/registry.mjs';
import { outboundVoice, flagEndCustomers, recipientMismatch } from '../outbound/draft.mjs';
import { senderFor } from '../outbound/senders.mjs';
import { unipile, ROUTES, accountForCampaign } from '../research/unipile.mjs';
import { linkedinSlug } from './liInvite.mjs';

// The message stage, John's design of 24 August 2026: emails one and two as
// they are, then one direct message from James or Andy on their own profile,
// then, if still nothing, the break-up email from the regional rep.
//
// Three rules make this defensible rather than pestering. It reaches only
// someone who accepted an invitation, so it arrives in a conversation they
// agreed to. It is one message, not a sequence: LinkedIn is a second channel,
// not a second inbox to fill, and the break-up email does the work a second
// message would do, more gracefully. And it is honest about the emails
// instead of pretending they never happened, because coordinated outreach
// that acts uncoordinated is the thing that reads badly.

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

async function callClaude(system, user, { maxTokens = 400 } = {}) {
  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`Claude failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

// LinkedIn messages are read on a phone, in a list. Long is worse than short.
export const DM_MAX_CHARS = 600;

export function dmSystem(campaign = 'marwin_dc', repName = null) {
  const def = typeof campaign === 'string' ? requireCampaign(campaign) : campaign;
  return (
    `You write one short LinkedIn message for a UK flow control specialist. His identity: ${def.studio.connectLine}. ` +
    'CONTEXT: this person accepted his connection request. A colleague emailed them twice about the same subject and got no reply. ' +
    (repName
      ? `HONESTY RULE: mention plainly and lightly that ${repName} wrote to them, in a single clause, then move on. Never pretend the emails did not happen, and never complain that they went unanswered, because an unanswered email is not a debt. `
      : 'HONESTY RULE: never pretend earlier contact did not happen, and never complain about an unanswered email. ') +
    'GROUNDING RULE: you may reference only the facts provided. Invent no project, figure, date or need. If the grounding is thin, write less. ' +
    "CONFIDENTIALITY RULE, absolute: never state or imply that any named company is a customer. " +
    `VOICE: plain British English, calm, first person, three or four sentences at most, well under ${DM_MAX_CHARS} characters. Open with their name. One clear reason for writing, tied to their work or the story in the grounding, and one light question or offer that is easy to ignore. ` +
    'No em dashes or en dashes, never the word genuinely, no exclamation marks, no emojis, no links, no bullet points, no subject line, no sign-off block. ' +
    'Return the message text only.'
  );
}

// The blocking checks a message must pass, the draft vocabulary reused so a
// reviewer reads the same sentences here as on an email card.
export function dmFlags(body, { operator = null, contact = null, company = null } = {}) {
  const flags = flagEndCustomers(body, operator).map(n =>
    `blocking: names or implies a customer relationship (${n}); never in a message either`);
  if (String(body || '').length > DM_MAX_CHARS) {
    flags.push(`blocking: the message runs to ${String(body).length} characters; a LinkedIn message over ${DM_MAX_CHARS} reads as an email in the wrong place`);
  }
  if (/https?:\/\//i.test(String(body || ''))) {
    flags.push('blocking: the message carries a link; a first message with a link reads as a pitch');
  }
  const first = String(contact?.name || '').trim().split(/\s+/)[0];
  if (first && !new RegExp(`\\b${first.replace(/[^\w]/g, '')}\\b`, 'i').test(String(body || ''))) {
    flags.push(`blocking: the message never uses ${first}'s name, so it reads as a broadcast`);
  }
  // Recipient truth applies to a message exactly as it does to an email: the
  // text speaks to their role at a company, and a mismatched contact would be
  // addressed as somebody they are not.
  for (const m of recipientMismatch(contact, company)) flags.push(m);
  return flags;
}

export async function writeDm(grounding, { repName = null, callModel = callClaude } = {}) {
  const g = grounding || {};
  const facts = [
    g.contact?.name ? `Their name: ${g.contact.name}` : null,
    g.contact?.role ? `Their role: ${g.contact.role}` : null,
    g.company?.name ? `Their company: ${g.company.name}` : null,
    g.signal?.text ? `Recent news about them: ${g.signal.text}` : 'No news story on file; write from their role alone.',
    g.icpReason ? `Why they fit: ${g.icpReason}` : null,
  ].filter(Boolean).join('\n');
  const body = outboundVoice(await callModel(dmSystem(g.campaign || 'marwin_dc', repName), `GROUNDING:\n${facts}\n\nWrite the message.`));
  if (!body) throw new Error('empty message');
  return {
    body,
    flags: dmFlags(body, { operator: g.signal?.operator || null, contact: g.contact, company: g.company }),
  };
}

// When the message stage is due for a thread: the person accepted the
// invitation, nothing has come back, and the last email has had a few days to
// breathe. Pure, so the sequence is provable offline.
export const dmAfterEmailDays = () => Math.max(0, parseInt(process.env.DM_AFTER_EMAIL_DAYS || '3', 10) || 3);

export function dmDue({ connectedAt = null, lastEmailAt = null, replied = false, dmSentAt = null,
                        now = Date.now(), afterDays = dmAfterEmailDays() } = {}) {
  if (replied || dmSentAt || !connectedAt) return false;
  const conn = new Date(connectedAt).getTime();
  if (Number.isNaN(conn)) return false;
  if (!lastEmailAt) return true;
  const last = new Date(lastEmailAt).getTime();
  if (Number.isNaN(last)) return true;
  return now - last >= afterDays * 86_400_000;
}

// Draft the messages that are due, one per contact, into the queue. No send
// path here: a message is a draft until a person approves it or the standing
// automatic sanction releases it, exactly like a post.
export async function generateDms({ limit = 5, callModel = callClaude, log = () => {} } = {}) {
  const report = { considered: 0, drafted: 0, flagged: 0, failed: 0 };
  if (!(await hasColumn('contacts', 'li_connected_at'))) return { ...report, skipped: 'run npm run migrate first' };
  if (!process.env.ANTHROPIC_API_KEY) return { ...report, skipped: 'ANTHROPIC_API_KEY is not set' };
  const { gatherGrounding } = await import('../outbound/grounding.mjs');
  const { rows } = await pool.query(
    `SELECT ct.id AS contact_id, ct.full_name, ct.li_connected_at, l.id AS lead_id, l.campaign, l.company_id, c.region,
            (SELECT max(s.created_at) FROM outbound_sends s JOIN outbound_drafts d ON d.id = s.draft_id
             WHERE d.contact_id = ct.id AND s.sent AND NOT s.test_mode) AS last_email_at,
            EXISTS (SELECT 1 FROM outbound_replies r JOIN outbound_drafts d ON d.id = r.draft_id
                    WHERE d.contact_id = ct.id
                      AND (r.category IS NULL OR r.category NOT IN ('bounce', 'out_of_office'))) AS replied
     FROM contacts ct
     JOIN companies c ON c.id = ct.company_id
     JOIN leads l ON l.company_id = ct.company_id AND l.campaign <> 'rehearsal'
     WHERE ct.li_connected_at IS NOT NULL AND NOT ct.suppressed AND NOT ct.rehearsal
       AND l.stage NOT IN ('replied', 'handed_off', 'closed')
       AND NOT EXISTS (SELECT 1 FROM li_messages m WHERE m.contact_id = ct.id AND m.status <> 'rejected')
     ORDER BY ct.li_connected_at ASC LIMIT 40`);
  for (const r of rows) {
    if (report.drafted >= limit) break;
    if (!dmDue({ connectedAt: r.li_connected_at, lastEmailAt: r.last_email_at, replied: r.replied })) continue;
    report.considered++;
    try {
      const grounding = await gatherGrounding(r.lead_id, { campaign: r.campaign, contactId: r.contact_id });
      const rep = senderFor(r.region);
      const d = await writeDm(grounding, { repName: rep?.name || null, callModel });
      await pool.query(
        `INSERT INTO li_messages (contact_id, company_id, lead_id, campaign, body, grounding, flags, status)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'draft')
         ON CONFLICT (contact_id) WHERE status IN ('draft', 'approved') DO NOTHING`,
        [r.contact_id, r.company_id, r.lead_id, r.campaign, d.body,
         JSON.stringify(grounding), JSON.stringify(d.flags)]);
      report.drafted++;
      if (d.flags.length) report.flagged++;
      log(`  message drafted for ${r.full_name}${d.flags.length ? ` [${d.flags.length} flag(s)]` : ''}`);
    } catch (e) {
      report.failed++;
      log(`  message failed for ${r.full_name}: ${String(e.message).slice(0, 140)}`);
    }
  }
  return report;
}

// Send one approved message through the account the person connected with.
// Two calls, both ledgered: resolve the profile to its provider id, then open
// the chat with the text. Never called except by the drip, which owns the
// pace and the caps.
export async function sendDm(message, contact, { accountId }) {
  const slug = linkedinSlug(contact.linkedin_url);
  if (!slug) return { sent: false, reason: 'no usable LinkedIn profile URL on file' };
  if (!accountId) return { sent: false, reason: 'no LinkedIn account is configured for this campaign' };
  const profile = await unipile(ROUTES.profile, { pathSuffix: slug, query: { account_id: accountId }, target: `dm ${slug}` });
  const providerId = profile?.provider_id || profile?.member_id || profile?.id || null;
  if (!providerId) return { sent: false, reason: 'could not resolve the LinkedIn profile to an id' };
  await unipile(ROUTES.sendMessage, {
    body: { account_id: accountId, attendees_ids: [providerId], text: String(message.body).slice(0, DM_MAX_CHARS) },
    target: `dm ${slug}`,
  });
  return { sent: true };
}
