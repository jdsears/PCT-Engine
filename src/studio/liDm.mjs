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
//
// A fourth rule, 10 September 2026, after a message from James's profile
// opened "I'm Patrick, MD at PCT": the writer is named. The prompt had given
// the model a title and no name, and the honesty rule had given it the rep's
// name, and it fused the two. Now each campaign's definition names the
// person whose profile carries it, the prompt states that identity as an
// absolute rule, and an identity check blocks any message that introduces
// the sender under another name or title. The check runs at draft, at
// approval and again at release, so a draft made before the rule cannot
// slip past it.

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

// Whose profile carries a campaign's messages: the definition's studio
// sender, name and title. Null when a campaign names nobody, and a campaign
// that names nobody cannot message, because a message must say who writes.
export function dmSender(campaign) {
  const def = typeof campaign === 'string' ? requireCampaign(campaign) : campaign;
  const s = def?.studio?.sender;
  return s?.name ? { name: String(s.name).trim(), title: String(s.title || '').trim() } : null;
}
const firstName = name => String(name || '').trim().split(/\s+/)[0] || '';

export function dmSystem(campaign = 'marwin_dc', repName = null) {
  const def = typeof campaign === 'string' ? requireCampaign(campaign) : campaign;
  const sender = dmSender(def);
  const who = sender ? `${sender.name}, ${sender.title} at PCT` : 'a UK flow control specialist';
  return (
    `You write one short LinkedIn message as ${who}, sent from his own profile. His introduction line, for tone and positioning: ${def.studio.connectLine}. ` +
    (sender
      ? `IDENTITY RULE, absolute: you are ${sender.name}. If the message introduces the writer at all, it is as ${firstName(sender.name)}, ${sender.title} at PCT, and under no other name or title. `
      : '') +
    'CONTEXT: this person accepted his connection request. A colleague emailed them twice about the same subject and got no reply. ' +
    (repName
      ? `HONESTY RULE: mention plainly and lightly that ${repName} wrote to them, in a single clause, then move on. ${repName} is a colleague and is spoken of only in the third person, never as the writer. Never pretend the emails did not happen, and never complain that they went unanswered, because an unanswered email is not a debt. `
      : 'HONESTY RULE: never pretend earlier contact did not happen, and never complain about an unanswered email. ') +
    'GROUNDING RULE: you may reference only the facts provided. Invent no project, figure, date or need. If the grounding is thin, write less. ' +
    "CONFIDENTIALITY RULE, absolute: never state or imply that any named company is a customer. " +
    `VOICE: plain British English, calm, first person, three or four sentences at most, well under ${DM_MAX_CHARS} characters. Open with their name. One clear reason for writing, tied to their work or the story in the grounding, and one light question or offer that is easy to ignore. ` +
    'No em dashes or en dashes, never the word genuinely, no exclamation marks, no emojis, no links, no bullet points, no subject line, no sign-off block. ' +
    'Return the message text only.'
  );
}

// Words that follow "I'm" without being a name, so "I'm keen" and "I'm
// writing" never trip the identity check. Anything else capitalised after an
// introduction reads as a name, and a wrong name blocks.
const NOT_A_NAME = /^(Managing|Sales|Director|The|Not|Also|Just|Here|Only|Very|Still|Sure|Keen|Happy|Glad|Based|Away|Back|Writing|Getting|Sending|Reaching|Following|Hoping|Looking|Pleased|Sorry|Afraid|Aware|Interested|Curious|Conscious|Mindful|Grateful|Delighted|Working|Part|One|Now|Always|Often|Usually|Currently|Responsible|Involved|Guessing|Assuming|Told|Told|New|Old|Local|Keen)$/;
const normTitle = t => String(t || '').toLowerCase().replace(/\bmanaging director\b/, 'md').replace(/\s+/g, ' ').trim();

// The identity check: the message may introduce the writer only as the
// campaign's sender, by first name and by title. A message that says "I'm
// Patrick" from James's profile, or "I'm the sales director" from the MD's,
// blocks. A campaign with no sender blocks everything, because the message
// cannot say who writes.
export function identityFlags(body, sender, repName = null) {
  const flags = [];
  const text = String(body || '');
  if (!sender?.name) {
    flags.push('blocking: no sender is named for this campaign, so the message cannot say who is writing; add studio.sender to the definition');
    return flags;
  }
  const first = firstName(sender.name);
  const claimedNames = new Set();
  for (const m of text.matchAll(/\b(?:I'?m|I am|this is|my name is|it'?s)\s+([A-Z][a-z]+)\b/g)) {
    if (NOT_A_NAME.test(m[1]) || m[1].toLowerCase() === first.toLowerCase()) continue;
    claimedNames.add(m[1]);
  }
  for (const m of text.matchAll(/\b([A-Z][a-z]+),\s+(?:the\s+)?(?:MD|managing director|sales director)\s+(?:at|of)\s+PCT\b/gi)) {
    if (m[1].toLowerCase() !== first.toLowerCase() && !NOT_A_NAME.test(m[1])) claimedNames.add(m[1]);
  }
  for (const n of claimedNames) {
    const rep = repName && n.toLowerCase() === firstName(repName).toLowerCase() ? `, who is the colleague who emailed, not the writer` : '';
    flags.push(`blocking: the message introduces the writer as ${n}${rep}; it goes out from ${sender.name}'s profile`);
  }
  const claimedTitle = /\b(?:I'?m|I am)\s+(?:the\s+)?(MD|managing director|sales director)\b/i.exec(text)
    || /\b(?:MD|managing director|sales director)\s+(?:at|of)\s+PCT\b/i.exec(text);
  if (claimedTitle) {
    const said = normTitle(claimedTitle[1] || claimedTitle[0].replace(/\s+(at|of)\s+PCT$/i, ''));
    if (sender.title && said !== normTitle(sender.title)) {
      flags.push(`blocking: the message calls the writer ${said === 'md' ? 'the MD' : 'the ' + said}; ${sender.name} is ${sender.title === 'MD' ? 'the MD' : 'the ' + sender.title}`);
    }
  }
  return flags;
}

// The blocking checks a message must pass, the draft vocabulary reused so a
// reviewer reads the same sentences here as on an email card.
export function dmFlags(body, { operator = null, contact = null, company = null, sender = undefined, repName = null } = {}) {
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
  // Sender truth: the writer is who the profile says. undefined means the
  // caller did not say, which is the old call shape and checks nothing;
  // null means the campaign names nobody, which blocks.
  if (sender !== undefined) flags.push(...identityFlags(body, sender, repName));
  return flags;
}

// A spaced hyphen used as a dash reads as a dash. Commas do that work here.
const tidy = body => String(body || '').replace(/\s+-\s+/g, ', ');

export async function writeDm(grounding, { repName = null, callModel = callClaude } = {}) {
  const g = grounding || {};
  const campaign = g.campaign || 'marwin_dc';
  const sender = dmSender(campaign);
  const facts = [
    g.contact?.name ? `Their name: ${g.contact.name}` : null,
    g.contact?.role ? `Their role: ${g.contact.role}` : null,
    g.company?.name ? `Their company: ${g.company.name}` : null,
    g.signal?.text ? `Recent news about them: ${g.signal.text}` : 'No news story on file; write from their role alone.',
    g.icpReason ? `Why they fit: ${g.icpReason}` : null,
  ].filter(Boolean).join('\n');
  const body = tidy(outboundVoice(await callModel(dmSystem(campaign, repName), `GROUNDING:\n${facts}\n\nWrite the message.`)));
  if (!body) throw new Error('empty message');
  return {
    body,
    flags: dmFlags(body, { operator: g.signal?.operator || null, contact: g.contact, company: g.company, sender, repName }),
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
// automatic sanction releases it, exactly like a post. A campaign that names
// no sender drafts nothing.
export async function generateDms({ limit = 5, callModel = callClaude, log = () => {} } = {}) {
  const report = { considered: 0, drafted: 0, flagged: 0, failed: 0, noSender: 0 };
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
    if (!dmSender(r.campaign)) { report.noSender++; continue; }
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

// The flags a stored message carries today, recomputed from its text and
// its context: the recipient nets, the customer rule and the identity rule.
// Persisted when they differ from what is stored, so a draft made before a
// rule existed shows the rule's verdict, and used at approval and at release
// so nothing sends on stale flags.
export async function recheckMessage(id, { persist = true } = {}) {
  const { rows } = await pool.query(
    `SELECT m.id, m.body, m.flags, m.status, m.campaign, m.grounding, ct.full_name, ct.role_title, ct.email,
            ct.payload->'recipient_confirmed' IS NOT NULL AS confirmed, c.name AS company, c.domain, c.region
     FROM li_messages m JOIN contacts ct ON ct.id = m.contact_id
     LEFT JOIN companies c ON c.id = m.company_id
     WHERE m.id = $1`, [id]);
  const r = rows[0];
  if (!r) return null;
  const flags = dmFlags(r.body, {
    operator: r.grounding?.signal?.operator || null,
    contact: { name: r.full_name, role: r.role_title, email: r.email, confirmed: !!r.confirmed },
    company: { name: r.company, domain: r.domain },
    sender: dmSender(r.campaign),
    repName: senderFor(r.region)?.name || null,
  });
  const changed = JSON.stringify(flags) !== JSON.stringify(r.flags || []);
  if (persist && changed && ['draft', 'approved'].includes(r.status)) {
    await pool.query(`UPDATE li_messages SET flags = $2::jsonb, updated_at = now() WHERE id = $1`, [id, JSON.stringify(flags)]);
  }
  return { id: r.id, status: r.status, campaign: r.campaign, name: r.full_name, company: r.company, body: r.body, flags, changed };
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
