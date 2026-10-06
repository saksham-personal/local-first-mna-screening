# Screening UI validation

## Background screening, uploads, and research — 5 October 2026

The latest iteration adds a background controller for approved LLMSuite and
M365 jobs, automatic source imports, `/data` tables, and approved Bing research.
See [BACKGROUND_SCREENING.md](BACKGROUND_SCREENING.md) for behavior and
[the implementation record](../mna-tools/IMPLEMENTATION.md) for backend evidence.

| Check | Result |
|---|---|
| UI tests | **100 passed**, zero failed or skipped |
| TypeScript and production build | Passed; the existing large-chunk advisory remains for lazy grid/diagram bundles |
| Backend checks | **107 Rust tests**, format, strict lint, release build, and isolated executable HTTP smoke passed |
| Catalogs | **65 agent tools / 19 privileged operations**; generated schemas, examples, Markdown links and three workbook layouts verified |
| Independent review | **GPT-6.1 Sol** reviewed lifecycle, replay, query construction and UI integration; confirmed findings were corrected |
| Live corporate execution | Disabled; connected behavior is validated with loopback mocks only |

The browser check uploaded fictional PitchBook data before its mapping CSV,
plus a ROGO CSV, before companies existed. Header detection staged them without
a chat message or approval. The approved example performed 31 actual local
tool calls and returned seven companies. The grouped import then hydrated one
PB identifier, one PB record and one ROGO record, with no unmatched or
quarantined rows. The side panel showed source summaries rather than imported
file lists or duplicate company tables. `/data` displayed the saved projection
in AG Grid, including labeled PB/MID descriptions and blank unavailable fields.

Separate LLMSuite and M365 approvals created four and three background batches.
Both appeared in the progress dock and correctly reported no request sent while
disconnected. The Bing dialog expanded four questions for seven companies into
28 exact queries; approval saved an `executed:false` handoff without search
results. Retry, pause-before-send, lease recovery, ambiguous-attempt protection,
offline partial staging and the shared seven-send gate are covered by local
automated tests rather than claimed live corporate calls.

Browser testing found and corrected an existing discovery failure: the example's
`Exclude` clause was being sent as query syntax. Both discovery paths now use
the same positive core-business query and pass only approved business exclusions
separately. Additional final corrections preserve CSV blanks, update filtered
row counts, remove recognized imports only from the composer copy, and keep
company-template and general Bing drafts separate. Background pulses use
opacity-only ease-in-out fades and honor reduced motion.

GPT-6 Sol contributed backend and import work; GPT-6 Luna contributed bounded
UI work. The integration owner completed the source integration, regression
checks, and browser verification. No DeepSeek or Terra agents were used.
Changed source is concentrated in the bridge, background/research controllers,
shared discovery and import clients, chat artifacts and tables, setup/research
dialogs, and background dock; backend changes add header inspection, compact
progress, and controller-only safe retry. No new production dependency was added.

Final automated logs are `work/background-ui-final-tests.log`,
`work/background-ui-final-build.log`, `work/background-rust-tests.log`, and
`work/background-clippy.log`. Release proof is in
`work/background-release-smoke/proof.json`; browser diagnostics remain under
`output/qa` and `.playwright-cli`, outside source archives. A UI automation
infrastructure failure required switching from the in-app browser tool to the
Playwright CLI. No application exception was identified by that failure.

Full LLM chat orchestration, production multi-user scheduling/identity and real
provider deployment contracts remain planned or unverified. Original spreadsheet
references and background controls persist; discovery queue state remains
process-local.

The final upload check confirmed that a recognized ROGO sheet disappears from
the composer and leaves Send disabled, without adding a raw file entry to chat.
It also invalidated the older provider input snapshots as expected. A filtered
one-row CSV contained blank PB fields rather than presentation dashes. The dark
desktop layout and 390×844 mobile layout were visually checked; mobile document
width and scroll width were both 390 pixels. Separate company/general Bing
drafts were checked through the dialog. A browser selector initially used the
wrong input role and was corrected; the application filter itself passed.

The controlled restart exposed and corrected a recovery display issue: stale
plans could fall back to an empty snapshot and lose Copilot's provider or batch
count. The controller now saves the initial compact snapshot and reads durable
historical progress after staleness. A stale plan remains blocked even if all its
batches succeeded; completed counts and actual execution history remain visible.
The additional regression verifies temporary disconnection, durable STALE status,
all-success stale jobs, and denial of further staging or dispatch. Earlier
validation below is retained as history.

## Result

This UI iteration was validated on 4 October 2026. Independent source review
found no remaining verified blocker, including the final dropdown layer
correction. The local preview used was `http://127.0.0.1:4173/`.

| Check            | Result                                                                                                                                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Automated suite  | 63/63 tests passed, with no failures or skipped tests. The six added tests cover attachment validation and staging, presentation copy, supporting-file preservation, and explicit criteria revision. Existing approval, isolation, import, export, cancellation, recovery, and archive regressions remain covered. |
| TypeScript       | `tsc --noEmit` passed as part of the production builds.                                                                                                                                                                                                                                                            |
| Production build | Vite 7.3.6 transformed 4,975 modules; the latest build passed in 43.34 seconds. The main app is about 490 kB / 152 kB gzip. Lazy AG Grid and Mermaid chunks, plus the assistant-ui chunk, produce the large-chunk advisory.                                                                                        |
| Source review    | Independent review approved after verified corrections. The integration owner performed builds, tests, and browser verification.                                                                                                                                         |
| Browser checks   | The production build passed the example, shared composer, expanding dock, attachment, PDF, responsive-layout, and nested Escape checks. See the confirmed behavior below.                                                                                                                                          |
| Design checks    | The Impeccable workflow was applied to the changed UI. The final light/dark desktop and mobile screenshots were inspected. Brown branding remains `#8F5A39`; semantic source, success, warning, and error colors remain distinct.                                                                                  |

## CPU-friendly animation follow-up

The user requested ordinary CPU-compatible animations, then explicitly asked to retain looping status pulses. Pulses remain infinite opacity-only ease-in-out loops. Loaders share one smooth linear `ui-spin` rotation (one second per turn). Menus and the log backdrop retain short opacity fades; panel sliding, backdrop blur, brightness filters, animated shadows, and AG Grid row movement were removed. PDF.js explicitly disables hardware acceleration and uses a standard readback-friendly 2D canvas. Reduced-motion disables animations and transitions while leaving status text and colors visible.

Independent source review found no verified blockers. Changed files include
the application styles, company grid, and PDF preview. DESIGN, UI_GUIDE, and
this validation record were updated; no dependencies or tool APIs changed.

The production UI was tested in the installed Chrome browser with `--disable-gpu --disable-webgl --disable-webgl2 --disable-accelerated-2d-canvas`. Separate new canvases could create neither WebGL 1 nor WebGL 2 contexts; ordinary 2D canvas remained available. The approved example completed and returned seven companies. During a controlled delay of the real job-creation request, the visible running pulse reported `ct-pulse`, 1.5 seconds, `steps(8)`, infinite iterations, and no box shadow; its opacity changed from 1 to 0.93125. Emulating reduced motion changed its animation name to `none`. The held request was released, and discovery completed normally.

The grid rendered seven rows with all five headers and no row-animation class. The log backdrop had no filter and the log drawer had no animation. The public workflow diagram rendered as SVG. A two-page PDF rendered using `CanvasRenderingContext2D`, with `willReadFrequently: true`; page navigation, rotation, zoom, and Fit width worked. At 390x844, the PDF preview had no page-level horizontal overflow. The browser checks reported no application page exceptions. These checks confirm operation without graphics acceleration; they do not claim a frame-rate benchmark for every CPU.

The production build and complete 63-test regression suite passed; no new tests were written for the presentation-only changes. The first build was interrupted between user turns and was rerun. The first test-browser launch requested an uninstalled bundled Chromium; it was corrected to use the installed Chrome channel without downloading a browser. The local preview was restarted after the earlier process ended. Final successful build/test logs, launch configuration, and the mobile screenshot are under `output/qa/cpu-*`; these diagnostics and browser data are excluded from the source ZIP.

## Confirmed behavior

- There is one Workspace button, in the header view switch. Commands is an action picker; Prompt library has five editable starting prompts. Using a prompt fills the composer without sending a message. The screening rename control uses a form instead of a browser prompt.
- The approved example completed 31 real local tool calls and returned seven fictional MID companies. The production company grid shows Company, Source, HQ location, MID score, and ISCC score. Source scores are never combined. User-facing example and service labels contain no Rust wording; raw technical records and exported data remain intact.
- The same chat composer persists across Chat and Workspace. At 1,595px, expanding the dock changed its width from 390px to approximately 747px and kept the draft. Restore and Open full chat use the same conversation.
- AG Grid Community provides sorting, column filtering, resizing, keyboard selection, and 25/50/100-row pagination. An MID score filter of 0.9 changed the summary from 7 of 7 to 0 of 7; clearing it returned all seven. All five headers fit the desktop table. Exports remain scoped to the entire current company set, independently of grid filters and pagination.
- File drags show a drop overlay listing accepted formats and the 20 MB limit. A drop on Workspace attached a valid PDF and reported `bad.exe` with a filename-specific format error. The chat had six messages before and after that drop: no message or approval was sent. Empty, unsupported, and oversized attachments are rejected by the shared policy.
- Sending a supporting PDF with a short note retained the seven companies and approved criteria. Automated tests also confirm that an explicit new business request with an attachment creates an unapproved criteria revision instead of silently preserving an old approval.
- Pending PDFs can be previewed before sending. Saved PDF artifacts read their original bytes from the staged-file endpoint. Previewing from Workspace opens Chat beside the reader; a view switch closes the preview. Page navigation, page entry, zoom, fit width, rotation, expand/restore, open/download, and retry controls are available.
- A fixture with intrinsic 90-degree rotation rendered page two at approximately 522 by 369 CSS pixels. Applying a further 90-degree rotation changed it to approximately 522 by 739. Rapid zoom changes followed by Fit width completed without a page exception. Expand uses an accessible modal dialog, keyboard focus wraps inside it, and Escape restores the sidebar.
- A malformed PDF showed a readable Preview unavailable error; Try again reproduced that error without a crash. The malformed-fixture checks emitted two expected PDF.js indexing warnings, with no application page exceptions. Its original can still be downloaded.
- The PDF reader was checked in light and dark desktop layouts and at 390x844 mobile. Mobile had no page-level horizontal overflow. It fills the available panel, with scrolling for zoomed pages. The worker, standard fonts, character maps, and codecs are served locally; no PDF service or CDN is required.
- Session timing has separate colors for messages, tools, approvals, files/results, and errors. Only recorded durations become spans; events without a duration use point markers. The selected-turn/all-events control and log filters use shared styled Select menus. With a menu open, the first Escape dismisses that menu and leaves the log open; a second Escape closes the log.

Prior manual checks of company workbook columns, compatible PitchBook/ROGO imports, message queues, tool error/retry, session exports, and archive byte preservation remain recorded in the earlier validation artifacts. The complete automated suite was rerun in this iteration; those manual scenarios were not all repeated.

## Corrections and failed checks

The source review found and corrected three issues: intrinsic PDF rotation had to be combined with the viewer rotation; Session log's capture-phase Escape handler had to yield to an open Select portal; and the visible grid count had to include AG Grid column filters. The integration owner also corrected source-badge sizing, company column widths, and supporting uploads that could unintentionally replace approved criteria.

The final visual check found that Select portals were below the session-log
layer. Their layer order was raised, then pointer checks confirmed that the
Kind, Status, and Timing range menus stayed visible above the modal and left
the log intact after dismissal.

One production build stopped in esbuild transpilation with `The service was stopped`. The test browser and extra development server were closed, and the build succeeded with `GOMAXPROCS=2`. This was a transient build failure; no claim is made about its unconfirmed operating-system cause. No build warning was suppressed. Two browser scripts used incorrect accessible names or selectors and were corrected. Development configuration changes also caused expected Vite reloads. Successful final production checks reported no application page exceptions; this does not erase earlier diagnostic failures.

## Ownership, architecture, and files

The integration owner kept assistant-ui as the chat runtime and added reusable Radix Select and file-drop controls. AG Grid and PDF.js are lazy feature modules; there is one active composer and no second workspace agent. Pending preview URLs are owned by the app, PDF viewer resources and render tasks are cleaned up on file changes or unmount, and exported raw records are not rewritten by presentation-copy cleanup.

The UI changes and documentation were reviewed and validated locally. No
external research or model provider was invoked.

New source files: `src/ui/SelectField.tsx`, `src/ui/FileDropArea.tsx`, `src/ui/controls.css`, `src/files/PdfPreview.tsx`, `src/files/pdf-preview.css`, `src/workspace/CompanyGrid.tsx`, `src/workspace/company-grid.css`, `src/lib/attachment-policy.ts`, `src/lib/product-copy.ts`, `src/lib/prompt-library.ts`, `server/pdf-assets.ts`, and `tests/attachment-ui.test.ts`.

Updated integration files: `src/App.tsx`, `src/WorkspaceApp.tsx`, `src/SessionLog.tsx`, `src/chat/ChatThread.tsx`, `src/chat/ArtifactCard.tsx`, `src/chat/MarkdownMessage.tsx`, `src/chat/SessionTiming.tsx`, `src/main.tsx`, `src/lib/chat-contract.ts`, `src/lib/chat-driver.ts`, `src/lib/chat-jobs.ts`, `src/lib/chat-policy.ts`, `src/lib/tool-workflow.ts`, `src/lib/assistant-driver.ts`, `src/AssistantPanel.tsx`, `src/theme/ThemeMenu.tsx`, `src/workspace/workspace.css`, `tests/chat-regression.test.ts`, `vite.config.ts`, `package.json`, and `pnpm-lock.yaml`. The dependency additions are AG Grid Community/React 36.2.0, PDF.js 6.3.289, and Radix UI 1.6.7. No backend tool API or Rust implementation change was needed for these UI requests.

README, DESIGN, UI_GUIDE, ELEMENT_COVERAGE, this record, and the sibling TOOL_REFERENCE UI integration section describe the settled behavior. `public/examples/screening-brief.pdf` is a two-page fictional preview sample. Final screenshots and the production build log are under `output/qa`; prior validation remains under `output/playwright`. The source ZIP excludes dependencies, build output, screenshots, test-browser state, staged uploads, and local databases.

Commands used include `npm.cmd test`, `npm.cmd run build`, the Playwright CLI `run-code`/`upload`/`snapshot` commands, read-only `rg` and PowerShell source inspection, the cached Prettier formatter, and `node work/make-ui-zip.mjs` for the source archive.

## Remaining integration limits

The local assistant uses deterministic rules and real local operations on fictional MID fixtures. External LLM inference, Bing search, ISCC, LLMSuite, M365 Copilot, and external subagents remain unconnected. Bing prepares fit questions only. These UI changes do not add external service connections.

PDF preview renders original pages but does not provide selectable text, text extraction, OCR, or an embedded password-entry workflow. DOCX originals are retained without text extraction. UTF-8 TXT may seed a local criteria excerpt. Company notes are browser-local annotations. Live jobs and uploaded-file references are process-local; completed tool data and checkpoints persist. Full ZIP requires the local server and every declared original and enforces a 40 MB aggregate upload limit. Markdown and JSONL omit file bytes. This prototype has no production multi-user tenancy or authentication layer.

## Message copy feedback follow-up

The shared message Copy button now shows a check mark and a "Copied to clipboard" tooltip for two seconds after a successful clipboard write. It uses assistant-ui's `isCopied` state for both user and assistant messages. The production TypeScript/Vite build passed. Browser checks confirmed that the actual clipboard text matched the message, the icon reset after two seconds, and a denied clipboard write did not show success. No dependencies or backend behavior changed. Diagnostics are saved under `output/qa/copy-feedback-*` and are excluded from the source archive.
