import type { ChatArtifact, ResearchStep } from "./chat-contract";

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
    label: "LLM screening",
    description:
      "Review inputs and the prompt, then run batches in the background.",
    available: true,
  },
  {
    id: "copilot",
    label: "M365 screening",
    description: "Prepare screening or a question. LinkedIn is optional.",
    available: true,
  },
];
export function recommendedStep(companyCount: number): ResearchStep {
  return companyCount >= 2000 ? "llm" : "pitchbook";
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
    title: "Ask LLMSuite",
    description: "Prepare a question with your chosen company context.",
  },
  {
    command: "/copilot",
    title: "Ask M365 Copilot",
    description: "Prepare a question; LinkedIn is optional.",
  },
  {
    command: "/screen",
    title: "Prepare screening",
    description:
      "Review inputs, prompt, outputs, and batch size before approval.",
  },
  {
    command: "/example",
    title: "Start the example",
    description:
      "Approve criteria, then run working tools on fictional companies.",
  },
  {
    command: "/criteria",
    title: "Review criteria",
    description: "Show the current business criteria and approval.",
  },
  { command: "/data", title: "Show company data", description: "Read the latest MID, ISCC, PitchBook and ROGO sources in a table." },
  { command: "/bing", title: "Bing research", description: "Edit web queries and choose companies before approving a search." },
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
  "flowchart TD\n  A[Criteria or DDI] --> B[Review business criteria]\n  B --> C{Analyst approves?}\n  C -->|Revise| B\n  C -->|Yes| D[Search companies]\n  D --> E[Merge company IDs]\n  E --> F[Review company list]\n  F -->|More companies| D\n  F --> G{Choose next step}\n  G --> H[PitchBook or ROGO files]\n  G --> I[LLM or M365 screening]\n  G --> J[Bing research approval]\n  H --> K[Company context]\n  I --> K\n  J --> K\n  K --> L[Save checkpoint and export]";
