import { useState, useEffect } from 'react';
import { apiFetch } from './api.js';
import { fmtClockDay } from './labels.js';

// The BD watchlist: data centre operators the engine has spotted expanding, where
// a UK move is plausible but not yet a project. Intelligence to act on, kept
// distinct from the lead pipeline. A short, high-value list, not a feed.
export default function Watchlist() {
  const [items, setItems] = useState(null);
  const [state, setState] = useState('loading');

  useEffect(() => {
    let live = true;
    apiFetch('/api/watchlist').then(r => r.json())
      .then(d => { if (live) { setItems(d.watchlist || []); setState('ready'); } })
      .catch(() => { if (live) setState('error'); });
    return () => { live = false; };
  }, []);

  if (state === 'loading') return <div className="content-pad"><p className="muted-note">Loading the watchlist.</p></div>;
  if (state === 'error') return <div className="content-pad"><p className="muted-note">The watchlist is not available right now.</p></div>;

  return (
    <div className="content-pad watchlist">
      <p className="wl-intro">Data centre operators the engine has spotted expanding, where a UK move is plausible but not yet a named project. These are business-development targets to approach or watch, not leads in the pipeline.</p>
      {items.length === 0 ? (
        <p className="muted-note">No expansion signals captured yet. Operators appear here as the news sweep finds them.</p>
      ) : (
        <div className="wl-list">
          {items.map(w => (
            <div className="card wl-card" key={w.id}>
              <div className="wl-top">
                <div className="wl-operator">{w.operator || 'Unnamed operator'}</div>
                {w.observedAt && <div className="wl-when">{fmtClockDay(w.observedAt)}</div>}
              </div>
              <div className="wl-title">{w.title}</div>
              <div className="wl-foot">
                <span className="pill">{w.type === 'news_contract' ? 'Contract' : 'Build-out'}</span>
                {w.source && (w.url
                  ? <a className="wl-src" href={w.url} target="_blank" rel="noreferrer">{w.source}</a>
                  : <span className="wl-src">{w.source}</span>)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
