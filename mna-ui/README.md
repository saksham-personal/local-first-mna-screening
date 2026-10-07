# Screening

A local, chat-first M&A company-screening workspace. Criteria, companies, source files, research, screening setups, tool calls, and checkpoints appear as reviewable chat cards. Workspace tabs show the same saved project state. The local example searches fictional MID companies through the local service. ISCC and live LLM Suite, M365, and Bing providers are disconnected by default.

## Run locally

Use Node.js 22+ and pnpm. The Rust executable must exist at `../mna-tools/target/x86_64-pc-windows-gnu/release/mna-tools.exe`, or set `SCREENING_RUST_BINARY` to its absolute path. See the sibling Rust project for build instructions.

```sh
pnpm install --store-dir .pnpm-store
pnpm test
pnpm build
pnpm start
```

Open `http://127.0.0.1:4173/`. Use `pnpm dev` for port 5173. `pnpm start` launches the UI and the local Rust bridge. `pnpm preview` serves only the UI. The bridge binds to localhost, generates server-only credentials, and disables external providers unless explicitly configured. Rust data and uploaded originals live under `.screening-data/`; browser chat presentation state uses local storage. Keep `.screening-data/` out of source archives.

## Follow a screening

1. Select **New screening**, describe the core business, or use `/example` for fictional insurance software criteria. A UTF-8 TXT file can supply a draft. Files can be stored and previewed. The Intake Form opens PDFs and pre-fills fields by label; check each field. Full parsing is deferred.
2. Review the business criteria. Enter optional good-fit and bad-fit examples in separate boxes, or skip. Review and approve the final criteria. Drafts are saved as backend revisions before discovery. Editing criteria later creates a new revision and requires another approval.
3. Search fictional MID data. The local example uses local search tools and saves candidates in the approved run. It can search again without replacing original company data or prior hidden decisions. ISCC is a configured external gateway, not simulated in this example. `/data` shows saved source columns; tool calls and timing appear in **Session log**.
4. Review the company list. Counts and recommendations use companies still **considered**. Hidden companies remain in the saved history. Use **Company enrichment** for PitchBook/ROGO files or **Research and screening** for LLM Suite, M365, and Bing. Both groups can be opened at any time.
5. Import PitchBook mapping and data files or a ROGO workbook through the enrichment drop zone. Example files are in `public/examples/`. A new PitchBook mapping can hide unmapped or `Company Profile = No` companies; review and restore any company you want to keep. A separate ROGO upload adds context without reapplying an old mapping exclusion. File drops add source context and do not run a provider screen.
6. Prepare scored screening with input/output column chips and an editable prompt. You can ask for an AI prompt draft when a provider is connected. Preview exact rows and approve the saved plan. The model field can stay automatic: the bridge binds a configured deployment when present, or records `automatic` with `executed:false` while disconnected. A disconnected plan sends nothing. See [SCREENING_SETUP.md](SCREENING_SETUP.md) and [BACKGROUND_SCREENING.md](BACKGROUND_SCREENING.md).
7. Ask LLM Suite or M365 Copilot a direct question by choosing it in the composer's runtime selector (no screening setup needed). Chat-purpose files are included by default; turn off the provider toggle on any file you want to omit. Without a provider connection, the response states `executed:false`.
8. For Bing, edit one to five query chips or request AI query suggestions when connected. Preview the exact request count. Company research covers every considered company. The client sends up to 100 requests per page and continues through the approved list. Findings are source-linked, unverified leads. Without Bing configuration, approval saves the plan but sends no queries.
9. Review scores and source evidence. Keep strong matches and `CHECK` cases; hide other companies. Select saved RESULTS columns for another screening, add context, search again, or revise criteria. Export only considered companies as PitchBook, LLM, or Full XLSX. Hidden rows remain available for restoration.

The UI suggests PitchBook and Bing when `0 < n < 1000`, ROGO when `500 < n < 2000`, LLM Suite when `n > 2000`, and M365 when `0 < n < 250` with PitchBook context. These comparisons use the current considered count `n` and are strict. **Research and screening** opens first when `n > 5000`, after PitchBook, ROGO, or Bing data is added, or when `0 < n < 500`; otherwise **Company enrichment** opens first. Uploads remain available when their group is collapsed. For example, review can narrow 2,500 companies to 400, then 150, then 55. The UI does not remove companies to meet those numbers.

## Local behavior and limits

The chat assistant uses local rules and calls the local service; it does not call an LLM by default. External services are disconnected by default. When a provider is configured, the provider controller enforces exact approval and plan freshness, parses responses strictly, allows at most two repairs, and shares a seven-send-per-minute LLM Suite limit across purposes. An approved setup starts with `executed:false`; live corporate/provider operation has not been verified. MID and ISCC retrieval scores, provider screening scores, and query scores stay separate.

CSV/XLSX uploads are inspected by their headers and matched to saved candidates. PDF, DOCX, TXT, CSV, and XLSX files can be staged up to 20 MB each. Original uploads and their index persist on the local server. Background execution controls and Rust provider jobs survive restarts; a running UI discovery job is process-local and stops on server restart. Completed Rust writes and checkpoints remain. The **Session log** shows events, timing, and downloads. Full ZIP includes original upload bytes while available; Markdown and JSONL preserve event history without those bytes.

The company table supports sorting, filters, resizing, keyboard navigation, virtualization, and 25, 50, or 100 visible rows per page. A page size does not limit the saved run or export. The Intake Form opens PDFs and pre-fills fields by label; check each field. Full parsing, production multi-user authentication, live provider configuration, large-corpus Arctic retrieval validation, a selected reranker, and durable LangGraph integration remain future work.

See [the workflow](../mna-tools/docs/WORKFLOW.md), [backend architecture](../mna-tools/docs/BACKEND_ARCHITECTURE.md), [UI guide](UI_GUIDE.md), and [validation record](VALIDATION.md).
