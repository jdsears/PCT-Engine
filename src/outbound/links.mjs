// Prospect-facing web links, exactly as approved and nothing else. The
// documentation corpus is full of manufacturer addresses (the Marwin book's
// cover alone carries marwinvalve.com), and a grounded link is still the
// wrong link: prospects are sent to PCT's own pages, never a factory's. So
// drafts may carry only the links listed here, letter for letter, plus the
// booking link; anything else, including a deeper path invented under an
// approved page, is a blocking flag.
//
// Provenance: James supplied the Steriflow landing page and the data centre
// cooling article by WhatsApp in July 2026 and confirmed the site is live
// for Marwin and Steriflow; John supplied the Marwin landing page on 24
// July. Its path is marwin-valve, not marwin, which is why these are never
// guessed from a pattern.
//
// OUTBOUND_LINKS (optional, Railway) merges over these defaults without a
// deploy: {"marwin_page":{"url":"https://www.pctflow.com/...","label":"Marwin range page"}}
// Only https pctflow.com addresses are accepted from the override.

const DEFAULTS = {
  steriflow_page: {
    url: 'https://www.pctflow.com/our-products/valves/steriflow/',
    label: 'Steriflow range page',
  },
  marwin_page: {
    url: 'https://www.pctflow.com/our-products/valves/marwin-valve/',
    label: 'Marwin range page',
  },
  dc_cooling_article: {
    url: 'https://www.pctflow.com/applications/data-centres-liquid-cooling-control-valves-and-europes-ai-build-out/',
    label: 'Data centre liquid cooling article',
  },
};

export function approvedLinks() {
  const merged = { ...DEFAULTS };
  const raw = String(process.env.OUTBOUND_LINKS || '').trim();
  if (raw) {
    try {
      const o = JSON.parse(raw);
      for (const [k, v] of Object.entries(o || {})) {
        const url = String(v?.url || v || '').trim();
        const label = String(v?.label || k).trim();
        if (/^https:\/\/(www\.)?pctflow\.com\//i.test(url)) merged[k] = { url, label };
      }
    } catch { /* a malformed override changes nothing */ }
  }
  return merged;
}

export const approvedLinkList = () => Object.values(approvedLinks()).map(l => l.url);

// The block a drafter is shown: the approved pages by name and address, and
// the plain prohibition on everything else.
export function promptLinksBlock() {
  const ls = Object.values(approvedLinks());
  if (!ls.length) return 'No approved PCT pages are configured; include no web address beyond the booking link.';
  return 'Approved PCT pages you may include, exactly as given and only when they help the reader: '
    + ls.map(l => `${l.label}: ${l.url}`).join('  ')
    + '. Never any other web address, and never a manufacturer site from the documentation.';
}
