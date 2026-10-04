# Local-First M&A Screening

A local-first workspace for qualitative M&A company screening. The repository
contains the screening interface, Rust research tools, and an offline
orchestration scaffold.

## Projects

- **`mna-ui/`** — React and assistant-ui application for criteria review,
  company discovery, enrichment, screening setup, and session history.
- **`mna-tools/`** — Rust service for company data, retrieval, evidence,
  imports, exports, prepared plans, and durable run state.
- **`mna-orchestrator/`** — Python and LangGraph scaffold for future workflow
  orchestration. Its external ports are disabled and it is not connected to
  the UI or Rust service.

## Current limits

The application runs local workflows and prepares screening handoffs. External
ISCC, LLMSuite, M365 Copilot, and Bing connections are not verified or enabled
by default. A prepared handoff does not mean a provider call was executed.
Read each project's README and validation notes for its current status.

## Start locally

Build the Rust service from `mna-tools/` with Rust and Cargo installed. Then
follow the setup instructions in `mna-ui/README.md` to install the UI
dependencies and start the application. The UI expects the local Rust service
binary beside it; see the UI README for the platform-specific path and
configuration.

The orchestration scaffold has separate Python dependencies and test
instructions in `mna-orchestrator/README.md`.

## Screening policy

Discovery focuses on a company's core business. Geography, financial size,
ownership, and industry classifications remain available as review details
and do not narrow discovery. MID and ISCC scores use different methods and
are displayed separately.

## Data and credentials

Local databases, uploaded files, build outputs, dependency folders, and
credentials are excluded from Git. Keep provider credentials in environment
variables or a local environment file; never commit them.
