import { readdir, readFile } from 'node:fs/promises';
import { join, extname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { mapFolder as richardsMapFolder, EXCLUDED_FOLDERS as RICHARDS_EXCLUDED } from '../folderMap.mjs';

const TEXT_EXT = new Set(['.pdf', '.docx', '.pptx', '.ppt', '.doc']);

// A mapping pairs a folder classifier with the set of folders to skip. It
// defaults to the Richards map, so an unparameterised call behaves as before.
const RICHARDS_MAPPING = { mapFolder: richardsMapFolder, excludedFolders: RICHARDS_EXCLUDED };

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

export async function* localFolderSource(root, mapping = RICHARDS_MAPPING) {
  const { mapFolder, excludedFolders, excludeFile } = mapping;
  const seenHashes = new Set();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const topName = entry.isDirectory() ? entry.name : '(root)';
    if (excludedFolders.has(topName)) continue;
    const folderMeta = mapFolder(topName);
    if (!folderMeta.include) continue;

    const files = entry.isDirectory() ? await walk(join(root, entry.name)) : [join(root, entry.name)];
    for (const path of files) {
      const ext = extname(path).toLowerCase();
      if (!TEXT_EXT.has(ext)) continue;
      const sourceId = relative(root, path);
      const title = sourceId.split(/[/\\]/).pop();
      if (excludeFile && excludeFile(title)) continue;
      const bytes = await readFile(path);
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (seenHashes.has(hash)) continue; // a byte-identical copy was already yielded this run
      seenHashes.add(hash);
      yield { sourceId, path, ext, hash, title, meta: { ...folderMeta, topFolder: topName } };
    }
  }
}
