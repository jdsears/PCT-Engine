import { useState, useEffect } from 'react';

const STAGE_DEFS = [
  { id: 'sourced', label: 'Sourced', left: '6%' },
  { id: 'researched', label: 'Researched', left: '22%' },
  { id: 'outbound', label: 'Outbound', left: '38%' },
  { id: 'replied', label: 'Replied', left: '54%' },
  { id: 'qualified', label: 'Qualified', left: '78%' },
  { id: 'handed_off', label: 'Handed off', left: '93%' },
];

const EMPTY_COPY = {
  outbound: 'Outbound has no leads yet. The stage opens when sending is built, and drafts will wait here for approval.',
};

export default function Pipeline({ isMobile }) {
  const [stage, setStage] = useState('researched');
  const [data, setData] = useState(null);
  const [state, setState] = useState('loading');

  useEffect(() => {
    let live = true;
    fetch(`/api/pipeline?stage=${stage}`)
      .then(r => r.json())
      .then(d => { if (live) { setData(d); setState('ready'); } })
      .catch(() => { if (live) setState('error'); });
    return () => { live = false; };
  }, [stage]);

  if (state === 'error') {
    return <div className="content-pad"><p className="muted-note">The pipeline is not available right now.</p></div>;
  }

  const counts = Object.fromEntries((data?.stages || []).map(s => [s.stage, s.count]));
  const leads = data?.leads || [];
  const total = data?.total ?? 0;
  const stageDef = STAGE_DEFS.find(s => s.id === stage);
  const hasLeads = leads.length > 0;

  return (
    <div className="content-pad pipeline">
      <div className="card track-card">
        <div className="track" style={{ height: isMobile ? 150 : 122 }}>
          <div className="track-line" />
          <div className="track-wave" aria-hidden="true">
            <svg width="1600" height="24" viewBox="0 0 1600 24">
              <path d="M0,12 q30,-8 60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0" fill="none" stroke="#49C0B1" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
          {STAGE_DEFS.map((s, i) => {
            const active = stage === s.id;
            return (
              <div className="stop" style={{ left: s.left }} key={s.id}>
                <button className={`stop-btn${active ? ' active' : ''}`} aria-label={`${s.label} stage`}
                  onClick={() => setStage(s.id)}>
                  <span className="stop-count">{state === 'loading' && !data ? '' : (counts[s.id] ?? 0)}</span>
                  <span className="stop-dot" />
                  <span className="stop-label" style={isMobile ? { top: i % 2 ? 100 : 74 } : undefined}>{s.label}</span>
                </button>
              </div>
            );
          })}
          <div className="gate-mark" style={{ left: '65%' }} aria-hidden="true">
            <div className="gate-bar" />
            <div className="gate-label">Qualification gate</div>
          </div>
        </div>
      </div>

      <div className="card leads-card">
        <div className="leads-head">
          <div className="leads-title">{stageDef.label}</div>
          {hasLeads && <div className="leads-meta">Showing {leads.length} of {total}</div>}
        </div>
        {hasLeads ? (
          <div className="leads-list">
            {leads.map((l, i) => (
              <div className="lead-row" key={i}>
                <div className="lead-main">
                  <div className="lead-company">{l.company}</div>
                  <div className="lead-contact">{l.contact || 'No contact yet'}</div>
                </div>
                <div className="lead-side">
                  {l.region && <span className="pill">{l.region}</span>}
                  <span className="lead-score">{l.score ?? '—'}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="leads-empty">{EMPTY_COPY[stage] || 'No leads at this stage yet.'}</div>
        )}
      </div>
    </div>
  );
}
