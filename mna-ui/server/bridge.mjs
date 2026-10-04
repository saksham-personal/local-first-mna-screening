import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, resolve, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJobRegistry } from './jobs.mjs';
import { createDurableScreeningPreparation } from './durable-screening.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = resolve(root, '.screening-data');
const importRoot = resolve(data, 'import');
const rustAddress = 'http://127.0.0.1:17318';
const admin = { import_company_files: '/admin/company-files', create_run: '/admin/runs', approve_screening_profile: '/admin/profiles/approve', approve_prepared_plan: '/admin/prepared-plan-approve' };
const allowed = new Set(['get_active_screening_profile', 'get_run_context', 'search_mid', 'add_candidates', 'get_candidate_set', 'get_company', 'get_company_context', 'get_candidate_context', 'get_discovery_summary', 'get_source_rows', 'get_candidate_source_data', 'save_checkpoint', 'get_checkpoint', 'import_enrichment_files', 'propose_prepared_plan', 'get_prepared_plan']);
const origins = new Set(['http://127.0.0.1:4173', 'http://localhost:4173', 'http://127.0.0.1:5173', 'http://localhost:5173']);
const hosts = new Set(['127.0.0.1:7319', 'localhost:7319', '127.0.0.1:4173', 'localhost:4173', '127.0.0.1:5173', 'localhost:5173']);
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

async function rustCall(apiKey, analystKey, staged, tool, args, analystApproved, signal) {
  if (typeof tool !== 'string' || (!Object.hasOwn(admin, tool) && !allowed.has(tool))) throw new Error('This tool is not enabled in the local example.');
  if ((tool === 'approve_screening_profile' || tool === 'create_run' || tool === 'approve_prepared_plan') && analystApproved !== true) throw new Error('Approve the screening setup before changing a Rust screening run.');
  if (tool === 'import_company_files' || tool === 'import_enrichment_files') {
    if (!Array.isArray(args.files) || !args.files.length || !args.files.every(file => typeof file === 'string' && staged.has(file))) throw new Error('Select files through the upload controls.');
  }
  const response = await fetch(`${rustAddress}${admin[tool] ?? '/tools/call'}`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...(Object.hasOwn(admin, tool) ? { 'X-MNA-Analyst-Key': analystKey } : {}) },
    body: JSON.stringify(Object.hasOwn(admin, tool) ? args : { tool, arguments: args }),
  });
  const result = await response.json().catch(() => undefined);
  if (!response.ok || result?.ok === false) throw new Error(result?.error?.message ?? result?.message ?? result?.error ?? `Tool failed (${response.status})`);
  const value = Object.hasOwn(admin, tool) ? result : result?.result;
  if (!value || typeof value !== 'object') throw new Error('The Rust tool returned an unreadable result.');
  return value;
}

export async function startBridge() {
  await mkdir(importRoot, { recursive: true });
  await mkdir(resolve(data, 'export'), { recursive: true });
  const seedId = 'example-mid.csv';
  const seedPath = resolve(importRoot, seedId);
  await writeFile(seedPath, await readFile(resolve(root, 'examples/mid.csv')));
  const staged = new Set([seedId]);
  const stagedFiles = new Map();
  const defaultBinary = resolve(root, '../mna-tools/target/x86_64-pc-windows-gnu/release/mna-tools.exe');
  const binary = process.env.SCREENING_RUST_BINARY || defaultBinary;
  await access(binary).catch(() => { throw new Error(`Rust executable is missing. Build mna-tools or set SCREENING_RUST_BINARY. Expected: ${binary}`); });
  const apiKey = randomBytes(32).toString('hex');
  const analystKey = randomBytes(32).toString('hex');
  const env = { ...process.env, MNA_ENABLE_EXTERNAL: 'false', MNA_API_KEY: apiKey, MNA_ANALYST_KEY: analystKey, MNA_BIND: '127.0.0.1:17318', MNA_DB_PATH: resolve(data, 'screening.db'), MNA_IMPORT_DIR: importRoot, MNA_EXPORT_DIR: resolve(data, 'export'), MNA_ARTIFACT_DIR: resolve(data, 'web') };
  for (const key of Object.keys(env)) if (/(?:OPENAI|ANTHROPIC|AZURE_OPENAI|GOOGLE|GEMINI|COHERE|BING|M365|ISCC|MEILI|LLMSUITE|PROVIDER_(?:URL|ENDPOINT|API_KEY))/i.test(key)) delete env[key];
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
    rust.kill();
    throw new Error(launchError || 'The Rust tool server did not start. Check that port 17318 is free.');
  }

  const call = (tool, args, analystApproved, signal) => rustCall(apiKey, analystKey, staged, tool, args, analystApproved, signal);
  const jobs = createJobRegistry({ call, seedFile: seedId });
  const screening = createDurableScreeningPreparation({ call });
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) return respond(res, 403, { error: 'This local endpoint accepts the Screening UI only.' });
    if (!hosts.has(req.headers.host ?? '')) return respond(res, 403, { error: 'This local endpoint accepts localhost requests only.' });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1:7319');
    try {
      if (req.method === 'GET' && url.pathname === '/api/health') return respond(res, 200, { ready: true, engine: 'Rust', providers: false });
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
      if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) return respond(res, 400, { error: 'Use a JSON request.' });
      const input = await body(req);
      const screeningMatch = url.pathname.match(/^\/api\/screening\/(catalog|preview|approve)$/);
      if (screeningMatch) {
        const controller = new AbortController();
        res.on('close', () => { if (!res.writableEnded) controller.abort(); });
        return respond(res, 200, await screening[screeningMatch[1]](input, controller.signal));
      }
      if (url.pathname === '/api/jobs') return respond(res, 202, { job: jobs.create(input) });
      if (url.pathname === '/api/files') {
        if (!Array.isArray(input.files) || !input.files.length || input.files.length > 32) throw new Error('Select between 1 and 32 files.');
        const files = [];
        for (const file of input.files) {
          const name = typeof file?.name === 'string' ? basename(file.name.trim()) : '';
          const extension = extname(name).toLowerCase();
          const descriptor = fileKinds.get(extension);
          if (!name || name.length > 255 || !descriptor) throw new Error('Use PDF, DOCX, TXT, CSV, or XLSX files with valid names.');
          const bytes = decodeBase64(file.base64);
          validateFileBytes(extension, bytes);
          const id = `${randomUUID()}${extension}`;
          const path = resolve(importRoot, id);
          await writeFile(path, bytes, { flag: 'wx' });
          staged.add(id);
          const record = { id, name, bytes: bytes.length, path, ...descriptor };
          stagedFiles.set(id, record);
          files.push({ id, name, bytes: bytes.length, kind: descriptor.kind, parseKind: descriptor.parseKind, importable: descriptor.importable, ...(extension === '.txt' ? { excerpt: textExcerpt(bytes) } : {}) });
        }
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
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(7319, '127.0.0.1', resolveListen); });
  } catch (error) {
    rust.kill();
    throw error;
  }
  return { close: () => { server.close(); rust.kill(); }, rust, jobs };
}
