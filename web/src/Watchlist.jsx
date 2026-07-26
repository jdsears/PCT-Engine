import { useState, useEffect } from 'react';
import { apiFetch } from './api.js';
import { fmtClockDay } from './labels.js';
import { withCampaign, CampaignChip, useCampaignList, isAll } from './CampaignSwitcher.jsx';

// The BD watchlist: organisations the engine has spotted expanding, where a UK
// move is plausible but not yet a project. Intelligence to act on, kept distinct
// from the lead pipeline. A short, high-value list, not a feed.
//
// The standing sentence comes from the API, because it is the campaign's own
// description of who it watches. Hardcoding the data centre wording here would
// put "data centre operators" above a list of pharmaceutical manufacturers.
export default function Watchlist({ campaign }) {
  const [items, setItems] = useState(null);
  const [intro, setIntro] = useState('');
  const [state, setState] = useState('loading');
  const campaignList = useCampaignList();

  useEffect(() => {
    let live = true;
    apiFetch(withCampaign('/api/watchlist', campaign)).then(r => r.json())
      .then(d => { if (live) { setItems(d.watchlist || []); setIntro(d.intro || ''); setState('ready'); } })
      .catch(() => { if (live) setState('error'); });
    return () => { live = false; };
  }, [campaign]);

  if (state === 'loading') return <div className="content-pad"><p className="muted-note">Loading the watchlist.</p></div>;
  if (state === 'error') return <div className="content-pad"><p className="muted-note">The watchlist is not available right now.</p></div>;

  return (
    <div className="content-pad watchlist">
      {intro && <p className="wl-intro">{intro}</p>}
      {items.length === 0 ? (
        <p className="muted-note">No expansion signals captured yet. Organisations appear here as the news sweep finds them.</p>
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
                {isAll(campaign) && campaignList.length > 1 && <CampaignChip campaign={w.campaign} list={campaignList} />}
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
