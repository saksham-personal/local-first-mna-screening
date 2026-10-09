import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PAGE_SIZE = 500;
const SEND_BATCH = 25;
// Result rows the chat shows for a run; every observation stays saved in the evidence store.
const MAX_ROWS = 500;
const TTL = 15 * 60_000;

function templatesFrom(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 5) throw new Error('Use one to five research queries.');
  const seen = new Set();
  return input.map(item => {
    if (typeof item !== 'string' || !item.trim() || item.length > 2000) throw new Error('Each research query must be nonempty and under 2,000 characters.');
    const query = item.trim();
    const placeholders = [...query.matchAll(/\{([^{}]+)\}|<([^<>]+)>/g)].map(match => (match[1] ?? match[2]).toLowerCase());
    if (placeholders.some(key => !['company', 'website'].includes(key))) throw new Error('Only {company}, {website}, and <company> placeholders are supported.');
    const key = query.toLocaleLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) throw new Error('Research queries must be distinct.');
    seen.add(key);
    return query;
  });
}

function message(error) { return error instanceof Error ? error.message : String(error); }
function timestamp(now) { return new Date(now()).toISOString(); }
function isConnectionError(error) {
  const code = error?.code ?? error?.cause?.code;
  if (typeof code === 'string' && /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ENOTFOUND|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(code)) return true;
  return /(?:econn(?:refused|reset)|ehostunreach|enetunreach|eai_again|enotfound|fetch failed|socket hang up|network (?:error|failure)|connection (?:refused|reset|closed|failed|lost|timed out)|provider connection.*(?:unavailable|lost)|bing is not connected)/i.test(message(error));
}

export function createBingResearch({ call, connected = () => false, storeFile, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  const previews = new Map();
  const runs = new Map();
  const byPlan = new Map();
  const timers = new Map();
  const pumps = new Map();
  const starts = new Map();
  let saveQueue = Promise.resolve();
  let loaded = false;

  function tracer(calls) {
    return async (tool, args, approved = false) => {
      calls.totalCount = (calls.totalCount ?? 0) + 1;
      const startedAt = timestamp(now);
      try {
        const result = await call(tool, args, approved);
        const traceArgs = tool === 'propose_action_plan' ? { run_id: args.run_id, steps: args.steps?.map(step => ({ step_id: step.step_id, kind: step.kind, company_count: step.company_ids?.length, query_templates: step.query_templates })) }
          : tool === 'prepare_bing_queries' ? { run_id: args.run_id, plan_id: args.plan_id, step_id: args.step_id, company_count: args.company_ids?.length } : args;
        if (calls.length < 256) calls.push({ tool, args: traceArgs, result: tool === 'get_shortlist_context'
          ? { returned: result.candidates?.length, considered_count: result.considered_count, has_more: result.has_more, selection_revision: result.selection_revision }
          : tool === 'get_company' ? { company_id: result.company_id }
          : tool === 'propose_action_plan' || tool === 'approve_action_plan' ? { plan_id: result.plan_id, status: result.status }
          : tool === 'prepare_bing_queries' ? { queries: result.queries?.length }
          : tool === 'bing_search' ? { evidence_id: result.evidence_id, results: result.results?.length } : result,
          startedAt, finishedAt: timestamp(now), status: 'success' });
        return result;
      } catch (error) {
        if (calls.length < 256) calls.push({ tool, args: tool === 'propose_action_plan' ? { run_id: args.run_id, company_count: args.steps?.[0]?.company_ids?.length } : args, error: message(error), startedAt, finishedAt: timestamp(now), status: 'error' });
        error.calls = calls;
        throw error;
      }
    };
  }

  async function selection(runId, traced, limit = 1, cursor) {
    const page = await traced('get_shortlist_context', { run_id: runId, include_hidden: false, limit, ...(cursor ? { after_company_id: cursor } : {}) });
    if (!Array.isArray(page.candidates) || !Number.isSafeInteger(page.considered_count) || page.considered_count < 0 ||
        !(typeof page.selection_revision === 'string' || Number.isSafeInteger(page.selection_revision)))
      throw new Error('The considered-company reader returned an invalid page.');
    return page;
  }

  async function shortlist(runId, traced) {
    let cursor, count, revision;
    const ids = [], seen = new Set();
    do {
      const page = await selection(runId, traced, PAGE_SIZE, cursor);
      if ((count !== undefined && count !== page.considered_count) || (revision !== undefined && revision !== page.selection_revision))
        throw new Error('Considered companies changed during approval. Preview again.');
      count = page.considered_count; revision = page.selection_revision;
      for (const candidate of page.candidates) {
        const id = candidate?.company_id ?? candidate?.pk;
        if (typeof id !== 'string' || !SAFE_ID.test(id) || seen.has(id)) throw new Error('The considered-company reader returned a duplicate or invalid ID.');
        seen.add(id); ids.push(id);
      }
      const next = page.next_after_company_id || undefined;
      if (page.has_more && (!next || next === cursor || !page.candidates.length)) throw new Error('Considered-company pagination did not advance.');
      cursor = page.has_more ? next : undefined;
    } while (cursor);
    if (ids.length !== count) throw new Error('The considered-company reader did not return every company. Preview again.');
    return { ids, revision };
  }

  function snapshot(saved) {
    const state = saved.state;
    const sendState = state === 'running' ? 'running' : state === 'queued' ? 'queued' : state === 'paused' ? 'paused' :
      state === 'failed' ? 'failed' : state === 'cancelling' ? 'running' : 'completed';
    const saveState = state === 'completed' ? 'completed' : state === 'running' || state === 'cancelling' ? 'running' :
      state === 'paused' ? 'paused' : state === 'failed' ? 'failed' : state === 'cancelled' ? 'cancelled' : 'queued';
    return {
      id: saved.id, kind: 'bing', runId: saved.runId, sessionId: saved.sessionId,
      planId: saved.planId, title: saved.title, state,
      steps: [
        { id: 'approve-plan', label: 'Approve plan', state: 'completed' },
        { id: 'send-queries', label: `Send queries · ${saved.processedQueries} of ${saved.queryCount}`, state: sendState },
        { id: 'save-observations', label: 'Save observations', state: saveState },
      ],
      processedQueries: saved.processedQueries, queryCount: saved.queryCount,
      failedQueries: saved.failedQueries, startedAt: saved.startedAt,
      updatedAt: saved.updatedAt, message: saved.message,
    };
  }

  function persist() {
    if (!storeFile) return Promise.resolve();
    const content = JSON.stringify({ version: 1, runs: [...runs.values()] });
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      await mkdir(dirname(storeFile), { recursive: true });
      const tmp = `${storeFile}.${randomUUID()}.tmp`;
      await writeFile(tmp, content, { flag: 'wx' });
      await rename(tmp, storeFile);
    });
    return saveQueue;
  }

  async function init() {
    if (loaded) return;
    if (storeFile) {
      try {
        const saved = JSON.parse(await readFile(storeFile, 'utf8'));
        if (saved?.version === 1 && Array.isArray(saved.runs)) {
          for (const item of saved.runs) {
            if (!SAFE_ID.test(item?.id ?? '') || !SAFE_ID.test(item?.token ?? '') || !SAFE_ID.test(item?.runId ?? '') ||
                !SAFE_ID.test(item?.planId ?? '') || !Array.isArray(item.templates) || !Array.isArray(item.ids) ||
                !Number.isSafeInteger(item.nextQueryIndex) || !Number.isSafeInteger(item.queryCount)) continue;
            if (!['completed', 'cancelled', 'failed'].includes(item.state)) {
              item.state = 'paused';
              item.message = 'Paused after the bridge restarted. Resume to continue.';
            }
            item.pauseRequested = false;
            item.cancelRequested = false;
            item.updatedAt = timestamp(now);
            runs.set(item.token, item);
            byPlan.set(item.planId, item.token);
          }
        }
      } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    loaded = true;
    await persist();
  }

  async function preview(input) {
    await init();
    const calls = [], traced = tracer(calls), templates = templatesFrom(input.queries);
    const mode = input.mode ?? (Array.isArray(input.companyIds) && input.companyIds.length ? 'company' : 'general');
    if (!['company', 'general'].includes(mode)) throw new Error('Choose company or general research.');
    let runId = input.runId;
    if (mode === 'company' && (typeof runId !== 'string' || !SAFE_ID.test(runId))) throw new Error('Choose a screening run for company research.');
    if (!runId) runId = (await traced('create_run', { objective: 'Bing research', original_criteria: { queries: templates } }, true)).run_id;
    if (typeof runId !== 'string' || !SAFE_ID.test(runId)) throw new Error('Use a valid screening run.');
    const first = mode === 'company' ? await selection(runId, traced) : undefined;
    const companyCount = first?.considered_count ?? 0;
    if (mode === 'company' && !companyCount) throw new Error('No considered companies are available for research.');
    for (const [token, saved] of previews) if (!saved.started && saved.expires <= now()) previews.delete(token);
    if (previews.size >= 8) {
      const idle = [...previews].find(([, saved]) => !saved.started);
      if (!idle) throw new Error('Close or finish an existing research plan before preparing another.');
      previews.delete(idle[0]);
    }
    const token = randomUUID();
    previews.set(token, { token, runId, stepId: 'bing-grounding', mode, templates,
      expires: now() + TTL, started: false, previewCount: companyCount,
      previewRevision: first?.selection_revision });
    return { token, queries: templates.map(query => ({ query })), queryCount: (companyCount || 1) * templates.length,
      companyCount, executed: false, calls, traceCount: calls.totalCount ?? calls.length,
      traceTruncated: (calls.totalCount ?? calls.length) > calls.length };
  }

  function schedule(token) {
    if (timers.has(token)) clearTimer(timers.get(token));
    const timer = setTimer(() => {
      timers.delete(token);
      void pump(token);
    }, 0);
    timers.set(token, timer);
    timer?.unref?.();
  }

  // Rows live in a per-run side file (or memory without a store file) so the state file stays small.
  const memoryRows = new Map();
  const rowsFile = (saved) => storeFile ? join(dirname(storeFile), 'bing-rows', `${saved.id}.jsonl`) : undefined;
  function resultRows(saved, query, result) {
    const verification = result?.simulated ? 'SIMULATED — Unverified research lead' : 'Unverified research lead';
    const base = { pk: query.company_id ?? '', Query: query.query, Verification: verification, evidence_id: result?.evidence_id ?? '' };
    const rows = (result?.results ?? []).map(source => ({ ...base, Title: source.title, URL: source.url, Excerpt: source.snippet }));
    if (!rows.length && result?.answer) rows.push({ ...base, Answer: result.answer });
    return rows;
  }
  async function recordRows(saved, query, result) {
    const rows = resultRows(saved, query, result);
    saved.totalRows = (saved.totalRows ?? 0) + rows.length;
    const room = Math.max(0, MAX_ROWS - (saved.rowCount ?? 0));
    const kept = rows.slice(0, room);
    if (!kept.length) return;
    saved.rowCount = (saved.rowCount ?? 0) + kept.length;
    const file = rowsFile(saved);
    if (!file) { memoryRows.set(saved.id, [...(memoryRows.get(saved.id) ?? []), ...kept]); return; }
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, kept.map(row => JSON.stringify(row)).join('\n') + '\n');
  }
  /** Result rows of one run for the chat outcome. Discarded runs return none. */
  async function rows(input = {}) {
    await init();
    const saved = typeof input.id === 'string' ? [...runs.values()].find(item => item.id === input.id) : find(input);
    if (!saved) throw new Error('Bing research run was not found.');
    const job = snapshot(saved);
    if (saved.state === 'cancelled' && saved.keepOnCancel === false) return { job, rows: [], total: 0, capped: false, discarded: true };
    let list = memoryRows.get(saved.id) ?? [];
    const file = rowsFile(saved);
    if (file) {
      try { list = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; list = []; }
    }
    return { job, rows: list.slice(0, MAX_ROWS), total: saved.totalRows ?? list.length, capped: (saved.totalRows ?? 0) > list.length, discarded: false };
  }

  function find(input = {}) {
    const token = typeof input.token === 'string' ? input.token : byPlan.get(input.planId);
    return token ? runs.get(token) : undefined;
  }

  async function prepareBatch(saved, traced) {
    if (!saved.ids.length) return saved.templates.map(query => ({ query }));
    const templateCount = saved.templates.length;
    const companyIndex = Math.floor(saved.nextQueryIndex / templateCount);
    const start = Math.floor(companyIndex / SEND_BATCH) * SEND_BATCH;
    const end = Math.min(start + SEND_BATCH, saved.ids.length);
    const prepared = await traced('prepare_bing_queries', { run_id: saved.runId, plan_id: saved.planId,
      step_id: saved.stepId, company_ids: saved.ids.slice(start, end) });
    const queries = prepared.queries;
    if (!Array.isArray(queries) || queries.length !== (end - start) * templateCount ||
        queries.some(query => typeof query.query !== 'string' || !saved.ids.slice(start, end).includes(query.company_id)))
      throw new Error('The research service returned invalid prepared queries.');
    return queries.slice(saved.nextQueryIndex - start * templateCount);
  }

  async function finishCancel(saved, traced) {
    if (!saved.keepOnCancel) {
      await traced('discard_plan_results', { run_id: saved.runId, plan_id: saved.planId,
        kind: 'research', reason: 'Analyst chose to discard observations from cancelled Bing research.' }, true);
    }
    saved.state = 'cancelled';
    saved.pauseRequested = false;
    saved.cancelRequested = false;
    saved.message = saved.keepOnCancel ? 'Research cancelled. Completed observations were kept.' : 'Research cancelled and processed observations were discarded.';
    saved.updatedAt = timestamp(now);
    await persist();
  }

  async function pumpOnce(token) {
    const saved = runs.get(token);
    if (!saved || saved.state === 'completed' || saved.state === 'cancelled' || saved.state === 'failed') return;
    if (saved.pauseRequested) {
      saved.state = 'paused'; saved.pauseRequested = false;
      saved.message = 'Paused after the current query.'; saved.updatedAt = timestamp(now);
      await persist(); return;
    }
    if (saved.cancelRequested) return finishCancel(saved, tracer([]));
    if (!connected()) {
      saved.state = 'paused'; saved.pauseRequested = false;
      saved.message = 'Bing is not connected — paused; resume when connected';
      saved.updatedAt = timestamp(now); await persist(); return;
    }
    saved.state = 'running'; saved.message = 'Research is running in the background.';
    saved.updatedAt = timestamp(now); await persist();
    const calls = [], traced = tracer(calls);
    try {
      let cachedBatchStart = -1;
      let pendingQueries = [];
      let disconnected = false;
      let fatalError;
      while (saved.nextQueryIndex < saved.queryCount) {
        if (saved.cancelRequested || saved.pauseRequested) break;
        const companyIndex = Math.floor(saved.nextQueryIndex / saved.templates.length);
        const batchStart = Math.floor(companyIndex / SEND_BATCH) * SEND_BATCH;
        if (batchStart !== cachedBatchStart) {
          pendingQueries = await prepareBatch(saved, traced);
          cachedBatchStart = batchStart;
        }
        if (saved.cancelRequested || saved.pauseRequested) break;
        const query = pendingQueries.shift();
        if (!query) throw new Error('The research service returned no query at the saved cursor.');
        if (!connected()) { disconnected = true; break; }
        saved.updatedAt = timestamp(now); await persist();
        try {
          const result = await traced('bing_search', { run_id: saved.runId, plan_id: saved.planId, step_id: saved.stepId,
            ...(query.company_id ? { company_id: query.company_id } : {}), query: query.query, max_results: 5 });
          saved.savedObservations++;
          await recordRows(saved, query, result);
        } catch (error) {
          if (!connected() || isConnectionError(error)) {
            disconnected = true;
            break;
          }
          if (/bing research plan was discarded/i.test(message(error))) {
            fatalError = error;
            break;
          }
          saved.failedQueries++;
        }
        // Save the cursor only after bing_search returns and any observation has been saved.
        // A crash can therefore re-send at most the current query after restart.
        saved.processedQueries++;
        saved.nextQueryIndex++;
        saved.updatedAt = timestamp(now);
        await persist();
        if (saved.cancelRequested || saved.pauseRequested) break;
        // Yield between queries so pause and cancellation requests are observed promptly.
        await new Promise(resolve => setImmediate(resolve));
      }
      if (saved.cancelRequested) {
        await finishCancel(saved, traced);
      } else if (disconnected) {
        saved.state = 'paused'; saved.pauseRequested = false;
        saved.message = 'Bing is not connected — paused; resume when connected';
        saved.updatedAt = timestamp(now); await persist();
      } else if (fatalError) {
        saved.state = 'failed'; saved.message = message(fatalError);
        saved.updatedAt = timestamp(now); await persist();
      } else if (saved.pauseRequested) {
        saved.state = 'paused'; saved.pauseRequested = false;
        saved.message = 'Paused after the current query.'; saved.updatedAt = timestamp(now);
        await persist();
      } else if (saved.nextQueryIndex >= saved.queryCount) {
        saved.state = 'completed'; saved.message = `${saved.processedQueries - saved.failedQueries} queries completed; ${saved.failedQueries} failed. Search observations remain unverified research leads.`;
        saved.updatedAt = timestamp(now); await persist();
      }
    } catch (error) {
      saved.state = 'failed'; saved.message = message(error); saved.updatedAt = timestamp(now);
      await persist();
    }
  }

  function pump(token) {
    if (pumps.has(token)) return pumps.get(token);
    const pending = pumpOnce(token).finally(() => pumps.delete(token));
    pumps.set(token, pending);
    return pending;
  }

  function start(input) {
    if (input?.approved !== true) return Promise.reject(new Error('Review and approve the query templates first.'));
    const token = input?.token;
    if (typeof token !== 'string') return Promise.reject(new Error('Research preview expired. Preview and approve it again.'));
    const pending = starts.get(token);
    if (pending) return pending;
    const inFlight = startApproved(input).finally(() => {
      if (starts.get(token) === inFlight) starts.delete(token);
    });
    starts.set(token, inFlight);
    return inFlight;
  }

  async function startApproved({ token, approved, sessionId }) {
    await init();
    if (approved !== true) throw new Error('Review and approve the query templates first.');
    let savedRun = runs.get(token);
    if (savedRun) {
      if (savedRun.state === 'paused') return resume({ token });
      return snapshot(savedRun);
    }
    const saved = previews.get(token);
    if (!saved || (saved.expires <= now() && !saved.started)) throw new Error('Research preview expired. Preview and approve it again.');
    if (saved.started) throw new Error('This research has already started.');
    const calls = [], traced = tracer(calls);
    const context = saved.mode === 'company' ? await shortlist(saved.runId, traced) : { ids: [], revision: null };
    if (saved.mode === 'company' && !context.ids.length) throw new Error('No considered companies are available for research.');
    if (saved.mode === 'company' && (context.ids.length !== saved.previewCount || context.revision !== saved.previewRevision))
      throw new Error(`Considered companies changed since the preview (${saved.previewCount} → ${context.ids.length}). Preview again.`);
    const queryCount = (context.ids.length || 1) * saved.templates.length;
    const plan = await traced('propose_action_plan', { run_id: saved.runId,
      rationale: 'Analyst-approved query templates for the considered companies at approval. Search leads remain unverified until checked.',
      steps: [{ step_id: saved.stepId, kind: 'bing_research', company_ids: context.ids, query_templates: saved.templates, parameters: {} }] });
    if (!plan.plan_id) throw new Error('Research proposal did not return a plan.');
    await traced('approve_action_plan', { run_id: saved.runId, plan_id: plan.plan_id,
      approved_by: 'screening-ui-analyst', approve: true }, true);
    saved.started = true;
    const record = {
      id: randomUUID(), token, runId: saved.runId, sessionId: sessionId && SAFE_ID.test(sessionId) ? sessionId : undefined,
      planId: plan.plan_id, stepId: saved.stepId, title: saved.mode === 'company' ? 'Bing company research' : 'Bing research',
      mode: saved.mode, templates: saved.templates, ids: context.ids, selectionRevision: context.revision,
      state: connected() ? 'queued' : 'paused', nextQueryIndex: 0, processedQueries: 0, queryCount,
      failedQueries: 0, savedObservations: 0, pauseRequested: false, cancelRequested: false,
      startedAt: timestamp(now), updatedAt: timestamp(now),
      message: connected() ? 'Research approved and queued.' : 'Bing is not connected — paused; resume when connected',
    };
    runs.set(token, record); byPlan.set(record.planId, token);
    await persist();
    previews.delete(token);
    if (record.state === 'queued') schedule(token);
    return snapshot(record);
  }

  async function list() {
    await init();
    return [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(snapshot);
  }

  async function pause(input) {
    await init();
    const saved = find(input);
    if (!saved) throw new Error('Background Bing research was not started.');
    if (['completed', 'cancelled', 'failed'].includes(saved.state)) return snapshot(saved);
    saved.pauseRequested = true;
    saved.updatedAt = timestamp(now);
    if (timers.has(saved.token)) { clearTimer(timers.get(saved.token)); timers.delete(saved.token); }
    if (pumps.has(saved.token)) await pumps.get(saved.token);
    else {
      saved.state = 'paused'; saved.pauseRequested = false;
      saved.message = 'Paused before the next query.'; await persist();
    }
    return snapshot(saved);
  }

  async function resume(input) {
    await init();
    const saved = find(input);
    if (!saved) throw new Error('Background Bing research was not started.');
    if (saved.nextQueryIndex >= saved.queryCount) return snapshot(saved);
    if (saved.state === 'completed' || saved.state === 'cancelled') return snapshot(saved);
    if (saved.state === 'cancelling' || saved.cancelRequested) return snapshot(saved);
    if (!connected()) {
      saved.state = 'paused'; saved.pauseRequested = false;
      saved.message = 'Bing is not connected — paused; resume when connected';
      saved.updatedAt = timestamp(now); await persist();
      return snapshot(saved);
    }
    saved.pauseRequested = false;
    saved.state = 'queued'; saved.message = 'Research queued to resume from the saved query.';
    saved.updatedAt = timestamp(now); await persist();
    schedule(saved.token);
    return snapshot(saved);
  }

  async function cancel(input) {
    await init();
    const saved = find(input);
    if (!saved) throw new Error('Background Bing research was not started.');
    if (saved.state === 'completed' || saved.state === 'cancelled') return snapshot(saved);
    if (typeof input.keep !== 'boolean') throw new Error('Choose whether to keep or discard completed observations.');
    saved.keepOnCancel = input.keep;
    saved.cancelRequested = true;
    saved.pauseRequested = false;
    saved.state = 'cancelling'; saved.message = 'Cancellation will finish after the current query.';
    saved.updatedAt = timestamp(now);
    if (timers.has(saved.token)) { clearTimer(timers.get(saved.token)); timers.delete(saved.token); }
    await persist();
    if (pumps.has(saved.token)) await pumps.get(saved.token);
    else await finishCancel(saved, tracer([]));
    return snapshot(saved);
  }

  // One-release compatibility aliases. The old run endpoint now starts the server runner
  // and returns immediately; query batches are no longer driven by repeated browser calls.
  async function run({ token, approved, sessionId }) {
    const job = await start({ token, approved, sessionId });
    return { ...job, rows: [], more: false, executed: false,
      calls: [], traceCount: 0, traceTruncated: false };
  }

  function close() {
    for (const timer of timers.values()) clearTimer(timer);
    timers.clear();
  }

  return { init, preview, start, list, rows, pause, resume, cancel, run, close };
}
