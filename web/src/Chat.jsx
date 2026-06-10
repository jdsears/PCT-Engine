import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';

export default function Chat() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);
  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [messages, busy]);

  async function send() {
    const q = input.trim();
    if (!q || busy) return;
    const history = messages.map(({ role, text }) => ({ role, text }));
    setInput('');
    setMessages(m => [...m, { role: 'user', text: q }]);
    setBusy(true);
    try {
      const res = await fetch('/ask', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q, history }),
      });
      const data = await res.json();
      setMessages(m => [...m, { role: 'copilot', text: data.answer, citations: data.citations || [] }]);
    } catch {
      setMessages(m => [...m, { role: 'copilot', text: 'Sorry, something went wrong reaching the co-pilot.', citations: [] }]);
    } finally { setBusy(false); }
  }

  return (
    <div className="copilot">
      <div className="chat-scroll">
        <div className="chat-col">
          {messages.length === 0 && (
            <div className="chat-empty">Ask about a product line, a specification, a policy, or how PCT sells. For example, "what is the pressure rating of the Marwin CV3000?"</div>
          )}
          {messages.map((m, i) => (
            m.role === 'user' ? (
              <div key={i} className="row-user"><div className="ububble">{m.text}</div></div>
            ) : (
              <div key={i} className="row-copilot">
                <div className="acard">
                  <div className="atext"><ReactMarkdown>{m.text}</ReactMarkdown></div>
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
                <div className="think-cap">Checking the corpus</div>
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>
      <div className="composer-band">
        <div className="composer">
          <input type="text" value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && send()}
            placeholder="Ask the co-pilot a question" aria-label="Ask the co-pilot a question" />
          <button onClick={send} disabled={busy}>Ask</button>
        </div>
      </div>
    </div>
  );
}
