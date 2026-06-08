const TARGET_CHARS = 1200, OVERLAP_CHARS = 150, MIN_CHUNK_CHARS = 40;

const KNOWN_SECTIONS = [
  'features', 'quick spec', 'product scope', 'materials of construction',
  'design standards', 'testing standards', 'approvals',
  'pressure', 'temperature', 'cv vs travel', 'cv vs. travel',
  'model number', 'ordering', 'prefix', 'positioner', 'operation', 'fail position',
  'dimensions', 'specifications', 'overview', 'description', 'applications',
];

function isHeading(line) {
  const t = line.trim();
  if (!t || t.length > 60) return false;
  const lower = t.toLowerCase();
  if (KNOWN_SECTIONS.some(s => lower === s || lower.startsWith(s))) return true;
  const words = t.split(/\s+/);
  if (words.length <= 6 && /^[A-Z0-9]/.test(t) && !/[.;:]$/.test(t)) {
    const caps = words.filter(w => /^[A-Z0-9]/.test(w)).length;
    return caps / words.length >= 0.6;
  }
  return false;
}

function classify(block) {
  const text = block.trim();
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  const digits = (text.match(/[0-9]/g) || []).length;
  const words = (text.match(/[A-Za-z]{3,}/g) || []).length;
  const lines = text.split(/\n/).filter(l => l.trim());
  const hasSentence = /[a-z]\s+[a-z].*[.?]/i.test(text);
  if (words < 4 && digits > letters && !hasSentence) return 'noise';
  const numericRows = lines.filter(l => (l.match(/\s\S/g) || []).length >= 4 && (l.match(/\d/g) || []).length >= 3).length;
  if (lines.length >= 3 && numericRows / lines.length >= 0.5) return 'table';
  return 'prose';
}

function summariseTable(block, section) {
  const firstLine = block.trim().split(/\n/)[0].slice(0, 120);
  return `${section ? `Table from section "${section}"` : 'Data table'}. First row or columns: ${firstLine}`;
}

export function chunkDocument(text, baseMeta) {
  const out = [];
  let section = baseMeta.section || null;
  let prose = '';

  const flushProse = () => {
    let s = prose.trim();
    while (s.length >= MIN_CHUNK_CHARS) {
      out.push({ content: s.slice(0, TARGET_CHARS).trim(), contentType: 'prose', ...baseMeta, section });
      if (s.length <= TARGET_CHARS) break;
      s = s.slice(TARGET_CHARS - OVERLAP_CHARS);
    }
    prose = '';
  };

  for (const raw of text.split(/\n\s*\n/)) {
    const block = raw.replace(/\r/g, '').trim();
    if (!block) continue;
    if (block.split(/\n/).length === 1 && isHeading(block)) { flushProse(); section = block.trim(); continue; }
    const kind = classify(block);
    if (kind === 'noise') continue;
    if (kind === 'table') { flushProse(); out.push({ content: `${summariseTable(block, section)}\n\n${block}`, contentType: 'table', ...baseMeta, section }); continue; }
    prose += (prose ? '\n\n' : '') + block;
    if (prose.length >= TARGET_CHARS) flushProse();
  }
  flushProse();
  return out;
}
