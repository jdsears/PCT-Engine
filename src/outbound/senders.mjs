// The live sending model, decided with James in July 2026: each regional rep
// gets a dedicated prospecting address, distinct from their real mailbox by
// the dot in the local part, so campaign mail stays out of the day-to-day
// inbox and reads personal from the first touch. The engine picks the sender
// from the lead's sales area.
//
// Configuration is one Railway variable, OUTBOUND_SENDERS, a JSON list:
//
//   [{"areas":["1"],"name":"Guy Beavan","mailbox":"guy.beavan@pctflow.com"},
//    {"areas":["2","3"],"name":"Craig Downs","mailbox":"craig.downs@pctflow.com"},
//    {"areas":["4","6"],"name":"Patrick Mangell","mailbox":"patrick.mangell@pctflow.com"}]
//
// Areas accept "1" or "RA-1"; "title" is optional per sender. With the
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
    list.push({ mailbox, name, title: String(s?.title || '').trim() || null, areas });
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
