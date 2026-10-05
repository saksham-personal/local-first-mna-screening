import { createHash, randomUUID } from 'node:crypto';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PAGE_SIZE = 500;
const SEND_BATCH = 100;
const SAMPLE = 20;
const TTL = 15 * 60_000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pick = (...values) => values.find(value => typeof value === 'string' && value.trim())?.trim() ?? '';
const traceMeta = calls => ({ traceCount: calls.totalCount ?? calls.length, traceTruncated: (calls.totalCount ?? calls.length) > calls.length });

function companyIdentity(raw) {
  const company = raw?.company ?? raw;
  const enrichment = company?.enrichment ?? {};
  return {
    name: pick(company?.PB_Name, enrichment.PB_Name, company?.MID_Name, company?.mid_name, company?.name, company?.ISCC_Name, company?.iscc_name),
    website: pick(company?.PB_Website, enrichment.PB_Website, company?.MID_Website, company?.mid_website, company?.website, company?.ISCC_Website, company?.iscc_website),
  };
}

function expand(templates, companies) {
  if (!companies.length) return templates.map(query => ({ query }));
  return companies.flatMap(({ id, name, website }) => templates.map(template => ({ company_id: id,
    query: template.replace(/<company>|\{company\}|\{website\}/gi, token => token.toLowerCase() === '{company}' ? name : token.toLowerCase() === '{website}' ? website : `${name}; ${website}`) })));
}

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

  async function shortlist(runId, traced) {
    let cursor, count, revision, criteriaRevision, sourceHash;
    const companies = [], ids = new Set();
    do {
      const page = await traced('get_shortlist_context', { run_id: runId, include_hidden: false, limit: PAGE_SIZE, ...(cursor ? { after_company_id: cursor } : {}) });
      if (!Array.isArray(page.candidates) || !Number.isSafeInteger(page.considered_count) || page.considered_count < 0 || !(typeof page.selection_revision === 'string' || Number.isSafeInteger(page.selection_revision)) || typeof page.source_hash !== 'string')
        throw new Error('The considered-company reader returned an invalid page.');
      const pageCriteria = JSON.stringify(page.criteria_revision ?? null);
      if ((count !== undefined && count !== page.considered_count) || (revision !== undefined && revision !== page.selection_revision) || (criteriaRevision !== undefined && criteriaRevision !== pageCriteria) || (sourceHash !== undefined && sourceHash !== page.source_hash))
        throw new Error('Considered companies changed during preparation. Preview again.');
      count = page.considered_count; revision = page.selection_revision; criteriaRevision = pageCriteria; sourceHash = page.source_hash;
      for (const candidate of page.candidates) {
        const id = candidate?.company_id ?? candidate?.pk;
        if (typeof id !== 'string' || !SAFE_ID.test(id) || ids.has(id)) throw new Error('The considered-company reader returned a duplicate or invalid ID.');
        ids.add(id);
        let details = candidate;
        if (!companyIdentity(candidate).name) details = await traced('get_company', { company_id: id });
        const selected = companyIdentity(details);
        if (!selected.name) throw new Error(`Company ${id} has no usable identity for Bing research.`);
        // Bing evidence from an earlier send page changes BING coverage; it
        // must not stale the remaining queries in this same approved plan.
        const sourceFingerprint = hash({ id, name: selected.name, website: selected.website,
          PBId: candidate.PBId, status: candidate.status, considered: candidate.considered,
          PB: candidate.coverage?.PB, ROGO: candidate.coverage?.ROGO });
        companies.push({ id, ...selected, sourceFingerprint });
      }
      const next = page.next_after_company_id || undefined;
      if (page.has_more && (!next || next === cursor || !page.candidates.length)) throw new Error('Considered-company pagination did not advance.');
      cursor = page.has_more ? next : undefined;
    } while (cursor);
    if (companies.length !== count) throw new Error('The considered-company reader did not return every company. Preview again.');
    return { companies, fingerprint: hash({ revision, criteriaRevision, sourceHash, companies }) };
  }

  async function preview(input) {
    const calls = [], traced = tracer(calls), templates = templatesFrom(input.queries);
    const mode = input.mode ?? (Array.isArray(input.companyIds) && input.companyIds.length ? 'company' : 'general');
    if (!['company', 'general'].includes(mode)) throw new Error('Choose company or general research.');
    let runId = input.runId;
    if (mode === 'company' && (typeof runId !== 'string' || !SAFE_ID.test(runId))) throw new Error('Choose a screening run for company research.');
    if (!runId) runId = (await traced('create_run', { objective: 'Bing research', original_criteria: { queries: templates } }, true)).run_id;
    if (typeof runId !== 'string' || !SAFE_ID.test(runId)) throw new Error('Use a valid screening run.');
    const context = mode === 'company' ? await shortlist(runId, traced) : { companies: [], fingerprint: '' };
    if (mode === 'company' && !context.companies.length) throw new Error('No considered companies are available for research.');
    const queries = expand(templates, context.companies), ids = context.companies.map(company => company.id), stepId = 'bing-grounding';
    const plan = await traced('propose_action_plan', { run_id: runId, rationale: 'Analyst-reviewed grounding queries. Search leads remain unverified until checked.', steps: [{ step_id: stepId, kind: 'bing_research', company_ids: ids, query_templates: templates, parameters: {} }] });
    if (!plan.plan_id) throw new Error('Research proposal did not return a plan.');
    for (const [token, saved] of previews) if (!saved.running && saved.expires <= now()) previews.delete(token);
    while (previews.size >= 8) previews.delete(previews.keys().next().value);
    const token = randomUUID(), queryFingerprint = hash(queries);
    previews.set(token, { runId, planId: plan.plan_id, stepId, mode, ids, queries, contextFingerprint: context.fingerprint, queryFingerprint,
      expires: now() + TTL, approved: false, nextIndex: 0, failed: 0, result: null });
    return { token, queries: queries.slice(0, SAMPLE), queryCount: queries.length, companyCount: ids.length, previewTruncated: queries.length > SAMPLE,
      queryFingerprint, executed: false, calls, ...traceMeta(calls) };
  }

  async function run({ token, approved }) {
    const saved = previews.get(token);
    if (approved !== true) throw new Error('Review and approve the exact queries first.');
    if (!saved || (!saved.approved && saved.expires <= now())) throw new Error('Research preview expired. Preview and approve it again.');
    if (saved.result) return saved.result;
    if (saved.running) throw new Error('This research is already running.');
    saved.running = true;
    const calls = [], traced = tracer(calls), freshnessCalls = [];
    try {
      if (saved.mode === 'company' && (await shortlist(saved.runId, tracer(freshnessCalls))).fingerprint !== saved.contextFingerprint)
        throw new Error('Considered companies or their source identities changed. Preview the queries and approve again.');
      if (hash(saved.queries) !== saved.queryFingerprint) throw new Error('Approved queries changed. Preview again.');
      if (!saved.approved) {
        await traced('approve_action_plan', { run_id: saved.runId, plan_id: saved.planId, approved_by: 'screening-ui-analyst', approve: true }, true);
        saved.approved = true;
      }
      if (!connected()) {
        saved.result = { executed: false, planId: saved.planId, message: 'Research approved and saved. Bing is not connected; no queries were sent.', rows: [], calls, queryCount: saved.queries.length, freshnessPagesChecked: freshnessCalls.totalCount ?? 0, ...traceMeta(calls) };
        return saved.result;
      }
      if (!saved.prepared) {
        const expanded = [];
        for (let offset = 0; offset < saved.ids.length; offset += SEND_BATCH) {
          const result = await traced('prepare_bing_queries', { run_id: saved.runId, plan_id: saved.planId, step_id: saved.stepId, company_ids: saved.ids.slice(offset, offset + SEND_BATCH) });
          if (!Array.isArray(result.queries)) throw new Error('The research service returned invalid prepared queries.');
          expanded.push(...result.queries.map(q => ({ company_id: q.company_id, query: q.query })));
        }
        if (!saved.ids.length) expanded.push(...saved.queries);
        if (hash(expanded) !== saved.queryFingerprint) throw new Error('Queries changed after approval. Prepare a new research plan.');
        saved.prepared = true;
      }
      const rows = [], end = Math.min(saved.nextIndex + SEND_BATCH, saved.queries.length);
      let failed = 0, sent = 0;
      for (let index = saved.nextIndex; index < end; index++) {
        const query = saved.queries[index];
        try {
          const result = await traced('bing_search', { run_id: saved.runId, plan_id: saved.planId, step_id: saved.stepId, ...query, max_results: 5 });
          sent++;
          for (const source of result.results ?? []) rows.push({ pk: query.company_id ?? '', Query: query.query, Title: source.title, URL: source.url, Excerpt: source.snippet, Verification: 'Unverified research lead', evidence_id: result.evidence_id ?? '' });
          if (!(result.results ?? []).length && result.answer) rows.push({ pk: query.company_id ?? '', Query: query.query, Answer: result.answer, Verification: 'Unverified research lead', evidence_id: result.evidence_id ?? '' });
        } catch { failed++; }
      }
      saved.nextIndex = end; saved.failed += failed;
      const more = end < saved.queries.length;
      const result = { executed: sent > 0, planId: saved.planId, rows, calls, ...traceMeta(calls), freshnessPagesChecked: freshnessCalls.totalCount ?? 0, more, processedQueries: end,
        queryCount: saved.queries.length, failedQueries: saved.failed,
        message: more ? `${end} of ${saved.queries.length} approved queries processed. Continue this research to process the rest.` : `${end - saved.failed} queries completed; ${saved.failed} failed. Company research is saved with source links as unverified observations.` };
      if (!more) saved.result = result;
      return result;
    } finally { saved.running = false; saved.expires = now() + TTL; }
  }
  return { preview, run };
}
