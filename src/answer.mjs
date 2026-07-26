import { search } from './retrieve.mjs';
import { route } from './configurator/converse.mjs';
import { priceTurn } from './pricing/priceAnswer.mjs';
import { quoteTurn } from './pricing/quote.mjs';

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6'; // configurable; confirm against Anthropic docs if it errors

// Light query understanding: detect a named line or application and scope the search.
const LINE_TERMS = [
  [/\bjordan\b/i, { line: 'jordan' }],
  [/\bsteriflow\s+(food|f&b|fb|beverage)/i, { line: 'steriflow_fb' }],
  [/\bsteriflow\b/i, { line: 'steriflow' }],
  [/\bmarwin\b/i, { line: 'marwin' }],
  [/\blow\s*flow\b/i, { line: 'low_flow' }],
  [/\bhex\s*valve\b/i, { line: 'hexvalve' }],
  [/\bbestobell\b/i, { line: 'bestobell_steam' }],
  [/\bequilibar\b/i, { line: 'equilibar' }],
  [/\bdata\s*cent(re|er)\b/i, { application: 'data_centre' }],
];
export function detectFilters(question) {
  for (const [re, f] of LINE_TERMS) if (re.test(question)) return f;
  return {};
}

// Clean the reply to the house voice. The stricter reject-and-regenerate gate
// belongs to outbound drafts later, not here. Newlines are kept so the Markdown
// structure survives for the chat to render.
export function voiceGate(text) {
  return text
    .replace(/\s*[—–]\s*/g, ', ') // em and en dashes
    .replace(/\bgenuinely\b/gi, '')
    // PCT is a supplier, not a distributor, in all client-facing copy. Rewrite the
    // self-description, but leave technical "distribution" (flow distribution, a
    // distribution header) alone, since that is not PCT's commercial role.
    .replace(/\bdistributors\b/gi, m => (/^[A-Z]/.test(m) ? 'Suppliers' : 'suppliers'))
    .replace(/\bdistributor\b/gi, m => (/^[A-Z]/.test(m) ? 'Supplier' : 'supplier'))
    .replace(/\b(PCT|Premier Control Technologies|we)\s+(distribute|distributes|distributing|distributed)\b/gi,
      (m, subj, verb) => `${subj} ${({ distribute: 'supply', distributes: 'supplies', distributing: 'supplying', distributed: 'supplied' })[verb.toLowerCase()]}`)
    .replace(/[ \t]{2,}/g, ' ')   // collapse runs of spaces but keep line breaks
    .replace(/[ \t]+([,.])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')   // at most one blank line between paragraphs
    .trim();
}

function buildContext(results) {
  return results.map((r, i) =>
    `[${i + 1}] ${r.title}${r.section ? ' | ' + r.section : ''}${r.page ? ' (p' + r.page + ')' : ''}\n${r.content || r.snippet}`
  ).join('\n\n');
}

export async function ask(question, { history = [], k = 10, configState = null, quoteState = null } = {}) {
  const startedAt = Date.now();

  // The quote basket runs first, on its own verbs alone: start, add, remove,
  // show, switch currency, discard. Anything else falls through untouched, and
  // an open basket rides along every other kind of turn unchanged, so a rep
  // can ask ordinary questions mid-quote without losing it.
  const basket = await quoteTurn(question, quoteState).catch(() => null);
  if (basket) {
    return {
      answer: basket.answer,
      filters: {}, citations: [], declined: false, citationsUsed: [],
      sourcesOffered: 0, latencyMs: Date.now() - startedAt,
      configState: configState ?? null, quoteState: basket.quoteState, quoteHandled: true,
    };
  }

  // The part-number configurator runs ahead of retrieval. It either continues a
  // guided build, answers a reply to an offer, or makes a conservative offer when
  // a message looks like a build. When it handles the turn the normal answer path
  // is skipped; otherwise it returns { handled: false } and we carry on, clearing
  // any stale offer so a declined or unrelated message drops it.
  const routed = await route(question, configState);
  if (routed.handled) {
    return {
      answer: routed.reply,
      filters: {}, citations: [], declined: false, citationsUsed: [],
      sourcesOffered: 0, latencyMs: Date.now() - startedAt,
      configState: routed.configState ?? null,
      quoteState: quoteState ?? null,
      configurator: routed.config || null,
      configOptions: routed.options || null,
      configLog: routed.configLog || null,
    };
  }

  // Price questions answer deterministically from the loaded lists or the
  // enquiry process, web and Teams alike, with no model between a part number
  // and its price. A pricing failure never fails the answer; the ordinary
  // path simply carries on.
  const priced = await priceTurn(question).catch(() => null);
  if (priced) {
    return {
      answer: priced.answer,
      filters: {}, citations: [], declined: false, citationsUsed: [],
      sourcesOffered: 0, latencyMs: Date.now() - startedAt, configState: null,
      quoteState: quoteState ?? null,
    };
  }

  // Use the immediate prior turn so a follow-up such as "and the reduced-port
  // version?" still retrieves and scopes against what was being discussed.
  const lastUser = history.filter(m => m.role === 'user').slice(-1).map(m => m.text);
  const retrievalQuery = [...lastUser, question].join('\n');
  const here = detectFilters(question);
  const filters = Object.keys(here).length ? here : detectFilters(lastUser.join(' '));
  const results = await search(retrievalQuery, { filters, k });

  // Supplier-naming guardrail, driven by the nameable flag we tagged at ingestion.
  const blocked = [...new Set(results.filter(r => r.nameable === false).map(r => r.manufacturer).filter(Boolean))];
  const blockNote = blocked.length ? ` Do not name these suppliers anywhere in your answer: ${blocked.join(', ')}.` : '';

  const system =
    "You are the knowledge co-pilot for Premier Control Technologies (PCT), answering questions for the PCT sales team. " +
    "Answer only from the numbered sources provided. If the answer is not in them, say you do not have it in the documents and suggest the person ask the relevant colleague. " +
    "Cite the sources you rely on with their bracket numbers, for example [1]. " +
    "Write in British English, calm and plain. Do not use em dashes or en dashes. Never use the word \"genuinely\". " +
    "Format the answer for easy reading with light Markdown: short paragraphs, and a simple bulleted or numbered list when you list items. Use bold sparingly for a key term, and do not use large headings. " +
    "Do not invent product specifications or numbers; if a figure is not in the sources, say so. " +
    "Pricing questions route internally: PCT's own price lookup and the mega price sheet are the source for prices, and quoted lines go through PCT's enquiry process. Never suggest contacting a manufacturer, or give a manufacturer's phone number or address, for pricing." +
    blockNote;

  const user = `Question: ${question}\n\nSources:\n${buildContext(results)}`;

  // Prior turns give the model the thread. Strip stale citation markers so the
  // bracket numbers in this answer refer only to this turn's sources, and drop a
  // leading assistant turn so the exchange still starts with a user message.
  let prior = history.slice(-6).map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.role === 'user' ? m.text : String(m.text || '').replace(/\[[\d,\s]+\]/g, '').replace(/[ \t]{2,}/g, ' ').trim(),
  })).filter(m => m.content);
  while (prior.length && prior[0].role === 'assistant') prior = prior.slice(1);
  const messages = [...prior, { role: 'user', content: user }];

  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, system, messages }),
  });
  if (!res.ok) throw new Error(`Claude answer failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const raw = (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

  const answer = voiceGate(raw);

  // Only surface citation chips for the sources the answer referenced, keeping
  // their original numbers so they match the [n] markers in the text.
  const cited = new Set();
  for (const m of answer.matchAll(/\[([\d,\s]+)\]/g)) {
    for (const num of m[1].split(/\D+/)) if (num) cited.add(Number(num));
  }
  const citations = results
    .map((r, i) => ({ n: i + 1, title: r.title, section: r.section, page: r.page, line: r.line, sourceId: r.sourceId }))
    .filter(c => cited.has(c.n));

  // declined is an honest, cheap proxy: a grounded answer cites a source, a
  // decline cites none. citationsUsed reuses the references resolved above.
  const citationsUsed = citations.map(c => ({ n: c.n, title: c.title }));
  return {
    answer, filters, citations,
    declined: citationsUsed.length === 0,
    citationsUsed,
    sourcesOffered: results.length,
    latencyMs: Date.now() - startedAt,
    // routed was not handled, so any prior offer is dropped by returning null.
    configState: routed.configState ?? null,
    // An open quote basket is never dropped by an ordinary turn.
    quoteState: quoteState ?? null,
    configurator: null,
    configOptions: null,
    configLog: null,
  };
}
