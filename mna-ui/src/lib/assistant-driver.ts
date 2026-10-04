import type { AssistantContext, WorkspaceAction } from "./assistant-contract";
import { planActions, recommendNext, uniqueCount } from "./policy";

export type LocalToolOutcome = {
  result: Record<string, unknown>;
  response: string;
  action?: WorkspaceAction;
};
export type LocalTurn = {
  toolName: string;
  args: Record<string, string | number | boolean | string[]>;
  execute(context: AssistantContext): LocalToolOutcome;
};
const approvalRequired = (): LocalToolOutcome => ({
  result: { blocked: true, reason: "Analyst approval required" },
  response: "Review and approve the criteria in Set criteria first.",
  action: { type: "navigate", stage: "criteria" },
});

/** Local workspace helpers. These do not pretend to be Rust search calls. */
export function prepareAssistantTurn(
  text: string,
  initial: AssistantContext,
): LocalTurn {
  const input = text.trim();
  const args = {
    session_id: initial.sessionId,
    mode: "workspace",
    request: input,
  };
  if (
    /^\/export\b|session\s*(log|history)|export.*(log|transcript)/i.test(input)
  )
    return {
      toolName: "open_session_log",
      args,
      execute: () => ({
        result: { formats: ["JSONL", "Markdown", "ZIP"] },
        response:
          "The session log is open. You can export the full history as JSONL, Markdown, or a ZIP.",
        action: { type: "session-log" },
      }),
    };
  if (/\bexport\b|\bdownload\b/i.test(input))
    return {
      toolName: "prepare_company_export",
      args,
      execute: (context) => {
        if (!context.criteriaApproved) return approvalRequired();
        return {
          result: {
            formats: ["PitchBook", "LLM", "Full"],
            row_count: context.companies?.length ?? 0,
          },
          response:
            "Choose PitchBook, LLM, or Full Export. The workbook uses the companies in your current list.",
          action: { type: "export" },
        };
      },
    };
  if (
    /run.*example|start.*example|\b(more|broaden|widen|expand)\b|additional targets/i.test(
      input,
    )
  )
    return {
      toolName: "check_search_readiness",
      args,
      execute: (context) => {
        if (!context.criteriaApproved) return approvalRequired();
        return {
          result: { ready: true, requires_local_run: true },
          response:
            "Use Run the screening example to search the local MID dataset and see every Rust tool call. A connected ISCC source can be added later.",
        };
      },
    };
  const actions = planActions(input);
  if (actions.length || /plan enrichment|next step|research plan/i.test(input))
    return {
      toolName: "recommend_next_steps",
      args: { ...args, requested_actions: actions },
      execute: (context) => {
        if (!context.criteriaApproved) return approvalRequired();
        const chosen = actions.length
          ? actions
          : uniqueCount(context.counts) >= 2000
            ? ["llm" as const]
            : ["pitchbook" as const, "rogo" as const];
        return {
          result: {
            ordered_actions: chosen,
            external_execution: false,
            bing_requires_approval: chosen.includes("bing"),
            copilot_requires_company_linkedin: chosen.includes("copilot"),
          },
          response: `I suggest ${chosen.map((action) => ({ pitchbook: "PitchBook", rogo: "ROGO", bing: "Bing research", llm: "LLM screening", copilot: "Copilot screening" })[action]).join(" → ")}. Choose Proceed to add these steps to your plan, or Not now to skip them. You can upload PitchBook and ROGO files in Add data. Bing and model screening services are not connected in this example.`,
        };
      },
    };
  const company = initial.companies?.find(
    (item) =>
      input.toLowerCase().includes(item.name.toLowerCase()) ||
      input.toLowerCase().includes(item.pk.toLowerCase()),
  );
  if (company)
    return {
      toolName: "read_company_in_workspace",
      args: { ...args, company_id: company.pk },
      execute: () => ({
        result: {
          company_id: company.pk,
          company_name: company.name,
          description: company.description,
          source: company.source,
          mid_score: company.midScore,
          iscc_score: company.isccScore,
        },
        response: `${company.name}: ${company.description}\n\nMID and ISCC scores are separate search results. Review the source description and collect evidence before deciding whether this company fits.`,
      }),
    };
  if (/shortlist|funnel|candidate|source|discovery|total|count/i.test(input))
    return {
      toolName: "read_workspace_summary",
      args,
      execute: (context) => {
        if (!context.criteriaApproved) return approvalRequired();
        const total = uniqueCount(context.counts);
        return {
          result: {
            ...context.counts,
            unique: total,
            recommendation: recommendNext(total),
            source: context.backendRunId ? "saved run" : "fictional sample",
          },
          response: total
            ? `There are ${total} unique companies: ${context.counts.midOnly} from MID only, ${context.counts.isccOnly} from ISCC only, and ${context.counts.both} from both. ${recommendNext(total)} is the suggested next step. Search uses the core business only.`
            : "No companies have been found yet. Run the screening example to start.",
          action: { type: "navigate", stage: "discovery" },
        };
      },
    };
  if (/criteria|definition|profile|approve|investment/i.test(input))
    return {
      toolName: "read_screening_criteria",
      args,
      execute: (context) => ({
        result: {
          business_definition: context.definition,
          original_criteria: context.mandate,
          approved: context.criteriaApproved,
          unused_search_dimensions: [
            "financial / size",
            "geography",
            "ownership",
            "industry codes",
          ],
        },
        response: `Business criteria:\n${context.definition || "Add a business description in Set criteria."}\n\n${context.criteriaApproved ? "Approved by you." : "Waiting for your approval."} Financial size, location, ownership, and industry codes are kept for reference and do not filter this search. Editing the criteria requires approval again.`,
        action: { type: "navigate", stage: "criteria" },
      }),
    };
  return {
    toolName: "read_workspace",
    args,
    execute: (context) => ({
      result: {
        title: context.title,
        stage: context.stage,
        approved: context.criteriaApproved,
      },
      response:
        "I can review criteria, run the local screening example, suggest research steps, or open exports. Try “PitchBook, then ROGO, then Bing”. The example uses working tools; recommendations follow simple local rules.",
    }),
  };
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Stopped", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Stopped", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
