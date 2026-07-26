import { useState, useEffect } from 'react';
import Chat from './Chat.jsx';
import Insights from './Insights.jsx';
import Pipeline from './Pipeline.jsx';
import Accounts from './Accounts.jsx';
import Signals from './Signals.jsx';
import Outbound from './Outbound.jsx';
import Health from './Health.jsx';
import Watchlist from './Watchlist.jsx';
import Studio from './Studio.jsx';
import Gate from './Gate.jsx';
import { ICONS, LockIcon, ChevronLeft, ChevronRight } from './icons.jsx';
import { setUnauthorizedHandler } from './api.js';
import CampaignSwitcher, { useCampaign, ALL } from './CampaignSwitcher.jsx';

const META = {
  copilot: { title: 'Co-Pilot', sub: 'Ask the knowledge base. Answers cite their sources.', short: 'Co-Pilot' },
  insights: { title: 'Insights', sub: 'What gets asked, what gets answered, where the gaps are', short: 'Insights' },
  pipeline: { title: 'Pipeline', sub: 'Leads moving toward the qualification gate', short: 'Pipeline' },
  accounts: { title: 'Accounts', sub: 'Named accounts with scores and signals', short: 'Accounts' },
  signals: { title: 'Signals', sub: 'What the engine has observed, newest first', short: 'Signals' },
  watchlist: { title: 'Watchlist', sub: 'Data centre operators expanding, worth approaching before a UK project', short: 'Watch' },
  studio: { title: 'Studio', sub: 'LinkedIn posts and connections, prepared for you to send', short: 'Studio' },
  outbound: { title: 'Outbound', sub: 'Drafts will queue here for approval', short: 'Outbound' },
  health: { title: 'Health', sub: 'System state at a glance', short: 'Health' },
};
const ORDER = ['copilot', 'insights', 'pipeline', 'accounts', 'signals', 'watchlist', 'studio', 'outbound', 'health'];
// Campaign-shaped sections take the switcher; the co-pilot, studio and health
// are campaign-neutral and ignore it, so the control is hidden rather than
// shown doing nothing.
const CAMPAIGN_SCOPED = new Set(['insights', 'pipeline', 'accounts', 'signals', 'watchlist', 'outbound']);

function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.innerWidth < 720);
  useEffect(() => {
    const onResize = () => setMobile(window.innerWidth < 720);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return mobile;
}

// The active section lives in the URL hash, so a refresh stays on the tab
// being read and back and forward walk the tabs. An unknown or empty hash
// lands on the co-pilot as before.
const sectionFromHash = () => {
  const h = window.location.hash.replace(/^#/, '');
  return ORDER.includes(h) ? h : 'copilot';
};

export default function App() {
  const [section, setSection] = useState(sectionFromHash);
  const [expanded, setExpanded] = useState(true);
  const [gateOpen, setGateOpen] = useState(false);
  const [gateForced, setGateForced] = useState(false);
  const [focusCompanyId, setFocusCompanyId] = useState(null);
  const [campaign, setCampaign] = useCampaign();
  const isMobile = useIsMobile();

  useEffect(() => {
    const onHash = () => setSection(sectionFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    if (window.location.hash.replace(/^#/, '') !== section) window.location.hash = section;
  }, [section]);

  // Send the UI to the gate on any 401, and check up front so an unauthed
  // visitor meets the gate rather than an empty shell.
  useEffect(() => {
    setUnauthorizedHandler(() => { setGateForced(true); setGateOpen(true); });
    fetch('/api/access/status')
      .then(r => r.json())
      .then(s => { if (s.required && !s.authed) { setGateForced(true); setGateOpen(true); } })
      .catch(() => {});
  }, []);

  const go = id => { setSection(id); setGateOpen(false); };
  const openCompany = id => { setFocusCompanyId(id); setSection('accounts'); };

  const navButtons = (cls, active) => ORDER.map(id => (
    <button key={id} className={`${cls}${section === id ? ' active' : ''}`}
      aria-label={META[id].title} onClick={() => go(id)}>
      {ICONS[id]()}
      {active(id)}
    </button>
  ));

  return (
    <div className={`root${isMobile ? ' is-mobile' : ''}`}>
      {!isMobile && (
        <aside className={`sidebar${expanded ? '' : ' collapsed'}`}>
          <div className="side-logo">
            <img src="/assets/pct-logo-white.svg" alt="PCT" />
          </div>
          <div className="side-nav">
            {navButtons('side-item', id => expanded && <span>{META[id].title}</span>)}
          </div>
          <div className="side-spacer" />
          <button className="side-foot" aria-label="View access gate" onClick={() => { setGateForced(false); setGateOpen(true); }}>
            <LockIcon />
            {expanded && <span>Access gate</span>}
          </button>
          <button className="side-foot" aria-label="Toggle sidebar width" onClick={() => setExpanded(e => !e)}>
            {expanded ? <ChevronLeft /> : <ChevronRight />}
            {expanded && <span>Collapse</span>}
          </button>
        </aside>
      )}

      <div className="main">
        <header className="head">
          <div className="head-pad">
            {isMobile && <img className="head-logo" src="/assets/pct-logo-color.svg" alt="PCT" />}
            <h1>{META[section].title}</h1>
            {!isMobile && <div className="head-sub">{META[section].sub}</div>}
            {CAMPAIGN_SCOPED.has(section) && (
              <CampaignSwitcher campaign={campaign} onChange={setCampaign} isMobile={isMobile} />
            )}
          </div>
          <div className="wave" aria-hidden="true">
            <svg width="1600" height="22" viewBox="0 0 1600 22">
              <path d="M0,8 q30,-7 60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0" fill="none" stroke="#49C0B1" strokeWidth="2" strokeLinecap="round" />
              <path d="M0,13 q30,-7 60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0 t60,0" fill="none" stroke="#009ADE" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
        </header>

        <div className="content">
          {/* The chat stays mounted so the conversation survives moving between sections. */}
          <div className="copilot-wrap" style={section === 'copilot' ? undefined : { display: 'none' }}>
            <Chat isMobile={isMobile} />
          </div>
          {section === 'insights' && <Insights campaign={campaign} />}
          {section === 'pipeline' && <Pipeline isMobile={isMobile} campaign={campaign} />}
          {section === 'accounts' && (
            <Accounts isMobile={isMobile} campaign={campaign} focusCompanyId={focusCompanyId}
              onFocusConsumed={() => setFocusCompanyId(null)} />
          )}
          {section === 'signals' && <Signals onOpenCompany={openCompany} campaign={campaign} />}
          {section === 'watchlist' && <Watchlist campaign={campaign} />}
          {section === 'studio' && <Studio />}
          {section === 'outbound' && <Outbound isMobile={isMobile} campaign={campaign} />}
          {section === 'health' && <Health />}
        </div>

        {isMobile && (
          <nav className="tabbar">
            {navButtons('tab-item', id => <span>{META[id].short}</span>)}
          </nav>
        )}
      </div>

      {gateOpen && <Gate forced={gateForced} onClose={() => setGateOpen(false)} />}
    </div>
  );
}
