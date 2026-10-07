import { createHash } from 'node:crypto';
import { extname } from 'node:path';

export const uploadPurposes = ['chat', 'pitchbook', 'rogo', 'company-data', 'intake'];
export function allowedUploadExtensions(purpose) {
  if (purpose === 'pitchbook' || purpose === 'rogo' || purpose === 'company-data') return ['.csv', '.xlsx'];
  if (purpose === 'intake') return ['.pdf', '.docx', '.txt'];
  return purpose === 'chat' ? ['.pdf', '.docx', '.txt', '.csv', '.xlsx'] : [];
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
