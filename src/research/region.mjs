// Maps a UK postcode to PCT's six sales areas by postcode area prefix.
//
// DRAFT for Andy to verify against PCT's sales areas map. The assignments are a
// best effort from public geography, and the weakest guesses are the Midlands
// and Wales, since the six areas have no Midlands or Wales region of their own.
// The table is plain data, so a correction is a one-line edit.
//
// RA-1 Scotland, RA-2 North West, RA-3 South West, RA-4 South East,
// RA-5 Ireland (inactive), RA-6 North East.

export const REGIONS = {
  'RA-1': { name: 'Scotland', active: true },
  'RA-2': { name: 'North West', active: true },
  'RA-3': { name: 'South West', active: true },
  'RA-4': { name: 'South East', active: true },
  'RA-5': { name: 'Ireland', active: false },
  'RA-6': { name: 'North East', active: true },
};

export const REGION_BY_POSTCODE_AREA = {
  // Scotland
  AB: 'RA-1', DD: 'RA-1', DG: 'RA-1', EH: 'RA-1', FK: 'RA-1', G: 'RA-1',
  HS: 'RA-1', IV: 'RA-1', KA: 'RA-1', KW: 'RA-1', KY: 'RA-1', ML: 'RA-1',
  PA: 'RA-1', PH: 'RA-1', TD: 'RA-1', ZE: 'RA-1',

  // Northern Ireland (RA-5 is inactive, recorded for completeness)
  BT: 'RA-5',

  // North West, with North Wales and the Isle of Man served from here (draft)
  BB: 'RA-2', BL: 'RA-2', CA: 'RA-2', CH: 'RA-2', CW: 'RA-2', FY: 'RA-2',
  IM: 'RA-2', L: 'RA-2', LA: 'RA-2', LL: 'RA-2', M: 'RA-2', OL: 'RA-2',
  PR: 'RA-2', SK: 'RA-2', ST: 'RA-2', SY: 'RA-2', WA: 'RA-2', WN: 'RA-2',

  // North East, including Yorkshire and the East Midlands' northern edge (draft)
  BD: 'RA-6', DE: 'RA-6', DH: 'RA-6', DL: 'RA-6', DN: 'RA-6', HD: 'RA-6',
  HG: 'RA-6', HU: 'RA-6', HX: 'RA-6', LN: 'RA-6', LS: 'RA-6', NE: 'RA-6',
  NG: 'RA-6', S: 'RA-6', SR: 'RA-6', TS: 'RA-6', WF: 'RA-6', YO: 'RA-6',

  // South West, with South and Mid Wales and the western Midlands (draft)
  B: 'RA-3', BA: 'RA-3', BH: 'RA-3', BS: 'RA-3', CF: 'RA-3', CV: 'RA-3',
  DT: 'RA-3', DY: 'RA-3', EX: 'RA-3', GL: 'RA-3', HR: 'RA-3', LD: 'RA-3',
  NP: 'RA-3', PL: 'RA-3', SA: 'RA-3', SN: 'RA-3', SP: 'RA-3', TA: 'RA-3',
  TF: 'RA-3', TQ: 'RA-3', TR: 'RA-3', WR: 'RA-3', WS: 'RA-3', WV: 'RA-3',

  // South East, including London, East Anglia and the eastern Midlands (draft)
  AL: 'RA-4', BN: 'RA-4', BR: 'RA-4', CB: 'RA-4', CM: 'RA-4', CO: 'RA-4',
  CR: 'RA-4', CT: 'RA-4', DA: 'RA-4', E: 'RA-4', EC: 'RA-4', EN: 'RA-4',
  GU: 'RA-4', HA: 'RA-4', HP: 'RA-4', IG: 'RA-4', IP: 'RA-4', KT: 'RA-4',
  LE: 'RA-4', LU: 'RA-4', ME: 'RA-4', MK: 'RA-4', N: 'RA-4', NN: 'RA-4',
  NR: 'RA-4', NW: 'RA-4', OX: 'RA-4', PE: 'RA-4', PO: 'RA-4', RG: 'RA-4',
  RH: 'RA-4', RM: 'RA-4', SE: 'RA-4', SG: 'RA-4', SL: 'RA-4', SM: 'RA-4',
  SO: 'RA-4', SS: 'RA-4', SW: 'RA-4', TN: 'RA-4', TW: 'RA-4', UB: 'RA-4',
  W: 'RA-4', WC: 'RA-4', WD: 'RA-4',

  // Not assigned: BF (British Forces), GY and JE (Channel Islands), GIR.
};

// Extract the postcode area, the leading letters of the outward code, and look
// it up. Unknown or missing postcodes return null rather than guessing.
export function regionForPostcode(postcode) {
  if (!postcode) return null;
  const m = String(postcode).trim().toUpperCase().match(/^([A-Z]{1,2})\d/);
  if (!m) return null;
  return REGION_BY_POSTCODE_AREA[m[1]] ?? null;
}
