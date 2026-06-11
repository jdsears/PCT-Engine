// One place for data fetches so an expired or missing session sends the UI back
// to the gate. Components use apiFetch; a 401 fires the registered handler (the
// app opens the gate) and rejects so callers fall into their error path.
let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export async function apiFetch(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401) {
    onUnauthorized();
    throw new Error('unauthorized');
  }
  return res;
}
