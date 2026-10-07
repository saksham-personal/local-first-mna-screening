import { createHash } from 'node:crypto';
import { extname } from 'node:path';

export const uploadPurposes = ['chat', 'pitchbook', 'rogo', 'company-data', 'intake', 'mid_index'];
export function allowedUploadExtensions(purpose) {
  if (purpose === 'mid_index') return ['.xlsx'];
  if (purpose === 'pitchbook' || purpose === 'rogo' || purpose === 'company-data') return ['.csv', '.xlsx'];
  if (purpose === 'intake') return ['.pdf', '.docx', '.txt'];
  return purpose === 'chat' ? ['.pdf', '.docx', '.txt', '.csv', '.xlsx'] : [];
}
export function validateIndexWorkbookName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 255 || /[\\/\x00-\x1f]/.test(name) || !/\.xlsx$/i.test(name)) throw new Error('Choose one .xlsx workbook with a valid file name.');
  return name.trim();
}
export function validateIndexWorkbookSignature(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) throw new Error('This file is not an XLSX workbook.');
}
export function indexUploadMaxBytes(value) {
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : 1024 * 1024 * 1024;
}
export function validateIndexUploadSize(bytes, limit) {
  if (bytes > limit) throw Object.assign(new Error(`Workbook is too large. The upload limit is ${limit.toLocaleString('en-US')} bytes.`), { status: 413 });
}
export function validateUploadPurpose(name, purpose) {
  const extensions = allowedUploadExtensions(purpose);
  if (!extensions.includes(extname(name).toLowerCase())) throw new Error(`${name}: ${purpose === 'intake' ? 'Intake Form' : purpose === 'pitchbook' ? 'PitchBook data' : purpose === 'rogo' ? 'ROGO data' : 'This destination'} accepts ${extensions.join(', ')} files.`);
}
export function uploadDedupeKey(sessionId, purpose, bytes) {
  return JSON.stringify([sessionId ?? '', purpose, createHash('sha256').update(bytes).digest('hex')]);
}
// Serialize writes for a manifest to prevent concurrent identical requests
// from staging two originals. The existing on-disk manifest stays unchanged.
const queues = new WeakMap();
export function withUploadLock(manifest, operation) {
  const next = (queues.get(manifest) ?? Promise.resolve()).catch(() => {}).then(operation);
  queues.set(manifest, next);
  void next.finally(() => { if (queues.get(manifest) === next) queues.delete(manifest); }).catch(() => {});
  return next;
}
