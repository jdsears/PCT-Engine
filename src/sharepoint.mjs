// Read-only SharePoint access over the existing app-only Graph client, so
// ingests can pull the current file straight from the Sales Engine site
// instead of a copy someone downloaded earlier. Read is the whole surface:
// nothing here writes, moves or shares anything, and file contents are
// fetched transiently for parsing, never stored in the repo. Access depends
// on the app being granted Sites.Selected with read on the site (or a
// broader Files permission an admin already consented to); the probe script
// reports plainly which state it finds.

import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { graph, graphJson } from './msgraph.mjs';

// The site in Graph's host:/path form. Overridable for a rename, but the
// Sales Engine team site is the default and the one James's folders live on.
export const spSite = () => process.env.SHAREPOINT_SITE || 'pctflow.sharepoint.com:/sites/SalesEngine';

// A drive path, URL-encoded per segment with the slashes kept, so folder
// names with spaces, dots and ampersands address correctly.
export function encodeDrivePath(p) {
  return String(p || '').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

// Values for the ingest scripts' source flags: "sharepoint:<path within the
// site's Documents library>" fetches from the site; anything else is a local
// file path, unchanged.
export const isSharepointRef = v => /^sharepoint:/i.test(String(v || '').trim());
export const sharepointPath = v => String(v || '').trim().replace(/^sharepoint:/i, '').trim();

let siteCache = null;
export async function resolveSite() {
  if (!siteCache) siteCache = await graphJson(`/sites/${spSite()}`);
  return siteCache;
}

// The document library's own web address, for linking people to the place
// where adding or updating a file is how the co-pilot learns.
let driveCache = null;
export async function resolveDrive() {
  if (!driveCache) {
    const site = await resolveSite();
    driveCache = await graphJson(`/sites/${site.id}/drive?$select=id,webUrl`);
  }
  return driveCache;
}

// A browser link to a document on the site, from the library url and the
// synced path. Pure over its inputs so the encoding is provable.
export function docWebUrl(driveWebUrl, path) {
  const base = String(driveWebUrl || '').replace(/\/+$/, '');
  return base && path ? `${base}/${encodeDrivePath(path)}` : null;
}

// List a folder in the site's default document library; '' lists the root.
export async function listFolder(path = '') {
  const site = await resolveSite();
  const p = path ? `root:/${encodeDrivePath(path)}:/children` : 'root/children';
  const json = await graphJson(`/sites/${site.id}/drive/${p}?$top=200&$select=name,size,folder,file,lastModifiedDateTime,eTag`);
  return (json?.value || []).map(i => ({
    name: i.name, folder: !!i.folder, size: i.size ?? null,
    children: i.folder?.childCount ?? null, modified: i.lastModifiedDateTime || null,
    etag: i.eTag || null,
  }));
}

// Download one file's bytes.
export async function downloadFile(path) {
  const site = await resolveSite();
  const res = await graph(`/sites/${site.id}/drive/root:/${encodeDrivePath(path)}:/content`);
  if (!res.ok) { const e = new Error(`Graph ${res.status} downloading ${path}: ${(await res.text()).slice(0, 300)}`); e.status = res.status; throw e; }
  return Buffer.from(await res.arrayBuffer());
}

// Resolve an ingest source to a local file path: a sharepoint: reference is
// downloaded to a temporary file (transient, outside the repo) and a plain
// path passes through untouched.
// The price workbook is one file, and every ingest must read the same one.
// The live copy lives on SharePoint, so PRICE_WORKBOOK holds its sharepoint:
// reference and an explicit --workbook overrides it only when someone means
// to. Pure so the gate can prove the precedence and the warning without a
// network or a workbook: it decides which source wins and whether that source
// is a local file, which is worth saying out loud because a download goes
// stale the moment the sheet is edited.
export function chooseWorkbookSource(flagValue, envValue) {
  const flag = String(flagValue || '').trim();
  const env = String(envValue || '').trim();
  if (flag) return { value: flag, from: 'flag', local: !isSharepointRef(flag) };
  if (env) return { value: env, from: 'env', local: !isSharepointRef(env) };
  return { value: null, from: null, local: false };
}

// Resolve the workbook to a readable path, fetching from SharePoint when the
// reference says so. A local source is allowed, never silent.
export async function resolveWorkbook(flagValue, { log = () => {} } = {}) {
  const chosen = chooseWorkbookSource(flagValue, process.env.PRICE_WORKBOOK);
  if (!chosen.value) return null;
  if (chosen.local) {
    log(`WARNING: reading the price workbook from a local file, which may be a stale download: ${chosen.value}`);
    log('         The live copy is on SharePoint; set PRICE_WORKBOOK to its sharepoint: path, or pass --workbook "sharepoint:<path>".');
  }
  return materialiseSource(chosen.value, { log });
}

export async function materialiseSource(value, { log = () => {} } = {}) {
  if (!isSharepointRef(value)) return value;
  const path = sharepointPath(value);
  const buf = await downloadFile(path);
  const dir = mkdtempSync(join(tmpdir(), 'pct-sp-'));
  const local = join(dir, basename(path) || 'download');
  writeFileSync(local, buf);
  log(`Fetched ${path} from ${spSite()} (${buf.length.toLocaleString('en-GB')} bytes).`);
  return local;
}
