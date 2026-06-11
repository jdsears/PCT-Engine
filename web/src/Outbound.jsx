import { useState, useEffect } from 'react';
import { apiFetch } from './api.js';

const STOPS = [
  { id: 'sourced', label: 'Sourced', left: '6%' },
  { id: 'researched', label: 'Researched', left: '22%' },
  { id: 'outbound', label: 'Outbound', left: '38%' },
  { id: 'replied', label: 'Replied', left: '54%' },
  { id: 'qualified', label: 'Qualified', left: '78%' },
  { id: 'handed_off', label: 'Handed off', left: '93%' },
];

export default function Outbound({ isMobile }) {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    let live = true;
    apiFetch('/api/outbound/status').then(r => r.json())
      .then(d => { if (live) setStatus(d); })
      .catch(() => { if (live) setStatus({ killSwitch: 'unknown' }); });
    return () => { live = false; };
  }, []);

  const on = status?.killSwitch !== 'off';
  return (
    <div className="content-pad outbound">
      <div className="outbound-col">
        <div className="card outbound-card">
          <div className="mini-track" aria-hidden="true">
            <div className="mini-line" />
            {STOPS.map(s => {
              const isOut = s.id === 'outbound';
              return (
                <div className="mini-stop" style={{ left: s.left }} key={s.id}>
                  <span className={`mini-dot${isOut ? ' here' : ''}`} />
                  {(isOut || !isMobile) && <span className={`mini-label${isOut ? ' here' : ''}`}>{s.label}</span>}
                </div>
              );
            })}
          </div>
          <div className="outbound-copy">
            <div className="outbound-title">Outbound is the next stage of the build</div>
            <p className="outbound-para">Drafts will queue here for approval before anything sends. Each draft will show its lead, its evidence and a send or hold decision. Nothing sends without a human.</p>
          </div>
        </div>
        <div className="card kill-card">
          <div className="kill-left">
            <div className="eyebrow">Kill switch</div>
            <div className="kill-status">
              <span className="kill-dot" style={on ? undefined : { background: 'var(--teal)' }} />
              {status == null ? 'Checking' : on ? 'Sending disabled' : 'Sending enabled'}
            </div>
          </div>
          <div className="kill-note">Read from the API. Outbound will not send while this is on.</div>
        </div>
      </div>
    </div>
  );
}
