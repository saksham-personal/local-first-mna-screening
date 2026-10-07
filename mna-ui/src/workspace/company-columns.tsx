import { ExternalLink } from "lucide-react";
import type { DataGridColumn } from "../grid/DataGrid";
import { hiddenReasonLabel, type GridCompany, type RoundColumns } from "../lib/grid-client";
import { KeywordTooltip, ScorePill, SemanticBar } from "./score-cells";

function websiteUrl(value: string | null): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function sourceLabel(source: GridCompany["source"]): string {
  return source === "both" ? "Both" : source ?? "Unknown";
}

const sourceTone = (source: GridCompany["source"]) =>
  source === "ISCC" ? "iscc" : source === "both" ? "both" : "mid";

export const companyColumns: DataGridColumn<GridCompany>[] = [
  {
    id: "company",
    header: "Company",
    group: "Company",
    kind: "text",
    pinned: "left",
    minWidth: 210,
    value: (row) => row.name,
    render: (row) => {
      const href = websiteUrl(row.website);
      return (
        <span className="ws-grid-company-cell">
          <span className="ws-grid-company-heading"><strong>{row.name}</strong>{row.simulated && <span className="ws-simulated-badge">Simulated</span>}</span>
          {href ? (
            <a href={href} target="_blank" rel="noreferrer" title={row.website ?? undefined}>
              {row.website} <ExternalLink size={11} aria-hidden="true" />
            </a>
          ) : (
            <small>{row.website || "No website"}</small>
          )}
        </span>
      );
    },
  },
  {
    id: "source",
    header: "Source",
    group: "Company",
    kind: "category",
    minWidth: 100,
    value: (row) => sourceLabel(row.source),
    render: (row) => <span className={`ws-grid-badge ws-grid-source-${sourceTone(row.source)}`}>{sourceLabel(row.source)}</span>,
  },
  {
    id: "hq",
    header: "HQ",
    group: "Company",
    kind: "text",
    value: (row) => [row.hq_city, row.hq_state].filter(Boolean).join(", "),
  },
  {
    id: "description",
    header: "Description",
    group: "Company",
    kind: "text",
    minWidth: 220,
    value: (row) => row.description,
    render: (row) => <span className="ws-grid-description">{row.description || "No description"}</span>,
    tooltip: (row) => row.description ?? undefined,
  },
  {
    id: "mid_score",
    header: "MID score",
    group: "Discovery",
    kind: "number",
    minWidth: 110,
    value: (row) => row.mid_score,
  },
  {
    id: "iscc_score",
    header: "ISCC score",
    group: "Discovery",
    kind: "number",
    minWidth: 110,
    value: (row) => row.iscc_score,
  },
  {
    id: "pbid",
    header: "PBId",
    group: "PitchBook",
    kind: "text",
    hidden: true,
    value: (row) => row.pbid,
  },
  {
    id: "pb_name",
    header: "PitchBook name",
    group: "PitchBook",
    kind: "text",
    hidden: true,
    value: (row) => row.pb.name,
  },
  {
    id: "pb_website",
    header: "PitchBook website",
    group: "PitchBook",
    kind: "text",
    hidden: true,
    value: (row) => row.pb.website,
  },
  {
    id: "pb_description",
    header: "PitchBook description",
    group: "PitchBook",
    kind: "text",
    hidden: true,
    value: (row) => row.pb.description,
  },
  {
    id: "pb_hq_location",
    header: "PitchBook HQ location",
    group: "PitchBook",
    kind: "text",
    hidden: true,
    value: (row) => row.pb.hq_location,
  },
  {
    id: "pb_active_investors",
    header: "PitchBook active investors",
    group: "PitchBook",
    kind: "text",
    hidden: true,
    value: (row) => row.pb.active_investors,
  },
  {
    id: "pb_universe",
    header: "PitchBook universe",
    group: "PitchBook",
    kind: "text",
    hidden: true,
    value: (row) => row.pb.universe,
  },
  {
    id: "pb_linkedin_url",
    header: "PitchBook LinkedIn URL",
    group: "PitchBook",
    kind: "text",
    hidden: true,
    value: (row) => row.pb.linkedin_url,
  },
  {
    id: "coverage",
    header: "Coverage",
    group: "Enrichment",
    kind: "category",
    value: (row) => [row.coverage.pb && "PB", row.coverage.rogo && "ROGO", row.coverage.bing && "Bing"].filter(Boolean).join(" · ") || "None",
    render: (row) => (
      <span className="ws-grid-coverage">
        {(["PB", "ROGO", "Bing"] as const).map((label) => {
          const covered = label === "PB" ? row.coverage.pb : label === "ROGO" ? row.coverage.rogo : row.coverage.bing;
          return <span className={covered ? "is-covered" : ""} key={label}>{label}</span>;
        })}
      </span>
    ),
  },
  {
    id: "discovery_count",
    header: "Discoveries",
    group: "Discovery",
    kind: "number",
    value: (row) => row.discovery_count,
  },
  {
    id: "status",
    header: "Status",
    group: "Review",
    kind: "category",
    value: (row) => row.considered ? "Considered" : "Hidden",
    render: (row) => (
      <span className="ws-grid-status">
        <span className={`ws-grid-badge ${row.considered ? "ws-grid-considered" : "ws-grid-hidden"}`}>
          {row.considered ? "Considered" : "Hidden"}
        </span>
        {!row.considered && <span className="ws-grid-reason">{hiddenReasonLabel(row.consideration_reason)}</span>}
      </span>
    ),
  },
];

export function roundScoreId(key: string, column: string): string {
  return `round:${key}:score:${column}`;
}

export function buildCompanyColumns(rounds: RoundColumns[]): DataGridColumn<GridCompany>[] {
  const discovery: DataGridColumn<GridCompany>[] = [
    { id: "mid_keyword_match", header: "MID keyword match %", group: "MID", kind: "number", minWidth: 180,
      value: (row) => row.mid_keyword?.best_match_pct ?? null,
      render: (row) => <KeywordTooltip data={row.mid_keyword}>{row.mid_keyword?.best_match_pct == null ? "—" : `${row.mid_keyword.best_match_pct.toFixed(0)}%`}</KeywordTooltip> },
    { id: "mid_matched_keywords", header: "Matched keywords", group: "MID", kind: "text", hidden: true,
      value: (row) => row.mid_keyword?.matched.map((item) => item.text).join(", ") ?? null },
    { id: "mid_query_rationale", header: "MID query rationale", group: "MID", kind: "text", hidden: true,
      value: (row) => row.mid_keyword?.queries.map((query) => `${query.rationale} (${query.display_query})`).join("; ") ?? null },
    { id: "mid_semantic_score", header: "MID semantic score", group: "MID", kind: "score", minWidth: 190,
      bucketScheme: { type: "bins", min: 0, max: 10, count: 10 }, value: (row) => row.mid_semantic_score,
      render: (row) => <SemanticBar value={row.mid_semantic_score} /> },
    { id: "iscc_relevancy", header: "ISCC relevancy", group: "ISCC", kind: "score", minWidth: 145,
      bucketScheme: { type: "bins", min: 0, max: 1, count: 10 }, value: (row) => row.iscc_relevancy,
      render: (row) => <span>{row.iscc_relevancy == null ? "—" : row.iscc_relevancy.toFixed(2)}</span> },
  ];
  const screening: DataGridColumn<GridCompany>[] = rounds.flatMap((round) => {
    const label = `R${round.round_no} ${round.provider_label}`;
    const scores: DataGridColumn<GridCompany>[] = round.score_columns.map((column) => ({
      id: roundScoreId(round.key, column), header: `${label} ${round.score_columns.length === 1 ? "score" : column}`,
      group: label, kind: "score", minWidth: 195, bucketScheme: { type: "integer", min: 0, max: 10 },
      value: (row) => row.rounds[round.key]?.scores[column] ?? null,
      render: (row) => <ScorePill value={row.rounds[round.key]?.scores[column]} />,
    }));
    const outputs: DataGridColumn<GridCompany>[] = round.output_columns.filter((column) => !round.score_columns.includes(column)).map((column) => ({
      id: `round:${round.key}:output:${column}`, header: `${label} ${column}`, group: label, kind: "text", hidden: true,
      value: (row) => row.rounds[round.key]?.values[column] ?? null,
    }));
    return [...scores, ...outputs];
  });
  return [...companyColumns.slice(0, 4), ...discovery, ...screening, ...companyColumns.slice(4)];
}
