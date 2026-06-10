// The access gate as designed: a preview of the shared-key sign-in. There is no
// server-side gate yet, so Enter simply closes it; the real check arrives with
// the access-gate phase and this screen is its front door.
export default function Gate({ onClose }) {
  return (
    <div className="gate">
      <div className="gate-col">
        <img src="/assets/pct-logo-color.svg" alt="PCT" className="gate-logo" />
        <div className="card gate-card">
          <label htmlFor="pct-access-key" className="eyebrow">Access key</label>
          <input id="pct-access-key" type="password" autoComplete="off" />
          <button onClick={onClose}>Enter</button>
        </div>
        <div className="gate-note">Shared access key for the pilot. Microsoft sign in comes in a later phase.</div>
      </div>
    </div>
  );
}
