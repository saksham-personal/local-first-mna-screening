import { extname } from 'node:path';
import { extractText } from './text-extract.mjs';
import { extractIntakeFieldsFromText } from '../shared/intake-extract.mjs';

function routeError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/** Pure route core for staged-file Intake Form extraction. */
export async function routeIntake(input, stagedFiles) {
  const fileId = input && typeof input === 'object' ? input.fileId : undefined;
  if (typeof fileId !== 'string' || !fileId.trim()) throw routeError('Choose a staged file to extract.', 400);
  const record = stagedFiles.get(fileId);
  if (!record) throw routeError('Staged file not found. Add it again.', 404);
  const extension = extname(record.name).toLowerCase();
  if (!['.pdf', '.docx', '.txt'].includes(extension)) throw routeError('Use a PDF, DOCX, or TXT file for Intake Form extraction.', 415);
  const attachment = await extractText(record);
  const text = attachment.content.slice(0, 24_000);
  const { fields, matched } = extractIntakeFieldsFromText(text);
  return { text, fields, matched, fileId, fileName: record.name };
}

export async function handleIntakeRoute(req, res, url, { respond, body, stagedFiles }) {
  if (url.pathname !== '/api/intake/extract') return false;
  if (req.method !== 'POST') {
    respond(res, 405, { error: 'Use POST to extract an Intake Form.' });
    return true;
  }
  if (!req.headers['content-type']?.startsWith('application/json')) {
    respond(res, 400, { error: 'Use a JSON request.' });
    return true;
  }
  const input = await body(req);
  const result = await routeIntake(input, stagedFiles);
  respond(res, 200, result);
  return true;
}
