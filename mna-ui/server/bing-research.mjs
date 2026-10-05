import { randomUUID } from 'node:crypto';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
export function createBingResearch({ call, connected = () => false, now = () => Date.now() }) {
  const previews = new Map();
  function tracer(calls) {
    return async (tool, args, approved = false) => {
      const startedAt = new Date(now()).toISOString();
      try {
        const result = await call(tool, args, approved);
        calls.push({ tool, args, result: tool === 'get_company' ? { company_id: result.company_id, name: result.name } : result, startedAt, finishedAt: new Date(now()).toISOString(), status: 'success' });
        return result;
      } catch (error) {
        calls.push({ tool, args, error: String(error.message ?? error), startedAt, finishedAt: new Date(now()).toISOString(), status: 'error' });
        error.calls = calls;
        throw error;
      }
    };
  }
  async function expand(templates, companyIds, traced) {
    if (!companyIds.length) return templates.map(query => ({ query }));
    const result = [];
    for (const id of companyIds) {
      const company = await traced('get_company', { company_id: id });
      const pb = company.enrichment ?? company;
      const name = String(pb.PB_Name || company.name || '');
      const website = String(pb.PB_Website || company.website || '');
      for (const template of templates) result.push({ company_id: id, query: template.replaceAll('<company>', `${name}; ${website}`).replaceAll('{company}', name).replaceAll('{website}', website) });
    }
    return result;
  }
  async function preview(input) {
    const calls = [], traced = tracer(calls);
    const ids = input.companyIds;
    if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || !SAFE_ID.test(id)) || new Set(ids).size !== ids.length) throw new Error('Select up to 100 distinct companies.');
    if (!Array.isArray(input.queries) || input.queries.length < (ids.length ? 3 : 1) || input.queries.length > 5 || input.queries.some(q => typeof q !== 'string' || !q.trim() || q.length > 2000)) throw new Error('Use three to five company questions, or one to five general queries.');
    const templates = input.queries.map(query => query.trim());
    let runId = input.runId;
    if (!runId) {
      if (ids.length) throw new Error('Find companies before company research.');
      const run = await traced('create_run', { objective: 'Bing research', original_criteria: { queries: templates } }, true);
      runId = run.run_id;
    }
    if (typeof runId !== 'string' || !SAFE_ID.test(runId)) throw new Error('Use a valid screening.');
    const queries = await expand(templates, ids, traced);
    const stepId = 'bing-grounding';
    const plan = await traced('propose_action_plan', { run_id: runId, rationale: 'Analyst-reviewed grounding queries. Search leads remain unverified until checked.', steps: [{ step_id: stepId, kind: 'bing_research', company_ids: ids, query_templates: templates, parameters: {} }] });
    if (!plan.plan_id) throw new Error('Research proposal did not return a plan.');
    for (const [token, value] of previews) if (value.expires <= now()) previews.delete(token);
    while (previews.size >= 8) previews.delete(previews.keys().next().value);
    const token = randomUUID();
    previews.set(token, { runId, planId: plan.plan_id, stepId, ids, templates, queries, expires: now() + 15 * 60_000, result: null });
    return { token, queries, executed: false, calls };
  }
  async function run({ token, approved }) {
    const saved = previews.get(token);
    if (approved !== true) throw new Error('Review and approve the exact queries first.');
    if (!saved || saved.expires <= now()) throw new Error('Research preview expired. Preview and approve it again.');
    if (saved.result) return saved.result;
    if (saved.running) throw new Error('This research is already running.');
    saved.running = true;
    const calls = [], traced = tracer(calls);
    try {
      const current = await expand(saved.templates, saved.ids, traced);
      if (JSON.stringify(current) !== JSON.stringify(saved.queries)) throw new Error('Company sources changed. Preview the queries and approve again.');
      await traced('approve_action_plan', { run_id: saved.runId, plan_id: saved.planId, approved_by: 'screening-ui-analyst', approve: true }, true);
      if (!connected()) {
        const result = { executed: false, planId: saved.planId, message: 'Research approved and saved. Bing is not connected; no queries were sent.', rows: [], calls };
        // Approval is durable; returning this state never claims provider execution.
        saved.result = result;
        return result;
      }
      const expanded = saved.ids.length ? (await traced('prepare_bing_queries', { run_id: saved.runId, plan_id: saved.planId, step_id: saved.stepId, company_ids: saved.ids })).queries.map(q => ({ company_id: q.company_id, query: q.query })) : saved.queries;
      if (JSON.stringify(expanded) !== JSON.stringify(saved.queries)) throw new Error('Queries changed after approval. Prepare a new research plan.');
      const rows = [];
      let failed = 0;
      for (const query of expanded) {
        try {
          const result = await traced('bing_search', { run_id: saved.runId, plan_id: saved.planId, step_id: saved.stepId, ...query, max_results: 5 });
          for (const source of result.results ?? []) rows.push({ pk: query.company_id ?? '', Query: query.query, Title: source.title, URL: source.url, Excerpt: source.snippet, Verification: 'Unverified research lead', evidence_id: result.evidence_id ?? '' });
          if (!(result.results ?? []).length && result.answer) rows.push({ pk: query.company_id ?? '', Query: query.query, Answer: result.answer, Verification: 'Unverified research lead', evidence_id: result.evidence_id ?? '' });
        } catch { failed++; }
      }
      const result = { executed: calls.some(c => c.tool === 'bing_search'), planId: saved.planId, rows, calls, message: `${expanded.length - failed} queries completed; ${failed} failed. Company research is saved with source links as unverified observations.` };
      saved.result = result;
      return result;
    } finally { saved.running = false; }
  }
  return { preview, run };
}
