import { useState, useEffect } from 'react';
import { TYPE_LABELS, fmtClockDay, fmtMonthYear } from './labels.js';
import { CloseIcon } from './icons.jsx';
import { apiFetch } from './api.js';

const typeLabel = t => TYPE_LABELS[t] || '—';

function ScoreBar({ score, wide }) {
  return (
    <span className={`score-bar${wide ? ' wide' : ''}`}>
      <span style={{ width: `${Math.max(0, Math.min(100, score ?? 0))}%` }} />
    </span>
  );
}

function DetailPanel({ id, isMobile, onClose }) {
  const [detail, setDetail] = useState(null);
  const [state, setState] = useState('loading');
  useEffect(() => {
    let live = true;
    setState('loading');
    apiFetch(`/api/accounts/${id}`)
      .then(r => r.json())
      .then(d => { if (live) { setDetail(d); setState('ready'); } })
      .catch(() => { if (live) setState('error'); });
    return () => { live = false; };
  }, [id]);

  return (
    <>
      <div className="panel-overlay" onClick={onClose} />
      <div className="panel" style={{ width: isMobile ? '100%' : 440 }}>
        {state !== 'ready' ? (
          <div className="panel-body"><p className="muted-note">{state === 'error' ? 'This account is not available right now.' : 'Loading.'}</p></div>
        ) : (
          <>
            <div className="panel-head">
              <div className="panel-id">
                <div className="panel-name">{detail.name}</div>
                <div className="panel-pills">
                  <span className="pill">{typeLabel(detail.type)}</span>
                  {detail.region && <span className="pill">{detail.region}</span>}
                  <span className={`panel-ch${detail.chNumber ? '' : ' missing'}`}>{detail.chNumber || 'Unmatched'}</span>
                </div>
              </div>
              <button className="panel-close" aria-label="Close detail panel" onClick={onClose}><CloseIcon /></button>
            </div>
            <div className="panel-body">
              <div className="panel-block">
                <div className="panel-block-head">
                  <div className="eyebrow">ICP breakdown</div>
                  <div className="panel-score">{detail.score ?? '—'} / 100</div>
                </div>
                {detail.icp.map((r, i) => (
                  <div className="icp-row" key={i} title={r.reason || undefined}>
                    <span className="icp-label">{r.label}</span>
                    <span className="meter"><span style={{ width: `${r.points == null ? 0 : Math.round((r.points / r.max) * 100)}%` }} /></span>
                    <span className="icp-val">{r.points == null ? '—' : `${r.points} / ${r.max}`}</span>
                  </div>
                ))}
                <div className="panel-foot-note">Every score is explainable. These rows are the audit trail.</div>
              </div>
              <div className="panel-block">
                <div className="eyebrow">Recent signals</div>
                {detail.recentSignals.length === 0 && <div className="muted-small">No signals for this account yet.</div>}
                {detail.recentSignals.map((s, i) => (
                  <div className="panel-signal" key={i}>
                    <div className="panel-signal-title">{s.title}</div>
                    <div className="panel-signal-time">{fmtClockDay(s.observedAt)}</div>
                  </div>
                ))}
              </div>
              <div className="panel-block">
                <div className="eyebrow">Directors</div>
                {detail.directors.length === 0 && <div className="muted-small">No register contacts pulled yet.</div>}
                {detail.directors.map((d, i) => (
                  <div className="director-row" key={i}>
                    <span className="director-name">{d.name}</span>
                    {d.appointed && <span className="director-since">Appointed {fmtMonthYear(d.appointed)}</span>}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

export default function Accounts({ isMobile, focusCompanyId, onFocusConsumed }) {
  const [companies, setCompanies] = useState(null);
  const [state, setState] = useState('loading');
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    let live = true;
    apiFetch('/api/accounts')
      .then(r => r.json())
      .then(d => { if (live) { setCompanies(d.companies || []); setState('ready'); } })
      .catch(() => { if (live) setState('error'); });
    return () => { live = false; };
  }, []);

  // A jump from Signals lands here with the company already chosen.
  useEffect(() => {
    if (focusCompanyId != null) { setSelected(focusCompanyId); onFocusConsumed(); }
  }, [focusCompanyId, onFocusConsumed]);

  if (state === 'loading') return <div className="content-pad"><p className="muted-note">Loading accounts.</p></div>;
  if (state === 'error') return <div className="content-pad"><p className="muted-note">Accounts are not available right now.</p></div>;

  return (
    <div className="content-pad">
      {!isMobile ? (
        <div className="card accounts-table">
          <div className="acc-grid acc-head">
            <div className="eyebrow">Company</div>
            <div className="eyebrow">Type</div>
            <div className="eyebrow">Region</div>
            <div className="eyebrow">Domain</div>
            <div className="eyebrow">CH number</div>
            <div className="eyebrow">ICP score</div>
            <div className="eyebrow right">Signals</div>
          </div>
          {companies.map(c => (
            <button className="acc-grid acc-row" key={c.id} onClick={() => setSelected(c.id)}>
              <div className="acc-name">{c.name}</div>
              <div className="acc-dim">{typeLabel(c.type)}</div>
              <div className="acc-dim">{c.region || '—'}</div>
              <div className={`acc-flagged${c.domain ? '' : ' missing'}`}>
                <span className="flag-dot" style={{ opacity: c.domain ? 0 : 1 }} />
                <span className="acc-ellipsis">{c.domain || 'No domain'}</span>
              </div>
              <div className={`acc-flagged mono${c.chNumber ? ' navy' : ' missing'}`}>
                <span className="flag-dot" style={{ opacity: c.chNumber ? 0 : 1 }} />
                <span>{c.chNumber || 'Unmatched'}</span>
              </div>
              <div className="acc-score">
                <ScoreBar score={c.score} />
                <span className="acc-score-num">{c.score ?? '—'}</span>
              </div>
              <div className="acc-signals">{c.signals}</div>
            </button>
          ))}
        </div>
      ) : (
        <div className="acc-cards">
          {companies.map(c => (
            <button className="acc-card" key={c.id} onClick={() => setSelected(c.id)}>
              <div className="acc-card-top">
                <div className="acc-card-name">{c.name}</div>
                <span className="acc-card-score">{c.score ?? '—'}</span>
              </div>
              <ScoreBar score={c.score} wide />
              <div className="acc-card-meta">
                <span className="pill">{typeLabel(c.type)}</span>
                {c.region && <span className="pill">{c.region}</span>}
                <span className="acc-card-signals">{c.signals} signals</span>
                {(!c.domain || !c.chNumber) && (
                  <span className="acc-card-flag"><span className="flag-dot" />{!c.domain ? 'No domain' : 'CH unmatched'}</span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
      {selected != null && <DetailPanel id={selected} isMobile={isMobile} onClose={() => setSelected(null)} />}
    </div>
  );
}
