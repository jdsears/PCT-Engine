import { useState, useEffect } from 'react';
import { apiFetch } from './api.js';

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

const SIZES = [10, 20, 50, 100];
const SORTS = [
  { id: 'score', label: 'Score', defDir: 'desc' },
  { id: 'company', label: 'Company', defDir: 'asc' },
  { id: 'region', label: 'Region', defDir: 'asc' },
];

function Head({ children }) {
  return (
    <div className="ins-head">
      <div className="eyebrow">{children}</div>
      <div className="rule" />
    </div>
  );
}

export default function Pipeline({ isMobile }) {
  const [stage, setStage] = useState('researched');
  const [limit, setLimit] = useState(10);
  const [sort, setSort] = useState('score');
  const [dir, setDir] = useState('desc');
  const [qLive, setQLive] = useState('');
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [state, setState] = useState('loading');

  // Debounce the search box so typing does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQ(qLive.trim()), 250);
    return () => clearTimeout(t);
  }, [qLive]);

  useEffect(() => {
    let live = true;
    const params = new URLSearchParams({ stage, limit: String(limit), sort, dir });
    if (q) params.set('q', q);
    apiFetch(`/api/pipeline?${params}`)
      .then(r => r.json())
      .then(d => { if (live) { setData(d); setState('ready'); } })
      .catch(() => { if (live) setState('error'); });
    return () => { live = false; };
  }, [stage, limit, sort, dir, q]);

  useEffect(() => {
    let live = true;
    apiFetch('/api/pipeline/analytics')
      .then(r => r.json())
      .then(d => { if (live) setAnalytics(d); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  function clickSort(s) {
    if (sort === s.id) setDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(s.id); setDir(s.defDir); }
  }

  if (state === 'error') {
    return <div className="content-pad"><p className="muted-note">The pipeline is not available right now.</p></div>;
  }

  const counts = Object.fromEntries((data?.stages || []).map(s => [s.stage, s.count]));
  const leads = data?.leads || [];
  const total = data?.total ?? 0;
  const stageDef = STAGE_DEFS.find(s => s.id === stage);
  const hasLeads = leads.length > 0;

  const regionMax = Math.max(1, ...(analytics?.regions || []).map(r => r.n));
  const spread = analytics ? [
    { label: '70 and above', n: analytics.scores.strong },
    { label: '40 to 69', n: analytics.scores.middle },
    { label: 'Under 40', n: analytics.scores.weak },
    ...(analytics.scores.unscored ? [{ label: 'Not yet scored', n: analytics.scores.unscored }] : []),
  ] : [];
  const spreadMax = Math.max(1, ...spread.map(r => r.n));

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
          {(hasLeads || q) && <div className="leads-meta">Showing {leads.length} of {total}</div>}
        </div>
        <div className="leads-tools">
          <input className="tool-search" type="search" value={qLive}
            onChange={e => setQLive(e.target.value)}
            placeholder="Search companies and contacts" aria-label="Search leads" />
          <div className="tool-group" role="group" aria-label="Sort leads">
            {SORTS.map(s => (
              <button key={s.id} className={`filter-pill${sort === s.id ? ' active' : ''}`}
                onClick={() => clickSort(s)}>
                {s.label}{sort === s.id ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
              </button>
            ))}
          </div>
          <div className="tool-group" role="group" aria-label="Rows to show">
            {SIZES.map(n => (
              <button key={n} className={`filter-pill mono-pill${limit === n ? ' active' : ''}`}
                onClick={() => setLimit(n)}>{n}</button>
            ))}
          </div>
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
          <div className="leads-empty">
            {q ? `No matches for “${q}” at this stage.` : (EMPTY_COPY[stage] || 'No leads at this stage yet.')}
          </div>
        )}
      </div>

      {analytics && (
        <>
          <div className="ins-section">
            <Head>Pipeline analytics</Head>
            <div className="ins-cards">
              <div className="ins-card ins-card--stat">
                <div className="ins-hero">{analytics.scores.median ?? '—'}</div>
                <div className="eyebrow">Median ICP score</div>
              </div>
              <div className="ins-card ins-card--stat">
                <div className="ins-hero">{analytics.coverage.withContact} / {analytics.coverage.leads}</div>
                <div className="eyebrow">Leads with a register contact</div>
              </div>
              <div className="ins-card ins-card--stat">
                <div className="ins-hero">{analytics.coverage.withDomain} / {analytics.coverage.leads}</div>
                <div className="eyebrow">Official domains resolved</div>
              </div>
              <div className="ins-card ins-card--stat">
                <div className="ins-hero">{analytics.signals30}</div>
                <div className="eyebrow">Signals in the last 30 days</div>
              </div>
            </div>
          </div>

          <div className="ins-section">
            <Head>Leads by region</Head>
            <div className="ins-bars">
              {analytics.regions.map((r, i) => (
                <div className="ins-bar" key={i}>
                  <div className="ins-bar-label">{r.region}</div>
                  <div className="ins-bar-track"><span className="ins-bar-fill" style={{ width: `${Math.round((r.n / regionMax) * 100)}%` }} /></div>
                  <div className="ins-bar-count">{r.n}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="ins-section">
            <Head>Score spread</Head>
            <div className="ins-bars">
              {spread.map((r, i) => (
                <div className="ins-bar" key={i}>
                  <div className="ins-bar-label">{r.label}</div>
                  <div className="ins-bar-track"><span className="ins-bar-fill" style={{ width: `${Math.round((r.n / spreadMax) * 100)}%` }} /></div>
                  <div className="ins-bar-count">{r.n}</div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
