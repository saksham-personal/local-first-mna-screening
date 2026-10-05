# Backend and UI integration validation

The latest 5 October 2026 background/import/grounding checks are recorded in
[VALIDATION.md](VALIDATION.md) and [the implementation record](../mna-tools/IMPLEMENTATION.md):
100 UI tests, 107 Rust tests, 65 agent tools, and 19 privileged operations.
The record below is retained as the earlier preparation iteration; its
unconnected scheduler statement does not describe the current local controller.

Updated 4 October 2026. The UI now uses backend schema-v2 prepared plans, exact approval digests and durable job/index tables. Its preview displays the complete compiled execution prompt. The short-lived bridge cache stores preview references; it is not domain truth.

The actual local bridge was checked against the freshly compiled service: seven fictional MID companies were found, source/proposal/approval tool traces were returned, compiled prompt and complete company count appeared in preview, approval created three backend jobs, a changed prompt was rejected, and a general M365 question without companies created one unexecuted job. No corporate provider ran. This was an HTTP integration check, not a new visual/browser review.

UI tests: **79 passed**. Production build/type check passed with the existing Vite large-chunk warning. Release service: **103 Rust tests**, format, strict lint and release build passed. CPU worker: **5 mocked-session tests**. Offline LangGraph: **14 tests**. The release executable smoke also verified 63 agent/18 privileged catalogs, imports/enrichment, exact workbook layouts, approval authorization, typed command and v2 approval/jobs across service restart. See [the full implementation record](../mna-tools/IMPLEMENTATION.md).

An independent review examined backend approval, rate limits, recovery,
parsing, and provenance and reported no remaining blocker in those areas.

The browser ledger and background discovery queue are still local presentation/process state. Backend provider jobs are durable. Corporate transport deployments, real ONNX assets and reranker selection remain unverified/planned. Production scheduler, durable LangGraph ports and multi-user identity are not connected. Prepared artifacts continue to show executed:false. The UI does not offer a live corporate dispatch action.

See [screening setup](SCREENING_SETUP.md), [architecture](../mna-tools/docs/BACKEND_ARCHITECTURE.md), [execution contract](../mna-tools/docs/EXECUTION_CONTRACT.md) and [required correction status](../mna-tools/docs/ARCHITECTURE_CRITIQUE.md).
