import { readdir, readFile } from 'node:fs/promises';
import { join, extname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { mapFolder, EXCLUDED_FOLDERS } from '../folderMap.mjs';

const TEXT_EXT = new Set(['.pdf', '.docx', '.pptx', '.ppt', '.doc']);

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

export async function* localFolderSource(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const topName = entry.isDirectory() ? entry.name : '(root)';
    if (EXCLUDED_FOLDERS.has(topName)) continue;
    const mapping = mapFolder(topName);
    if (!mapping.include) continue;

    const files = entry.isDirectory() ? await walk(join(root, entry.name)) : [join(root, entry.name)];
    for (const path of files) {
      const ext = extname(path).toLowerCase();
      if (!TEXT_EXT.has(ext)) continue;
      const bytes = await readFile(path);
      const hash = createHash('sha256').update(bytes).digest('hex');
      const sourceId = relative(root, path);
      yield { sourceId, path, ext, hash, title: sourceId.split(/[/\\]/).pop(), meta: { ...mapping, topFolder: topName } };
    }
  }
}
