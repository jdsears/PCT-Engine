// Acknowledged sync failures.
//
// A reworked Health page surfaced sixteen sync errors in amber. They were all
// known and explained, so the page read as a wall of orange over a working
// system. Hiding them is the wrong fix: a genuinely new failure would vanish
// with them. So a known failure is acknowledged, with a reason, and shown
// calmly, while anything unacknowledged still breaks out in amber above the
// routine stats. A new failure tomorrow is therefore still visible, which is
// the whole point of the page.
//
// The registry is a file, not a table, chosen for the same reasons the campaign
// registry is: acknowledgements are a curated list changed by a reviewed edit,
// git records who acknowledged what and when, the classification is provable
// offline where the gate runs with no database, and no migration or runtime
// write path is needed. An acknowledgement is a PR, which is the audit trail.
//
// An entry acknowledges either an exact document path, for a one-off like a
// file in an unsupported format already ingested another way, or an error
// signature, for a whole known class such as image-only scans that report no
// extractable text. The signature form exists because the class shares one
// truthful reason and its members are not enumerated by guessing paths.
//
// Acknowledgements apply only to the current error set, so they cannot hide a
// document that is not failing. When an acknowledged document later syncs
// clean it leaves the error list, and its acknowledgement stops applying by
// itself, spent without any bookkeeping.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadAcknowledgements() {
  try {
    const raw = JSON.parse(readFileSync(join(HERE, 'acknowledgements.json'), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

// A sync error is stored as "path: message". Split on the first ": " so a
// message that itself contains a colon stays whole.
export function parseSyncError(line) {
  const s = String(line || '');
  const i = s.indexOf(': ');
  if (i === -1) return { path: s.trim(), message: '' };
  return { path: s.slice(0, i).trim(), message: s.slice(i + 2).trim() };
}

// Does an acknowledgement cover this parsed error? A path entry matches when
// the error's path is, or ends with, the acknowledged path, so a leading root
// difference does not defeat it. A signature entry matches when its string
// appears in the message, case-insensitively.
function covers(ack, { path, message }) {
  if (ack.path) {
    const a = String(ack.path).toLowerCase(), p = String(path).toLowerCase();
    return p === a || p.endsWith('/' + a) || p.endsWith(a);
  }
  if (ack.errorMatch) return message.toLowerCase().includes(String(ack.errorMatch).toLowerCase());
  return false;
}

// Split the current sync errors into acknowledged and unacknowledged. The
// acknowledged carry their reason and short summary; the unacknowledged are
// the ones that still deserve amber. A summary aggregate groups the
// acknowledged by their summary label for the one calm line the page shows.
export function classifySyncErrors(errorList, acks = loadAcknowledgements()) {
  const acknowledged = [], unacknowledged = [];
  for (const line of errorList || []) {
    const parsed = parseSyncError(line);
    const ack = acks.find(a => covers(a, parsed));
    if (ack) acknowledged.push({ ...parsed, reason: ack.reason, summary: ack.summary, acknowledgedAt: ack.acknowledgedAt || null });
    else unacknowledged.push(parsed);
  }
  // Group the acknowledged by their summary label, preserving first-seen order,
  // so the calm line reads "14 image-only scans handled another way, 1
  // ingested separately".
  const groups = [];
  for (const a of acknowledged) {
    const label = a.summary || 'known exception';
    const g = groups.find(x => x.summary === label);
    if (g) g.count++;
    else groups.push({ summary: label, count: 1 });
  }
  return {
    acknowledged, unacknowledged,
    counts: { acknowledged: acknowledged.length, unacknowledged: unacknowledged.length },
    summary: groups,
  };
}
