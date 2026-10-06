# AGENTS.md

Guidance for coding agents working in this repository. Read this first, then the
project README for whichever package you touch.

## What this is

A local-first workspace for **qualitative M&A company screening**. An analyst
describes a target core business, approves criteria, discovers companies (MID
locally; ISCC via a corporate gateway), narrows the list through enrichment
(PitchBook, ROGO) and research/screening (LLMSuite, M365 Copilot, Bing), keeps
strong/`CHECK` matches, hides the rest, iterates, and exports the considered set.

All external providers are **disconnected by default**. The default UI path uses
deterministic local rules plus real Rust tool calls against fictional MID data —
no LLM is called. Approved provider plans are saved with `executed:false`.

## Repository layout

| Path | Stack | Role |
|---|---|---|
| `mna-ui/` | React 19, TypeScript, Vite 7, assistant-ui, AG Grid Community, Radix, PDF.js, Mermaid | Chat-first screening UI plus a Node bridge (`server/`) that launches and proxies the Rust service |
| `mna-tools/` | Rust 2021, Axum, Tokio, rusqlite (bundled SQLite), Parquet, calamine, rust_xlsxwriter | Deterministic tool service: company data, retrieval, identity, imports/exports, criteria revisions, shortlist review, prepared plans, durable jobs, provider gateway |
| `mna-orchestrator/` | Python ≥3.11, LangGraph | **Offline scaffold only.** Not wired to the UI or Rust. Ports disabled by default. Don't integrate it unless asked. |

### `mna-ui/` map

- `server/start.mjs` — starts the bridge, then Vite (`--dev` → :5173, otherwise `vite preview` → :4173).
- `server/bridge.mjs` — HTTP bridge on `127.0.0.1:7319`; spawns the Rust binary on `127.0.0.1:17318` with generated per-process keys, an isolated DB under `.screening-data/`, and env scrubbing of provider secrets. Forwards only an **allowlist** of tools (`allowed` set) and admin routes (`admin` map). New Rust tools the UI needs must be added here.
- `server/jobs.mjs` — process-local discovery jobs (lost on server restart; Rust writes persist).
- `server/background-screening.mjs`, `durable-screening.mjs`, `screening.mjs`, `bing-research.mjs`, `provider-conversation.mjs` — background runs, prepared screening plans, Bing, direct provider questions.
- `shared/screening.mjs` — logic shared by server and client.
- `src/App.tsx` — shell: sidebar, header, modals, command palette, criteria editor, inspectors. Large file (~1.5k lines).
- `src/WorkspaceApp.tsx` — Workspace view (Overview / Companies / Files). It is a *view* of the same chat state; it has no second runtime.
- `src/chat/ChatThread.tsx` — assistant-ui LocalRuntime thread, composer, attachments.
- `src/chat/ArtifactCard.tsx` — all screening-domain cards (criteria, company results, next steps, plans, jobs, checkpoints, files, handoffs).
- `src/chat/ShortlistReview.tsx`, `FitExamples.tsx`, `EnrichmentUpload.tsx`, `NextStepsCard.tsx`, `DataTable.tsx`, `ScreeningInspector.tsx`, `SessionTiming.tsx`.
- `src/screening/` — `ScreeningSetup.tsx` (provider setup: column chips, prompt, preview, approve), `SetupController.tsx`, `BackgroundRuns.tsx`, `BingResearchDialog.tsx`, `PrepareMenu.tsx`, `ColumnChips.tsx`.
- `src/workspace/CompanyGrid.tsx` — AG Grid company table.
- `src/files/` — import staging and PDF preview.
- `src/SessionLog.tsx` — event ledger, timing view, exports.
- `src/lib/` — non-visual logic. Key files: `chat-driver.ts` (command interpretation, local "assistant"), `chat-store.ts` (per-screening state in localStorage), `chat-jobs.ts` (job → tool-call parts), `session-store.ts` (event ledger), `chat-policy.ts` (recommendation thresholds), `format.ts` (`plural`, `formatTime`/`formatDateTime`), `exports.ts`, `import-pipeline.ts`, `*-client.ts` (bridge API clients), `product-copy.ts` (user-facing strings).
- `src/theme/theme.css` — **all design tokens** (light + dark). `src/ui/controls.css` — shared controls. Other CSS files are per-feature.
- `tests/*.test.ts` — Node test runner via `tsx --test` (logic/contract tests, no browser).

### `mna-tools/` map

- `src/main.rs` → `runtime.rs` (Axum router, auth, tool dispatch).
- `store.rs` (SQLite domain store), `search.rs` (MID lexical/hybrid search), `data.rs` (company data/imports), `workflow.rs` (criteria/runs/approvals), `execution.rs` + `providers.rs` + `gateway.rs` (prepared plans, durable jobs, provider dispatch), `review.rs` (shortlist review), `projection.rs` (run source projection), `tabular.rs` (CSV/XLSX), `identity.rs` (ECID/CID normalization), `result_parser.rs` + `protocol.rs` (strict LLMSuite text protocol), `retrieval.rs`, `trust.rs`, `context.rs`, `agent_commands.rs`.
- `migrations/00N_*.sql` — append new numbered migrations; never edit applied ones.
- `tool-catalog.json`, `admin-tool-catalog.json`, `TOOL_REFERENCE.md` — generated; refresh after schema changes (see below).
- `tests/*.rs` — integration tests.

## Build, run, test

Work only inside `E:\` on this machine (repo at `E:\local-first-mna-screening`).
Keep toolchains and caches on E: too (e.g. `CARGO_HOME`, `RUSTUP_HOME`,
pnpm `--store-dir .pnpm-store`). At the time of writing, Node 22 is installed
but **cargo/rustup and pnpm are not** (use `corepack enable pnpm` or install
Rust to E:). A MinGW GCC exists under Cygwin for the bundled SQLite build.

### Rust service (`mna-tools/`)

```powershell
cargo build --release --locked --target x86_64-pc-windows-gnu   # path the UI bridge expects
cargo fmt --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
```

The UI looks for `mna-tools/target/x86_64-pc-windows-gnu/release/mna-tools.exe`;
override with `SCREENING_RUST_BINARY=<absolute path>`. After changing tool
schemas: regenerate with `mna-tools.exe --print-tool-schemas` /
`--print-admin-schemas` and run `python scripts/build_tool_reference.py`.

### UI (`mna-ui/`)

```powershell
pnpm install --store-dir .pnpm-store
pnpm test        # tsx --test tests/*.test.ts
pnpm build       # tsc --noEmit && vite build — must pass before you finish
pnpm dev         # bridge + Vite on http://127.0.0.1:5173
pnpm start       # bridge + vite preview on http://127.0.0.1:4173 (needs a build)
```

Ports: 5173/4173 (UI), 7319 (bridge), 17318 (Rust). The bridge validates
`Origin`/`Host` against those exact localhost values. Local state lives in
`mna-ui/.screening-data/` (gitignored); browser state lives in localStorage
(`screening-workspace-v3:*`, `screening-appearance-v1`, etc.). To reset a
manual test, stop the server, delete `.screening-data/`, and clear site storage.

Quick manual path: **New screening** → `/example` → approve criteria → wait for
discovery → review companies → drop files from `public/examples/`
(`pitchbook-mapping.csv`, `pitchbook-data.xlsx`, `rogo-data.xlsx`) → **Screen / ask**
→ preview → approve → hide/keep → export.

### Orchestrator (`mna-orchestrator/`)

```powershell
python -m pip install -e .
py -3 -m unittest discover -s tests -v
```

## Domain invariants (do not break)

- **Approval is revision-specific and analyst-only.** Editing criteria creates a new revision, clears approval and the displayed result set. An old approval or prepared plan never authorizes changed criteria. The agent/UI must never self-approve.
- **Prepared plans bind an exact digest.** Any edit to setup or a relevant upload invalidates the preview and requires re-approval. Disconnected runs record `executed:false` and send nothing.
- **Discovery is core-business only.** Geography, size, financials, ownership, industry codes are review details, never discovery filters.
- **MID and ISCC scores stay separate.** Never average retrieval scores, and never merge them with screening/provider scores.
- **Hidden ≠ deleted.** Hidden companies stay in saved history and can be restored. Counts, recommendations, screening scopes and exports use **considered** companies only.
- **Never fabricate** results, scores, provider responses, approvals, or agent activity. Unavailable providers must show as unavailable. Research claims are unverified leads until analyst review.
- **Identity:** names/websites alone never merge companies; only exact identifier bridges.
- **LLMSuite rate gate:** seven actual sends per rolling minute shared across all purposes.
- Recommendation thresholds (strict comparisons on considered count `n`) are documented in `mna-tools/docs/WORKFLOW.md` and implemented in `src/lib/chat-policy.ts`; keep code, tests and docs in sync.
- Bridge security: keep the tool allowlist, Origin/Host checks, staged file IDs (never caller paths), 20 MB file limit, and secret scrubbing.

## UI conventions

- Use tokens from `src/theme/theme.css` (`--surface`, `--text-muted`, `--border`, `--accent`, `--success`/`--warning`/`--danger`/`--info` + `-soft`). Don't hardcode colors. Accent is `#8F5A39` (brown); keep the palette — refine spacing, hierarchy, typography and consistency rather than recoloring.
- Every change must work in both light and dark themes and respect `prefers-reduced-motion`. Motion is deliberately minimal (short fades, stepped loaders; no blurs, slide-ins, or hover filters).
- Fonts: Geist (body/controls/tables), Manrope (headings), both local via Fontsource.
- Status color always comes with a text label.
- Desktop dock vs. mobile: below 1001px the hidden chat is `inert`; keep focus management and keyboard access intact (dialogs trap focus and close on Escape).
- Prefer editing existing shared controls (`SelectField`, `FileDropArea`, `Tooltip`, `controls.css`) over introducing new one-off components or libraries.
- User-facing copy belongs in `src/lib/product-copy.ts` where a string is shared.
- Use the in-app browser to verify UI changes visually (both themes, desktop and ~375px width), not just `pnpm build`.

## Working rules

- Keep diffs focused; match surrounding style (the codebase uses dense single-line JS in `server/`, Prettier-style TSX in `src/`).
- Add or update tests in `mna-ui/tests/` or `mna-tools/tests/` for logic changes.
- Docs are extensive and asserted in places (counts of tools, tests, thresholds). If behavior changes, update the relevant README / `DESIGN.md` / `UI_GUIDE.md` / `WORKFLOW.md`.
- Never commit `.screening-data/`, `.env*`, databases, `node_modules/`, `target/`, or credentials. Provider credentials go in environment variables (`MNA_LLMSUITE_*`, `MNA_M365_*`, `MNA_BING_*`, `MNA_ISCC_*`, plus `SCREENING_ENABLE_EXTERNAL=true`).
- Don't enable external providers or make network calls to corporate services while testing.

## Further reading

- `README.md` — overview and current limits
- `mna-tools/docs/WORKFLOW.md` — full analyst loop and thresholds
- `mna-tools/docs/BACKEND_ARCHITECTURE.md`, `EXECUTION_CONTRACT.md`, `LLMSUITE_PROTOCOL.md`, `gateways.md`
- `mna-tools/TOOL_REFERENCE.md` — every tool's arguments
- `mna-ui/DESIGN.md`, `UI_GUIDE.md`, `SCREENING_SETUP.md`, `BACKGROUND_SCREENING.md`, `VALIDATION.md`
