// The one decision the engine scheduler makes, kept pure so it is testable:
// run when the engine is switched on, no run is already in flight, and the
// interval has elapsed since the last run (or there has never been one).
export function shouldRun({ enabled, running, lastRunAt, intervalMs, now = Date.now() }) {
  if (!enabled || running) return false;
  if (!lastRunAt) return true;
  const last = new Date(lastRunAt).getTime();
  if (Number.isNaN(last)) return true;
  return now - last >= intervalMs;
}
