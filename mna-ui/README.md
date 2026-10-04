# Screening

A local, chat-first M&A company-screening workspace. The assistant-ui conversation is the main work area; criteria, company results, tool calls, files, and checkpoints appear as reviewable artifacts. The interface uses Geist for working text, Manrope for headings, neutral surfaces, and restrained `#8F5A39` accents. Light, Dark, and System appearance apply to the entire workspace.

## Run locally

The **Screen / ask** menu now prepares LLMSuite or M365 screening and general questions. Review inputs, source fields, inline enrichment uploads, prompt, output columns, deployment and batch size, then preview and save an immutable setup. See [SCREENING_SETUP.md](SCREENING_SETUP.md) for the complete flow. Provider execution remains disconnected. The [backend architecture](../mna-tools/docs/BACKEND_ARCHITECTURE.md), [proposal critique](../mna-tools/docs/ARCHITECTURE_CRITIQUE.md), and [offline LangGraph scaffold](../mna-orchestrator/README.md) describe implemented preparation and later execution separately.

Use Node.js 22+ and pnpm. The Rust executable must exist at `../mna-tools/target/x86_64-pc-windows-gnu/release/mna-tools.exe`, or set `SCREENING_RUST_BINARY` to its absolute path. See the sibling Rust project for its build instructions.

```sh
pnpm install --store-dir .pnpm-store
pnpm test
pnpm build
pnpm start
```

Open `http://127.0.0.1:4173/`. For development, use `pnpm dev` (port 5173). `pnpm start` launches the production preview and local Rust bridge together. `pnpm preview` serves only the UI, without its Rust tools.

The bridge binds to localhost, generates server-only credentials, and disables external providers. Rust data is stored under `.screening-data/`; keep that directory out of source archives. Browser chat transcripts and screening state use local storage. Uploaded originals and process-local running jobs remain on the local server.

## Try a screening

1. Select **New screening**. Describe the company’s core products or services, or select **Run the example**. `/example` creates a fictional insurance-software criteria draft.
2. Review and edit the criteria card, then choose **Approve criteria**. Approval applies to that criteria revision; editing it clears the approval and displayed result set.
3. The approved search runs the real local Rust workflow against fictional MID data. Tool calls, arguments, results, statuses, and recorded durations appear in the chat and **Session log**. ISCC, web research, LLM screening, and M365 Copilot are not simulated.
4. When the run completes, the chat offers **Choose the next step**. **Not now** defers; PitchBook and ROGO continue through local file imports. **Prepare Bing research** opens draft questions with a **Draft questions** action; it does not search the web. `/memory` reads saved company context, `/flow` shows the process map, `/checkpoint` reads saved Rust progress, and `/export` opens the session log.
5. To import fictional enrichment examples, choose **Add PitchBook data** from the next-step options, then attach `public/examples/pitchbook-mapping.csv` and `public/examples/pitchbook-data.xlsx`. For ROGO, attach `public/examples/rogo-data.xlsx`. `public/examples/criteria.txt` is available as a local criteria sample. With a completed Rust run and approved current criteria, compatible CSV/XLSX uploads are imported and matched to the saved candidates.
6. Export company workbooks from a company-list artifact. Export the complete session as Markdown, JSONL, or **Full ZIP** from **Session log**. Full ZIP includes the actual original upload bytes while they are available from the local server.

The header switches between Chat and Workspace; the duplicate Workspace entry in the navigation is removed. Workspace has Overview, Companies, and Files tabs plus the same mounted chat runtime docked on desktop. Expand or restore the dock, or open full Chat, without losing the active composer or running turn. File drops anywhere in the main content area attach to the active chat through its attachment adapter. Attachments wait for review and an explicit send; dropping files does not send a message or approve a search. PDF, DOCX, TXT, CSV, and XLSX files up to 20 MB each are supported. Pending PDFs can be previewed before sending, and saved PDF artifacts open in the local PDF.js viewer. The company table supports sorting, filters, resizing, keyboard navigation, virtualization, and 25, 50, or 100 rows per page (50 by default); exports still use the full result set. The local job can continue while you switch screenings or reload the page as long as the local server remains up. A server restart ends its running jobs; completed Rust writes and checkpoints remain available.

The Session log is a local, turn-grouped event and timing inspector inspired by agent-harness observability patterns. On mobile, **Activity** and **Record details** keep the ledger navigable; timing defaults to **Selected turn**, and recorded events can be selected for inspection. It is not a DeepSeek Harness backend or nested trace tree. Full ZIP fetches actual original uploads from the local server and retains all events even when the visible ledger is filtered; Markdown and JSONL preserve the event history without file bytes.

## Screening policy

Discovery uses the approved core business description. Financial size, geography, ownership, and industry classifications stay visible as reference details and do not filter the search. MID and ISCC scores are presented separately; the UI does not average them or convert them into a fit score.

## Current integration limits

The chat assistant uses deterministic local rules and real Rust calls; it does not call an LLM. The interface reports zero connected external subagents. Bing questions can be drafted, but no web search runs. LLMSuite, OpenAI, DeepSeek, M365 Copilot, and ISCC are not connected. PDF and DOCX files can be staged as artifacts, but their text is not extracted here. UTF-8 TXT can provide a local criteria draft excerpt; that is not model inference.

The PDF viewer renders local original bytes with page navigation, page number entry, fit-width and 25–300% zoom, rotation, expand/restore, open/download, and retry states. It does not extract text or provide a text-selection layer. The local Rust workflow runs on fictional example data. This is a prototype without production multi-user authentication or tenancy. See [UI_GUIDE.md](UI_GUIDE.md), [DESIGN.md](DESIGN.md), [ELEMENT_COVERAGE.md](ELEMENT_COVERAGE.md), and [VALIDATION.md](VALIDATION.md) for operation, architecture, component coverage, and current verification status.
