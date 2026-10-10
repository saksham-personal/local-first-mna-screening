// Dev-only adapter contract: POST /v1/chat {prompt, conversation_id, model}
// -> {response_text, usage}. No provider calls and no dependencies.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

function chooseInstruction(message, model) {
  const lower = message.toLowerCase();
  if (/\biscc\b/.test(lower)) return { action: 'search_iscc', title: 'Find core-business matches in ISCC', fields: { query: message, limit: 100 } };
  if (/\bsemantic\b/.test(lower)) return { action: 'score_mid_semantic', title: 'Score current MID candidates', fields: {} };
  if (/\bscreen\b|screening/.test(lower)) return { action: 'propose_prepared_plan', title: 'Propose screening for analyst review', fields: { mode: 'screening', provider: 'llm_suite', deployment: model, prompt: 'Assess core-business fit using supplied company descriptions. Return unknown as CHECK.', input_columns: 'pk; Description', output_columns: 'Fit Score; Rationale', score_columns: 'Fit Score' } };
  if (/\bbing\b/.test(lower)) return { action: 'get_shortlist_context', title: 'Read research scope', fields: { limit: 20 }, notes: 'Bing query preparation needs an existing analyst-approved action plan and its step id. This stub does not invent those ids.' };
  if (/\bsummary\b/.test(lower)) return { action: 'get_discovery_summary', title: 'Read discovery counts', fields: {} };
  if (/\bstatus\b/.test(lower)) return { action: 'get_mid_index_status', title: 'Read active MID index status', fields: {} };
  if (/\bsearch\b|\bfind\b/.test(lower)) {
    const text = message.replace(/^(?:please\s+)?(?:search|find)(?:\s+(?:mid|for))?\s*/i, '').replace(/[\r\n;]+/g, ' ').trim().slice(0, 200) || 'claims software';
    return { action: 'search_mid', title: 'Find core-business matches in MID', fields: { rationale: 'Use the analyst core-business request for broad discovery.', keywords: text } };
  }
  return { action: 'get_shortlist_context', title: 'Read current screening state', fields: { limit: 20 } };
}

function markdown(instruction, { variant = false, typo = false, feedback = false } = {}) {
  const heading = name => variant ? `**${name}**` : `## ${name}`;
  return `${heading('Context')}\n${feedback ? 'Correcting the rejected instruction only.' : 'Local deterministic stub responding to the analyst request.'}\n${heading('Reasoning')}\nRead or propose through the allowed actions; analyst approval remains required.\n${heading('Instruction set')}\n1. **${typo ? 'unavailable_stub_action' : instruction.action}** — ${instruction.title}\n${Object.entries(instruction.fields).map(([key, value]) => `   - ${key}${variant ? ' = ' : ': '}${value}`).join('\n')}\n${heading('Notes for the analyst')}\nSIMULATED: local LLM Suite stub. ${instruction.notes || 'No model results or approvals are fabricated.'}`;
}

// Read only the structured loop state/observation lines, never company prose.
function loopReply(prompt, turn, loopTurns) {
  const reserve = prompt.includes('TURN BUDGET:');
  const queryLines = [...prompt.matchAll(/^(Q\d+) · (MID_KEYWORD|MID_SEMANTIC|ISCC) ·.*$/gm)];
  const queries = [...new Map(queryLines.map(m => [m[1], { id: m[1], source: m[2] }])).values()];
  const keep = queries.slice(0, 49).map(q => {
    const header = prompt.indexOf(`${q.id} · ${q.source}`, prompt.indexOf('Observations from'));
    const histogram = header >= 0 ? prompt.slice(header).match(/^Histogram: (.+)$/m)?.[1] : undefined;
    const bins = histogram ? [...histogram.matchAll(/([\d.]+)–([\d.]+):(\d+)/g)] : [];
    const total = bins.reduce((n, b) => n + Number(b[3]), 0);
    let threshold = q.source === 'MID_SEMANTIC' ? 5 : 0.5, count = 0;
    for (const bin of bins) { count += Number(bin[3]); if (count >= total / 2 && total) { threshold = Number(bin[1]); break; } }
    return { action: 'keep_query_results', title: `Keep the upper score band of ${q.id}`, fields: { query_id: q.id, min_score: threshold, note: 'SIMULATED: choose the upper half of the observed distribution.' } };
  });
  let actions;
  if (reserve) actions = [...keep, { action: 'finish_loop', title: 'Consolidate within the turn reserve', fields: { summary: 'SIMULATED: consolidate the observed upper score bands before the cap.' } }];
  else if (turn === 1 || (loopTurns > 0 && turn < loopTurns)) actions = [
    { action: 'search_mid', title: 'Find claims software', fields: { rationale: 'Broad core-business product vocabulary', keywords: 'claims; software' } },
    { action: 'search_mid', title: 'Find policy software', fields: { rationale: 'Alternate insurance workflow vocabulary', keywords: 'policy administration; insurance' } },
    { action: 'search_mid_semantic', title: 'Find semantic neighbors', fields: { rationale: 'Owned software for insurance claims and policy workflows', min_score: 0 } },
  ];
  else if (turn === 2) actions = keep;
  else if (turn === 3 && queries.length) actions = [{ action: 'inspect_band', title: 'Inspect the threshold boundary', fields: { query_id: queries[0].id, min_score: 0.4, max_score: 0.7, limit: 15 } }];
  else actions = [{ action: 'finish_loop', title: 'Consolidate the stable shortlist', fields: { summary: 'SIMULATED: stable shortlist from query-specific thresholds.' } }];
  return `## Context\nSIMULATED: local deterministic discovery loop.\n## Reasoning\nUse the observed query distributions and preserve separate score scales.\n## Instruction set\n${actions.length ? actions.map((a, i) => `${i + 1}. **${a.action}** — ${a.title}\n${Object.entries(a.fields).map(([k, v]) => `   - ${k}: ${v}`).join('\n')}`).join('\n') : 'None.'}\n## Notes for the analyst\nSIMULATED: no corporate provider was called.`;
}

export function createStub({ deviations = process.env.STUB_DEVIATIONS === '1', loopTurns = Number(process.env.STUB_LOOP_TURNS || 0) } = {}) {
  const transcripts = new Map();
  const instructions = new Map();
  const reply = ({ conversation_id: id, prompt, model }) => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(id) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 120_000 || typeof model !== 'string' || !model.trim() || model.length > 160) throw new Error('Use bounded prompt, conversation_id and model fields.');
    const transcript = transcripts.get(id) ?? [];
    const handoff = prompt.startsWith('Summarize this screening state for a new conversation.');
    const feedback = prompt.startsWith('Correct only the rejected instructions below.');
    let text;
    if (handoff) {
      const state = prompt.split('Run state:\n')[1]?.split('\n\nRecent decisions:')[0] ?? 'No state supplied.';
      text = `## Approved state\n${state.slice(0, 1200)}\n## Results and open work\nContinue from the saved run; no new results generated.\n## Recent decisions\nUse the persisted analyst decisions.\nSIMULATED: local stub handoff.`;
    } else if (prompt.startsWith('You are running a discovery loop') || /^Turn \d+ of \d+/.test(prompt)) {
      const turn = Number(prompt.match(/Turn (\d+) of/)?.[1] || 1);
      text = loopReply(prompt, turn, loopTurns);
    } else if (feedback && transcript.some(item => item.prompt.startsWith('You are running a discovery loop'))) {
      text = '## Context\nSIMULATED: loop repair.\n## Reasoning\nLeave rejected actions out.\n## Instruction set\nNone.';
    } else {
      const message = prompt.split('Analyst message:\n').at(-1).trim();
      let instruction = feedback ? instructions.get(id) : chooseInstruction(message, model);
      instruction ??= chooseInstruction('status', model);
      // Honor an explicitly narrowed action guide; feedback never repeats accepted work.
      const guide = prompt.split(feedback ? 'Allowed actions:\n' : 'Allowed actions and fields:\n')[1];
      if (guide && !guide.includes(`${instruction.action}:`)) {
        const action = ['get_mid_index_status', 'get_discovery_summary', 'get_shortlist_context'].find(action => guide.includes(`${action}:`));
        instruction = action ? { action, title: 'Read permitted state', fields: {} } : null;
      }
      if (instruction) {
        instructions.set(id, instruction);
        const nth = transcript.length + 1;
        text = markdown(instruction, { feedback, variant: deviations && !feedback && nth % 2 === 0, typo: deviations && !feedback && nth % 3 === 0 });
      } else text = '## Context\nNo permitted action for this request.\n## Reasoning\nAnalyst input is needed.\n## Instruction set\nNone.\n## Notes for the analyst\nSIMULATED: local stub.';
    }
    transcript.push({ prompt, model, response_text: text });
    transcripts.set(id, transcript);
    return { response_text: text, usage: { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: Math.ceil(text.length / 4) }, simulated: true };
  };
  const server = createServer(async (req, res) => {
    const respond = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (req.method === 'GET' && req.url === '/health') return respond(200, { stub: true });
    if (req.method !== 'POST' || req.url !== '/v1/chat') return respond(404, { error: 'Endpoint not found.' });
    if (req.headers.authorization !== 'Bearer stub') return respond(401, { error: 'Use the stub token.' });
    try {
      let length = 0; const chunks = [];
      for await (const chunk of req) { length += chunk.length; if (length > 600_000) throw new Error('Request exceeds stub limit.'); chunks.push(chunk); }
      return respond(200, reply(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    } catch (error) { return respond(400, { error: error.message }); }
  });
  return { server, transcripts, reply };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.SCREENING_LLMSUITE_STUB_PORT || 8875);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid LLM Suite stub port.');
  const { server } = createStub();
  server.listen(port, '127.0.0.1', () => process.send?.({ ready: true }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
