# Screening overhaul: implementation plan

## Context
The audit (`E:\local-first-mna-screening\docs\flow-audit\CURRENT_FLOW.md`) and your review define the work. The UI is cluttered and has layout bugs. Uploads go through one page-wide drop zone. A PitchBook mapping silently hides companies. Good/bad-fit examples are never used. Criteria are approved twice, and button clicks show up as fake user messages. Hidden companies can't be seen or restored from the grid. MID search is a substring scan with no index. There is no scoring/round model for the iterative screening loop.

Goals:
- A clean, navigable app that runs well on a CPU-only Windows machine.
- An Intake Form (renamed from DDI).
- A prompts directory.
- Purpose-specific drop zones with a PitchBook match review.
- A full AG Grid experience (filters, side panel, hidden companies, drawer).
- Build Index (MID ingestion with an FTS5 keyword index plus semantic scoring).
- ISCC merge.
- LLM Suite/M365 rounds with 0–10/CHECK score filters and histograms.

The base is `origin/main` @ `02650fe` (includes `APPLICATION_FLOW_GUIDE.md`, which is the reference flow).

## Your decisions
- Phased delivery, with a stop for your review after Phase 1 and after Phase 2.
- Dev-only simulated provider mode. Off by default, always labelled "Simulated", never in real exports.
- Intake PDF parsing: you will finalize it later. I build a pluggable extractor and the manual form, and the PDF opens automatically.
- Embeddings: configure later. The semantic step shows "model not installed" until a model folder is set.
- PitchBook/ROGO enrichment stays company-global (intended).
- MID keyword searches use a keyword list plus an expression, like the old Company Screener: weights, `(1 OR 2) AND NOT 3`, and a rationale.
- Intake Form fields have no character limits, only a live character count.
- Criteria versions: picking a version opens a view with an optional "Restore as new version" (creates a draft that needs approval).
- MID never has the same ECID with different CIDs, so the current identity rules stay. ISCC's `ECI` is added as an alias of ECID.
- **Confirmed at Checkpoint 1:** MID's `Crescendo ID` is the CID (configurable alias in the index config).

## Ground rules and setup (Wave 0, done by me)
- **Worktree on E: (all writes on E:):**
  - `git -C E:\local-first-mna-screening fetch origin`
  - `git worktree add E:\lfms-wt\overhaul -b overhaul/screening-ux origin/main`
  - Copy the untracked `AGENTS.md` and `docs/flow-audit/` from `E:\local-first-mna-screening`.
  - Parallel subagents use sibling worktrees `E:\lfms-wt\<wave>` on branches `overhaul/<wave>`. I merge them back.
  - Commits are local only, on these worktree branches. Nothing is pushed.
- **Toolchain:** add `scripts/dev-env.ps1` / `.cmd` to the worktree:
  - Reuse the existing rustup at `C:\…\x20-im\work\toolchain` read-only (`RUSTUP_HOME`, the toolchain `bin`, w64devkit gcc, gnu target and linker vars as in `work\rust-env.cmd`).
  - `CARGO_HOME=E:\lfms-wt\.cargo-home`, shared `CARGO_TARGET_DIR=E:\lfms-wt\.cargo-target`, `CARGO_BUILD_JOBS=2`.
  - pnpm 11.19.0 via corepack with `COREPACK_HOME=E:\lfms-wt\.corepack` and `--store-dir E:\lfms-wt\.pnpm-store`.
- **Configurable ports** (`server/start.mjs`, `server/bridge.mjs` hosts/origins, `vite.config.ts` proxy, Rust bind): `SCREENING_UI_PORT`, `SCREENING_BRIDGE_PORT`, `SCREENING_RUST_PORT`. The worktree runs on 4273/5273, 7419 and 17418, so the existing app in `outputs/` keeps working.
- **Baseline before any change:** `cargo test`, `pnpm test`, `pnpm build`.
- **Invariants from AGENTS.md stay:**
  - approval is per revision and analyst-only
  - approvals bind exact digests, and nothing is sent when disconnected
  - discovery uses the core business only
  - MID, ISCC and model scores stay separate
  - hidden ≠ deleted
  - nothing is fabricated; the only exception is the labelled simulated mode

## Target flow
```
New screening → Criteria (type, or Intake Form: PDF opens automatically, fields filled/edited)
 → Criteria card vN with optional good/bad examples inline → ONE "Approve & search"
 → Discovery: MID keyword queries (rationale + query) + semantic score; ISCC pull; merge ECID→CID
 → Companies grid (All · MID · ISCC tabs, histogram, column filters, side panel, hidden toggle, drawer)
 → Hide / keep selected → Next step: PitchBook zone (match review) · ROGO zone · Bing · LLM Suite/M365 round N
 → Round results join as columns → filter by score (CHECK kept by default) → hide → repeat → Export
```

---

## Phase 1: UI/UX and flow foundations

### 1.1 Shell and layout bugs (`mna-ui/src`)
- **Header pushed off-screen:**
  - Cause: `.ct-app` is `overflow:hidden`, so it can still be scrolled programmatically.
  - Fix: `overflow:clip` on `.ct-app`, `.ct-main` and `.ct-body` (`chat/chat.css:14-28, 241-246, 409-414`).
  - Add `preventScroll:true` to focus calls: `App.tsx:484, 532-536, 126-130, 155`; `SessionLog.tsx:518`; `PdfPreview.tsx:137`.
  - Add a scroll guard that resets `.ct-app` `scrollTop` to 0.
- **Header at ~800px:**
  - `white-space:nowrap` on `.ct-log-button` (`chat.css:322-333`).
  - Title and status line truncate with an ellipsis at every width (`chat.css:258-290`).
  - A container query collapses the "Screen", Session log and Appearance labels to icon plus tooltip below about 1180px.
- **Chat tables only showing ~3 rows** (`chat/data-table.css:1-13`, no height set): fixed by the new DataGrid (1.9), which gets an explicit or flex height with a 420px minimum.
- **Other visual bugs from the audit:**
  - ISCC column clipped
  - Session log timing axis overlaps at narrow widths (stack the timing panel, thin out ticks)
  - On mobile the Activity dock collapses to a pill above the composer and never covers primary actions
  - Stale earlier `/review` cards become read-only snapshots
  - "Start in background" shows run status and disables after use
  - typos ("saved saved", `chat-jobs.ts:432`)
  - a `plural()` helper fixes "1 companies"
  - one `formatTime()` helper unifies time formats
- **Background polling** (`lib/background-client.ts:79-97`, every 2s, unconditional): poll every 2s only while runs are active, every 15s when idle, and pause while the tab is hidden.
- **Remove dead code:** `AssistantPanel.tsx`, `assistant.css`, `lib/assistant-driver.ts`, `assistant-contract.ts`, `policy.ts`, `tool-workflow.ts`, along with their legacy tests. Grep first to confirm they are unreferenced.

### 1.2 Desloppify, help tips, menus, surfaces
- **`HelpTip`:** a new "?" component built on Radix Tooltip/Popover (collision-aware, rich content, keyboard accessible). It replaces `src/Tooltip.tsx`. Fix the dead selectors at `chat.css:222, 799`.
- **Copy sweep:** about 43 verbose strings, listed by the UI explorer:
  - `chat-jobs.ts:196,197,209,87,355`
  - `ShortlistReview.tsx:119-131`
  - `ArtifactCard.tsx:244-410`
  - `ScreeningSetup.tsx:366-759`
  - `BingResearchDialog.tsx:117-138`
  - `chat-driver.ts:175-882`
  - `WorkspaceApp.tsx:399-799`
  - `ImportStaging.tsx`
  - …

  Shorten each to one plain sentence or move it into a HelpTip. Hide jargon:
  - `executed:false` becomes "Not sent: provider not connected"
  - tool timelines collapse by default
  - checkpoint JSON goes behind "Details"

  Fix inaccurate copy: `WorkspaceApp.tsx:740`, `ImportStaging.tsx:17`, `ScreeningSetup.tsx:757-759`.
- **Theme menu:** remove the description lines (`theme/ThemeMenu.tsx:24,30,36`). `SelectField` already renders without them when they're absent.
- **Screen menu** (`screening/PrepareMenu.tsx`):
  - Remove "Ask LLMSuite" and "Ask M365 Copilot", and the footer text.
  - Rename the trigger to "Screen".
  - Use "LLM Suite" and "M365 Copilot screening" everywhere (`PrepareMenu:42,51`, `ArtifactCard:252,290`, `App.tsx:741`).
  - Direct questions stay available through the composer's runtime selector, which is highlighted whenever it isn't on Screening assistant.
- **Chat dock on the Workspace tab: expand and contract** (`App.tsx:1123-1178`, `workspace.css:17-23`, `controls.css:315-349`):
  - Three states, rail (44px) / default / expanded, saved as `screening-dock-v1`.
  - A drag handle sets `--ct-dock-width`.
  - The rail shows an icon, a busy dot and an expand control.
  - `ChatThread` is never unmounted: it gets CSS-hidden and `inert`.
  - The dock re-opens automatically from `setDraft`, `addDroppedFiles`, `openSetup`, `send` and `upload` (`App.tsx:478-572, 727-736`).
  - Update the `BackgroundRuns` measurements.
- **Duplicate surfaces, resolved:**
  - The 📁 panel is consistently named **"Context"**: title, aria-label and icon all match (`App.tsx:1065-1076, 1197-1256`; `ScreeningInspector.tsx`).
  - The 🕑 "Background runs" inspector (`App.tsx:1258-1325`) is removed. Discovery jobs become a "Searches" section of the single bottom **Activity** dock (`screening/BackgroundRuns.tsx`), next to Screening (and Index builds in Phase 2). The header clock button toggles that dock, and its dot counts all activity.
  - Workspace › Overview is the only overview.
  - The empty state has two actions, *Write criteria* and *Upload Intake Form*, plus a "Try the example" link. The Overview's empty state points to those rather than repeating them.

### 1.3 Motion and skeletons (CPU-only, no WebGL)
- Merge the 8 separate spin keyframes (`styles.css:51`, `artifacts.css:442`, `shortlist-flow.css:82`, `screening-setup.css:641`, `bing-research.css:54`, `pdf-preview.css:287`, …) into one smooth `ui-spin`: linear, transform only, replacing the stepped spin.
- Keep the status pulses, as opacity with ease-in-out.
- New `src/ui/Skeleton.tsx` with Line, Block, Table, Card, List and Drawer variants, using a gentle opacity pulse (no gradient shimmer or blur). Use it in place of:
  - the Suspense text fallbacks (`App.tsx:1181-1186, 1430-1436, 1446`; `WorkspaceApp.tsx:671-676`; `ArtifactCard.tsx:221, 329`)
  - grid loading
  - the setup preview ("Reading available data…")
  - the Activity list
  - the company drawer
  - PDF page loading
  - the versions menu
- The global reduced-motion rule (`theme.css:858-866`) still covers everything.

### 1.4 Criteria: single approval, versions, no fake user messages
- **One criteria card:** an editable definition plus a collapsible **Good fits / Bad fits** section inside the same card, and one primary **Approve & search** button.
  - If the examples were edited, a new revision vN+1 is saved first, then that exact revision is approved, so what you see is what gets approved.
  - Remove the "business" phase: `chat-driver.ts:105-131, 164-185, 447-465`; `ArtifactCard.tsx:384-454`; `FitExamples.tsx`, which becomes an inline sub-component; `App.tsx:737-738`.
  - The Rust revision number becomes authoritative, and the local counter is dropped (`review-client.ts:19-43`).
- **No fake user messages:** artifact actions still go through the thread (`App.tsx` `sendRef` → `ChatThread.tsx:624-632`) but are marked `metadata.custom.hidden=true`.
  - `UserMessage` renders these as a compact system chip ("✓ Approved criteria v2 · 1:33") with no edit or copy.
  - Routing stays metadata-only, which also fixes the regex pitfall at `chat-driver.ts:449`.
  - The same applies to `/criteria`, `/plan`, `/review`, "Choose PitchBook data" and the inspect actions sent from buttons.
- **Version selector replaces "Last criteria"** (`ArtifactCard.tsx:397-404`, `ScreeningInspector.tsx:24`):
  - A "v3 ▾" button opens a menu of v1…vN. Each entry shows a status chip, start time (`created_at`), end time (the next revision's `created_at`, or "current"), and approval time and approver.
  - Hovering shows a rich tooltip with the criteria text: max-width 440px, about 12 lines with a line-clamp ellipsis, and it grows to fit.
  - Clicking opens a **Criteria vN** window with the full text, examples, Intake Form fields, deferred conditions, status, timestamps and digest, plus **Restore as new version** and **Copy**.
  - Data source: `get_criteria_history` (already allowlisted; `review.rs:316-326`).

### 1.5 Intake Form (renamed from DDI)
- **Rename** all 26 "DDI" occurrences:
  - `ChatThread.tsx:700,780`
  - `chat-driver.ts:504`
  - `chat-policy.ts:160`
  - the README
  - `build_tool_reference.py` (then regenerate `TOOL_REFERENCE.md`)
  - `docs/APPLICATION_FLOW_GUIDE.md`, `WORKFLOW.md`, `BACKEND_ARCHITECTURE.md`, `OPERATING_INSTRUCTIONS.md`
  - the test fixture name

  Also add a `productCopy` rule so already-saved messages display "Intake Form".
- **`src/intake/`:**
  - `IntakeForm.tsx`, a window laid out like your screenshots:
    - Submitter: name, due date, senior client exec(s), request type
    - Asset parameters: Industry → Sector as dependent selects using your mapping; Sub-sector as free text
    - Idea screening: Investment thesis, Relevant products/services, Focus end-markets
    - Size parameters, ownership preference and geography focus as multi-select chips that also accept custom entries
  - Every text field shows a live character count with **no limit**.
  - `intake-options.ts` holds:
    - the Industry → Sector map
    - the request types: New Platform (Sponsor / Family Office), Add-on (Sponsor / Family Office), Acquisitive Strategic Client (non-Sponsor), General Industry Screen
    - size buckets $0–50MM … $500MM+
    - the ownership options
    - starting geography values: US – All regions, Canada
- **How the fields map:**
  - thesis, products/services and end-markets become the core-business draft
  - industry, sector, sub-sector, size, ownership and geography become **deferred conditions**, shown as "Recorded, not used for search"
  - submitter, due date and request type become metadata
  - all of it is stored on the revision (backend 1.10)
- **PDF intake:**
  - A PDF dropped in the Intake zone is staged and opens **automatically** in a new `DocumentWindow`: a floating, resizable window that works in Workspace without switching to Chat (refactor the PdfPreview host at `App.tsx:454, 506-522, 1179-1196`).
  - It can be closed, and "View Intake PDF" reopens it.
  - Extraction is a pluggable `extractIntakeFields()`. The v1 implementation moves the bridge's `pdfExcerpt`/`zipExcerpt` into `server/text-extract.mjs`, then does a simple label match and marks the result "Pre-filled — check each field". You'll finalize parsing later. `prompts/intake-form-extraction.md` is reserved for an LLM-based extractor.

### 1.6 Prompts directory and a generated screening prompt
- **`prompts/` at the repo root**, one `.md` per prompt:
  - H1 title
  - a description block: **ID**, **What it does**, **Inputs** (placeholders), **Output**, **Supplied to**, **Version**
  - then `===@@=== STARTING ===@@===` … `===@@=== END ===@@===`
  - Placeholders are `{{name}}`, plus optional sections `{{#name}}…{{/name}}` that render only when non-empty.
  - Parsing is strict: exactly one marker pair, no unknown or missing placeholders.
- **Loaders:**
  - `mna-ui/shared/prompts.mjs` (Node fs; used by the bridge and the tsx tests)
  - `mna-tools/src/prompts.rs` (`include_str!` defaults with an optional `MNA_PROMPTS_DIR` runtime override; validated at startup)
  - Both are checked against the same conformance fixtures.
- **The browser never reads the files.** It gets rendered prompts from bridge endpoints (`POST /api/prompts/screening-draft`, …) because `shared/screening.mjs` also runs under tsx.
- **Files, migrated from today's prompt locations:**

  | File | Source |
  |---|---|
  | `screening-scored.md` | P1 |
  | `screening-question.md` | P1 |
  | `screening-prompt-writer.md` | P8 "Generate with AI" |
  | `output-contract.md` | P9 `gateway.rs:341-350` |
  | `batch-repair.md` | P10 `execution.rs:493-495` |
  | `format-repair.md` | P11 `gateway.rs:250-254` |
  | `tool-command-repair.md` | P12 `protocol.rs:141-156` |
  | `controller-tools.md` | P13 `agent_commands.rs:172-220` |
  | `direct-question.md` | P7 `provider-conversation.mjs:188` |
  | `bing-query-writer.md` | P8 |
  | `criteria-from-examples.md` | P3 `chat-driver.ts:172` |
  | `criteria-from-research.md` | P3 `chat-driver.ts:189` |
  | `intake-form-extraction.md` | reserved |
  | `mid-search-planner.md` | Phase 2 |

  You'll supply the final wording later. The files ship with tightened versions of today's text.
- **The screening prompt is generated** from:
  - the approved definition
  - the **good- and bad-fit examples**
  - deferred conditions, as "for context, do not score on these"
  - an input-column glossary
  - the task and analyst request
  - one unified score definition: 0–10 bands plus CHECK = insufficient or conflicting data. This removes the current mismatch between P1, P8 and P9.
  - the index-only Markdown output contract

  `ScreeningSetup` fetches it with a skeleton while loading, and keeps manual edits (no regex reparse; remove `ScreeningSetup.tsx:110-118`).
- **Contract hash:** the compiled prompt hash now includes the prompt ID and content hash. Existing approved plans go stale once; this is documented.
- **Bing default templates:** fix "Does {company} provide find companies that…" by extracting the core-business phrase (strip lead-ins and exclusions, keep the verb phrase), giving e.g. "Does {company} sell claims management … software to insurance carriers? Website: {website}" (`chat-driver.ts:261-269`).

### 1.7 Purpose-specific drop zones
- **Remove the page-wide `FileDropArea`** that wraps `.ct-body` (`App.tsx:1102-1105`).
  - A window-level dragover/drop handler stops the browser from opening dropped files.
  - On drag-enter, a **"Drop to…" chooser** appears with real target tiles: Chat attachment · PitchBook data · ROGO data · Intake Form, plus MID workbook in Phase 2, which opens Build Index. Dropping outside a tile does nothing.
  - In-place zones take priority: the composer, the PitchBook and ROGO cards, the Intake window and the Build Index window. Fix the nested-drop stuck overlay (`EnrichmentUpload.tsx:63-70`).
- **Processing is scoped to purpose:**
  - `stageUploads(files, {purpose})` (`lib/tool-client.ts:141-229`) sends `purpose` ∈ chat | pitchbook | rogo | intake | mid_index.
  - The bridge `/api/files` (`bridge.mjs:242-264`) checks extensions per purpose and dedupes identical files by sha256+purpose.
  - It runs header inspection **only** for pitchbook and rogo, and rejects mismatches with a clear message using the original filename (e.g. "This looks like a ROGO file. Drop it in ROGO data.").
  - Chat attachments are never inspected or imported. Remove the chat path from `processStagedUploads` and the unused `screening:files-staged` event.
- **Workspace › Files** becomes a new `workspace/FilesTab.tsx` with the three zones plus the chat-attachment list.

### 1.8 Enrichment backend fixes and PitchBook/ROGO match review
**Rust (`data.rs`, `review.rs`, `tabular.rs`, migration 008):**
1. **Imports never change considered flags.**
   - Drop `exclude_unmapped` from the UI (`import-pipeline.ts:54`).
   - In Rust it defaults to false, and the hide-all path is removed (`data.rs:572-574`, `review.rs:349-351`).
   - Explicit Profile ≠ Yes rows also stop auto-hiding (`data.rs:514-530`).
2. **Match report:** the import returns, and saves in `enrichment_import_reports`:
   - `matched[]` (company, PBId, fields hydrated)
   - `not_matched[]` with reason ∈ not_in_mapping | profile_not_company | blank_pbid | no_data_row | conflict
   - for ROGO: matched / unmatched rows / ambiguous
   - accurate, non-cumulative counts
   - New tool `get_enrichment_report`.
3. **New admin op `apply_enrichment_review {run_id, report_id, hide_company_ids, keep_company_ids}`:** hides with reason `pitchbook_unmatched` (restorable). It writes one review row only when flags actually change.
4. **One current PBID per company:** a Yes mapping row replaces the old one. Readers stop using `ORDER BY identifier LIMIT 1` (`data.rs:984-995, 1675-1678`; `review.rs:198`). PB compact fields come only from the current PBID's record, and the latest value wins (`data.rs:1173-1177`).
5. **Stop needless plan staleness:**
   - No review row on imports (`data.rs:627`).
   - `update_canonical` only bumps `updated_at` when a value changes (`data.rs:1116-1135`).
   - `jobs.mjs:251,274` imports the MID seed only if it isn't already loaded.
6. **Exclusions:** `save_criteria_revision` takes `core_business_exclusions` (new column), and `approve_criteria_revision` copies them into the profile content (`review.rs:307`).
7. **Quarantine:** add a unique index on the quarantine table and use INSERT OR IGNORE, so re-imports don't inflate counts. Rows outside the run get their own reason (`data.rs:509-512, 560-568`).
8. **Tolerant headers** (`tabular.rs:307-358`):
   - PB mapping header found within the first 20 rows; requires pk + PBId + Company Profile, with aliases accepted
   - ROGO website aliases: Website(s), Company Website, URL, Domain
   - PB data is classified before ROGO
   - the zone's purpose is used as a hint when a file is ambiguous
   - per-file errors and status, so one bad file doesn't fail the batch
9. **ROGO ambiguity** only when two or more *distinct* companies share a host. Normalize CHECK casing on the UI side.

**UI: `PitchBookReviewDialog`** (shown after a PitchBook import; the ROGO variant shows matched/unmatched rows):
- Tabs **PitchBook matched (n)** (green) and **Not matched (n)** (red, with a reason badge).
- Each row has a Retain/Hide toggle.
- A bulk choice: **Keep companies without PitchBook data** / **Hide them**.
- **Apply** calls `apply_enrichment_review`, then the import summary uses the report's counts.

### 1.9 Company grid v2 (AG Grid Community only)
New `src/grid/`, adapting patterns from `E:\OriginationsDashboard\chdb-scale-benchmark\src\components\DataGrid.tsx` (`ValueFilterHeader`, `ColumnAdvancedFilter`, `matchesAgFilter`). It uses the client-side row model with an external filter, `getRowId = company_id`, and the theme from `CompanyGrid.tsx:40-70`.
- **`DataGrid.tsx`:**
  - custom header with sort and a filter icon showing the active count
  - floating filter row
  - **per-column filter panel** with:
    - a value checklist with counts and search, (Blanks), Select shown, Clear
    - typed operators: text contains; number >, ≥, <, ≤, =, ≠, between, blank / not blank; date
    - sort shortcuts
  - "Search all columns"
  - applied-filter chips with Clear all
  - columns grouped by source
  - flex height with a 420px minimum
- **`grid-filter.ts`:** a pure, unit-tested filter engine covering the text, number, score, date and category kinds.
- **`SidePanel.tsx`:** vertical tabs **COLUMNS** (search, checkboxes grouped by source, select all / reset) | **FILTERS** (per-column editors that mirror the header filters) | **HIDDEN COMPANIES** (reason badge, Restore, Restore all).
- **Row selection** with an action bar: **Hide selected**, **Keep only selected**, **Restore**. A **Show hidden** toggle is off by default; hidden rows appear muted with their reason (Manual, No PitchBook match, Score review).
- **`CompanyDrawer.tsx`** (like the Hampton screenshot):
  - header: name, ECID/pk, status, Considered/Hidden badge, prev/next arrows
  - tabs: **Overview** (matched keyword chips with counts, labelled descriptions with keyword highlights, scores) · **Company details** (every field grouped by source) · **Activity** (rounds, Bing findings, notes, hide/restore history)
  - footer: Hide/Restore and Ask assistant
- **Cells:** ScorePill, SemanticBar, SourceBadges, WebsiteCell, DescriptionCell (hover tooltip), KeywordTooltip (dark style).
- **Replaces:**
  - `CompanyGrid.tsx` and its pre-grid hidden filtering (`WorkspaceApp.tsx:556-584`)
  - `DataTable.tsx`
  - the grid inside `ShortlistReview.tsx`

  Chat `/data` and `/review` embed it at a fixed height with "Open in Workspace".

### 1.10 Backend for Phase 1 (migration `008_intake_reports.sql`)
- `criteria_revisions` gains `intake_form_json` and `core_business_exclusions_json` (ALTER ADD COLUMN; inserts only, the table stays immutable). `save_criteria_revision` accepts `intake_form` (validated keys, ≤100 KB) and `get_criteria_history` returns it.
- New table `enrichment_import_reports(report_id, run_id, purpose, files_json, summary_json, matched_json, not_matched_json, created_at)`.
- New tool **`get_screening_grid {run_id, include_hidden=true, after_company_id?, limit≤2000}`**: one SQL pass per page joining:
  - candidates (considered and `consideration_reason`)
  - companies
  - the current PBID
  - `company_enrichment` (PB/ROGO key fields and coverage)
  - latest MID/ISCC compact source fields
  - the best discovery score per source (max, not first)

  It replaces the N+1 per-company calls in `jobs.mjs:381-400` and the grid's use of `readShortlist`/`readCompanySources`.
- New tool **`get_company_detail {run_id, company_id}`**: all fields grouped by source, descriptions, and activity.
- Bridge allowlist additions: `get_screening_grid`, `get_company_detail`, `get_enrichment_report`, `apply_enrichment_review` (admin map).

**Checkpoint 1:** full tests and builds, browser walkthrough, then stop for your review.

---

## Phase 2: Data, search and scores

### 2.1 Build Index (MID ingestion)
- **Config** `mna-tools/config/mid-index.json`, editable and validated on load, using your lists (trailing commas fixed): `search_columns`, `llm_description_columns`, `fts5_column_names`, `metadata_columns`. It also adds:
  - `source_weights` (bm25 per column; defaults from the old app, extended to 12)
  - `identifier_columns` `{ecid:["ECID","ECI"], cid:["CID","Crescendo ID"], pbid:["PBID","Pitchbook ID"]}`
- **Migration `009_mid_index.sql`:**
  - `mid_bundles(bundle_id, name, status building|ready|active|failed|superseded, source_file, row_count, config_json, config_hash, created_at, activated_at, error)`
  - `index_builds(build_id, bundle_id, status, current_step, steps_json, rows_total, rows_done, started_at, updated_at, finished_at, error, cancel_requested)`
  - `mid_rows(bundle_id, company_id, row_json, desc_hash, PK(bundle_id, company_id))`
  - FTS5 tables per bundle: `mid_fts_<n>` (porter unicode61) and `mid_fts_exact_<n>` (unicode61), external content, with the configured columns
- **`src/index_build.rs`:**
  - a worker thread with its **own SQLite connection (WAL)**, so the global mutex is never held for minutes
  - streams the xlsx (calamine `worksheet_cells_reader`, header row 1) in batches of 5k rows per transaction
  - normalizes identifiers through `identity.rs`
  - fills FTS
  - runs the embeddings step using `retrieval.rs`; it skips honestly with "model not installed" when not configured, and only re-embeds rows whose `desc_hash` changed
  - verifies, then activates atomically, keeping the previous bundle for rollback
  - **Steps:** read workbook → validate headers → normalize identifiers → store rows → build keyword index → semantic embeddings → verify → activate
  - Each step reports status, rows done/total, rate and ETA (EWMA). Builds can be cancelled, and their state survives a restart.
- **Admin routes:** `index-builds` start/status/list/cancel, `mid-bundles` activate/delete. **Bridge:** a raw streaming upload route for large xlsx (to disk, configurable cap, default 1 GB), plus routes for these operations.
- **UI:**
  - A header **Build Index** button (top-right) opens `BuildIndexDialog`:
    - drop or browse an .xlsx, bundle name, Activate on success, Start
    - the step list with per-step progress bars, counts, elapsed time and ETA
    - collapsible log
    - Recent builds (Activate/Delete)
    - "Columns used" view
  - Closing the window moves progress into the Activity dock as an **Index build** item in the info-blue accent, with its steps.

### 2.2 MID search v2 (keyword list + expression)
- **`search_mid` v2** in `src/mid_search.rs`, keeping the old `query` parameter for compatibility:

  ```
  {run_id, rationale (required, ≤300 chars),
   keywords: [{id, text, weight = 1, match: stem | exact}] (1..50),
   expression? (default: OR of all ids),
   columns?, limit (default 5000, max 20000), add_to_run = true}
  ```
- Each keyword compiles to a safely escaped FTS5 phrase (a trailing `*` makes it a prefix) against the stem or exact table, using bm25 with column weights.
- The expression (`AND` / `OR` / parentheses / `AND NOT`) is evaluated in Rust as set operations over each keyword's hit set. A standalone NOT is rejected.
- NOT operands must come from the **approved core-business exclusions**, otherwise the search is rejected with a clear message. This preserves the invariant.
- Per company:
  - matched keywords
  - hit count
  - **Match % = Σ weights of matched positive keywords / Σ positive weights × 100**
  - bm25 (used for ordering)
- Persisted in `mid_keyword_queries(query_id, run_id, rationale, keywords_json, expression, created_at, hit_count)` and `mid_keyword_hits(run_id, query_id, company_id, matched_json, match_pct, hit_count, bm25)`. Candidates are added in the same transaction.
- Grid columns: **MID query rationale**, with each matching query shown as "rationale (expression with keyword text)", plus matched keywords, best Match % and hits.
- **Local strategy** when no LLM is connected: derive 2–4 broad keyword groups from the approved definition, each with a rationale (`discovery-query.mjs` extended). `prompts/mid-search-planner.md` serves LLM Suite when connected.

### 2.3 Semantic score
- **`score_mid_semantic {run_id}`:** embed the approved criteria once with the "query:" prefix; for each candidate, cosine against its stored vector gives **MID semantic score = round(10·max(0, cos), 1)**, stored as `mid_semantic_scores(run_id, company_id, criteria_revision, score, cosine, model, computed_at)`. Without vectors or a model it returns status `skipped` with a reason.
- **`search_mid_semantic {run_id, rationale, min_score, limit≤5000}`:** optional semantic-only additions; streams vectors from SQLite.

### 2.4 ISCC
- Add `ECI` as an ECID alias (`data.rs:192-193`).
- Add `Relevancy Score` to the score keys (`providers.rs:977-985`), store it in 0–1 with 2 decimals and range-check it. Keep all of your listed columns in `row_json`, including `iQ Link`.
- Merge happens through identity: ECID first, then CID. MID and ISCC scores stay in separate columns; Source = MID / ISCC / Both.
- Add `search_iscc` to the bridge allowlist, gated to connected or simulated mode.

### 2.5 Rounds, score filters and histograms
- `screening_rounds(run_id, round_no, plan_id UNIQUE, provider, created_at)`, assigned when a plan is approved.
- `get_screening_grid` v2 adds keyword data, semantic score, ISCC score, and **per-round columns**: `R{n} LLM Suite score` / `R{n} M365 score`, rationale and other outputs, from `model_assessments`. Assessments orphaned by identity promotion are joined through company aliases.
- **Score filter kind:** numeric operators plus a bucket checklist 0…10, with **CHECK pinned at the bottom and selected by default**, so a numeric filter keeps CHECK rows unless you untick it. The comparator always sorts CHECK last.
- **`ScoreDistribution`** histogram above the grid (CSS/SVG, CPU-light):
  - buckets 0–10 plus CHECK for LLM/M365; 10 buckets for semantic (0–10) and for ISCC (0–1)
  - counts shown on the bars
  - clicking a bar toggles that bucket's filter, kept in sync with the column filter
  - can be minimized
  - each tab has a default metric: MID → semantic, ISCC → relevancy, All → latest round
- Companies tabs: **All · MID · ISCC**.
- Cells: coloured score pills (0–3 red, 4–6 amber, 7–10 green, CHECK neutral with a label), the semantic bar, and a dark keyword tooltip (matched keywords, rationale, query).
- **Rounds timeline** in Overview, e.g. "R1 LLM Suite · 2,500 → kept 400 (≥4 + CHECK)". In screening setup, the input picker labels prior-round results by round.

### 2.6 Simulated mode (dev only)
- `SCREENING_SIMULATE=1`: the bridge passes `MNA_SIMULATE=1` to Rust.
- A simulated provider in `providers.rs`/`gateway.rs` produces:
  - deterministic ISCC rows (from a fixture derived from MID plus synthetic rows)
  - LLM/M365 tables (score from a hash of company and plan, about 10% CHECK)
  - Bing leads
- Rows are flagged `simulated=1` (migration). The UI shows a "Simulated" badge and banner. Exports refuse simulated rows, or watermark them if explicitly allowed.

### 2.7 Tools and docs
- Update `tool-catalog.json`, `admin-tool-catalog.json` and `TOOL_REFERENCE.md` (via `build_tool_reference.py`), and `LLMSUITE_PROTOCOL.md`.
- Update `APPLICATION_FLOW_GUIDE.md` and `WORKFLOW.md` for: Intake Form, single approval, drop zones, PitchBook review, scores and rounds, Build Index.
- Update the READMEs and AGENTS.md.
- Fix stale counts: `scripts/verify.ps1:72` (65/19), `mna-tools/README.md:42`, the docs and VALIDATION files.

**Checkpoint 2:** full verification, then stop for your review.

---

## Execution with cheaper subagents
I orchestrate, merge, review and verify. **Sonnet** subagents implement and **Haiku** handles mechanical sweeps. Each gets its own worktree, owned files, acceptance criteria and the test/build commands. Waves within a phase run in parallel on disjoint files; I merge between waves.

- **Phase 1:**
  - **Wave 0** (me): setup.
  - **Wave 1:**
    - A: Rust import fixes, report and apply, criteria intake and exclusions, grid/detail tools, migration 008, tests
    - B: prompts directory, Node and Rust loaders, generated screening prompt, Bing fix, bridge prompt endpoints
    - C: UI shell fixes, HelpTip, Skeleton, motion, theme/Screen menus, dock rail, Activity dock merge, polling, dead code
  - **Wave 2:**
    - D: criteria single approval, versions, hidden action messages, Intake Form, DocumentWindow
    - E: drop chooser and zones, purpose-scoped bridge, FilesTab, PitchBookReviewDialog, import-pipeline rewrite
    - F: DataGrid v2, side panel, drawer; replace CompanyGrid, DataTable and ShortlistReview
  - **Wave 3:** Haiku does the DDI rename and doc count fixes; Sonnet does the copy sweep. Then I do integration, `/code-review high`, fixes and browser verification → **Checkpoint 1**.
- **Phase 2:**
  - **Wave 4:** G: migration 009 and the Build Index backend plus streaming upload (first, because it defines the schema). Then in parallel:
    - H: MID search v2, semantic scoring, grid v2
    - I: ISCC mapping, rounds, simulated mode
  - **Wave 5:** J: Build Index UI and Activity item; K: histogram, score filter/pills, tabs, rounds UI, keyword tooltip.
  - **Wave 6:** tool catalog and docs (Haiku), then my integration and verification → **Checkpoint 2**.

## Verification
- **Rust** (with `scripts/dev-env.ps1`): `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked`, and a release build (`--target x86_64-pc-windows-gnu`, the path the bridge expects).
- **UI:** `pnpm test`, `pnpm build`.
- **New tests:**
  - prompt conformance, sharing fixtures between Rust and Node
  - import never hides; report reasons
  - PBID replacement
  - no-op or ROGO import doesn't stale a plan
  - exclusions survive approval
  - criteria history and intake JSON
  - grid filter engine (CHECK default, buckets, operators)
  - drop-purpose validation and dedupe
  - Build Index on a small xlsx: FTS stem/exact, expression evaluation, Match %, cancel and resume
  - semantic `skipped` status
  - ISCC ECI alias and merge
  - simulated labelling and export refusal
- **Browser** (in-app browser, worktree instance on alternate ports), at 1440 / 1024 / 800 / 375 in light and dark. Walk the full target flow:
  1. new screening
  2. Intake Form (PDF opens automatically)
  3. single approval
  4. discovery
  5. grid filters, side panel, hidden toggle, drawer
  6. PitchBook zone and review modal
  7. setup preview showing the generated prompt with examples
  8. simulated round, histogram filtering, CHECK default
  9. export

  Phase 2 adds Build Index on a generated 150k-row synthetic xlsx to check performance and the ETA, and keyword rationale columns.
- **Audit re-check:** every bug in `docs/flow-audit/CURRENT_FLOW.md` §4 is confirmed closed.

## Risks and mitigations
- **Windows running out of memory during Rust builds:** `CARGO_BUILD_JOBS=2`, debug builds for tests, one release build per checkpoint.
- **Moving prompts out of code makes existing approved plans stale once:** documented. The worktree uses its own fresh `.screening-data`, so the DB in `outputs/` is never touched.
- **Migrations:** append-only, using ALTER ADD COLUMN.
- **150k rows × 768-dim embeddings on CPU:** streaming, hash-skip, honest ETA; skipped until a model is configured.
- **AG Grid Community has no side bar or set filter:** custom components. A client-side model with about 10k rows is fine.
- **Crescendo ID ⇒ CID:** confirmed by the analyst at Checkpoint 1; kept as a config alias.
