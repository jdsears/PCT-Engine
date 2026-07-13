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
  const l = (await pool.query(
    `SELECT count(*) FILTER (WHERE created_at >= ${week})::int AS created,
            count(*) FILTER (WHERE updated_at >= ${week} AND created_at < ${week})::int AS refreshed
     FROM leads`)).rows[0];
  const d = (await pool.query(
    `SELECT count(*) FILTER (WHERE status = 'draft')::int AS waiting,
            count(*) FILTER (WHERE status = 'approved')::int AS approved,
            count(*) FILTER (WHERE created_at >= ${week})::int AS drafted_this_week
     FROM outbound_drafts`)).rows[0];
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
  return { questions: q, signals: s, leads: l, drafts: d, posts };
}

// Plain text in the house voice. The subject carries the three numbers that
// matter; the body stays short enough to read on a phone.
export function renderDigest(data, { weekEnding = new Date().toISOString().slice(0, 10) } = {}) {
  const { questions: q, signals: s, leads: l, drafts: d, posts } = data;
  const lines = [
    `The engine's week to ${weekEnding}.`,
    '',
    `Signals: ${s.news} data centre stories kept (${s.uk} UK project, ${s.watch} watchlist), ${s.filings} register filings tracked.`,
    `Leads: ${l.created} new, ${l.refreshed} refreshed.`,
    `Outbound: ${d.waiting} draft${d.waiting === 1 ? '' : 's'} awaiting review, ${d.approved} approved, ${d.drafted_this_week} drafted this week. Nothing sends without a person.`,
    `Co-pilot: ${q.questions} question${q.questions === 1 ? '' : 's'} (${q.teams} from Teams), ${q.declined} it could not answer, feedback ${q.fb_up} helpful and ${q.fb_down} not.`,
  ];
  if (posts) lines.push(`Studio: ${posts.waiting} post draft${posts.waiting === 1 ? '' : 's'} waiting, ${posts.posted} posted this week.`);
  lines.push('', 'The detail is in the app: pipeline, watchlist, drafts and gaps. This is an internal summary, sent to the digest list only.');
  return {
    subject: `Engine week: ${s.news} signals, ${l.created} new leads, ${d.waiting} drafts waiting`,
    text: lines.join('\n'),
  };
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
