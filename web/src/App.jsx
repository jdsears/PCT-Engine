import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';

export default function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);
  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [messages, busy]);

  async function send() {
    const q = input.trim();
    if (!q || busy) return;
    setInput('');
    setMessages(m => [...m, { role: 'user', text: q }]);
    setBusy(true);
    try {
      const res = await fetch('/ask', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      const data = await res.json();
      setMessages(m => [...m, { role: 'copilot', text: data.answer, citations: data.citations || [] }]);
    } catch {
      setMessages(m => [...m, { role: 'copilot', text: 'Sorry, something went wrong reaching the co-pilot.', citations: [] }]);
    } finally { setBusy(false); }
  }

  return (
    <div className="app">
      <header className="topbar"><span className="mark">PCT</span> Knowledge Co-Pilot</header>
      <main className="chat">
        {messages.length === 0 && (
          <div className="empty">Ask about a product line, a specification, a policy, or how PCT sells. For example, "what is the pressure rating of the Marwin CV3000?"</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="bubble">
              {m.role === 'copilot' ? <ReactMarkdown>{m.text}</ReactMarkdown> : m.text}
            </div>
            {m.citations?.length > 0 && (
              <div className="cites">
                {m.citations.map(c => (
                  <span className="cite" key={c.n}
                    title={`${c.title}${c.section ? ' | ' + c.section : ''}${c.page ? ' (p' + c.page + ')' : ''}`}>
                    [{c.n}] {c.title}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="msg copilot"><div className="bubble thinking">Looking through the documents...</div></div>}
        <div ref={endRef} />
      </main>
      <footer className="composer">
        <input value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && send()}
          placeholder="Ask the co-pilot a question" />
        <button onClick={send} disabled={busy}>Ask</button>
      </footer>
    </div>
  );
}
