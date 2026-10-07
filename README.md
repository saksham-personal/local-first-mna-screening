# Local-First M&A Screening

A local-first workspace for qualitative M&A company screening. The repository
contains the screening interface, a Rust service with durable run and review
records, and an offline orchestration scaffold.

## Projects

- **`mna-ui/`** — React and assistant-ui application for criteria approval,
  company discovery, shortlist review, enrichment, direct provider questions,
  iterative screening, export, and session history.
- **`mna-tools/`** — Rust service for company data, retrieval, evidence,
  imports, exports, criteria and shortlist versions, prepared plans, durable
  jobs, and a provider-text gateway. Its catalog has 76 agent tools and 28
  privileged operations.
- **`mna-orchestrator/`** — Python and LangGraph scaffold for future workflow
  orchestration. Its external ports are disabled and it is not connected to
  the UI or Rust service.

## Screening flow

Start with a core-business definition or a local TXT draft. Review the initial
criteria, optionally enter good-fit and bad-fit examples in separate boxes, and
approve the final revision. The backend saves these revisions before MID/ISCC
discovery. Editing criteria later requires approval of the latest revision and
a fresh preview of affected work.

Review discovered companies, including saved hidden rows. PitchBook and ROGO
spreadsheets add company context; a new PitchBook mapping can hide unmapped or
explicit `No` matches without deleting them, and the analyst can restore a
company. Screening uses selected input/output columns and an editable prompt.
Keep strong matches and `CHECK` cases, hide weaker matches, select saved
RESULTS columns as inputs for another pass, and export the considered set. A
broad 2,500-company set might become 400, then 150, then 55 through analyst
review; these counts are examples, not automatic quotas. See the
[workflow](mna-tools/docs/WORKFLOW.md) for the short process map, or the
[application flow guide](mna-tools/docs/APPLICATION_FLOW_GUIDE.md) for the
detailed analyst/developer walkthrough, hydration, memory, and LangGraph design.

Uploads have distinct purposes. Company-data spreadsheets are inspected by
their headers and matched to the run. Chat attachments can be included or
excluded per file when using Ask LLM Suite or Ask M365 Copilot, without a
screening setup. The direct-question path can extract bounded text from TXT,
CSV, DOCX, XLSX, and PDF attachments. PDF/DOCX attachments do not currently
draft screening criteria from their text.

## Current limits

The application runs local workflows and prepares screening handoffs. Provider
adapters and the Rust gateway's durable text dispatch are implemented, but
corporate ISCC, LLMSuite, M365 Copilot, and Bing connections are unconfigured
and unverified. The local provider-disconnected path prepares plans marked
`executed:false`; it made no external calls in the release smoke. Actual
Arctic model assets and large-corpus behavior remain unverified, and reranking
is pluggable but a production reranker is not selected. Read the
[implementation record](mna-tools/IMPLEMENTATION.md) and each project's README
for validation details.

## Start locally

Build the Rust service from `mna-tools/` with Rust and Cargo installed. Then
follow the setup instructions in `mna-ui/README.md` to install the UI
dependencies and start the application. The UI expects the local Rust service
binary beside it; see the UI README for the platform-specific path and
configuration.

The orchestration scaffold has separate Python dependencies and test
instructions in `mna-orchestrator/README.md`.

## Screening policy

The UI can **Build Index** from a staged MID workbook using `mna-tools/config/mid-index.json`. MID keyword discovery records a rationale and weighted Match %; configured semantic embeddings add a separate 0–10 score, while ISCC relevancy stays on its 0–1 scale. Approved LLM Suite and M365 scored plans are shown as separate rounds. The workspace provides All/MID/ISCC views, score histograms and filters, and the analyst can hide or restore companies between hydration and screening passes. `SCREENING_SIMULATE=1` enables labelled deterministic provider output for development; exports reject simulated rows unless explicitly allowed and labelled. Large 150,000-row performance, real embedding inference and live corporate connections are unverified.

Discovery focuses on a company's core business. Geography, financial size,
ownership, and industry classifications remain available as review details
and do not narrow discovery. MID and ISCC scores use different methods and
are displayed separately. Provider scores and research claims also retain
their own provenance. Research leads remain unverified until analyst review.

## Validation

The prior local release checks passed: 120 Rust tests, strict Clippy, release
build, 119 UI tests, and UI build. An eight-row fictional MID smoke covered
database restart, criteria lineage, PitchBook hide/restore, three XLSX export
types, and prepared `executed:false` runs. It did not call a corporate provider.
Those results predate Phase 2; they do not validate the new large MID index path.

## Data and credentials

Local databases, uploaded files, build outputs, dependency folders, and
credentials are excluded from Git. Keep provider credentials in environment
variables or a local environment file; never commit them.
