import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, access, readdir, stat, rename, open, unlink } from 'node:fs/promises';
import { dirname, resolve, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJobRegistry } from './jobs.mjs';
import { createDurableScreeningPreparation } from './durable-screening.mjs';
import { createBackgroundScreening } from './background-screening.mjs';
import { createBingResearch } from './bing-research.mjs';
import { createProviderConversation } from './provider-conversation.mjs';
import { handlePromptRoute } from './prompt-routes.mjs';
import { handleIntakeRoute } from './intake-routes.mjs';
import { ports, allowedOrigins, allowedHosts } from './ports.mjs';
import { uploadPurposes, validateUploadPurpose, uploadDedupeKey, withUploadLock, validateIndexWorkbookName, validateIndexWorkbookSignature, indexUploadMaxBytes, validateIndexUploadSize } from './upload-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = resolve(root, '.screening-data');
const importRoot = resolve(data, 'import');
const rustAddress = `http://127.0.0.1:${ports.rust}`;
const admin = { start_index_build: '/admin/index-build-start', cancel_index_build: '/admin/index-build-cancel', activate_mid_bundle: '/admin/mid-bundle-activate', delete_mid_bundle: '/admin/mid-bundle-delete', import_company_files: '/admin/company-files', create_run: '/admin/runs', approve_screening_profile: '/admin/profiles/approve', approve_prepared_plan: '/admin/prepared-plan-approve', approve_action_plan: '/admin/actions/approve', review_shortlist: '/admin/shortlist-review', apply_enrichment_review: '/admin/enrichment-review', save_criteria_revision: '/admin/criteria-save', approve_criteria_revision: '/admin/criteria-approve' };
const allowed = new Set(['get_mid_index_status', 'get_index_build', 'list_index_builds', 'get_active_screening_profile', 'get_run_context', 'search_mid', 'add_candidates', 'get_candidate_set', 'get_company', 'get_company_context', 'get_candidate_context', 'get_discovery_summary', 'get_source_rows', 'get_candidate_source_data', 'save_checkpoint', 'get_checkpoint', 'import_enrichment_files', 'propose_prepared_plan', 'get_prepared_plan']);
for (const tool of ['inspect_enrichment_files', 'get_execution_job', 'get_execution_progress', 'get_model_assessments', 'get_screening_rounds', 'propose_action_plan', 'get_action_plan', 'prepare_bing_queries', 'bing_search', 'get_evidence', 'get_previous_research', 'get_shortlist_context', 'get_criteria_history', 'get_run_source_projection', 'get_screening_grid', 'get_company_detail', 'get_enrichment_report', 'score_mid_semantic', 'search_mid_semantic']) allowed.add(tool);
Object.assign(admin, { space_sync: '/admin/space-sync', space_add_to_run: '/admin/space-add-to-run', space_export: '/admin/space-export' });
for (const tool of ['space_sync_status', 'space_browse', 'space_search_lexical', 'space_search_semantic', 'space_search_iscc', 'space_recent']) allowed.add(tool);
const simulate = process.env.SCREENING_SIMULATE === '1';
if (simulate) allowed.add('search_iscc');
const origins = allowedOrigins;
const hosts = allowedHosts;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const fileKinds = new Map([
  ['.pdf', { kind: 'pdf', parseKind: 'document', importable: false, contentType: 'application/pdf' }],
  ['.docx', { kind: 'docx', parseKind: 'document', importable: false, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }],
  ['.txt', { kind: 'txt', parseKind: 'text', importable: false, contentType: 'text/plain; charset=utf-8' }],
  ['.csv', { kind: 'csv', parseKind: 'tabular', importable: true, contentType: 'text/csv; charset=utf-8' }],
  ['.xlsx', { kind: 'xlsx', parseKind: 'tabular', importable: true, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
]);

function respond(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(payload));
}

async function body(req) {
  let length = 0;
  const parts = [];
  for await (const part of req) {
    length += part.length;
    if (length > 30 * 1024 * 1024) throw new Error('Request is too large. Use files under 20 MB.');
    parts.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

function decodeBase64(value) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new Error('File content must be valid base64 under 20 MB.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error('Use nonempty files under 20 MB.');
  return bytes;
}

function validateFileBytes(extension, bytes) {
  if (extension === '.pdf' && bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('The PDF file signature is invalid.');
  if ((extension === '.docx' || extension === '.xlsx') && !(bytes[0] === 0x50 && bytes[1] === 0x4b)) throw new Error(`The ${extension.slice(1).toUpperCase()} file signature is invalid.`);
  if ((extension === '.txt' || extension === '.csv') && bytes.includes(0)) throw new Error('Text and CSV uploads cannot contain binary data.');
  if (extension === '.txt' || extension === '.csv') {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('Text and CSV uploads must use UTF-8.'); }
  }
}

function textExcerpt(bytes) {
  let text = bytes.subarray(0, 120_000).toString('utf8');
  text = text.replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/gi, '[PRIVATE KEY REDACTED]');
  text = text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, '$1[REDACTED]');
  text = text.replace(/\b((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
  text = text.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]');
  return text;
}

function quotedFilename(name) {
  const ascii = basename(name).replace(/[\r\n"\\]/g, '_').replace(/[^\x20-\x7e]/g, '_') || 'attachment';
  const encoded = encodeURIComponent(basename(name)).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

async function sendStagedFile(res, record) {
  const bytes = await readFile(record.path);
  res.writeHead(200, {
    'Content-Type': record.contentType,
    'Content-Length': String(bytes.length),
    'Content-Disposition': quotedFilename(record.name),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(bytes);
}

async function rustCall(apiKey, analystKey, controllerKey, staged, tool, args, analystApproved, signal) {
  if (typeof tool !== 'string' || (!Object.hasOwn(admin, tool) && !allowed.has(tool))) throw new Error('This tool is not enabled in the local example.');
  if (tool === 'space_add_to_run' && analystApproved !== true) throw new Error('Approve adding the selected companies to the screening run.');
  if ((['start_index_build', 'cancel_index_build', 'activate_mid_bundle', 'delete_mid_bundle'].includes(tool) || tool === 'approve_screening_profile' || tool === 'create_run' || tool === 'approve_prepared_plan' || tool === 'approve_action_plan' || tool === 'review_shortlist' || tool === 'apply_enrichment_review' || tool === 'save_criteria_revision' || tool === 'approve_criteria_revision') && analystApproved !== true) throw new Error('Approve the screening setup before changing a screening run.');
  if (tool === 'import_company_files' || tool === 'import_enrichment_files' || tool === 'inspect_enrichment_files') {
    if (!Array.isArray(args.files) || !args.files.length || !args.files.every(file => typeof file === 'string' && staged.has(file))) throw new Error('Select files through the upload controls.');
  }
  if (tool === 'start_index_build' && (typeof args.file !== 'string' || !staged.has(args.file))) throw new Error('Select a workbook through the upload controls.');
  const response = await fetch(`${rustAddress}${admin[tool] ?? '/tools/call'}`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...(Object.hasOwn(admin, tool) ? { 'X-MNA-Analyst-Key': analystKey } : {}), ...(['review_shortlist', 'apply_enrichment_review', 'save_criteria_revision', 'approve_criteria_revision'].includes(tool) ? { 'X-MNA-Controller-Key': controllerKey } : {}) },
    body: JSON.stringify(Object.hasOwn(admin, tool) ? args : { tool, arguments: args }),
  });
  const result = await response.json().catch(() => undefined);
  if (!response.ok || result?.ok === false) throw new Error(result?.error?.message ?? result?.message ?? result?.error ?? `Tool failed (${response.status})`);
  const value = Object.hasOwn(admin, tool) ? result : result?.result;
  if (!value || typeof value !== 'object') throw new Error('The Rust tool returned an unreadable result.');
  return value;
}

// Pure spawn decision; explicit local settings are restored AFTER provider scrubbing.
export function managedMeiliConfig(env, dataRoot, masterKey) {
  if (!env.SCREENING_MEILI_BIN) return null;
  const port = Number(env.SCREENING_MEILI_PORT || 7700);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SCREENING_MEILI_PORT must be 1..65535.');
  const url = `http://127.0.0.1:${port}`;
  return { binary: env.SCREENING_MEILI_BIN, url, args: ['--http-addr', `127.0.0.1:${port}`, '--db-path', resolve(dataRoot, 'meili'), '--env', 'development', '--no-analytics'], masterKey };
}

export async function startBridge() {
  await mkdir(importRoot, { recursive: true });
  await mkdir(resolve(data, 'export'), { recursive: true });
  const seedId = 'example-mid.csv';
  const seedPath = resolve(importRoot, seedId);
  await writeFile(seedPath, await readFile(resolve(root, 'examples/mid.csv')));
  const staged = new Set([seedId]);
  const stagedFiles = new Map();
  const fileManifest = resolve(data, 'uploaded-files.json');
  let savedFiles = [];
  try { savedFiles = JSON.parse(await readFile(fileManifest, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!Array.isArray(savedFiles)) throw new Error('The saved upload index is unreadable. Original files are retained.');
  // Recover older uploads that predate the durable metadata index. Names still
  // live in the conversation; only UUID-named files under this import directory are eligible.
  for (const id of await readdir(importRoot)) {
    if (!/^[0-9a-f-]{36}\.(?:pdf|docx|txt|csv|xlsx)$/i.test(id)) continue;
    const descriptor = fileKinds.get(extname(id).toLowerCase());
    const path = resolve(importRoot, id), info = await stat(path);
    const saved = savedFiles.find(file => file?.id === id);
    if (!info.isFile() || !info.size || info.size > (saved?.purpose === 'mid_index' ? indexUploadMaxBytes(process.env.SCREENING_INDEX_UPLOAD_MAX_BYTES) : MAX_FILE_BYTES) || !descriptor) continue;
    const name = typeof saved?.name === 'string' ? basename(saved.name) : id;
    staged.add(id);
    stagedFiles.set(id, { id, name, bytes: info.size, path, ...(typeof saved?.sessionId === 'string' ? { sessionId: saved.sessionId } : {}), ...(uploadPurposes.includes(saved?.purpose) ? { purpose: saved.purpose } : {}), ...descriptor });
  }
  let manifestQueue = Promise.resolve();
  const saveFiles = () => {
    manifestQueue = manifestQueue.catch(() => {}).then(async () => {
      const temp = `${fileManifest}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify([...stagedFiles.values()].map(({ id, name, sessionId, purpose }) => ({ id, name, ...(sessionId ? { sessionId } : {}), ...(purpose ? { purpose } : {}) }))), { flag: 'wx' });
      await rename(temp, fileManifest);
    });
    return manifestQueue;
  };
  const defaultBinary = resolve(root, '../mna-tools/target/x86_64-pc-windows-gnu/release/mna-tools.exe');
  const binary = process.env.SCREENING_RUST_BINARY || defaultBinary;
  await access(binary).catch(() => { throw new Error(`Rust executable is missing. Build mna-tools or set SCREENING_RUST_BINARY. Expected: ${binary}`); });
  const apiKey = randomBytes(32).toString('hex');
  const analystKey = randomBytes(32).toString('hex');
  const controllerKey = randomBytes(32).toString('hex');
  const externalEnabled = process.env.SCREENING_ENABLE_EXTERNAL === 'true';
  const env = { ...process.env, MNA_ENABLE_EXTERNAL: String(externalEnabled), MNA_API_KEY: apiKey, MNA_ANALYST_KEY: analystKey, MNA_CONTROLLER_KEY: controllerKey, MNA_BIND: `127.0.0.1:${ports.rust}`, MNA_DB_PATH: resolve(data, 'screening.db'), MNA_IMPORT_DIR: importRoot, MNA_EXPORT_DIR: resolve(data, 'export'), MNA_ARTIFACT_DIR: resolve(data, 'web') };
  if (simulate) { env.MNA_SIMULATE = '1'; console.log('Simulated providers are ON (dev only). Data is labelled SIMULATED.'); } else { delete env.MNA_SIMULATE; }
  for (const key of Object.keys(env)) if (/(?:OPENAI|ANTHROPIC|AZURE_OPENAI|GOOGLE|GEMINI|COHERE|BING|M365|ISCC|MEILI|LLMSUITE|PROVIDER_(?:URL|ENDPOINT|API_KEY))/i.test(key) && !(externalEnabled && /^MNA_(?:LLMSUITE|M365|BING|ISCC)_/.test(key))) delete env[key];
  let meili;
  const meiliKey = randomBytes(32).toString('hex');
  const meiliConfig = managedMeiliConfig(process.env, data, meiliKey);
  if (meiliConfig) {
    let meiliError = false;
    try {
      await access(meiliConfig.binary);
      // The master key goes through the environment so it is not visible in the process list.
      const meiliEnv = { ...Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]])), MEILI_MASTER_KEY: meiliConfig.masterKey };
      meili = spawn(meiliConfig.binary, meiliConfig.args, { cwd: root, env: meiliEnv, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
      meili.on('error', () => { meiliError = true; });
      let healthy = false;
      for (let attempt = 0; attempt < 100 && !meiliError && meili.exitCode === null; attempt++) {
        try {
          healthy = (await fetch(`${meiliConfig.url}/health`, { signal: AbortSignal.timeout(500) })).ok
            && (await fetch(`${meiliConfig.url}/indexes`, { headers: { Authorization: `Bearer ${meiliKey}` }, signal: AbortSignal.timeout(500) })).ok;
        } catch {}
        if (healthy) break;
        await new Promise(done => setTimeout(done, 100));
      }
      if (healthy && !meiliError && meili.exitCode === null) {
        Object.assign(env, { MNA_MEILI_URL: meiliConfig.url, MNA_MEILI_API_KEY: meiliKey, MNA_MEILI_INDEX: 'companies' });
      } else { meili.kill(); }
    } catch { meili?.kill(); }
    console.log(env.MNA_MEILI_URL ? 'Search Space Meilisearch is running locally.' : 'Meilisearch is not running; lexical Search Space is unavailable.');
  }
  // Optional local embedding worker (Arctic-embed-m-v2 ONNX int8) for MID semantic scoring.
  // SCREENING_EMBED_MODEL_DIR points at the unpacked model folder (onnx/model_int8.onnx + tokenizer.json).
  let embedWorker;
  const embedDir = process.env.SCREENING_EMBED_MODEL_DIR;
  if (embedDir && !env.MNA_EMBED_ENDPOINT) {
    const embedPort = Number(process.env.SCREENING_EMBED_PORT || 8865);
    embedWorker = spawn(process.env.SCREENING_PYTHON || 'python', [
      resolve(root, '..', 'mna-tools', 'scripts', 'local_embed_worker.py'),
      '--model', resolve(embedDir, 'onnx', 'model_int8.onnx'), '--tokenizer', resolve(embedDir, 'tokenizer.json'),
      '--port', String(embedPort), '--intra-op-threads', process.env.SCREENING_EMBED_THREADS || '4',
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
    embedWorker.on('error', () => {});
    for (let attempt = 0; attempt < 120 && !env.MNA_EMBED_ENDPOINT; attempt++) {
      try { if ((await fetch(`http://127.0.0.1:${embedPort}/health`, { signal: AbortSignal.timeout(500) })).ok) env.MNA_EMBED_ENDPOINT = `http://127.0.0.1:${embedPort}/embed`; } catch {}
      if (!env.MNA_EMBED_ENDPOINT) await new Promise(done => setTimeout(done, 500));
    }
    console.log(env.MNA_EMBED_ENDPOINT ? `Semantic search is ON (local embedding worker on port ${embedPort}).` : 'The embedding worker did not start; semantic search stays off.');
  }
  const rust = spawn(binary, [], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let launchError = '';
  rust.on('error', error => { launchError = error.message; });
  rust.stdout.on('data', () => {});
  rust.stderr.on('data', chunk => { launchError = chunk.toString().slice(-1000); });
  let ready = false;
  for (let index = 0; index < 50; index++) {
    if (launchError || rust.exitCode !== null) break;
    try {
      ready = (await fetch(`${rustAddress}/tools`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(300) })).ok;
      if (ready) break;
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  if (!ready) {
    rust.kill(); embedWorker?.kill(); meili?.kill();
    throw new Error(launchError || `The Rust tool server did not start. Check that port ${ports.rust} is free.`);
  }

  // Search Space sync runs in the background; callers get its latest known state, never wait.
  // A failed sync is retried at most every five minutes.
  const syncs = new Map();
  const syncResults = new Map();
  const syncBundle = bundleId => {
    if (!bundleId || !env.MNA_MEILI_URL) return null;
    if (syncs.has(bundleId)) return { task_status: 'processing', bundle_id: bundleId };
    const known = syncResults.get(bundleId);
    if (known && (known.result.task_status !== 'failed' || Date.now() - known.at < 300_000)) return known.result;
    const pending = (async () => {
      let result;
      try {
        const status = await rustCall(apiKey, analystKey, controllerKey, staged, 'space_sync_status', {});
        if (status.bundle_id !== bundleId) result = { task_status: 'skipped', bundle_id: bundleId };
        else if (status.task_status === 'succeeded' && status.documents > 0) result = status;
        else result = await rustCall(apiKey, analystKey, controllerKey, staged, 'space_sync', {});
      } catch (error) { result = { task_status: 'failed', bundle_id: bundleId, error: error.message }; }
      syncResults.set(bundleId, { at: Date.now(), result });
      syncs.delete(bundleId);
    })();
    syncs.set(bundleId, pending);
    return { task_status: 'processing', bundle_id: bundleId };
  };
  const call = async (tool, args, analystApproved, signal) => {
    // Index workbooks (up to 1 GiB) are only for Build Index; other uploads never build an index.
    const purposeOf = id => stagedFiles.get(id)?.purpose;
    if (['import_company_files', 'import_enrichment_files', 'inspect_enrichment_files'].includes(tool) && Array.isArray(args?.files) && args.files.some(id => purposeOf(id) === 'mid_index'))
      throw new Error('Use Build Index for MID workbooks.');
    if (tool === 'start_index_build' && purposeOf(args?.file) !== 'mid_index') throw new Error('Select a workbook through Build Index.');
    const result = await rustCall(apiKey, analystKey, controllerKey, staged, tool, args, analystApproved, signal);
    if (tool === 'activate_mid_bundle' || (tool === 'get_index_build' && result.status === 'succeeded' && result.bundle?.status === 'active')) result.space_sync = syncBundle(result.bundle_id);
    if (tool === 'get_mid_index_status' && result.active) result.space_sync = syncBundle(result.active.bundle_id);
    return result;
  };
  const jobs = createJobRegistry({ call, seedFile: seedId });
  const screening = createDurableScreeningPreparation({ call, deployment: provider => providerDeployment(provider) });
  const externalReady = (provider) => {
    const prefix = provider === 'llm_suite' ? 'LLMSUITE' : provider === 'copilot' ? 'M365' : 'BING';
    return externalEnabled && Boolean(env[`MNA_${prefix}_ENDPOINT`] && env[`MNA_${prefix}_TOKEN`]);
  };
  // Dev-only simulation answers screening jobs and Bing searches (labelled SIMULATED in Rust);
  // direct provider questions are not simulated, so they keep the real readiness check.
  const simulatedProviders = process.env.SCREENING_SIMULATE === '1';
  const providerReady = (provider) => (simulatedProviders && ['llm_suite', 'copilot', 'bing'].includes(provider)) || externalReady(provider);
  const providerDeployment = provider => {
    const prefix = provider === 'llm_suite' ? 'LLMSUITE' : provider === 'copilot' ? 'M365' : null;
    const configured = prefix ? (env[`MNA_${prefix}_DEPLOYMENT`] || '').trim() : '';
    return configured || (simulatedProviders && prefix ? 'simulated' : '');
  };
  const controllerCall = async (tool, args) => {
    const path = { lease_execution_job: '/admin/execution-lease', dispatch_execution_job: '/admin/execution-dispatch', retry_execution_job: '/admin/execution-retry', dispatch_provider_text: '/admin/provider-text' }[tool];
    if (!path) return call(tool, args);
    const response = await fetch(`${rustAddress}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'X-MNA-Controller-Key': controllerKey }, body: JSON.stringify(args) });
    const result = await response.json();
    if (!response.ok) throw new Error(result?.error?.message ?? result?.message ?? result?.error ?? `Provider controller failed (${response.status})`);
    return result;
  };
  const background = createBackgroundScreening({ call: controllerCall, dispatch: args => controllerCall('dispatch_execution_job', args), connected: providerReady, storeFile: resolve(data, 'background-runs.json') });
  await background.init().catch(error => { rust.kill(); embedWorker?.kill(); meili?.kill(); throw error; });
  const research = createBingResearch({ call, connected: () => providerReady('bing') });
  const conversation = createProviderConversation({ dispatch: args => controllerCall('dispatch_provider_text', args), connected: externalReady,
    deployment: providerDeployment, stagedFiles, call });
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) return respond(res, 403, { error: 'This local endpoint accepts the Screening UI only.' });
    if (!hosts.has(req.headers.host ?? '')) return respond(res, 403, { error: 'This local endpoint accepts localhost requests only.' });
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${ports.bridge}`);
    try {
      if (await handlePromptRoute(req, res, url, { respond, body })) return;
      if (await handleIntakeRoute(req, res, url, { respond, body, stagedFiles })) return;
      if (req.method === 'GET' && url.pathname === '/api/health') return respond(res, 200, { ready: true, simulated: simulatedProviders, providers: { llm_suite: providerReady('llm_suite'), copilot: providerReady('copilot'), bing: providerReady('bing') } });
      // The existing file route serves staged uploads only. Exports use a separate
      // basename-only route rooted in export/, never a caller-supplied path.
      const exportMatch = url.pathname.match(/^\/api\/exports\/(space-[0-9a-f-]{36}\.xlsx)$/);
      if (req.method === 'GET' && exportMatch) {
        const path = resolve(data, 'export', exportMatch[1]);
        let info;
        try { info = await stat(path); } catch (error) { if (error.code === 'ENOENT') return respond(res, 404, { error: 'Export not found.' }); throw error; }
        if (!info.isFile()) return respond(res, 404, { error: 'Export not found.' });
        return sendStagedFile(res, { path, name: exportMatch[1], bytes: info.size, ...fileKinds.get('.xlsx') });
      }
      if (req.method === 'GET' && url.pathname === '/api/background-runs') return respond(res, 200, { jobs: await background.list() });
      if (req.method === 'GET' && url.pathname === '/api/jobs') return respond(res, 200, { jobs: jobs.list() });
      const jobMatch = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9-]+)$/);
      if (req.method === 'GET' && jobMatch) {
        const job = jobs.get(jobMatch[1]);
        return job ? respond(res, 200, { job }) : respond(res, 404, { error: 'Screening job not found.' });
      }
      const fileMatch = url.pathname.match(/^\/api\/files\/([A-Za-z0-9._-]+)$/);
      if (req.method === 'GET' && fileMatch) {
        const record = stagedFiles.get(fileMatch[1]);
        if (!record) return respond(res, 404, { error: 'Staged file not found.' });
        return sendStagedFile(res, record);
      }
      const cancelMatch = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9-]+)\/cancel$/);
      if (req.method === 'POST' && cancelMatch) {
        const job = jobs.cancel(cancelMatch[1]);
        return job ? respond(res, 200, { job }) : respond(res, 404, { error: 'Screening job not found.' });
      }
      if (req.method === 'PUT' && url.pathname === '/api/index-files') {
        let path, handle, id;
        try {
          const name = validateIndexWorkbookName(url.searchParams.get('name'));
          const limit = indexUploadMaxBytes(process.env.SCREENING_INDEX_UPLOAD_MAX_BYTES);
          if (req.headers['content-length']) validateIndexUploadSize(Number(req.headers['content-length']), limit);
          id = `${randomUUID()}.xlsx`; path = resolve(importRoot, id);
          handle = await open(path, 'wx');
          let bytes = 0, prefixLength = 0;
          const prefix = Buffer.alloc(4);
          // Keep at most one network chunk and four signature bytes in memory.
          // Do not destroy the socket on early return: it must receive the 413.
          for await (const chunk of req.iterator({ destroyOnReturn: false })) {
            bytes += chunk.length; validateIndexUploadSize(bytes, limit);
            if (prefixLength < 4) {
              const copied = chunk.copy(prefix, prefixLength, 0, Math.min(chunk.length, 4 - prefixLength));
              prefixLength += copied;
              if (prefixLength === 4) validateIndexWorkbookSignature(prefix);
            }
            await handle.writeFile(chunk);
          }
          validateIndexWorkbookSignature(prefix.subarray(0, prefixLength));
          await handle.close(); handle = null;
          stagedFiles.set(id, { id, name, bytes, path, purpose: 'mid_index', ...fileKinds.get('.xlsx') });
          await saveFiles(); staged.add(id);
          return respond(res, 200, { id, name, bytes });
        } catch (error) {
          if (handle) await handle.close().catch(() => {});
          if (path) await unlink(path).catch(() => {});
          if (id) { staged.delete(id); stagedFiles.delete(id); }
          req.resume();
          if (!res.destroyed) {
            res.writeHead(error.status === 413 ? 413 : 400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close' });
            res.end(error.message || 'Workbook upload did not finish.', () => req.destroy());
          }
          return;
        }
      }
      if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) return respond(res, 400, { error: 'Use a JSON request.' });
      const input = await body(req);
      const backgroundMatch = url.pathname.match(/^\/api\/background-runs\/(start|pause|resume|retry|stage)$/);
      if (backgroundMatch) {
        const result = await background[backgroundMatch[1]](input);
        return respond(res, 200, backgroundMatch[1] === 'stage' ? result : { job: result });
      }
      const researchMatch = url.pathname.match(/^\/api\/research\/(preview|run)$/);
      if (researchMatch) return respond(res, 200, await research[researchMatch[1]](input));
      const conversationMatch = url.pathname.match(/^\/api\/conversation\/(ask|generate)$/);
      if (conversationMatch) return respond(res, 200, await conversation[conversationMatch[1]](input));
      const screeningMatch = url.pathname.match(/^\/api\/screening\/(catalog|preview|approve)$/);
      if (screeningMatch) {
        const controller = new AbortController();
        res.on('close', () => { if (!res.writableEnded) controller.abort(); });
        return respond(res, 200, await screening[screeningMatch[1]](input, controller.signal));
      }
      if (url.pathname === '/api/jobs') return respond(res, 202, { job: jobs.create(input) });
      if (url.pathname === '/api/files') {
        if (!Array.isArray(input.files) || !input.files.length || input.files.length > 32) throw new Error('Select between 1 and 32 files.');
        if (input.sessionId != null && (typeof input.sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.sessionId))) throw new Error('Use a valid chat session ID.');
        if (input.purpose != null && !uploadPurposes.includes(input.purpose)) throw new Error('Choose a valid file destination.');
        const purpose = input.purpose ?? 'chat';
        const files = await withUploadLock(stagedFiles, async () => {
          const uploaded = [];
          for (const file of input.files) {
            const name = typeof file?.name === 'string' ? basename(file.name.trim()) : '';
            const extension = extname(name).toLowerCase();
            const descriptor = fileKinds.get(extension);
            if (!name || name.length > 255 || !descriptor) throw new Error(`${name || 'File'}: Use PDF, DOCX, TXT, CSV, or XLSX files with valid names.`);
            validateUploadPurpose(name, purpose);
            const bytes = decodeBase64(file.base64);
            validateFileBytes(extension, bytes);
            const key = uploadDedupeKey(input.sessionId, purpose, bytes);
            let existing;
            for (const record of stagedFiles.values()) {
              if (record.sessionId !== input.sessionId || (record.purpose ?? 'chat') !== purpose || record.bytes !== bytes.length) continue;
              if (uploadDedupeKey(record.sessionId, record.purpose ?? 'chat', await readFile(record.path)) === key) { existing = record; break; }
            }
            if (existing) {
              uploaded.push({ id: existing.id, name: existing.name, bytes: existing.bytes, kind: existing.kind, parseKind: existing.parseKind, importable: existing.importable, deduplicated: true, ...(existing.kind === 'txt' ? { excerpt: textExcerpt(bytes) } : {}) });
              continue;
            }
            const id = `${randomUUID()}${extension}`, path = resolve(importRoot, id);
            await writeFile(path, bytes, { flag: 'wx' });
            staged.add(id);
            stagedFiles.set(id, { id, name, bytes: bytes.length, path, ...(input.sessionId ? { sessionId: input.sessionId } : {}), purpose, ...descriptor });
            uploaded.push({ id, name, bytes: bytes.length, kind: descriptor.kind, parseKind: descriptor.parseKind, importable: descriptor.importable, ...(extension === '.txt' ? { excerpt: textExcerpt(bytes) } : {}) });
          }
          await saveFiles();
          return uploaded;
        });
        return respond(res, 200, { files });
      }
      if (url.pathname !== '/api/tools') return respond(res, 404, { error: 'Endpoint not found.' });
      const controller = new AbortController();
      res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      const result = await call(input.tool, input.arguments ?? {}, input.analystApproved, controller.signal);
      return respond(res, 200, { tool: input.tool, ok: true, result });
    } catch (error) {
      if (!res.destroyed) respond(res, Number.isSafeInteger(error?.status) ? error.status : 400, { error: error instanceof Error ? error.message : String(error), ...(error.calls ? { calls: error.calls } : {}) });
    }
  });
  try {
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(ports.bridge, '127.0.0.1', resolveListen); });
  } catch (error) {
    rust.kill(); embedWorker?.kill(); meili?.kill();
    throw error;
  }
  return { close: () => { background.close(); server.close(); rust.kill(); embedWorker?.kill(); meili?.kill(); }, rust, jobs };
}
