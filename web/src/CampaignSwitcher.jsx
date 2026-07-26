import { useState, useEffect } from 'react';
import { apiFetch } from './api.js';

// Campaign as a dimension, not another nav section. A section per campaign dies
// at campaign three; a switcher in the header scopes the sections that are
// campaign-shaped and is ignored by the ones that are not.
//
// The choice persists for the session, so moving between Pipeline and Signals
// keeps the campaign in view, and a refresh does not silently widen the scope
// back to everything.

export const ALL = 'all';
const KEY = 'pct.campaign';

export function useCampaign() {
  const [campaign, setCampaign] = useState(() => {
    try { return sessionStorage.getItem(KEY) || ALL; } catch { return ALL; }
  });
  useEffect(() => {
    try { sessionStorage.setItem(KEY, campaign); } catch { /* private mode, session only */ }
  }, [campaign]);
  return [campaign, setCampaign];
}

// The campaign list comes from the registry through the API, so adding a
// campaign never means editing the UI.
export function useCampaignList() {
  const [list, setList] = useState([]);
  useEffect(() => {
    apiFetch('/api/campaigns')
      .then(r => (r.ok ? r.json() : null))
      .then(d => setList(d?.campaigns || []))
      .catch(() => setList([]));
  }, []);
  return list;
}

// One place decides how the campaign reaches the API, so no section can quietly
// omit the parameter and show every campaign's rows under a scoped label.
export function withCampaign(path, campaign) {
  if (!campaign || campaign === ALL) return path;
  return `${path}${path.includes('?') ? '&' : '?'}campaign=${encodeURIComponent(campaign)}`;
}

export const isAll = campaign => !campaign || campaign === ALL;

export default function CampaignSwitcher({ campaign, onChange, isMobile }) {
  const list = useCampaignList();
  // With one campaign there is nothing to switch between, so the control stays
  // out of the way until a second exists.
  if (list.length < 2) return null;
  const options = [{ id: ALL, displayName: 'All campaigns' }, ...list];
  return (
    <div className={`campaign-switch${isMobile ? ' is-mobile' : ''}`} role="group" aria-label="Campaign">
      {options.map(o => (
        <button key={o.id} type="button"
          className={`campaign-chip${campaign === o.id ? ' active' : ''}`}
          aria-pressed={campaign === o.id}
          onClick={() => onChange(o.id)}>
          {o.displayName}
        </button>
      ))}
    </div>
  );
}

// The small muted marker a row or card carries when the view is showing every
// campaign at once, so a mixed list is never ambiguous about what it is showing.
export function CampaignChip({ campaign, list }) {
  if (!campaign) return null;
  const name = (list || []).find(c => c.id === campaign)?.displayName || campaign;
  return <span className="eyebrow campaign-tag">{name}</span>;
}
