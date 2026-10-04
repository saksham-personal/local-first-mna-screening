# Offline screening orchestrator scaffold

This package is an importable **control-plane scaffold**, not a connected screening service. It is not wired to the UI, Node bridge, Rust domain store, MID, ISCC, LLMSuite, or M365. `build_graph()` requires an injected checkpointer; all external/domain ports are disabled by default. Tests use deterministic fake ports and LangGraph's in-memory saver. Production must inject a durable LangGraph saver and a stable `thread_id` for each task.

The screening graph interprets criteria through an LLMSuite port, can request separately attributed optional M365 criteria analysis, synthesizes a profile, pauses for profile review, plans and executes both MID and live ISCC searches through ports, pauses for coverage review with a bounded broaden loop, selects sources, prepares an immutable plan, pauses for exact-revision approval, then enqueues and validates/joins/persists batches through domain ports. The direct question route enqueues LLMSuite, M365, or both as separately attributed answers and has no candidate score stage. A direct analyst instruction can be supplied as the corresponding `Command(resume=...)` decision; the graph does not authenticate the caller.

The default `DisabledPorts` prevents accidental calls. A production `Ports` implementation must:

- Route **every** LLMSuite call, including criteria, synthesis, subagent, screening, question, and retry, through Rust's single shared seven-per-rolling-60-second gate, consuming reservations at actual send time. M365 is an optional separate criteria/question provider and must not require LinkedIn.
- Delegate candidate identity, source observations, profile/version approval, prepared plans, immutable batch index maps, and accepted results to Rust's authoritative domain APIs. Rust now implements the v2 prepared-plan/result contract, immutable manifests, outbox/leases and shared gate. Production ports must call those APIs; this scaffold is not wired to them yet. Do not treat this package's operational SQLite queue as a second domain store.
- Make any work preceding a LangGraph interrupt replay-safe. LangGraph restarts an interrupted node on resume. The graph's review nodes do no side effects before `interrupt()`; the port implementation still needs idempotent job/outbox writes and revision checks.
- Bind approval to authenticated analyst identity and exact plan revision, then verify current revisions at enqueue and dispatch. Quarantine timed-out requests that may have reached a provider. There is no exactly-once provider execution claim.
- Save raw provider attempts with hashes, run `parse_markdown_result` against that job's frozen `index -> pk` manifest, and save accepted rows atomically in Rust. Parser failures leave all companies unknown for that attempt. Display/export layers must escape Markdown and neutralize spreadsheet formulas.

The example SQLite `OperationalQueue` is not the production gate or scheduler. It demonstrates atomic `BEGIN IMMEDIATE` leases and a persisted global LLMSuite gate. It counts each reserved attempt, including retries and confirmed 429s; a blocked attempt receives `next_eligible`. A timeout after send becomes `AMBIGUOUS` for reconciliation. It is deliberately a small operational example: it does not implement a full production outbox, provider transport, clock coordination across hosts, or Rust transactions. Deploy a single scheduler or a shared database and trusted clock before enabling provider execution.

The pure helpers provide narrow schema resolution, a canonical plan revision digest, exhaustive batch manifests with global prepared-plan indexes, run-scoped source projection with independent PB/MID/ISCC fallback, and a strict index-only Markdown validator. `resolve_output_columns` accepts semicolon/newline declarations such as `Fit Score (0-10 or CHECK); Rationale`; its interpretation must be shown to the analyst and its rules included in the approved plan. The parser accepts only one complete Markdown table whose header is exactly `index` plus the requested columns in order, and its indexes must equal that job's frozen manifest even when the batch starts at 26 or later. The model never supplies a trusted `pk`.

From this repository root, with Python 3.11+ and `langgraph>=0.6.7,<2` installed:

```powershell
$env:PYTHONPATH='mna-orchestrator/src'
py -3 -m unittest discover -s mna-orchestrator/tests -v
```

Example review/resume pattern:

```python
from langgraph.checkpoint.memory import InMemorySaver  # tests only
from langgraph.types import Command
from mna_orchestrator.graph import build_graph

graph = build_graph(fake_ports, checkpointer=InMemorySaver())
config = {"configurable": {"thread_id": "run-R42"}}
pending = graph.invoke({"mode": "screening", "run_id": "R42"}, config)
profile_revision = pending["__interrupt__"][0].value["revision"]
pending = graph.invoke(Command(resume={"decision": "approve", "revision": profile_revision}), config)
```

Further reference: [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) and [persistence](https://docs.langchain.com/oss/python/langgraph/persistence). These documents require the same thread ID on resume and explain that an interrupted node restarts from its beginning.
