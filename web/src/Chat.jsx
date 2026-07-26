import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { apiFetch } from './api.js';
import { ICONS, ChevronRight, ChevronLeft, ThumbUpIcon, ThumbDownIcon } from './icons.jsx';

// The web chat. Most turns are ordinary co-pilot answers. When the part-number
// configurator is running, a turn can also carry an options list (the next slot
// to choose) or a completed code with its decode. The configurator keeps its
// state on the server; the client only holds the opaque configState blob and
// returns it on the next turn.
export default function Chat() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [configState, setConfigState] = useState(null);
  const [quoteState, setQuoteState] = useState(null);
  const [priceMode, setPriceMode] = useState(false);
  const [priceReady, setPriceReady] = useState(false);
  const endRef = useRef(null);
  const inputRef = useRef(null);
  // Braced body on purpose: a concise arrow would leak scrollIntoView's
  // return value as the effect's cleanup, and newer Chrome returns a value
  // there, which React then calls as a function the moment a message lands.
  // That was a live white screen; an effect must return a function or nothing.
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, busy]);
  useEffect(() => {
    apiFetch('/api/price/status').then(r => r.json())
      .then(s => setPriceReady(!!s.ready)).catch(() => setPriceReady(false));
  }, []);

  async function send(forced) {
    const q = (forced ?? input).trim();
    if (!q || busy) return;
    const history = messages.map(({ role, text }) => ({ role, text }));
    if (forced == null) setInput('');
    setMessages(m => [...m, { role: 'user', text: q }]);
    setBusy(true);
    try {
      const res = await apiFetch('/ask', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q, history, configState, quoteState }),
      });
      const data = await res.json();
      // An error body parses as JSON too, so the catch below never sees it. It
      // must land as a readable message, never as an answerless bubble: the
      // Markdown renderer throws on a missing string and whites the screen.
      if (!res.ok || typeof data.answer !== 'string') {
        const why = res.status === 401
          ? 'Your sign-in has expired. Reload the page and enter the access key again.'
          : `The co-pilot hit an error${data?.error ? `: ${String(data.error).slice(0, 300)}` : ''}. Try again, and if it repeats send this message to John.`;
        setMessages(m => [...m, { role: 'copilot', text: why, citations: [] }]);
        return;
      }
      setConfigState(data.configState ?? null);
      setQuoteState(data.quoteState ?? null);
      setMessages(m => [...m, {
        role: 'copilot', text: data.answer, citations: data.citations || [],
        options: data.configOptions || null, config: data.configurator || null,
        pricing: data.pricing || null,
        logId: data.queryLogId ?? null,
      }]);
    } catch {
      setMessages(m => [...m, { role: 'copilot', text: 'Sorry, something went wrong reaching the co-pilot.', citations: [] }]);
    } finally { setBusy(false); }
  }

  // Return to the shortcut landing: clear the conversation and any build in
  // progress so the empty-state cards come back.
  function reset() {
    setMessages([]);
    setConfigState(null);
    setInput('');
  }

  const building = !!(configState && configState.active);

  return (
    <div className="copilot">
      <div className="chat-scroll">
        <div className="chat-col">
          {messages.length > 0 && (
            <div className="chat-top">
              <button className="back-shortcuts" onClick={reset} aria-label="Back to shortcuts">
                <ChevronLeft /> Back to shortcuts
              </button>
            </div>
          )}
          {messages.length === 0 && (priceMode ? (
            <PricePanel onBack={() => setPriceMode(false)} />
          ) : (
            <Shortcuts
              onConfigure={() => send('build a part number')}
              onPrefill={t => { setInput(t); inputRef.current?.focus(); }}
              onPrice={() => setPriceMode(true)}
              priceReady={priceReady}
            />
          ))}
          {messages.map((m, i) => (
            m.role === 'user' ? (
              <div key={i} className="row-user"><div className="ububble">{m.text}</div></div>
            ) : (
              <div key={i} className="row-copilot">
                <div className="acard">
                  {m.config ? (
                    <PartNumberCard config={m.config} pricing={m.pricing} />
                  ) : (
                    <div className="atext"><ReactMarkdown>{stripEnumeration(m.text, m.options)}</ReactMarkdown></div>
                  )}
                  {m.options && !m.config && (
                    <OptionList options={m.options} disabled={busy} onPick={v => send(v)} />
                  )}
                  {m.citations?.length > 0 && (
                    <div className="asources">
                      <div className="asources-cap">Sources</div>
                      <div className="achips">
                        {m.citations.map(c => (
                          <span className="achip" key={c.n}
                            title={`[${c.n}] ${c.title}${c.section ? ' | ' + c.section : ''}${c.page ? ' (p' + c.page + ')' : ''}`}>
                            <span className="achip-dot" />
                            {c.title}{c.page ? `, p. ${c.page}` : ''}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {m.logId != null && <FeedbackChips id={m.logId} />}
                </div>
              </div>
            )
          ))}
          {busy && (
            <div className="row-copilot">
              <div className="acard thinking-card">
                <div className="think-wave" aria-hidden="true">
                  <svg width="300" height="22" viewBox="0 0 300 22">
                    <path d="M0,8 q30,-7 60,0 t60,0 t60,0 t60,0 t60,0" fill="none" stroke="#49C0B1" strokeWidth="2" strokeLinecap="round" />
                    <path d="M0,13 q30,-7 60,0 t60,0 t60,0 t60,0 t60,0" fill="none" stroke="#009ADE" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  <div className="pct-shimmer-el" />
                </div>
                <div className="think-cap">{building ? 'Working the matrix' : 'Checking the corpus'}</div>
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>
      <div className="composer-band">
        {building && (
          <div className="build-banner">
            Building a part number. Say <button className="link-btn" onClick={() => send('cancel')} disabled={busy}>cancel</button> to stop.
          </div>
        )}
        <div className="composer">
          <input ref={inputRef} type="text" value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && send()}
            placeholder={building ? 'Type or pick an option above' : 'Ask the co-pilot a question'}
            aria-label="Ask the co-pilot a question" />
          <button onClick={() => send()} disabled={busy}>{building ? 'Send' : 'Ask'}</button>
        </div>
      </div>
    </div>
  );
}

// The co-pilot's empty state: four shortcut cards so a first-time user sees what
// the co-pilot can do, with the part-number builder promoted to the front door
// rather than left to be discovered. Three live, one honestly disabled until the
// price lists land. Built in the existing card grammar, no flow line borrowed.
const SHORTCUTS = [
  { id: 'build', icon: 'pipeline', heading: 'Build a part number',
    sub: 'Turn process conditions into a valid part number, step by step.', kind: 'configure' },
  { id: 'product', icon: 'copilot', heading: 'Product and spec questions',
    sub: 'Ask about a product line, a datasheet, a rating or a material.',
    kind: 'prefill', prompt: 'what is the pressure rating of the Marwin CV3000?' },
  { id: 'sells', icon: 'accounts', heading: 'How PCT sells',
    sub: "Process, qualification and policy, from PCT's own playbook.",
    kind: 'prefill', prompt: 'how do we qualify an opportunity?' },
  { id: 'price', icon: 'insights', heading: 'Look up a price',
    sub: 'Sales pricing from PCT price lists. Available once the lists are loaded.', kind: 'disabled' },
];

// The price panel: a part number in, the loaded sell prices out. Deliberately
// not a chat turn, no model sits anywhere in this path; the answer is only
// ever what the ingested lists say, or an honest nothing.
function PricePanel({ onBack }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async (e) => {
    e?.preventDefault();
    const query = q.trim();
    if (!query || busy) return;
    setBusy(true);
    try {
      const r = await apiFetch(`/api/price?q=${encodeURIComponent(query)}`);
      const json = await r.json();
      setRes(r.ok ? json : { error: json.error || 'lookup failed' });
    } catch { setRes({ error: 'The lookup is not available right now.' }); }
    setBusy(false);
  };
  const sym = { GBP: '£', EUR: '€', USD: '$' };
  return (
    <div className="cp-landing">
      <div className="chat-top">
        <button className="back-shortcuts" onClick={onBack} aria-label="Back to shortcuts">
          <ChevronLeft /> Back to shortcuts
        </button>
      </div>
      <div className="cp-eyebrow">Look up a price</div>
      <form className="price-form" onSubmit={run}>
        <input className="price-input" placeholder="Part number, for example SEM203/P" value={q}
          onChange={e => setQ(e.target.value)} autoFocus />
        <button className="ob-btn primary" disabled={busy || !q.trim()}>Look up</button>
      </form>
      {res?.error && <p className="muted-note">{String(res.error)}</p>}
      {res && !res.error && res.matches.length === 0 && res.quoted && (
        <div className="card price-row">
          <div className="eyebrow">Priced per enquiry</div>
          <div className="price-part">{res.quoted.line}</div>
          <div className="price-desc">{res.quoted.note}</div>
        </div>
      )}
      {res && !res.error && res.matches.length === 0 && !res.quoted && (
        <p className="muted-note">
          Nothing in the loaded lists matches "{res.query}". Lines priced per order are quoted through the mega sheet, not here, and a price that is not in the lists is never guessed.
        </p>
      )}
      {res && !res.error && res.matches.length > 0 && (
        <div className="price-results">
          {!res.exact && <p className="muted-note">No exact match. The closest part numbers:</p>}
          {res.matches.map((m, i) => (
            <div className="card price-row" key={i}>
              <div className="price-part">{m.partNumber}</div>
              {m.description && <div className="price-desc">{m.description}</div>}
              <div className="price-prices">
                {['GBP', 'EUR', 'USD'].filter(c => m.prices[c] != null).map(c => (
                  <span className="pill" key={c}>{sym[c]}{Number(m.prices[c]).toLocaleString('en-GB')}</span>
                ))}
              </div>
              <div className="price-meta">
                {m.basis === 'guide'
                  ? `Guide price at the standard margin, computed from the ${m.listName}${m.effectiveDate ? `, effective ${String(m.effectiveDate).slice(0, 10)}` : ''}. Final margin is set per customer at quote.`
                  : `Sell price from the ${m.sourceTab} tab of the ${m.listName}${m.effectiveDate ? `, effective ${String(m.effectiveDate).slice(0, 10)}` : ''}.`}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Shortcuts({ onConfigure, onPrefill, onPrice, priceReady }) {
  const cards = SHORTCUTS.map(s => (s.id === 'price' && priceReady)
    ? { ...s, kind: 'price', sub: 'Sell prices from the loaded PCT price lists, exact and cited.' }
    : s);
  return (
    <div className="cp-landing">
      <div className="cp-eyebrow">Start here</div>
      <div className="cp-shortcuts">
        {cards.map(s => s.kind === 'disabled' ? (
          <div key={s.id} className="cp-card disabled" aria-disabled="true">
            <div className="cp-card-top">
              <span className="cp-card-icon">{ICONS[s.icon]()}</span>
              <span className="cp-coming">Coming</span>
            </div>
            <div className="cp-card-head">{s.heading}</div>
            <div className="cp-card-sub">{s.sub}</div>
          </div>
        ) : (
          <button key={s.id} className="cp-card"
            onClick={() => (s.kind === 'configure' ? onConfigure() : s.kind === 'price' ? onPrice() : onPrefill(s.prompt))}>
            <div className="cp-card-top">
              <span className="cp-card-icon">{ICONS[s.icon]()}</span>
              <span className="cp-card-arrow"><ChevronRight /></span>
            </div>
            <div className="cp-card-head">{s.heading}</div>
            <div className="cp-card-sub">{s.sub}</div>
          </button>
        ))}
      </div>
      <div className="cp-or">Or just type your question below.</div>
    </div>
  );
}

// A quiet thumbs up or down against the logged answer, one verdict per answer.
// Configurator turns carry no log id, so they show no chips.
function FeedbackChips({ id }) {
  const [given, setGiven] = useState(null);
  const give = (verdict) => {
    if (given) return;
    setGiven(verdict);
    apiFetch('/api/feedback', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queryLogId: id, verdict }),
    }).catch(() => {});
  };
  return (
    <div className="fb-row">
      <button className={`fb-btn${given === 'up' ? ' on' : ''}`} aria-label="Mark this answer as helpful"
        disabled={!!given} onClick={() => give('up')}><ThumbUpIcon /></button>
      <button className={`fb-btn${given === 'down' ? ' on' : ''}`} aria-label="Mark this answer as not helpful"
        disabled={!!given} onClick={() => give('down')}><ThumbDownIcon /></button>
      {given && <span className="fb-thanks">Noted, thank you.</span>}
    </div>
  );
}

// The next slot to choose, as a vertical list of tappable rows. Picking one
// sends its label as the next turn, the same path a typed answer takes.
function OptionList({ options, disabled, onPick }) {
  return (
    <div className="optwrap">
      <div className="optcap">{options.label}</div>
      <div className="optlist" role="list">
        {options.choices.map(c => (
          <button key={c.code} className="optrow" role="listitem"
            disabled={disabled} onClick={() => onPick(c.label)}>
            <span className="optlabel">{c.label}</span>
            <span className="optcode">{c.code}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// The completed part number: the code in mono, a per-position decode, and the
// source line. The code is the deliverable; the table is the audit trail.
function PartNumberCard({ config, pricing }) {
  const sym = { GBP: '£', EUR: '€', USD: '$' };
  const priced = pricing?.matches?.length > 0 ? pricing.matches[0] : null;
  return (
    <div className="pncard">
      <div className="pncap">Part number</div>
      <div className="pncode">{config.code}</div>
      <table className="pndecode">
        <tbody>
          {config.decode.map((d, j) => (
            <tr key={j}>
              <td className="pnpos">{d.code}</td>
              <td className="pnname">{d.label}</td>
              <td className="pnchoice">{d.choice}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {priced ? (
        <div className="pnprice">
          <span className="eyebrow">{priced.basis === 'guide' ? 'Guide price' : 'Sell price'}</span>
          {['GBP', 'EUR', 'USD'].filter(c => priced.prices[c] != null).map(c => (
            <span className="pill" key={c}>{sym[c]}{Number(priced.prices[c]).toLocaleString('en-GB')}</span>
          ))}
          <span className="pnprice-src">
            {priced.basis === 'guide'
              ? `standard margin guide from the ${priced.listName}; the master price sheet sets the margin`
              : `from the ${priced.sourceTab} tab of the ${priced.listName}`}
          </span>
        </div>
      ) : pricing?.quoted ? (
        <div className="pnprice pnprice-quoted">
          <span className="eyebrow">Pricing, per enquiry</span>
          <div className="price-desc">{pricing.quoted.note}</div>
        </div>
      ) : null}
      <div className="pnsource">Per the ordering matrix in {config.citation}.{priced || pricing?.quoted ? '' : ' Pricing is a separate step, handled later.'}</div>
    </div>
  );
}

// When the tappable option list is shown, drop the server's inline "The options
// are: ..." enumeration from the prose so the choices are not listed twice. The
// server phrasing is fixed, and no option label carries a full stop, so the run
// ends cleanly at the terminating period. Plain-text clients keep the full text.
// Always a string, whatever arrives: react-markdown v9+ throws on undefined
// children, and a thrown render is a blank screen.
function stripEnumeration(text, options) {
  const t = String(text ?? '');
  if (!options) return t;
  return t.replace(/\s*The options are:[^.]*\./g, '').replace(/\n{3,}/g, '\n\n').trim();
}
