import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { unzipSync } from 'fflate';

const MAX_ATTACHMENT_TEXT = 24_000;

export function xmlText(xml) {
  return xml.replace(/<[^>]*>/g, ' ').replace(/&(?:amp|lt|gt|quot|apos|#(?:x[0-9a-f]+|[0-9]+));/gi, entity => {
    const key = entity.slice(1, -1).toLowerCase();
    if (key[0] === '#') {
      const code = key[1] === 'x' ? Number.parseInt(key.slice(2), 16) : Number(key.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[key] ?? ' ';
  }).replace(/\s+/g, ' ').trim();
}

export function zipExcerpt(bytes, kind) {
  let selectedSize = 0;
  const files = unzipSync(bytes, { filter: file => {
    const selected = kind === '.docx' ? /^word\/document\.xml$/.test(file.name)
      : /^(?:xl\/sharedStrings\.xml|xl\/worksheets\/sheet[0-9]+\.xml)$/.test(file.name);
    if (!selected) return false;
    selectedSize += file.originalSize;
    if (file.originalSize > 4_000_000 || selectedSize > 8_000_000)
      throw new Error('Document content is too large to include in the question.');
    return true;
  } });
  const entries = Object.entries(files);
  if (!entries.length) throw new Error(`The ${kind.slice(1).toUpperCase()} has no readable document content.`);
  let text = '';
  for (const [, content] of entries) {
    if (content.byteLength > 4_000_000) throw new Error('A document part is too large to include in the question.');
    text += `${xmlText(new TextDecoder().decode(content))}\n`;
    if (text.length >= MAX_ATTACHMENT_TEXT) break;
  }
  return text;
}

export async function pdfExcerpt(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  const document = await task.promise;
  try {
    let text = '';
    for (let page = 1; page <= Math.min(document.numPages, 12) && text.length < MAX_ATTACHMENT_TEXT; page++) {
      const content = await (await document.getPage(page)).getTextContent();
      text += `${content.items.map(item => typeof item.str === 'string' ? item.str : '').join(' ')}\n`;
    }
    return text;
  } finally { await task.destroy(); }
}

export function redact(text) {
  return text
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/gi, '[PRIVATE KEY REDACTED]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, '$1[REDACTED]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]');
}

/** Returns the plain-text attachment part consumed by provider conversations. */
export async function extractText(record) {
  const bytes = await readFile(record.path);
  if (!bytes.length || bytes.length > 20 * 1024 * 1024 || bytes.length !== record.bytes)
    throw new Error(`The staged attachment ${record.name} changed. Add it again.`);
  const kind = extname(record.name).toLowerCase();
  let text;
  if (kind === '.txt' || kind === '.csv') text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  else if (kind === '.docx' || kind === '.xlsx') text = zipExcerpt(bytes, kind);
  else if (kind === '.pdf') text = await pdfExcerpt(bytes);
  else throw new Error('Unsupported attachment type.');
  text = redact(text).slice(0, MAX_ATTACHMENT_TEXT).trim();
  if (!text) throw new Error(`No readable text was found in ${record.name}.`);
  return { name: record.name, media_type: 'text/plain', content: text };
}
