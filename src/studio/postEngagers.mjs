import { pool } from '../db.mjs';
import { unipile, ROUTES, accountForCampaign } from '../research/unipile.mjs';
import { matchParty } from '../research/match.mjs';
import { EXCLUDE_TITLES } from '../research/orbitRules.mjs';
import { getCampaign } from '../campaigns/registry.mjs';
import { cleanRole } from './liPosts.mjs';

// Who engaged with a post, made useful.
//
// James's old-story post still drew the right audience, a Project Manager
// (Data Centres) among the likers, and his question was what the engine can do
// with that. Engagement is self-selected interest from exactly the population
// the campaign hunts, so it is worth reading, and reading is all this does:
// one human click fetches the reactions on one of OUR OWN published posts
// through the connected account, the same thing a person sees under their
// post, counted against the same daily cap as every other call in the lane.
// The lane's two sanctioned writes, one post and one invite per human click,
// are untouched.
//
// Each engager is analysed, not just listed: the headline's company against
// the register through the matcher, the title against the campaign's orbit
// list. Acting on one stays human: a matched engager can become a contact on
// that account, which then flows into the existing invite eligibility and the
// gated email discovery. Nothing automatic follows.
//
// A deliberate position, taken once here: engagement informs targeting, never
// email wording. The liked-our-post fact does not enter draft grounding,
// because a cold email that says "I saw you liked our post" reads as
// surveillance and spends the trust the voice has earned.

// The company from a LinkedIn headline, "Project Manager (Data Centres) at
// Ark Data Centres | DC builds" -> "Ark Data Centres". Word-bounded " at " so
// Battersea never splits; the first separator ends the company. Null when the
// headline names none, which is honest rather than guessed.
export function companyFromHeadline(headline) {
  const s = String(headline || '').trim();
  const m = s.split(/\s+at\s+/i);
  if (m.length < 2) return null;
  const company = m.slice(1).join(' at ').split(/\s*\|\s*|\s*·\s*|\s+[–—-]\s+/)[0].trim();
  return company || null;
}

// Does a title fit a campaign's decision orbit? The campaign's own orbit
// vocabulary decides, with the shared exclusions (students, interns and kin)
// refusing first, whatever they contain.
export function titleFitsCampaign(title, campaign) {
  const def = typeof campaign === 'string' ? getCampaign(campaign) : campaign;
  const t = String(title || '').toLowerCase();
  if (!t || !def?.orbitTitles?.length) return false;
  if (EXCLUDE_TITLES.some(x => t.includes(x))) return false;
  return def.orbitTitles.some(o => t.includes(o));
}

// One reaction item into one engager row, defensively: the provider's item
// shape is nested or flat depending on endpoint version, so every field is
// tried in both places, and an item with no name at all is dropped and
// counted, never invented.
export function shapeEngager(item) {
  const a = item?.author ?? item?.user ?? item ?? {};
  const name = String(a.name ?? [a.first_name, a.last_name].filter(Boolean).join(' ')).trim();
  if (!name) return null;
  const headline = String(a.headline ?? item?.headline ?? '').trim();
  const publicId = a.public_identifier ?? a.public_profile_id ?? item?.public_identifier ?? null;
  const profileUrl = a.profile_url ?? (publicId ? `https://www.linkedin.com/in/${publicId}` : null);
  return {
    name, headline,
    role: cleanRole(headline) || null,
    company: companyFromHeadline(headline),
    profileUrl,
    reaction: item?.value ?? item?.reaction_type ?? null,
  };
}

// Analyse a reaction list against the register and the campaign: pure, so the
// gate proves the whole judgement without a provider.
export function analyseEngagers(items, { register = [], aliases = {}, campaign = 'marwin_dc' } = {}) {
  const def = typeof campaign === 'string' ? getCampaign(campaign) : campaign;
  const rows = [];
  let unparsed = 0;
  for (const item of items || []) {
    const e = shapeEngager(item);
    if (!e) { unparsed++; continue; }
    const orbitFit = titleFitsCampaign(e.role || e.headline, def);
    const match = e.company ? matchParty(e.company, register, { aliases }) : { status: 'unknown' };
    rows.push({
      ...e, orbitFit,
      matchedCompanyId: match.status === 'matched' ? match.company.id : null,
      matchedCompanyName: match.status === 'matched' ? match.company.name : null,
    });
  }
  // The strongest prospects first: orbit fit and a matched account, then
  // orbit fit alone, then the rest in arrival order.
  rows.sort((a, b) => (Number(b.orbitFit) * 2 + Number(!!b.matchedCompanyId)) - (Number(a.orbitFit) * 2 + Number(!!a.matchedCompanyId)));
  return { engagers: rows, unparsed };
}

// Fetch and analyse the engagers of one published post. Read-only; CapReached
// and AccountUnhealthy pass through for the route to report plainly.
export async function fetchPostEngagers(liPostId) {
  const p = (await pool.query(
    `SELECT lp.id, lp.status, lp.grounding, s.campaign
     FROM li_posts lp LEFT JOIN signals s ON s.id = lp.signal_id
     WHERE lp.id = $1`, [liPostId])).rows[0];
  if (!p) return { ok: false, reason: 'post not found' };
  if (p.status !== 'posted') return { ok: false, reason: 'only a published post has engagement' };
  const pid = p.grounding?.linkedinPostId;
  if (!pid) {
    return { ok: false, reason: 'this post was published before engagement capture existed, so no post id is on record; new posts carry one' };
  }
  // The read goes through the account that published the post, which is the
  // campaign's own connected account.
  const campaign = p.grounding?.campaign || p.campaign || 'marwin_dc';
  const json = await unipile(ROUTES.listPostReactions, {
    pathSuffix: `${encodeURIComponent(String(pid))}/reactions`, rawSuffix: true,
    query: { account_id: accountForCampaign(campaign), limit: 100 },
    target: `li_post ${p.id} reactions`,
  });
  const items = Array.isArray(json?.items) ? json.items : Array.isArray(json) ? json : [];
  const { rows: register } = await pool.query(`SELECT id, name FROM companies`);
  const aliases = Object.fromEntries(
    (await pool.query(`SELECT alias, canonical FROM matcher_aliases`)).rows.map(r => [r.alias, r.canonical]));
  return { ok: true, campaign, raw: items.length, ...analyseEngagers(items, { register, aliases, campaign }) };
}
