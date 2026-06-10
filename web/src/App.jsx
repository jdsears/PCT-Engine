import { useState } from 'react';
import Chat from './Chat.jsx';
import Insights from './Insights.jsx';

export default function App() {
  const [view, setView] = useState('copilot');
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand"><span className="mark">PCT</span> Engine</span>
        <nav className="nav">
          <button className={`tab${view === 'copilot' ? ' active' : ''}`} onClick={() => setView('copilot')}>Co-pilot</button>
          <button className={`tab${view === 'insights' ? ' active' : ''}`} onClick={() => setView('insights')}>Insights</button>
        </nav>
      </header>
      <div className="brandwave" aria-hidden="true">
        <svg width="1600" height="22" viewBox="0 0 1600 22" preserveAspectRatio="none">
          <path d="M0,8 q30,-7 60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0" fill="none" stroke="var(--ins-teal)" strokeWidth="2" strokeLinecap="round" />
          <path d="M0,13 q30,-7 60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0" fill="none" stroke="var(--ins-blue)" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </div>
      {view === 'copilot' ? <Chat /> : <Insights />}
    </div>
  );
}
