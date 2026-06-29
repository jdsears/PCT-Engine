import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { apiFetch } from './api.js';
import { ICONS, ChevronRight, ChevronLeft } from './icons.jsx';

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
  const endRef = useRef(null);
  const inputRef = useRef(null);
  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [messages, busy]);

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
        body: JSON.stringify({ question: q, history, configState }),
      });
      const data = await res.json();
      setConfigState(data.configState ?? null);
      setMessages(m => [...m, {
        role: 'copilot', text: data.answer, citations: data.citations || [],
        options: data.configOptions || null, config: data.configurator || null,
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
          {messages.length === 0 && (
            <Shortcuts
              onConfigure={() => send('build a part number')}
              onPrefill={t => { setInput(t); inputRef.current?.focus(); }}
            />
          )}
          {messages.map((m, i) => (
            m.role === 'user' ? (
              <div key={i} className="row-user"><div className="ububble">{m.text}</div></div>
            ) : (
              <div key={i} className="row-copilot">
                <div className="acard">
                  {m.config ? (
                    <PartNumberCard config={m.config} />
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

function Shortcuts({ onConfigure, onPrefill }) {
  return (
    <div className="cp-landing">
      <div className="cp-eyebrow">Start here</div>
      <div className="cp-shortcuts">
        {SHORTCUTS.map(s => s.kind === 'disabled' ? (
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
            onClick={() => (s.kind === 'configure' ? onConfigure() : onPrefill(s.prompt))}>
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
function PartNumberCard({ config }) {
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
      <div className="pnsource">Per the ordering matrix in {config.citation}. Pricing is a separate step, handled later.</div>
    </div>
  );
}

// When the tappable option list is shown, drop the server's inline "The options
// are: ..." enumeration from the prose so the choices are not listed twice. The
// server phrasing is fixed, and no option label carries a full stop, so the run
// ends cleanly at the terminating period. Plain-text clients keep the full text.
function stripEnumeration(text, options) {
  if (!options) return text;
  return text.replace(/\s*The options are:[^.]*\./g, '').replace(/\n{3,}/g, '\n\n').trim();
}
