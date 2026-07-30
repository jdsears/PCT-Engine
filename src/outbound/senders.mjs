// The live sending model, decided with James in July 2026: each regional rep
// gets a dedicated prospecting address, distinct from their real mailbox by
// the dot in the local part, so campaign mail stays out of the day-to-day
// inbox and reads personal from the first touch. The engine picks the sender
// from the lead's sales area.
//
// Configuration is one Railway variable, OUTBOUND_SENDERS, a JSON list:
//
//   [{"areas":["1"],"name":"Guy Beavan","mailbox":"guy.beavan@pctflow.com",
//     "meetingLink":"https://bookings.cloud.microsoft/bookwithme/user/..."},
//    {"areas":["2","3"],"name":"Craig Downs","mailbox":"craig.downs@pctflow.com"},
//    {"areas":["4","6"],"name":"Patrick Mangell","mailbox":"patrick.mangell@pctflow.com"}]
//
// Areas accept "1" or "RA-1"; "title" and "meetingLink" are optional per
// sender. The link is the rep's own booking page and must be https; it is
// offered only in emails that rep signs, because a booking link that lands on
// someone else's calendar is worse than none. A sender without a link gets
// the offer-to-suggest-times wording instead, never another person's diary.
// With the
// variable unset, malformed, or a lead's area unmapped, everything falls
// back to the single ENGINE_MAILBOX and the SENDER_* identity, so the
// testing shape keeps working untouched and a config mistake can never
// stop mail or misattribute it. Pure over the environment, so the gate can
// prove the mapping.

const normArea = a => {
  const s = String(a || '').trim().toUpperCase();
  const m = s.match(/^(?:RA-)?([1-9])$/);
  return m ? `RA-${m[1]}` : null;
};

export function senderList() {
  const raw = String(process.env.OUTBOUND_SENDERS || '').trim();
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const list = [];
  for (const s of parsed) {
    const mailbox = String(s?.mailbox || '').trim().toLowerCase();
    const name = String(s?.name || '').trim();
    const areas = (Array.isArray(s?.areas) ? s.areas : []).map(normArea).filter(Boolean);
    if (!mailbox || !mailbox.includes('@') || !name || !areas.length) continue;
    // https only: a typo'd or plain-http link must never reach a prospect.
    const rawLink = String(s?.meetingLink || '').trim();
    const meetingLink = /^https:\/\//i.test(rawLink) ? rawLink : null;
    list.push({ mailbox, name, title: String(s?.title || '').trim() || null, areas, meetingLink });
  }
  return list;
}

// The sender for a lead's region, or null to mean the single-mailbox default.
export function senderFor(region) {
  const area = normArea(region);
  if (!area) return null;
  return senderList().find(s => s.areas.includes(area)) || null;
}

// Every mailbox replies can arrive in: the configured senders plus the engine
// mailbox, deduplicated, so reply capture sweeps them all.
export function replyMailboxes() {
  const engine = String(process.env.ENGINE_MAILBOX || '').trim().toLowerCase();
  const all = [engine, ...senderList().map(s => s.mailbox)].filter(Boolean);
  return [...new Set(all)];
}

// Every configured booking link, for the link guardrail: a draft may carry
// any rep's own link (the drafter is only ever shown the right one), plus the
// global MEETING_LINK, and nothing else.
export function meetingLinks() {
  const global = String(process.env.MEETING_LINK || '').trim();
  return [...new Set([global, ...senderList().map(s => s.meetingLink)].filter(Boolean))];
}
