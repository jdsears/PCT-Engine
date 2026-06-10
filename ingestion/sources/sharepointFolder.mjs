import { graphJson, graph } from '../../src/msgraph.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { mapFolder as richardsMapFolder, EXCLUDED_FOLDERS as RICHARDS_EXCLUDED } from '../folderMap.mjs';

const TEXT_EXT = new Set(['.pdf', '.docx', '.pptx', '.ppt', '.doc']);

// Same default as the local source, so an unparameterised call reads Richards.
const RICHARDS_MAPPING = { mapFolder: richardsMapFolder, excludedFolders: RICHARDS_EXCLUDED };

// Encode a library path for Graph path addressing, keeping the slashes.
const escapePath = (p) => p.split('/').map(encodeURIComponent).join('/');

async function resolveDrive() {
  const site = await graphJson(`/sites/${process.env.SP_HOSTNAME}:${process.env.SP_SITE_PATH}`);
  const drive = await graphJson(`/sites/${site.id}/drive`);
  return { siteId: site.id, driveId: drive.id };
}

async function* pageItems(url) {
  while (url) {
    const page = await graphJson(url);
    for (const it of page.value) yield it;
    url = page['@odata.nextLink'] ? page['@odata.nextLink'].replace('https://graph.microsoft.com/v1.0', '') : null;
  }
}

async function* walkItems(driveId, itemId, prefix) {
  for await (const it of pageItems(`/drives/${driveId}/items/${itemId}/children?$top=200`)) {
    const rel = prefix ? `${prefix}/${it.name}` : it.name;
    if (it.folder) yield* walkItems(driveId, it.id, rel);
    else yield { item: it, rel };
  }
}

// Walks the document library and yields the same shape as localFolderSource,
// so everything downstream is untouched. rootFolder names a folder within the
// library to treat as the corpus root, for example "Richards", so source ids
// stay relative to it and match the local snapshot's ids exactly.
export async function* sharepointSource(mapping = RICHARDS_MAPPING, { rootFolder = null } = {}) {
  const { mapFolder, excludedFolders, excludeFile } = mapping;
  const { driveId } = await resolveDrive();
  const rootUrl = rootFolder
    ? `/drives/${driveId}/root:/${escapePath(rootFolder)}:/children?$top=200`
    : `/drives/${driveId}/root/children?$top=200`;
  const tmp = join(tmpdir(), 'pct-sp-cache');
  await mkdir(tmp, { recursive: true });
  const seenHashes = new Set();
  const downloadFailures = [];

  for await (const top of pageItems(rootUrl)) {
    const topName = top.folder ? top.name : '(root)';
    if (excludedFolders.has(topName)) continue;
    const folderMeta = mapFolder(topName);
    if (!folderMeta.include) { console.log(`Skipping unmapped top-level item: ${topName}`); continue; }

    const entries = top.folder
      ? walkItems(driveId, top.id, top.name)
      : (async function* () { yield { item: top, rel: top.name }; })();

    for await (const { item, rel } of entries) {
      const ext = extname(item.name).toLowerCase();
      if (!TEXT_EXT.has(ext)) continue;
      if (excludeFile && excludeFile(item.name)) continue;
      const res = await graph(`/drives/${driveId}/items/${item.id}/content`);
      if (!res.ok) { console.log(`Download failed for ${rel}: ${res.status}`); downloadFailures.push(rel); continue; }
      const bytes = Buffer.from(await res.arrayBuffer());
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (seenHashes.has(hash)) continue;
      seenHashes.add(hash);
      const local = join(tmp, hash + ext);
      await writeFile(local, bytes);
      yield { sourceId: rel, path: local, ext, hash, title: item.name, meta: { ...folderMeta, topFolder: topName } };
    }
  }

  // Failed downloads mean the walk did not fully cover the site. Throw after
  // yielding everything else, so the runner processes what it can but skips
  // the stale-document sweep rather than deleting chunks it failed to read.
  if (downloadFailures.length) {
    throw new Error(`${downloadFailures.length} download(s) failed: ${downloadFailures.slice(0, 5).join(', ')}${downloadFailures.length > 5 ? ' ...' : ''}`);
  }
}
