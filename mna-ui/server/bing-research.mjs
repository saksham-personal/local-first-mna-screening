import { randomUUID } from 'node:crypto';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PAGE_SIZE = 500;
const SEND_BATCH = 25;
const TTL = 15 * 60_000;
const traceMeta = calls => ({ traceCount: calls.totalCount ?? calls.length, traceTruncated: (calls.totalCount ?? calls.length) > calls.length });

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

export function createBingResearch({ call, connected = () => false, now = () => Date.now() }) {
  const previews = new Map();
  function tracer(calls) {
    return async (tool, args, approved = false) => {
      calls.totalCount = (calls.totalCount ?? 0) + 1;
      const startedAt = new Date(now()).toISOString();
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
          startedAt, finishedAt: new Date(now()).toISOString(), status: 'success' });
        return result;
      } catch (error) {
        if (calls.length < 256) calls.push({ tool, args: tool === 'propose_action_plan' ? { run_id: args.run_id, company_count: args.steps?.[0]?.company_ids?.length } : args, error: String(error.message ?? error), startedAt, finishedAt: new Date(now()).toISOString(), status: 'error' });
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

  async function preview(input) {
    const calls = [], traced = tracer(calls), templates = templatesFrom(input.queries);
    const mode = input.mode ?? (Array.isArray(input.companyIds) && input.companyIds.length ? 'company' : 'general');
    if (!['company', 'general'].includes(mode)) throw new Error('Choose company or general research.');
    let runId = input.runId;
    if (mode === 'company' && (typeof runId !== 'string' || !SAFE_ID.test(runId))) throw new Error('Choose a screening run for company research.');
    if (!runId) runId = (await traced('create_run', { objective: 'Bing research', original_criteria: { queries: templates } }, true)).run_id;
    if (typeof runId !== 'string' || !SAFE_ID.test(runId)) throw new Error('Use a valid screening run.');
    const companyCount = mode === 'company' ? (await selection(runId, traced)).considered_count : 0;
    if (mode === 'company' && !companyCount) throw new Error('No considered companies are available for research.');
    for (const [token, saved] of previews) if (!saved.running && saved.expires <= now()) previews.delete(token);
    if (previews.size >= 8) throw new Error('Close or finish an existing research plan before preparing another.');
    const token = randomUUID();
    previews.set(token, { runId, stepId: 'bing-grounding', mode, templates, expires: now() + TTL,
      approved: false, nextIndex: 0, processedQueries: 0, failed: 0, result: null });
    return { token, queries: templates.map(query => ({ query })), queryCount: (companyCount || 1) * templates.length,
      companyCount, executed: false, calls, ...traceMeta(calls) };
  }

  function cancel({ token }) {
    const saved = previews.get(token);
    if (!saved) throw new Error('Research plan is unavailable.');
    saved.cancelled = true;
    return { cancelled: true, message: 'Research stops after the current batch.' };
  }

  async function run({ token, approved }) {
    const saved = previews.get(token);
    if (approved !== true) throw new Error('Review and approve the query templates first.');
    if (!saved || (!saved.approved && saved.expires <= now())) throw new Error('Research preview expired. Preview and approve it again.');
    if (saved.result) return saved.result;
    if (saved.running) throw new Error('This research is already running.');
    saved.running = true;
    const calls = [], traced = tracer(calls);
    try {
      if (saved.cancelled) return { executed: false, cancelled: true, more: false, planId: saved.planId, rows: [], calls,
        queryCount: saved.queryCount ?? 0, processedQueries: saved.processedQueries, message: 'Research stopped. Completed observations remain saved.' };
      if (!saved.approved) {
        const context = saved.mode === 'company' ? await shortlist(saved.runId, traced) : { ids: [], revision: null };
        if (saved.mode === 'company' && !context.ids.length) throw new Error('No considered companies are available for research.');
        saved.ids = context.ids; saved.selectionRevision = context.revision;
        saved.queryCount = (saved.ids.length || 1) * saved.templates.length;
        const plan = await traced('propose_action_plan', { run_id: saved.runId,
          rationale: 'Analyst-approved query templates for the considered companies at approval. Search leads remain unverified until checked.',
          steps: [{ step_id: saved.stepId, kind: 'bing_research', company_ids: saved.ids, query_templates: saved.templates, parameters: {} }] });
        if (!plan.plan_id) throw new Error('Research proposal did not return a plan.');
        saved.planId = plan.plan_id;
      }
      if (saved.mode === 'company' && (await selection(saved.runId, traced)).selection_revision !== saved.selectionRevision)
        throw new Error('Considered companies changed. Preview and approve again.');
      if (!saved.approved) {
        await traced('approve_action_plan', { run_id: saved.runId, plan_id: saved.planId, approved_by: 'screening-ui-analyst', approve: true }, true);
        saved.approved = true;
      }
      if (!connected()) {
        saved.result = { executed: false, planId: saved.planId, message: 'Research approved and saved. Bing is not connected; no queries were sent.',
          rows: [], calls, queryCount: saved.queryCount, companyCount: saved.ids.length, ...traceMeta(calls) };
        return saved.result;
      }
      const end = Math.min(saved.nextIndex + SEND_BATCH, saved.ids.length);
      const batch = saved.ids.length ? (await traced('prepare_bing_queries', { run_id: saved.runId, plan_id: saved.planId,
        step_id: saved.stepId, company_ids: saved.ids.slice(saved.nextIndex, end) })).queries : saved.templates.map(query => ({ query }));
      if (!Array.isArray(batch) || batch.length !== (saved.ids.length ? end - saved.nextIndex : 1) * saved.templates.length ||
          batch.some(q => typeof q.query !== 'string' || (saved.ids.length && !saved.ids.slice(saved.nextIndex, end).includes(q.company_id))))
        throw new Error('The research service returned invalid prepared queries.');
      const rows = [];
      let failed = 0, sent = 0;
      for (const query of batch) {
        try {
          const result = await traced('bing_search', { run_id: saved.runId, plan_id: saved.planId, step_id: saved.stepId,
            ...(query.company_id ? { company_id: query.company_id } : {}), query: query.query, max_results: 5 });
          sent++;
          for (const source of result.results ?? []) rows.push({ pk: query.company_id ?? '', Query: query.query, Title: source.title, URL: source.url,
            Excerpt: source.snippet, Verification: result.simulated ? 'SIMULATED ? Unverified research lead' : 'Unverified research lead', evidence_id: result.evidence_id ?? '' });
          if (!(result.results ?? []).length && result.answer) rows.push({ pk: query.company_id ?? '', Query: query.query, Answer: result.answer,
            Verification: result.simulated ? 'SIMULATED ? Unverified research lead' : 'Unverified research lead', evidence_id: result.evidence_id ?? '' });
        } catch { failed++; }
      }
      saved.nextIndex = end; saved.processedQueries += batch.length; saved.failed += failed;
      const more = !saved.cancelled && end < saved.ids.length;
      const result = { executed: sent > 0, planId: saved.planId, rows, calls, ...traceMeta(calls), more, cancelled: saved.cancelled === true,
        processedQueries: saved.processedQueries, queryCount: saved.queryCount, companyCount: saved.ids.length, failedQueries: saved.failed,
        message: saved.cancelled ? 'Research stopped after the current batch. Completed observations remain saved.' : more
          ? `${saved.processedQueries} of ${saved.queryCount} queries processed.`
          : `${saved.processedQueries - saved.failed} queries completed; ${saved.failed} failed. Company research is saved with source links as unverified observations.` };
      if (!more) saved.result = result;
      return result;
    } finally { saved.running = false; saved.expires = now() + TTL; }
  }
  return { preview, run, cancel };
}
