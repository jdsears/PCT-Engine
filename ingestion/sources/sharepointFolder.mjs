import { graphJson, graph } from '../../src/msgraph.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { mapFolder, EXCLUDED_FOLDERS } from '../folderMap.mjs';

const TEXT_EXT = new Set(['.pdf', '.docx', '.pptx', '.ppt', '.doc']);

async function resolveDrive() {
  const site = await graphJson(`/sites/${process.env.SP_HOSTNAME}:${process.env.SP_SITE_PATH}`);
  const drive = await graphJson(`/sites/${site.id}/drive`);
  return { siteId: site.id, driveId: drive.id };
}

async function* walkItems(driveId, itemId, prefix) {
  let url = `/drives/${driveId}/items/${itemId}/children?$top=200`;
  while (url) {
    const page = await graphJson(url);
    for (const it of page.value) {
      const rel = prefix ? `${prefix}/${it.name}` : it.name;
      if (it.folder) yield* walkItems(driveId, it.id, rel);
      else yield { item: it, rel };
    }
    url = page['@odata.nextLink'] ? page['@odata.nextLink'].replace('https://graph.microsoft.com/v1.0', '') : null;
  }
}

export async function* sharepointSource() {
  const { driveId } = await resolveDrive();
  const root = await graphJson(`/drives/${driveId}/root/children?$top=200`);
  const tmp = join(tmpdir(), 'pct-sp-cache');
  await mkdir(tmp, { recursive: true });
  const seenHashes = new Set();

  for (const top of root.value) {
    const topName = top.folder ? top.name : '(root)';
    if (EXCLUDED_FOLDERS.has(topName)) continue;
    const mapping = mapFolder(topName);
    if (!mapping.include) { console.log(`Skipping unmapped top-level item: ${topName}`); continue; }

    const entries = top.folder
      ? walkItems(driveId, top.id, top.name)
      : (async function* () { yield { item: top, rel: top.name }; })();

    for await (const { item, rel } of entries) {
      const ext = extname(item.name).toLowerCase();
      if (!TEXT_EXT.has(ext)) continue;
      const res = await graph(`/drives/${driveId}/items/${item.id}/content`);
      if (!res.ok) { console.log(`Download failed for ${rel}: ${res.status}`); continue; }
      const bytes = Buffer.from(await res.arrayBuffer());
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (seenHashes.has(hash)) continue;
      seenHashes.add(hash);
      const local = join(tmp, hash + ext);
      await writeFile(local, bytes);
      yield { sourceId: rel, path: local, ext, hash, title: item.name, meta: { ...mapping, topFolder: topName } };
    }
  }
}
