import { pool } from './db.mjs';

// The engine's weekly report to its own team: what it found, pulled and queued
// in the last seven days, one plain email. Gathering and rendering are split so
// the wording is testable offline.

export async function gatherDigestData() {
  const week = `now() - interval '7 days'`;
  const q = (await pool.query(
    `SELECT count(*)::int AS questions,
            count(*) FILTER (WHERE declined)::int AS declined,
            count(*) FILTER (WHERE feedback = 'up')::int AS fb_up,
            count(*) FILTER (WHERE feedback = 'down')::int AS fb_down,
            count(*) FILTER (WHERE channel = 'teams')::int AS teams
     FROM copilot_queries WHERE created_at >= ${week}`)).rows[0];
  const s = (await pool.query(
    `SELECT count(*) FILTER (WHERE signal_type LIKE 'news%')::int AS news,
            count(*) FILTER (WHERE geo_scope = 'uk_project')::int AS uk,
            count(*) FILTER (WHERE geo_scope = 'expansion_watch')::int AS watch,
            count(*) FILTER (WHERE signal_type LIKE 'ch\\_%')::int AS filings
     FROM signals WHERE observed_at >= ${week}`)).rows[0];
  // Rehearsal rows are excluded everywhere: the digest reports the real
  // pipeline, and a test afternoon must not read as a good week.
  const l = (await pool.query(
    `SELECT count(*) FILTER (WHERE created_at >= ${week})::int AS created,
            count(*) FILTER (WHERE updated_at >= ${week} AND created_at < ${week})::int AS refreshed
     FROM leads WHERE campaign <> 'rehearsal'`)).rows[0];
  const d = (await pool.query(
    `SELECT count(*) FILTER (WHERE status = 'draft')::int AS waiting,
            count(*) FILTER (WHERE status = 'approved')::int AS approved,
            count(*) FILTER (WHERE created_at >= ${week})::int AS drafted_this_week
     FROM outbound_drafts WHERE campaign <> 'rehearsal'`)).rows[0];
  // The conversation stage: the outcomes that matter, not open rates. Guarded
  // like the studio block so the digest survives a not-yet-migrated database.
  let convo = null;
  try {
    const sends = (await pool.query(
      `SELECT count(*)::int AS sent FROM outbound_sends s JOIN outbound_drafts d ON d.id = s.draft_id
       WHERE s.sent AND NOT s.test_mode AND d.campaign <> 'rehearsal' AND s.created_at >= ${week}`)).rows[0];
    const reps = (await pool.query(
      `SELECT count(*)::int AS replies,
              count(*) FILTER (WHERE r.category IN ('interested','question'))::int AS live,
              count(*) FILTER (WHERE r.category = 'not_interested')::int AS closed
       FROM outbound_replies r JOIN outbound_drafts d ON d.id = r.draft_id
       WHERE d.campaign <> 'rehearsal' AND r.created_at >= ${week}`)).rows[0];
    const goals = (await pool.query(
      `SELECT count(*) FILTER (WHERE meeting_booked_at >= ${week})::int AS meetings,
              count(*) FILTER (WHERE handed_off_at >= ${week})::int AS handoffs
       FROM leads WHERE campaign <> 'rehearsal'`)).rows[0];
    convo = { ...sends, ...reps, ...goals };
  } catch { convo = null; }
  // The studio ships separately, so its table may not exist yet; the digest
  // simply says nothing about posts until it does.
  let posts = null;
  try {
    const reg = (await pool.query(`SELECT to_regclass('li_posts') AS t`)).rows[0]?.t;
    if (reg) posts = (await pool.query(
      `SELECT count(*) FILTER (WHERE status = 'draft')::int AS waiting,
              count(*) FILTER (WHERE status = 'posted' AND posted_at >= ${week})::int AS posted
       FROM li_posts`)).rows[0];
  } catch { posts = null; }
  // The decision-maker lane keeps score in the weekly rhythm, John's ask of
  // 17 August 2026: how many accounts were searched, who was found, and
  // whether the automatic search is actually on, because a latched-off
  // switch once hid for days behind quiet cycles. Guarded like the studio
  // block so an older database simply says nothing.
  let people = null;
  try {
    const searched = (await pool.query(
      `SELECT count(*)::int AS searches FROM unipile_calls
       WHERE target LIKE 'findContacts: %' AND called_at >= ${week}`)).rows[0];
    const found = (await pool.query(
      `SELECT count(*) FILTER (WHERE created_at >= ${week} AND source = 'linkedin')::int AS found,
              count(*) FILTER (WHERE created_at >= ${week} AND source = 'linkedin' AND in_decision_orbit)::int AS orbit,
              count(*) FILTER (WHERE email_verified_at >= ${week})::int AS emails
       FROM contacts WHERE NOT rehearsal`)).rows[0];
    const sw = (await pool.query(`SELECT value FROM kv WHERE key = 'autopeople_enabled'`)).rows[0]?.value;
    people = { ...searched, ...found, autoOn: sw === 'on' };
  } catch { people = null; }
  return { questions: q, signals: s, leads: l, drafts: d, posts, convo, people };
}

// The digest speaks dates like a person: 2026-08-17 reads as 17 August 2026.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
export function humanDate(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  return y && m && d ? `${d} ${MONTHS[m - 1]} ${y}` : String(iso || '');
}

// Plain text in the house voice. The subject carries the three numbers that
// matter; the body stays short enough to read on a phone.
export function renderDigest(data, { weekEnding = new Date().toISOString().slice(0, 10) } = {}) {
  const { questions: q, signals: s, leads: l, drafts: d, posts, convo, people } = data;
  const lines = [
    `The engine's week to ${humanDate(weekEnding)}.`,
    '',
    `Signals: ${s.news} data centre stories kept (${s.uk} UK project, ${s.watch} watchlist), ${s.filings} register filings tracked.`,
    `Leads: ${l.created} new, ${l.refreshed} refreshed.`,
    `Outbound: ${d.waiting} draft${d.waiting === 1 ? '' : 's'} awaiting review, ${d.approved} approved, ${d.drafted_this_week} drafted this week. Nothing sends without a person.`,
    `Co-pilot: ${q.questions} question${q.questions === 1 ? '' : 's'} (${q.teams} from Teams), ${q.declined} it could not answer, feedback ${q.fb_up} helpful and ${q.fb_down} not.`,
  ];
  if (convo) {
    const rate = convo.sent > 0 ? `, a reply rate of ${Math.round((convo.replies / convo.sent) * 100)} percent` : '';
    lines.push(`Conversations: ${convo.sent} prospect send${convo.sent === 1 ? '' : 's'}, ${convo.replies} repl${convo.replies === 1 ? 'y' : 'ies'}${rate}, ${convo.live} live (interested or asking), ${convo.closed} clear no. Meetings booked: ${convo.meetings}. Handed off: ${convo.handoffs}.`);
  }
  if (people) {
    lines.push(`Decision makers: ${people.searches} compan${people.searches === 1 ? 'y' : 'ies'} searched, ${people.found} ${people.found === 1 ? 'person' : 'people'} found (${people.orbit} in orbit), ${people.emails} email${people.emails === 1 ? '' : 's'} resolved.${people.autoOn ? '' : ' The automatic people search is switched off; the Health page turns it back on.'}`);
  }
  if (posts) lines.push(`Studio: ${posts.waiting} post draft${posts.waiting === 1 ? '' : 's'} waiting, ${posts.posted} posted this week.`);
  lines.push('', 'The detail is in the app: pipeline, watchlist, drafts and gaps. This is an internal summary, sent to the digest list only.');
  return {
    subject: `Engine week: ${s.news} signal${s.news === 1 ? '' : 's'}, ${l.created} new lead${l.created === 1 ? '' : 's'}, ${d.waiting} draft${d.waiting === 1 ? '' : 's'} waiting`,
    text: lines.join('\n'),
  };
}

// The same week as a designed email, John's ask of 17 August 2026 when the
// plain digest read as a wall of labelled sentences on a phone. One centred
// card in the app's own palette, the subject's three numbers as a hero row,
// then a short section per lane. Inline styles and tables only, because
// email clients; every value rendered here is a number or a fixed string, so
// nothing needs escaping. The text version above remains the wording of
// record and the two renderers share their arithmetic by construction.
const PAL = { navy: '#1F386B', blue: '#009ADE', ink2: '#5B6B8C', line: '#E3E7EE', paper: '#F7F8FA' };
export function renderDigestHtml(data, { weekEnding = new Date().toISOString().slice(0, 10), appUrl = process.env.APP_URL || '' } = {}) {
  const { questions: q, signals: s, leads: l, drafts: d, posts, convo, people } = data;
  const stat = (n, label) =>
    `<td align="center" style="padding:14px 6px;"><div style="font-size:30px;line-height:1;font-weight:700;color:${PAL.navy};">${n}</div><div style="font-size:12px;color:${PAL.ink2};margin-top:6px;">${label}</div></td>`;
  const section = (label, figures, note) =>
    `<tr><td style="padding:12px 26px;border-top:1px solid ${PAL.line};"><div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${PAL.blue};font-weight:700;">${label}</div><div style="font-size:14px;color:${PAL.navy};margin-top:4px;line-height:1.5;">${figures}</div>${note ? `<div style="font-size:12px;color:${PAL.ink2};margin-top:3px;">${note}</div>` : ''}</td></tr>`;
  const rate = convo && convo.sent > 0 ? `, a reply rate of ${Math.round((convo.replies / convo.sent) * 100)} percent` : '';
  const rows = [
    section('Signals', `${s.news} data centre stor${s.news === 1 ? 'y' : 'ies'} kept, ${s.uk} UK project and ${s.watch} watchlist, with ${s.filings} register filing${s.filings === 1 ? '' : 's'} tracked.`),
    section('Leads', `${l.created} new, ${l.refreshed} refreshed.`),
    section('Outbound', `${d.waiting} draft${d.waiting === 1 ? '' : 's'} awaiting review, ${d.approved} approved, ${d.drafted_this_week} drafted this week.`, 'Nothing sends without a person.'),
    convo ? section('Conversations', `${convo.sent} prospect send${convo.sent === 1 ? '' : 's'}, ${convo.replies} repl${convo.replies === 1 ? 'y' : 'ies'}${rate}. ${convo.live} live, ${convo.closed} clear no. Meetings booked ${convo.meetings}, handed off ${convo.handoffs}.`) : '',
    people ? section('Decision makers', `${people.searches} compan${people.searches === 1 ? 'y' : 'ies'} searched, ${people.found} ${people.found === 1 ? 'person' : 'people'} found (${people.orbit} in orbit), ${people.emails} email${people.emails === 1 ? '' : 's'} resolved.`,
      people.autoOn ? '' : `<span style="color:#D97706;font-weight:600;">The automatic people search is switched off; the Health page turns it back on.</span>`) : '',
    section('Co-pilot', `${q.questions} question${q.questions === 1 ? '' : 's'} (${q.teams} from Teams), ${q.declined} it could not answer, feedback ${q.fb_up} helpful and ${q.fb_down} not.`),
    posts ? section('Studio', `${posts.waiting} post draft${posts.waiting === 1 ? '' : 's'} waiting, ${posts.posted} posted this week.`) : '',
  ].join('');
  const button = appUrl
    ? `<div style="margin-top:14px;"><a href="${appUrl}" style="display:inline-block;background:${PAL.blue};color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;padding:9px 18px;border-radius:6px;">Open the engine</a></div>`
    : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAL.paper};padding:24px 0;"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid ${PAL.line};border-radius:10px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">
<tr><td style="padding:22px 26px 4px;"><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${PAL.ink2};font-weight:700;">PCT engine</div>
<div style="font-size:20px;font-weight:700;color:${PAL.navy};margin-top:6px;">The week to ${humanDate(weekEnding)}</div></td></tr>
<tr><td style="padding:6px 20px 12px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
${stat(s.news, `signal${s.news === 1 ? '' : 's'} kept`)}${stat(l.created, `new lead${l.created === 1 ? '' : 's'}`)}${stat(d.waiting, `draft${d.waiting === 1 ? '' : 's'} waiting`)}
</tr></table></td></tr>
${rows}
<tr><td style="padding:16px 26px 22px;border-top:1px solid ${PAL.line};"><div style="font-size:12px;color:${PAL.ink2};line-height:1.5;">The detail is in the app: pipeline, watchlist, drafts and gaps. This is an internal summary, sent to the digest list only.</div>${button}</td></tr>
</table></td></tr></table>`;
}

// Due on a Monday morning (07:00 UTC or later) when nothing has been sent since
// that Monday began. Pure, so the schedule is provable.
export function digestDue({ lastSentAt, now = Date.now() }) {
  const d = new Date(now);
  if (d.getUTCDay() !== 1 || d.getUTCHours() < 7) return false;
  const mondaySeven = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 7);
  if (!lastSentAt) return true;
  const last = new Date(lastSentAt).getTime();
  return Number.isNaN(last) ? true : last < mondaySeven;
}
