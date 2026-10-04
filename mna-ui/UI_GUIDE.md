# Screening chat guide

## Prepare LLMSuite or M365 work

Use **Screen / ask** in the header, choose a provider, then choose company screening or a question. The same setup opens from a chat recommendation or a direct request such as “Ask M365 which products each company offers.” It reads the saved company set and does not send a provider request.

Review the input chips. **index** stays pinned. Use **Add sources** to inspect MID, current-screening ISCC, PitchBook, and ROGO columns with actual coverage counts and examples. Name and website independently prefer usable PB, MID, then ISCC values. Description combines the selected source descriptions with labels. Source-specific fields stay blank for companies without that source. LinkedIn is optional and comes from genuine PB data.

Upload mapping CSVs and PitchBook workbooks, or ROGO files, directly inside the source picker. File names do not determine their role. **Upload and populate** imports the pending files, reports matching counts in chat, and refreshes the picker. Uploads invalidate the previous preview.

Edit the requested output columns, prompt, deployment, and batch size. Suggestions currently use a local template; the deployment remains an editable field because model names will be supplied later. **Generate preview** shows real projected values. **Approve and save setup** approves the exact backend digest and stores frozen inputs, the index-to-company mapping and durable jobs, adds a chat artifact, and records tool calls in Session log. Editing any setting requires a new preview. Use **Edit a new version** on a saved card to prepare another setup.

The backend LLMSuite gate shares seven actual sends per rolling minute across reasoning, subagents, questions, batches, and retries. M365 has a separate provider path. Corporate execution remains disconnected in this UI; the backend adapter and durable execution contracts are implemented but unverified against live providers. See [SCREENING_SETUP.md](SCREENING_SETUP.md) for contracts, diagrams, and current limits.

## Navigation and chat controls

| Where                 | What it does                                                                                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **New screening**     | Opens a blank screening conversation. Existing screenings are listed in the left navigation; search filters their titles.                                                                                                                        |
| **Chat / Workspace**  | The header is the only view switch. Workspace shows Overview, Companies, and Files for the selected screening, alongside the same mounted chat on desktop. Expand or restore its dock, or open full Chat; the composer and running turn persist. |
| **Appearance**        | Choose Light, Dark, or System in the shared header. The preference is saved in this browser; System follows the operating system.                                                                                                                |
| **Screening context** | Shows current criteria, approval, company and file counts, runtime, source-score policy, and excluded reference details. It is workspace state, not a model token meter.                                                                         |
| **Files and results** | Opens saved file, criteria, company, handoff, and checkpoint artifacts.                                                                                                                                                                          |
| **Background runs**   | Lists local discovery jobs across screenings. A running job can be stopped here.                                                                                                                                                                 |
| **Session log**       | Opens the complete local event ledger, timing view, event inspector, and export controls.                                                                                                                                                        |
| Composer `/`          | Filters supported local commands as you type; choosing one runs that action immediately. `Ctrl+K` opens the searchable Commands dialog. Prompt library is a separate dialog for drafting text.                                                   |
| Prompt library        | Choose and edit a template, then **Use prompt** inserts it into the composer. It does not send automatically.                                                                                                                                    |
| Composer `@`          | Filters saved companies after discovery; selecting one asks for that company’s local context.                                                                                                                                                    |
| Attach files / drop   | Adds PDF, DOCX, TXT, CSV, or XLSX files up to 20 MB each to the active chat. Invalid files show an attachment error. Dropping on the main content area does not send or approve; review and send from the composer.                              |
| Runtime selector      | Shows Local tools as active. Other listed providers are marked not connected.                                                                                                                                                                    |

Message actions include copy, edit and resubmit for user messages, and copy, retry, and Markdown export for assistant messages. The composer can queue messages while a turn is running. The queue sends them after the current turn and lets you remove queued items. Stop preserves completed tool calls and Rust writes. Shared select controls work with keyboard navigation and adapt to light and dark appearance.

## Criteria and search

Describe products, services, and customer workflows in plain text, or attach a UTF-8 TXT file to seed a local criteria draft. Review the business-definition card before searching. The current criteria revision must be approved; editing criteria clears its approval and the displayed company set.

Choose **Run the example** or type `/example` for fictional insurance software criteria. Approving that card starts the real local Rust workflow against fictional MID data. Each tool call appears with its actual arguments, result, status, and measured duration. The company and checkpoint artifacts arrive when the background job completes. A running job can continue while you view another screening or reload the browser if the local server stays available. Jobs are process-local and do not survive a local-server restart; saved Rust checkpoints can still be read. The compact **Preparing this step** indicator is only shown during a running turn and clears on completion.

MID and ISCC source scores remain separate. The current local example searches MID; ISCC is unavailable and no ISCC results are fabricated. Financials, size, geography, ownership, and industry codes are reference details, not search filters.

## Commands and artifacts

| Command       | Behavior                                                                                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/example`    | Creates a fictional criteria draft for review. You must approve it before discovery.                                                                                                |
| `/criteria`   | Shows the current criteria and decision state.                                                                                                                                      |
| `/companies`  | Shows the saved company list and workbook exports.                                                                                                                                  |
| `/plan`       | Shows next-step options. Completion also offers **Choose the next step**; **Not now** defers. Choosing an option records the decision; only connected local file workflows proceed. |
| `/memory`     | Reads saved company context from local Rust data, including the business description and a collapsible **View saved context** disclosure.                                           |
| `/flow`       | Shows a public process diagram and step list, not hidden reasoning or a live execution graph.                                                                                       |
| `/checkpoint` | Reads the saved Rust checkpoint. It does not restore or roll back application state.                                                                                                |
| `/export`     | Opens **Session log**.                                                                                                                                                              |

Criteria approval starts local discovery. PitchBook and ROGO options create file handoffs. Their sample downloads are `public/examples/pitchbook-mapping.csv`, `public/examples/pitchbook-data.xlsx`, and `public/examples/rogo-data.xlsx`; `public/examples/criteria.txt` is also available. With a completed run and approved criteria, compatible CSV/XLSX files are imported and matched against saved company records. The file parser identifies roles from headers instead of filenames. PitchBook may include a mapping CSV and multiple data workbooks; ROGO workbooks need a Website column. Import results include matched and unmatched counts. Uploads staged in Workspace keep their original bytes and appear as artifacts when you return to Chat. The Files tab opens the same assistant-ui file picker used by the chat composer. On mobile, choosing files opens Chat automatically so you can review and send the attachments.

Bing creates draft fit questions only; no live search occurs. LLMSuite and M365 Copilot are unavailable. The company context returned by `/memory` is a saved local record, not persistent model memory or vector retrieval.

## Workspace review

**Overview** shows the current criteria, approval, source counts, search status, and next-step recommendations. An approval or option in this view uses the same chat action and session log. Editing criteria clears the current companies and requires approval again; historical artifacts remain in chat.

**Companies** shows the current result set in AG Grid Community. Sort columns, filter values, resize columns, navigate rows with the keyboard, and select 25, 50 (default), or 100 rows per page. Search and source filters narrow visible rows; the table keeps MID and ISCC scores in separate columns and opens a company detail view with both scores, its description, identifiers, website, LinkedIn URL, and analyst notes. Notes are browser-local annotations; **Save notes** reports whether storage succeeded. **Ask agent** reads that company's saved local context. Workbook exports retain the full current result set, including rows hidden by filters or pagination.

PitchBook, LLM, and Full data exports use the entire current result set, including rows hidden by the table filter. Chat result-card exports use the set attached to that card, so earlier results remain reviewable. Changing a screening's criteria cannot cause Workspace to export an older result set.

**Files** shows each upload's artifact and import status. **Choose files** opens the chat attachment picker. You can also drop files anywhere on the main content area. Attachments appear in the active chat composer and require an explicit send; dropping neither sends nor approves anything. A pending PDF attachment can be previewed before sending. Saved PDF artifacts open a local PDF.js preview with page navigation and number entry, fit width, 25–300% zoom, rotation, expand/restore, open/download, and retry controls. It renders original bytes without text extraction or text selection. DOCX originals are retained without text extraction.

## Session log and exports

The session log records messages, workspace actions, approvals, uploads, tool calls, results, failures, cancellations, and artifacts. Select an event to inspect its summary, inputs/outputs, or timing. Search matches event text and recorded data; kind and status filters affect only the visible ledger. **Follow latest** controls whether new events scroll into view. Earlier events load in pages of 100.

The DeepSeek-inspired log experience is limited to turn-grouped event inspection and a timing overview of recorded spans. Timing defaults to **Selected turn**; **All events** is available, and each recorded event can be selected. The timing view uses multicolor event markers, plots durations only where timing data exists, and shows errors in semantic error styling. On mobile, **Activity** and **Record details** switch between the ledger and five detail tabs. It is a flat local event view, not a nested trace tree or a DeepSeek Harness session runtime. The ledger is stored in browser local storage. The process-local job server supplies live run state while it is available.

Markdown and JSONL exports contain the recorded session history but not original file bytes. **Full ZIP** contains every session event (including events hidden by current ledger filters), the transcript, manifest, and actual declared upload bytes fetched from the local file endpoint. ZIP requires the local server and every declared file to still be available; it is limited to 40 MB of combined upload bytes. If the server or an upload is unavailable, the export reports an error and Markdown/JSONL remain available.

Company workbook exports are separate from session exports. PitchBook includes `pk`, company name, website, headquarters city/state, and source. LLM includes index, `pk`, company name, website, source, and description. Full export keeps original MID and ISCC source rows in separate sheets with `pk` first.

## Accessibility and service boundaries

Navigation, composer controls, artifact actions, status messages, dialogs, and session-log event rows have accessible names or status labels. Dialogs close with Escape and keep focus within the open dialog. Keyboard focus is visibly outlined.

The local assistant uses deterministic rules; it does not call an LLM. No external subagents are connected. PDF originals can be viewed locally but their text is not extracted; DOCX originals are staged without text extraction. A UTF-8 TXT excerpt can seed local criteria drafting without an LLM. External provider names in menus and handoffs identify integration boundaries, not running services.

Supporting files sent with a short note preserve the current screening. To revise the criteria, use **Edit criteria** or explicitly describe the new business to find. Previewing a PDF from Workspace opens Chat beside the document; changing views closes the preview. `public/examples/screening-brief.pdf` is a two-page fictional sample for trying the reader.

Animations are deliberately light: short fades, small stepped loaders, and looping status pulses. The interface works without WebGL or browser graphics acceleration. If reduced motion is enabled in your operating system, motion stops while status labels and colors remain visible.
