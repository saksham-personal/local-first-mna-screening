import { useMemo, useState } from "react";
import { DataGrid, type DataGridColumn, type SidePanelTab } from "./DataGrid";

type DemoCompany = {
  id: string;
  company: string;
  source: "MID" | "ISCC" | "both";
  city: string;
  website: string;
  description: string;
  midScore: number;
  isccScore: number;
  llmScore: number | "CHECK" | null;
  revenue: number;
  lastCall: string;
};

const CITIES = [
  "Austin, TX", "Boston, MA", "Chicago, IL", "Denver, CO", "London, UK",
  "Los Angeles, CA", "Miami, FL", "Minneapolis, MN", "New York, NY", "Palo Alto, CA",
  "Portland, OR", "Raleigh, NC", "San Diego, CA", "San Francisco, CA", "Seattle, WA",
  "Toronto, ON", "Vancouver, BC", "Washington, DC", "Zurich, CH", "Remote",
];
const SECTORS = [
  "workflow automation", "data infrastructure", "vertical software", "compliance tools",
  "customer operations", "security analytics", "financial planning", "supply chain systems",
];

function createDemoRows(): DemoCompany[] {
  return Array.from({ length: 5000 }, (_, index) => {
    const number = index + 1;
    const scoreIndex = number % 20;
    const llmScore: DemoCompany["llmScore"] = scoreIndex < 2
      ? "CHECK"
      : scoreIndex === 2
        ? null
        : (number * 7) % 11;
    const date = new Date(Date.UTC(2022 + (number % 4), number % 12, (number % 27) + 1));
    const sector = SECTORS[number % SECTORS.length];
    const company = `${["Northstar", "Cedar", "BluePeak", "Meridian", "Brightpath", "Juniper", "Summit", "Harbor"][number % 8]} ${["Systems", "Analytics", "Software", "Labs", "Networks", "Works"][Math.floor(number / 3) % 6]} ${String(number).padStart(4, "0")}`;
    return {
      id: `demo-${number}`,
      company,
      source: (["MID", "ISCC", "both"] as const)[number % 3],
      city: CITIES[(number * 11) % CITIES.length],
      website: `https://company${number}.example.com`,
      description: `${company} builds ${sector} for mid-market customers. The fictional business combines a configurable software platform with implementation support, recurring subscriptions, and data integrations across its core customer workflow.`,
      midScore: ((number * 379) % 1001) / 100,
      isccScore: ((number * 683) % 101) / 100,
      llmScore,
      revenue: ((number * 137) % 240_000) * 1000,
      lastCall: date.toISOString().slice(0, 10),
    };
  });
}

export default function GridDemo() {
  const rows = useMemo(createDemoRows, []);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [openedCompany, setOpenedCompany] = useState<DemoCompany | null>(null);

  const columns = useMemo<DataGridColumn<DemoCompany>[]>(() => [
    {
      id: "company",
      header: "Company",
      group: "Company details",
      kind: "text",
      value: (row) => row.company,
      width: 250,
      pinned: "left",
      tooltip: (row) => row.description,
    },
    {
      id: "source",
      header: "Source",
      group: "Company details",
      kind: "category",
      value: (row) => row.source,
      width: 112,
    },
    {
      id: "city",
      header: "HQ city",
      group: "Company details",
      kind: "category",
      value: (row) => row.city,
      width: 150,
    },
    {
      id: "website",
      header: "Website",
      group: "Company details",
      kind: "text",
      value: (row) => row.website,
      width: 220,
      render: (row) => (
        <a
          className="dg-demo-link"
          href={row.website}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => event.stopPropagation()}
        >
          {row.website.replace(/^https?:\/\//, "")}
        </a>
      ),
    },
    {
      id: "description",
      header: "Description",
      group: "Company details",
      kind: "text",
      value: (row) => row.description,
      width: 330,
      tooltip: (row) => row.description,
    },
    {
      id: "midScore",
      header: "MID semantic score",
      group: "Screening scores",
      kind: "score",
      value: (row) => row.midScore,
      bucketScheme: { type: "bins", min: 0, max: 10, count: 10 },
      width: 166,
    },
    {
      id: "isccScore",
      header: "ISCC relevancy",
      group: "Screening scores",
      kind: "score",
      value: (row) => row.isccScore,
      bucketScheme: { type: "bins", min: 0, max: 1, count: 10 },
      width: 142,
      render: (row) => row.isccScore.toFixed(2),
    },
    {
      id: "llmScore",
      header: "R1 LLM Suite score",
      group: "Screening scores",
      kind: "score",
      value: (row) => row.llmScore,
      bucketScheme: { type: "integer", min: 0, max: 10 },
      width: 172,
    },
    {
      id: "revenue",
      header: "Revenue",
      group: "Company details",
      kind: "number",
      value: (row) => row.revenue,
      width: 140,
      render: (row) => `$${row.revenue.toLocaleString()}`,
    },
    {
      id: "lastCall",
      header: "Last call date",
      group: "Company details",
      kind: "date",
      value: (row) => row.lastCall,
      width: 145,
    },
  ], []);

  const hiddenCompanies = useMemo(
    () => rows.filter((row) => hiddenIds.has(row.id)),
    [rows, hiddenIds],
  );
  const sidePanelTabs = useMemo<SidePanelTab[]>(() => [{
    id: "hidden-companies",
    label: "Hidden companies",
    count: hiddenCompanies.length,
    render: () => hiddenCompanies.length === 0 ? (
      <p className="dg-side-empty">No companies are hidden.</p>
    ) : (
      <div className="dg-demo-hidden-list">
        {hiddenCompanies.map((row) => (
          <div className="dg-demo-hidden-item" key={row.id}>
            <span title={row.company}>{row.company}</span>
            <button
              type="button"
              onClick={() => setHiddenIds((current) => {
                const next = new Set(current);
                next.delete(row.id);
                return next;
              })}
            >
              Restore
            </button>
          </div>
        ))}
      </div>
    ),
  }], [hiddenCompanies]);

  const hideSelected = () => {
    setHiddenIds((current) => new Set([...current, ...selectedIds]));
    setSelectedIds([]);
  };

  return (
    <main className="dg-demo">
      <header className="dg-demo-heading">
        <div>
          <h1>DataGrid component review</h1>
          <p>5,000 fictional companies · filter, sort, select, and inspect the side panel</p>
        </div>
      </header>
      <DataGrid
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        label="Demo companies"
        selectable
        selectedIds={selectedIds}
        onSelectedIdsChange={setSelectedIds}
        actionBar={(ids) => (
          <button type="button" className="dg-demo-hide-button" onClick={hideSelected}>
            Hide selected ({ids.length})
          </button>
        )}
        isRowMuted={(row) => hiddenIds.has(row.id)}
        sidePanelTabs={sidePanelTabs}
        sidePanelDefaultOpen
        storageKey="screening-grid-demo-v1"
        onOpenRow={setOpenedCompany}
        toolbarExtra={<span className="dg-demo-hidden-count">Hidden: {hiddenCompanies.length.toLocaleString()}</span>}
      />
      {openedCompany && (
        <div className="dg-demo-detail" role="presentation" onClick={() => setOpenedCompany(null)}>
          <section
            className="dg-demo-detail-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dg-demo-detail-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="dg-demo-detail-title">{openedCompany.company}</h2>
            <p>{openedCompany.description}</p>
            <button type="button" onClick={() => setOpenedCompany(null)}>Close</button>
          </section>
        </div>
      )}
    </main>
  );
}
