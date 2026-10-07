# Architecture reference

The current architecture is [BACKEND_ARCHITECTURE.md](BACKEND_ARCHITECTURE.md). It describes authoritative SQLite/Parquet data, core-business retrieval, replaceable local models, run-scoped source projection, prepared approvals, durable jobs and the shared LLMSuite gate.

Use [ARCHITECTURE_CRITIQUE.md](ARCHITECTURE_CRITIQUE.md) for each required correction and its status, [EXECUTION_CONTRACT.md](EXECUTION_CONTRACT.md) for dispatch/recovery, [RETRIEVAL.md](RETRIEVAL.md) for the 1,000/500 retrieval policy and CPU worker, and [LLMSUITE_PROTOCOL.md](LLMSUITE_PROTOCOL.md) for deterministic model command/output parsing.

The service has 76 agent tools and 28 privileged operations. The UI is a consumer of domain truth. The offline LangGraph scaffold still requires durable production ports and a checkpointer. Corporate adapters and actual local model assets remain unverified.
