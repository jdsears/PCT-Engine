import { useState, useEffect } from 'react';
import { SIGNAL_TYPE_LABELS, fmtClockDay, companyLabel } from './labels.js';
import { apiFetch } from './api.js';
import { CampaignChip, useCampaignList, isAll } from './CampaignSwitcher.jsx';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'filing', label: 'Filings' },
  { id: 'director', label: 'Director changes' },
  { id: 'build', label: 'Build news' },
  { id: 'contract', label: 'Contracts' },
];

export default function Signals({ onOpenCompany , campaign }) {
  const [filter, setFilter] = useState('all');
  const [signals, setSignals] = useState(null);
  const [state, setState] = useState('loading');
  const campaignList = useCampaignList();
  const showChips = isAll(campaign) && campaignList.length > 1;

  useEffect(() => {
    let live = true;
    const params = new URLSearchParams();
    if (filter !== 'all') params.set('type', filter);
    if (campaign && campaign !== 'all') params.set('campaign', campaign);
    const q = params.toString() ? `?${params}` : '';
    apiFetch(`/api/signals${q}`)
      .then(r => r.json())
      .then(d => { if (live) { setSignals(d.signals || []); setState('ready'); } })
      .catch(() => { if (live) setState('error'); });
    return () => { live = false; };
  }, [filter, campaign]);

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
                  <button className="signal-company" onClick={() => onOpenCompany(s.companyId)}>{companyLabel(s.company)}</button>
                ) : (
                  <span className="signal-nocompany"><span className="flag-dot" />No matched company</span>
                )}
                {s.source && <span className="signal-source">{s.source}</span>}
                {showChips && <CampaignChip campaign={s.campaign} list={campaignList} />}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
