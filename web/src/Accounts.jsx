import { useState, useEffect } from 'react';
import { TYPE_LABELS, fmtClockDay, fmtMonthYear, companyLabel } from './labels.js';
import { CloseIcon } from './icons.jsx';
import { apiFetch } from './api.js';
import { withCampaign, CampaignChip, useCampaignList, isAll } from './CampaignSwitcher.jsx';
import ReviewQueue from './ReviewQueue.jsx';

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
                <div className="panel-name">{companyLabel(detail.name)}</div>
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
                <div className="eyebrow">Decision makers</div>
                {(detail.people || []).length === 0 && (
                  <div className="muted-small">None found for this account yet. The LinkedIn lane fills these in small, capped batches, and a register director only counts when the stated role is a specifier one.</div>
                )}
                {(detail.people || []).map((p, i) => (
                  <div className="person-row" key={i}>
                    <span className="person-name">{p.name}</span>
                    <span className="person-meta">
                      {p.role && <span>{p.role}</span>}
                      {p.email
                        ? <a className="person-link" href={`mailto:${p.email}`}>{p.email}</a>
                        : <span>no email on file</span>}
                      {p.linkedin && <a className="person-link" href={p.linkedin} target="_blank" rel="noreferrer">LinkedIn</a>}
                    </span>
                  </div>
                ))}
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

export default function Accounts({ isMobile, focusCompanyId, onFocusConsumed, campaign }) {
  const [companies, setCompanies] = useState(null);
  const [state, setState] = useState('loading');
  const [selected, setSelected] = useState(null);
  const campaignList = useCampaignList();

  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let live = true;
    apiFetch(withCampaign('/api/accounts', campaign))
      .then(r => r.json())
      .then(d => { if (live) { setCompanies(d.companies || []); setState('ready'); } })
      .catch(() => { if (live) setState('error'); });
    return () => { live = false; };
  }, [campaign, reloads]);

  // A jump from Signals lands here with the company already chosen.
  useEffect(() => {
    if (focusCompanyId != null) { setSelected(focusCompanyId); onFocusConsumed(); }
  }, [focusCompanyId, onFocusConsumed]);

  if (state === 'loading') return <div className="content-pad"><p className="muted-note">Loading accounts.</p></div>;
  if (state === 'error') return <div className="content-pad"><p className="muted-note">Accounts are not available right now.</p></div>;

  // A company can belong to more than one campaign and still be one account, so
  // the mixed view marks every membership rather than picking one.
  const showChips = isAll(campaign) && campaignList.length > 1;
  const chips = c => (showChips ? (c.campaigns || []) : []).map(id => (
    <CampaignChip key={id} campaign={id} list={campaignList} />
  ));

  const queue = (
    <ReviewQueue campaign={campaign} accounts={companies}
      onChanged={() => setReloads(n => n + 1)} />
  );

  if (companies.length === 0) {
    return (
      <div className="content-pad">
        {queue}
        <p className="muted-note">
          No named accounts on this campaign's register yet. Accounts appear once the campaign has been seeded, a sweep has matched a company to it, or a proposal above is confirmed.
        </p>
      </div>
    );
  }

  return (
    <div className="content-pad">
      {queue}
      {!isMobile ? (
        <div className="card accounts-table">
          <div className="acc-grid acc-head">
            <div className="eyebrow">Company</div>
            <div className="eyebrow">Type</div>
            <div className="eyebrow">Region</div>
            <div className="eyebrow">Domain</div>
            <div className="eyebrow">CH number</div>
            <div className="eyebrow">ICP score</div>
            <div className="eyebrow right">People</div>
            <div className="eyebrow right">Signals</div>
          </div>
          {companies.map(c => (
            <button className="acc-grid acc-row" key={c.id} onClick={() => setSelected(c.id)}>
              <div className="acc-name">{companyLabel(c.name)}{chips(c)}</div>
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
              <div className="acc-signals">{c.people ?? 0}</div>
              <div className="acc-signals">{c.signals}</div>
            </button>
          ))}
        </div>
      ) : (
        <div className="acc-cards">
          {companies.map(c => (
            <button className="acc-card" key={c.id} onClick={() => setSelected(c.id)}>
              <div className="acc-card-top">
                <div className="acc-card-name">{companyLabel(c.name)}</div>
                <span className="acc-card-score">{c.score ?? '—'}</span>
              </div>
              <ScoreBar score={c.score} wide />
              <div className="acc-card-meta">
                <span className="pill">{typeLabel(c.type)}</span>
                {c.region && <span className="pill">{c.region}</span>}
                {chips(c)}
                <span className="acc-card-signals">{c.people ?? 0} people · {c.signals} signals</span>
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
