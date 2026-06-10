import { useState, useEffect } from 'react';
import { SIGNAL_TYPE_LABELS, fmtClockDay } from './labels.js';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'filing', label: 'Filings' },
  { id: 'director', label: 'Director changes' },
  { id: 'build', label: 'DC build news' },
  { id: 'contract', label: 'Contracts' },
];

export default function Signals({ onOpenCompany }) {
  const [filter, setFilter] = useState('all');
  const [signals, setSignals] = useState(null);
  const [state, setState] = useState('loading');

  useEffect(() => {
    let live = true;
    const q = filter === 'all' ? '' : `?type=${filter}`;
    fetch(`/api/signals${q}`)
      .then(r => r.json())
      .then(d => { if (live) { setSignals(d.signals || []); setState('ready'); } })
      .catch(() => { if (live) setState('error'); });
    return () => { live = false; };
  }, [filter]);

  return (
    <div className="content-pad">
      <div className="signals-col">
        <div className="filter-row">
          {FILTERS.map(f => (
            <button key={f.id} className={`filter-pill${filter === f.id ? ' active' : ''}`}
              onClick={() => setFilter(f.id)}>{f.label}</button>
          ))}
        </div>
        {state === 'error' && <p className="muted-note">Signals are not available right now.</p>}
        {state === 'ready' && signals.length === 0 && (
          <p className="muted-note">No signals of this kind yet. The pollers add them as they observe.</p>
        )}
        <div className="signal-list">
          {(signals || []).map(s => (
            <div className="card signal-card" key={s.id}>
              <div className="signal-top">
                <span className="signal-type">{SIGNAL_TYPE_LABELS[s.type] || s.type}</span>
                <span className="signal-time">{fmtClockDay(s.observedAt)}</span>
              </div>
              <div className="signal-title">{s.title}</div>
              <div className="signal-foot">
                {s.company ? (
                  <button className="signal-company" onClick={() => onOpenCompany(s.companyId)}>{s.company}</button>
                ) : (
                  <span className="signal-nocompany"><span className="flag-dot" />No matched company</span>
                )}
                {s.source && <span className="signal-source">{s.source}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
