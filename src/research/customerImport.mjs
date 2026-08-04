import { matchParty, normalizeTokens } from './match.mjs';

// James's segmented customer list, made loadable.
//
// The CRM export (August 2026) is the first record the engine has of who
// already trades with PCT: five tabs, four line-led segments and a large
// unassigned remainder, every row graded A, B or C customer or prospect and
// carrying the rep's own sales area. The engine needs that truth for three
// reasons: a cold introduction must never be drafted to an existing customer
// as though they were a stranger; the party matcher should recognise a
// customer named in a story instead of proposing them as a discovery; and the
// pharma tab is the population James chose for the pharma campaign, customers
// and prospects both.
//
// The data itself never enters the repository. This module holds the pure
// judgement, shaping, grouping and merge planning, so the gate can prove it
// on synthetic rows; scripts/import-customer-list.mjs reads the workbook and
// applies the plan on a machine that has the database.

// What each known tab means for the engine. Only the pharma tab creates
// campaign membership: James built it as that campaign's population. The
// data centre tab is deliberately not marwin_dc membership, because it holds
// PCT's trade customers, controls houses and wholesalers, not the operators
// and contractors that campaign hunts; folding customers into a hunting list
// would blur what named_account means. Every tab still loads register truth.
// An unknown tab is refused by the script, never guessed at.
export const SHEET_PLANS = {
  Datacentres_EPC_Marwin: { campaign: null, namedAccount: false },
  Pharma_Steriflow_Jordan: { campaign: 'pharma_steriflow', namedAccount: true },
  FoodBev_Cosmetics_Steriflow: { campaign: null, namedAccount: false },
  OilGas_Jordan: { campaign: null, namedAccount: false },
  Unassigned: { campaign: null, namedAccount: false },
};

// PCT's own domain. The CRM keeps internal sales-channel records, the web
// shops, under it; they are not companies and never enter the register.
export const INTERNAL_DOMAIN = 'pctflow.com';

// "4 - South East" or "4" or "RA-4" to the register's RA-4 form. Junk is
// null, never a guess.
export function salesAreaToRegion(v) {
  const m = String(v || '').trim().toUpperCase().match(/^(?:RA-)?([1-9])\b/);
  return m ? `RA-${m[1]}` : null;
}

// The CRM's grade into the register's vocabulary. Anything else, including
// blank, is null: unknown stays unknown.
export function customerStatusFrom(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'a customer') return 'a';
  if (s === 'b customer') return 'b';
  if (s === 'c customer') return 'c';
  if (s === 'prospect') return 'prospect';
  return null;
}

// A domain cell into a bare lowercase host, or null. Protocol, www and any
// path are stripped; a value without a dot is not a domain.
export function cleanDomain(v) {
  let s = String(v || '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '');
  s = s.split(/[/?#\s]/)[0].replace(/\.+$/, '');
  return s.includes('.') ? s : null;
}

// The workbook's identity grain: bracket-stripped, stop-word-stripped, sorted
// tokens. Nine Pirtek branch rows are one trading identity to the register,
// which models who a company is, not how the CRM files its branches.
export const identityKey = (name) => normalizeTokens(name).sort().join(' ');

// One CRM row into the engine's shape, or null when it names no company.
// rec is keyed by the export's own header text.
export function shapeCustomerRow(sheetName, rec) {
  const plan = SHEET_PLANS[sheetName];
  if (!plan) return null;
  const name = String(rec['Company name'] || '').trim();
  if (!name) return null;
  const iso = (d) => (d && typeof d.toISOString === 'function') ? d.toISOString() : (d ? String(d) : null);
  return {
    name,
    domain: cleanDomain(rec['Company Domain Name']),
    region: salesAreaToRegion(rec['Sales Area']),
    postcode: String(rec['Postal Code'] || '').trim() || null,
    customerStatus: customerStatusFrom(rec['Customer Type']),
    campaign: plan.campaign,
    namedAccount: plan.namedAccount,
    crm: {
      sheet: sheetName,
      recordId: String(rec['Record ID'] || '').trim() || null,
      segment: String(rec['Suggested Segment'] || '').trim() || null,
      rationale: String(rec['Segmentation Rationale'] || '').trim() || null,
      salesArea: String(rec['Sales Area'] || '').trim() || null,
      city: String(rec['City'] || '').trim() || null,
      country: String(rec['Country/Region'] || '').trim() || null,
      lastEngagementAt: iso(rec['Last Engagement Date']),
      lastActivityAt: iso(rec['Last Activity Date']),
    },
  };
}

const GRADE_RANK = { a: 0, b: 1, c: 2, prospect: 3 };

// Rows sharing an identity fold into one company before any register match.
// The strongest grade wins, because an A relationship at one branch is an A
// relationship with the company; the shortest printed name, bracket stripped,
// names the group, which is how "Pirtek (Aberdeen)" and eight siblings become
// Pirtek. Branch regions that disagree leave region null, since a national
// franchise has no one sales area and a wrong rep is worse than the engine
// identity. Internal web-shop records are set aside, not silently dropped.
export function groupRows(rows) {
  const internal = [];
  const groups = new Map();
  for (const r of rows || []) {
    if (!r) continue;
    if (r.domain === INTERNAL_DOMAIN) { internal.push(r); continue; }
    const key = identityKey(r.name);
    if (!key) { internal.push(r); continue; } // a name of only stop words is not importable
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const merged = [];
  for (const members of groups.values()) {
    if (members.length === 1) { merged.push({ ...members[0], members: null }); continue; }
    const shortest = [...members].sort((a, b) => a.name.length - b.name.length)[0];
    const name = shortest.name.replace(/\s*\([^()]*\)\s*$/, '').trim() || shortest.name;
    const best = [...members].sort((a, b) =>
      (GRADE_RANK[a.customerStatus] ?? 9) - (GRADE_RANK[b.customerStatus] ?? 9))[0];
    const regions = [...new Set(members.map(m => m.region).filter(Boolean))];
    const domains = [...new Set(members.map(m => m.domain).filter(Boolean))];
    merged.push({
      ...best,
      name,
      region: regions.length === 1 ? regions[0] : null,
      domain: domains[0] || null,
      campaign: members.map(m => m.campaign).find(Boolean) || null,
      namedAccount: members.some(m => m.namedAccount),
      crm: { ...best.crm, branches: members.map(m => m.name) },
      members: members.map(m => m.name),
    });
  }
  return { rows: merged, internal };
}

// The merge plan against the live register. Two ways to an existing account,
// in order of evidence strength: a domain held by exactly one register row,
// then the party matcher, the same one the confirm queue trusts. A domain the
// register holds twice proves nothing, the Johnson Matthey shape, so it falls
// through to names. Ambiguous names are skipped and reported for the human,
// never guessed. Rows matching nothing become creations, and later rows that
// name the same identity fold into the pending creation rather than making a
// twin.
//
// Update rules, per field: customerStatus and the crm payload are the CRM's
// own truth and refresh on every run; domain, region and postcode only fill
// gaps, never overwrite what the register already holds; namedAccount can be
// set, never unset.
export function planImport(rows, register, { aliases = {} } = {}) {
  const byDomain = new Map();
  for (const c of register || []) {
    const d = cleanDomain(c.domain);
    if (!d) continue;
    byDomain.set(d, byDomain.has(d) ? null : c); // null marks a shared domain
  }
  const plan = [];
  const pendingByKey = new Map();
  for (const row of rows || []) {
    const pendingTwin = pendingByKey.get(identityKey(row.name));
    if (pendingTwin) {
      pendingTwin.row.customerStatus = better(pendingTwin.row.customerStatus, row.customerStatus);
      pendingTwin.row.campaign = pendingTwin.row.campaign || row.campaign;
      pendingTwin.row.namedAccount = pendingTwin.row.namedAccount || row.namedAccount;
      pendingTwin.folded.push(row.name);
      continue;
    }
    const domainHit = row.domain ? byDomain.get(row.domain) : null;
    if (domainHit) {
      plan.push({ action: 'update', companyId: domainHit.id, existing: domainHit, row, matchedBy: 'domain' });
      continue;
    }
    const m = matchParty(row.name, register, { aliases });
    if (m.status === 'matched') {
      const existing = (register || []).find(c => c.id === m.company.id) || m.company;
      plan.push({ action: 'update', companyId: m.company.id, existing, row, matchedBy: 'name' });
    } else if (m.status === 'ambiguous') {
      plan.push({ action: 'skip', row, reason: 'ambiguous', candidates: m.candidates });
    } else {
      const entry = { action: 'create', row, folded: [] };
      plan.push(entry);
      pendingByKey.set(identityKey(row.name), entry);
    }
  }
  return plan;
}

const better = (a, b) => {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return (GRADE_RANK[a] ?? 9) <= (GRADE_RANK[b] ?? 9) ? a : b;
};

// The field-level changes an update carries, so the dry run prints exactly
// what --apply will do and the writer stays a dumb executor of this answer.
export function updateSets(existing, row) {
  const sets = {};
  if (row.customerStatus && row.customerStatus !== existing.customer_status) sets.customer_status = row.customerStatus;
  if (row.domain && !cleanDomain(existing.domain)) sets.domain = row.domain;
  if (row.region && !existing.region) sets.region = row.region;
  if (row.postcode && !existing.postcode) sets.postcode = row.postcode;
  if (row.namedAccount && !existing.named_account) sets.named_account = true;
  return sets;
}
