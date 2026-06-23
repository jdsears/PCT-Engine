// The slot-filling engine for the part-number configurator. Pure and
// deterministic: no model calls, no I/O. The config is the single source of
// truth. These functions decide what is valid and assemble the code; the
// conversational layer only interprets the user's words into slot values and
// never invents a code.

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

// Required slots not yet filled, in position order.
export function emptySlots(config, state) {
  return [...config.slots]
    .filter(s => s.required && !(s.id in state))
    .sort((a, b) => a.position - b.position);
}

// Validate a raw value against a slot's options by code, label or alias, all
// case-insensitive. Returns the accepted code, or a rejection with the valid
// options listed. Never accepts an unlisted value.
export function applyValue(config, state, slotId, rawValue) {
  const slot = config.slots.find(s => s.id === slotId);
  if (!slot) return { accepted: false, error: `Unknown slot ${slotId}`, options: [] };
  const r = norm(rawValue);
  const hit = slot.options.find(o =>
    norm(o.code) === r || norm(o.label) === r || (o.aliases || []).some(a => norm(a) === r));
  if (!hit) {
    return { accepted: false, slot: slot.id, label: slot.label, options: slot.options };
  }
  return { accepted: true, slot: slot.id, code: hit.code, label: hit.label, state: { ...state, [slotId]: hit.code } };
}

// Constraints whose "when" matches the state and whose "forbid" the state
// violates. Each carries its matrix reason.
export function checkConstraints(config, state) {
  const violated = [];
  for (const c of config.constraints || []) {
    const whenMatches = Object.entries(c.when).every(([k, v]) => state[k] === v);
    if (!whenMatches) continue;
    for (const [k, forbiddenCodes] of Object.entries(c.forbid)) {
      if (forbiddenCodes.includes(state[k])) {
        violated.push({ reason: c.reason, when: c.when, conflict: { slot: k, code: state[k] } });
        break;
      }
    }
  }
  return violated;
}

// Build the code only when every required slot is filled and no constraint is
// violated. Returns the code plus a per-position decode for display and audit.
export function assemble(config, state) {
  const missing = emptySlots(config, state);
  if (missing.length) return { ok: false, reason: 'incomplete', missing };
  const violated = checkConstraints(config, state);
  if (violated.length) return { ok: false, reason: 'constraint', violated };
  const code = config.assembly.replace(/\{(\w+)\}/g, (_, slotId) => state[slotId]);
  return { ok: true, code, decode: decodeState(config, state) };
}

// The per-position breakdown from a filled state: each slot in assembly order
// with its code and chosen label.
function decodeState(config, state) {
  const order = [...config.assembly.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
  return order.map(slotId => {
    const slot = config.slots.find(s => s.id === slotId);
    const opt = slot.options.find(o => o.code === state[slotId]);
    return { slot: slotId, label: slot.label, code: state[slotId], choice: opt ? opt.label : null };
  });
}

// Parse an assembled code back into its slot choices, consuming each slot's
// code in assembly order, longest match first. Powers round-trip testing.
export function decode(config, code) {
  const order = [...config.assembly.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
  let rest = String(code);
  const state = {};
  for (const slotId of order) {
    const slot = config.slots.find(s => s.id === slotId);
    const match = slot.options
      .filter(o => rest.startsWith(o.code))
      .sort((a, b) => b.code.length - a.code.length)[0];
    if (!match) return { ok: false, error: `cannot decode slot ${slotId} from "${rest}"` };
    state[slotId] = match.code;
    rest = rest.slice(match.code.length);
  }
  if (rest.length) return { ok: false, error: `trailing characters after decode: "${rest}"` };
  return { ok: true, state, decode: decodeState(config, state) };
}
