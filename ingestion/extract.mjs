import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

// Probe whether a command line tool is on PATH. A missing binary rejects with
// ENOENT. Any other outcome means the binary ran, so it is present even if it
// complained about the arguments.
async function hasBinary(name) {
  try { await exec(name, ['--version']); return true; }
  catch (e) { return e?.code !== 'ENOENT'; }
}

// Report which PDF tools are available, so a run can warn before it starts.
export async function checkTooling() {
  return { pdftotext: await hasBinary('pdftotext'), ocrmypdf: await hasBinary('ocrmypdf') };
}

async function extractPdf(path) {
  try {
    const { stdout } = await exec('pdftotext', ['-layout', '-enc', 'UTF-8', path, '-'], { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch { return ''; }
}

async function ocrPdf(path) {
  try {
    const tmp = path + '.ocr.pdf';
    await exec('ocrmypdf', ['--quiet', '--skip-text', path, tmp], { maxBuffer: 64 * 1024 * 1024 });
    return await extractPdf(tmp);
  } catch { return ''; }
}

async function extractOffice(path) {
  const { parseOfficeAsync } = await import('officeparser');
  return await parseOfficeAsync(path);
}

export async function extractText(path, ext) {
  if (ext === '.pdf') {
    let text = await extractPdf(path);
    if (!text || text.trim().length < 30) text = await ocrPdf(path);
    return { text };
  }
  if (['.docx', '.pptx', '.ppt', '.doc'].includes(ext)) {
    try { return { text: await extractOffice(path) }; } catch { return { text: '' }; }
  }
  return { text: '' };
}
