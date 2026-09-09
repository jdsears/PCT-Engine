// A HubSpot company export, read and written without a dependency, shared by
// the seed script and the script that corrects an export before seeding.
// Quoted fields with commas, doubled quotes inside them, CRLF or LF, and a
// leading byte-order mark tolerated on the way in and never written out.

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const src = String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = (rows.shift() || []).map(h => h.trim());
  return rows
    .filter(r => r.some(v => String(v).trim()))
    .map(r => Object.fromEntries(header.map((h, i) => [h, String(r[i] ?? '').trim()])));
}

// Rows back to text in the header's own column order, quoting only what
// needs it, so a corrected export re-imports where it came from.
export function writeCsv(rows, header = null) {
  const cols = header || Object.keys(rows[0] || {});
  const cell = v => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols, ...rows.map(r => cols.map(c => r[c] ?? ''))].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// Northern Ireland reads as in scope however the CRM filed it: the sales area
// column puts Craigavon under Ireland, and the prospecting rule is about the
// Republic, not the island.
export const NI_CITIES = ['belfast', 'craigavon', 'lisburn', 'newry', 'derry', 'londonderry',
  'ballymena', 'coleraine', 'armagh', 'omagh', 'enniskillen', 'antrim', 'bangor', 'dungannon'];
// Cities that are plainly not in these islands. A CRM row can say United
// Kingdom and carry a head-office city abroad; that is a question for a human,
// not a silent include or a silent drop.
export const FOREIGN_CITIES = ['duesseldorf', 'dusseldorf', 'des plaines', 'kalamazoo', 'grand rapids',
  'miami', 'boulder', 'laverton north'];

export function placeOf(row) {
  const city = String(row['City'] || '').trim().toLowerCase();
  const country = String(row['Country/Region'] || '').trim().toLowerCase();
  if (NI_CITIES.includes(city)) return 'northern_ireland';
  if (country === 'ireland') return 'republic_of_ireland';
  if (city && FOREIGN_CITIES.includes(city)) return 'foreign_city';
  if (country && country !== 'united kingdom') return 'foreign_country';
  return 'uk';
}

// Why the seed would hold a row, or null when it would seed it. The seed
// script and the correction script agree by construction.
export function holdReason(row) {
  const place = placeOf(row);
  const city = String(row['City'] || '').trim();
  if (place === 'republic_of_ireland') return null;
  if (place === 'foreign_city' || place === 'foreign_country') {
    return `city ${city || 'unknown'} is outside the UK while the export says ${row['Country/Region'] || 'no country'}`;
  }
  if (!String(row['Company owner'] || '').trim() && !city) return 'no owner and no city; a stub row rather than a company';
  return null;
}
