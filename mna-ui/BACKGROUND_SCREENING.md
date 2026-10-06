# Background screening, imports, and grounding

## What is implemented

The approved LLMSuite or M365 setup creates immutable jobs in the local database. The UI submits the approved plan ID and digest to the background controller. It does not send company IDs or an editable prompt directly to a provider. The application remains usable while batches run: analysts can change views, open another screening, upload files, or continue chatting.

The bottom-right panel displays recorded batch counts and progress. Expand it to pause, resume, retry definite failures, or stage accepted results. Staging works for partial runs and after the provider disconnects. It reads persisted assessments, joins the server's frozen index mapping, and opens a table in chat. Retrieval scores and evidence verification are separate from these assessments.

Pause stops the next dispatch. It does not reverse an in-flight provider request. The controller checks the pause flag immediately before sending. Controls and trace metadata are persisted in `.screening-data/background-runs.json`; inputs, leases, attempts, parser results, and assessments remain authoritative in SQLite. Recovery reclaims expired undispatched leases. An expired dispatched attempt becomes ambiguous and requires receipt reconciliation; it is never automatically sent again.

Recovery also preserves the provider, batch counts, and recorded execution for an out-of-date setup. Historical progress remains readable after source changes, including when the database marks a plan STALE. It requires a new approval before dispatch or staging; completed historical batches do not make the old setup current.

Definite rejected requests can be retried after an explicit analyst action. The controller verifies the expected attempt and current source/profile hashes before making the job ready. Successful batches are retained. Unknown delivery outcomes and exhausted parser repairs cannot use this retry path. Such records require reconciliation or a fresh approved plan.

LLMSuite uses one durable limit of **seven actual messages in any rolling 60 seconds**. This includes screening, questions, orchestration, subagents, retries, and parser repairs. A local progress refresh does not consume a provider message. `next_eligible_at` controls scheduling after rate waits; the browser does not enforce the limit with an approximate timer.

## Spreadsheet uploads

1. Drop CSV or XLSX files on a PitchBook/ROGO upload card or use the screening input-source picker to add company data. A file dropped in the chat composer is a chat attachment instead, with an inclusion switch that defaults on for provider questions.
2. The read-only `inspect_enrichment_files` tool inspects sheet headers. Filenames do not decide the source. A mapping file requires its defined PitchBook headers; a PitchBook data header can be below the first row. ROGO uses Website/Websites and excludes PitchBook identifier headers.
3. Source uploads stay on their chat upload card. If a saved company set exists, import them as a group so mapping precedes PitchBook hydration. Source files uploaded before discovery wait until its company set is available. Chat attachments remain in the composer and are not automatically imported. Existing source sheets are reconsidered when new mappings arrive or discovery adds candidates; unchanged mappings are not replayed by an unrelated ROGO upload or a manual shortlist restoration.
4. Unknown or mixed workbooks stay staged with an explanation. They are not partly imported under a guessed source. Failed checks can be retried. Original files remain available to the session export and survive a server restart.
5. The saved company context refreshes. The sidebar shows coverage, current considered/hidden counts, and links to the review table and next steps. Source-file status and matching counts stay on the upload card. PitchBook mapping uploads automatically hide rows with Company Profile = No or no usable PBId. They retain all company history and can be restored by the analyst.
6. Type **`/data`**, **`/companies`**, or **`/review`** to read the latest company sources in an AG Grid table in chat. Choose kept companies or a score cutoff, preserve CHECK separately, restore hidden rows, and choose accepted output columns for the next run. Sort, filter, resize columns, search rows, and download the considered rows as CSV. Reading the table does not revise criteria or start a new search.

PitchBook name and website are independently preferred with MID/ISCC fallback. Descriptions retain source labels and are combined rather than silently replacing another source. Empty source fields remain empty. Data uploads or edits invalidate an old execution snapshot; preview and approve a new plan before executing against the changed inputs.

## Bing grounding

Use **Screen → Bing research**, the next-step option, or **`/bing`**. Company research uses every currently considered company. Edit one to five query chips or generate them from the current criteria with LLM Suite. General research uses literal queries and can optionally propose a new criteria revision from its answer. Company templates support `{company}`, `{website}`, and `<company>`. Preview shows expanded queries before approval; source identity or criteria changes require a fresh preview. The controller continues in pages of 100 queries while the app remains usable.

The controller proposes and approves a run-scoped action plan, then uses the registered `prepare_bing_queries` and `bing_search` tools. The same tools are available to an LLM through the backend's plain-language catalog and deterministic text-command parser. An agent can propose research when needed, but provider authorization still requires the approved scope and exact query templates.

Company results hydrate saved evidence with query, source URL, excerpt, and provenance. They remain **unverified research leads**. General grounding does not require a company or LinkedIn URL. Source-linked results appear as a table in chat; actual calls, failures, and times appear in Session log.

## Provider status and configuration

| Path | Status in the supplied application |
|---|---|
| Job ledger, background controller, controls, imports, source projection, and tables | Implemented and locally tested |
| Frozen-job HTTP dispatch and strict output parser | Implemented; corporate deployment protocol still unverified |
| LLMSuite, M365, and Bing live execution | Disabled by default; no live provider result is fabricated |
| Full LLM chat orchestration and production multi-user access | Planned; the current chat driver uses deterministic local routing |

A local administrator can opt in with `SCREENING_ENABLE_EXTERNAL=true` and the documented `MNA_LLMSUITE_*`, `MNA_M365_*`, or `MNA_BING_*` endpoint/token environment variables. This setting alone does not approve a job: the exact setup or research scope must still be approved in the UI. Keep credentials out of plans, messages, logs, and source control. Model/deployment choices remain editable pending the real provider configuration.

When a provider is unavailable, an approved setup is saved with **`executed:false`**, and the progress panel explains that no request was sent. Accepted records from a previously executed run can still be staged offline. Corporate endpoint compatibility and actual external execution require later verification with the chosen deployments.

## Local controller endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/background-runs` | Lightweight durable batch progress for tracked plans |
| `POST /api/background-runs/start` | Start an approved plan ID/digest; requires `approved:true` |
| `POST /api/background-runs/pause` / `resume` | Control future dispatch without discarding work |
| `POST /api/background-runs/retry` | Requeue safely retryable failures, optionally one `jobId` |
| `POST /api/background-runs/stage` | Read only current accepted results and question answers |
| `POST /api/research/preview` / `run` | Preview and approve exact Bing queries |

Execution dispatch, lease recovery, and safe retry use server-only controller credentials. These privileged operations are not exposed as agent tools. Local browser endpoints accept the configured localhost host/origin only.
