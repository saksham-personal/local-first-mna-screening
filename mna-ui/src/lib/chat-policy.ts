import type { ChatArtifact, ChatState, ResearchStep } from "./chat-contract";
import { usableText } from "./screening-data";

export const discoveryRequest = /^(?:find companies|start search|search companies|search again|find more companies|broaden the search)$/i;
export const nextStepsRequest = /^(?:\/plan|(?:show\s+)?(?:the\s+)?next steps?|recommend(?:ations)?|continue)\??$/i;
export function providerRequestMode(text: string): "screening" | "question" {
  if (/^\/(?:llm|copilot)(?:\s|$)/i.test(text)) return "question";
  return /^\/screen(?:\s|$)|^(?:please\s+)?(?:screen\b|(?:run|do|start|perform|prepare)\s+(?:a\s+|the\s+)?(?:(?:llm\s?suite|m365\s+copilot|copilot)\s+)?screening\b|(?:llm\s?suite|m365\s+copilot|copilot)\s+screening\s*$|(?:get|calculate|assign|produce)\s+(?:the\s+)?fit\s+scores?\b)/i.test(text) ? "screening" : "question";
}

export const nextStepOptions: Extract<
  ChatArtifact,
  { type: "options" }
>["options"] = [
  {
    id: "pitchbook",
    label: "Add PitchBook data",
    description: "Upload a mapping CSV and one or more PitchBook workbooks.",
    available: true,
  },
  {
    id: "rogo",
    label: "Add ROGO data",
    description:
      "Upload workbooks with a Website column to add company context.",
    available: true,
  },
  {
    id: "bing",
    label: "Bing research",
    description:
      "Review queries, search the web, and add source-linked research to company context.",
    available: true,
  },
  {
    id: "llm",
    label: "LLM Suite screening",
    description:
      "Review inputs and the prompt, then run batches in the background.",
    available: true,
  },
  {
    id: "copilot",
    label: "M365 Copilot screening",
    description: "Screen the current shortlist with your saved company context.",
    available: true,
  },
];
export function recommendedStep(companyCount: number): ResearchStep {
  return companyCount >= 2000 ? "llm" : "pitchbook";
}

export function consideredCompanies(state: Pick<ChatState, "companies">) {
  return state.companies.filter(company => company.considered !== false);
}
export function nextStepRecommendations(state: Pick<ChatState, "companies" | "coverage">) {
  const companies = consideredCompanies(state);
  const count = companies.length;
  const pb = (state.coverage?.PB ?? 0) > 0 || companies.some(company => Object.entries(company.enrichment ?? {}).some(([key, value]) => key.startsWith("PB_") && !!usableText(value)));
  const rogo = (state.coverage?.ROGO ?? 0) > 0 || companies.some(company => Object.keys((company.enrichment?.ROGO ?? {}) as object).length > 0);
  const bing = (state.coverage?.BING ?? 0) > 0 || companies.some(company => Object.keys((company.enrichment?.BING ?? {}) as object).length > 0);
  const hydrated = pb || rogo || bing;
  const recommended: ResearchStep[] = [];
  if (count > 0 && count < 1000) recommended.push("pitchbook", "bing");
  if (count > 500 && count < 2000) recommended.push("rogo");
  if (count > 2000) recommended.push("llm");
  if (pb && count > 0 && count < 250) recommended.push("copilot");
  const researchOpen = count > 5000 || hydrated || (count > 0 && count < 500);
  return { count, pb, rogo, bing, hydrated, recommended, researchOpen, uploadsOpen: !researchOpen };
}

export const exampleCriteria =
  "Find B2B software companies that provide policy administration or claims management software to insurers, MGAs, or TPAs.";
export const exampleDefinition =
  "Software products used in insurance policy administration or claims management. Exclude broker marketplaces, generic CRM, and pure consulting or outsourced claims services.";

/** A local drafting aid, reviewed by the analyst before execution; no model is connected. */
export function draftCriteria(text: string): {
  definition: string;
  ignored: string[];
} {
  const clauses = text
    .trim()
    .split(/\n+|(?<=[.;])\s+/)
    .filter(Boolean);
  const ignored: string[] = [];
  const business = clauses.filter((clause) => {
    const nonBusiness =
      /\b(revenue|ebitda|employees?|headcount|turnover|ownership|private equity|geograph|headquarters|hq |located in|based in|north america|united states|europe|independent|founder.owned|naics|sic code)\b/i.test(
        clause,
      );
    if (nonBusiness) ignored.push(clause);
    return !nonBusiness;
  });
  return { definition: business.join(" ").trim(), ignored };
}
export const commandPrompts = [
  {
    command: "/llm",
    title: "LLM Suite question",
    description: "Ask in chat with optional files.",
  },
  {
    command: "/copilot",
    title: "M365 Copilot question",
    description: "Ask in chat with optional files.",
  },
  {
    command: "/screen",
    title: "Prepare screening",
    description: "Review columns, prompt, and batch size before approval.",
  },
  {
    command: "/example",
    title: "Start the example",
    description: "Review and approve criteria, then search fictional companies.",
  },
  {
    command: "/criteria",
    title: "Review criteria",
    description: "Review current criteria and approval status.",
  },
  { command: "/data", title: "Show company data", description: "Review MID, ISCC, PitchBook, and ROGO data." },
  { command: "/bing", title: "Bing research", description: "Research all considered companies using editable queries." },
  { command: "/review", title: "Review shortlist", description: "Keep score matches, hide companies, or restore them." },
  {
    command: "/companies",
    title: "Show companies",
    description: "Open the saved company list and exports.",
  },
  {
    command: "/plan",
    title: "Next steps",
    description: "Choose enrichment or screening.",
  },
  {
    command: "/memory",
    title: "Company context",
    description: "Read saved company descriptions from local data.",
  },
  {
    command: "/flow",
    title: "Process map",
    description: "See the steps and approval points.",
  },
  {
    command: "/checkpoint",
    title: "Saved progress",
    description: "Read the last saved checkpoint.",
  },
  {
    command: "/export",
    title: "Export session",
    description: "Open the full session log and download options.",
  },
];
export const screeningDiagram =
  "flowchart TD\n  A[Criteria or Intake Form] --> B[Review business criteria]\n  B --> C{Analyst approves?}\n  C -->|Revise| B\n  C -->|Yes| E[Optional good-fit and bad-fit examples]\n  E --> V[Approve final criteria]\n  V --> D[Search MID and ISCC]\n  D --> F[Review company list]\n  F -->|Broaden search| D\n  F --> G[Choose enrichment or screening]\n  G --> H[PitchBook or ROGO uploads]\n  G --> I[LLM Suite or M365 screening]\n  G --> J[Bing research]\n  H --> K[Updated company context]\n  I --> K\n  J --> K\n  K --> R[Keep matches and CHECK; hide others]\n  R --> G\n  R --> X[Export considered companies]\n  K -->|Revise criteria| B";
