import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

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
