import { getCampaign } from '../campaigns/registry.mjs';

// What kind of company a confirmed discovery is.
//
// The confirm queue's purpose is to put a discovered company on the register so
// it can become a lead. It was not doing that. A confirmed account arrived with
// no company_type, so the ICP scorer awarded it nothing for type fit, and the
// arithmetic landed on exactly 35: named account 25, type fit 0, signals 0,
// Companies House health 10 as the neutral value for an uncached profile. The
// lead threshold is 40. Every account added through the queue therefore sat
// just below the line and could never become a lead, which is the whole point
// of the queue.
//
// The information needed was already in the review. A proposal records which
// party the name was, operator or contractor, and each campaign now declares
// what those parties are in its own ICP vocabulary: a contractor is the M&E
// contractor type on both campaigns, while an operator is the data centre
// developer on one and the pharmaceutical manufacturer on the other. Declared
// in the definition rather than inferred from the order of companyTypes,
// because a positional rule would break silently the first time that list is
// reordered.
export function companyTypeForParty(campaign, party) {
  const def = typeof campaign === 'string' ? getCampaign(campaign) : campaign;
  const map = def?.icp?.partyTypes;
  if (!map) return null;
  const key = String(party || '').toLowerCase() === 'contractor' ? 'contractor' : 'operator';
  return map[key] || null;
}
