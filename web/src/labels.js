// Friendly labels for the keys the engine stores. Shared across views.

export const LINE_LABELS = {
  marwin: 'Marwin', steriflow: 'Steriflow', steriflow_fb: 'Steriflow F&B',
  jordan: 'Jordan', low_flow: 'Low flow', hexvalve: 'Hex Valve',
  bestobell_steam: 'Bestobell', equilibar: 'Equilibar', data_centre: 'Data centre',
  general: 'General',
};
export const lineLabel = k =>
  LINE_LABELS[k] || (k ? k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' ') : 'General');

export const TYPE_LABELS = {
  dc_developer: 'DC developer', me_contractor: 'M&E contractor',
  end_client: 'End client', oem: 'OEM', other: 'Other',
};

export const SIGNAL_TYPE_LABELS = {
  ch_filing: 'Filing', ch_incorporation: 'Incorporation',
  ch_director_change: 'Director change', news_dc_build: 'DC build news',
  news_contract: 'Contract', planning: 'Planning',
};

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const fmtDay = dt => `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]}`;

// '08:12 · 10 Jun' in local time, the design's timestamp shape.
export function fmtClockDay(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm} · ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

// 'Mar 2024' from an ISO date.
export function fmtMonthYear(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// Registered names are upper case in the register; for display, title-case the
// all-caps ones. Tokens with digits or up to three letters (UK, DC01) keep
// their casing, and mixed-case names pass through untouched.
export function companyLabel(name) {
  const n = String(name || '').trim();
  if (!n || n !== n.toUpperCase()) return n;
  return n.split(/\s+/).map(t => (/^[A-Z]{4,}$/.test(t) ? t.charAt(0) + t.slice(1).toLowerCase() : t)).join(' ');
}
