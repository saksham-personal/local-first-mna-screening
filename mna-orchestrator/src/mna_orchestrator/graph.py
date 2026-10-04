"""Small LangGraph cursor. Domain writes, queueing and providers live behind ports."""

from __future__ import annotations

from typing import Protocol, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt


class State(TypedDict, total=False):
    mode: str
    run_id: str
    task_id: str
    profile_ref: str
    m365_analysis_ref: str
    profile_version: str
    query_ref: str
    mid_ref: str
    iscc_ref: str
    candidate_set_revision: str
    coverage_ref: str
    search_round: int
    selected_fields_ref: str
    plan_id: str
    plan_revision: str
    job_set_ref: str
    result_ref: str
    providers: list[str]
    question_ref: str
    answer_refs: list[str]
    profile_decision: str
    coverage_decision: str
    plan_decision: str
    approved_by: str


class Ports(Protocol):
    def interpret_criteria(self, run_id: str) -> str: ...
    def m365_criteria_analysis(self, run_id: str, profile_ref: str) -> str: ...
    def synthesize_criteria(self, run_id: str, profile_ref: str, m365_ref: str | None) -> str: ...
    def commit_profile(self, run_id: str, profile_ref: str, approved_revision: str) -> str: ...
    def plan_search(self, run_id: str, profile_version: str, round_number: int) -> str: ...
    def search_mid(self, run_id: str, query_ref: str) -> str: ...
    def search_iscc(self, run_id: str, query_ref: str) -> str: ...
    def union_and_coverage(self, run_id: str, mid_ref: str, iscc_ref: str) -> tuple[str, str]: ...
    def select_sources(self, run_id: str, candidate_revision: str) -> str: ...
    def prepare_plan(self, run_id: str, profile_version: str, candidate_revision: str, selected_ref: str) -> tuple[str, str]: ...
    def approve_and_enqueue(self, plan_id: str, plan_revision: str, analyst_id: str) -> str: ...
    def validate_join_persist(self, job_set_ref: str) -> str: ...
    def enqueue_question(self, task_id: str, providers: list[str], question_ref: str) -> str: ...
    def collect_answers(self, job_set_ref: str) -> list[str]: ...


class DisabledPorts:
    """Default port implementation guarantees no external or domain effects."""

    def __getattr__(self, name: str):
        raise RuntimeError(f"Port {name} is unconfigured; external execution is disabled")


def _decision(value: object, allowed: set[str], revision: str | None = None) -> dict:
    if not isinstance(value, dict) or value.get("decision") not in allowed:
        raise ValueError(f"Expected decision in {sorted(allowed)}")
    if revision is not None and value.get("revision") != revision:
        raise ValueError("Approval revision does not match frozen preview")
    return value


def build_graph(ports: Ports | None = None, *, checkpointer=None, max_search_rounds: int = 3):
    """Compile an importable graph with an injected durable checkpointer.

    Production must inject a persistent saver and stable thread_id. Tests may
    inject InMemorySaver. This function does not create a memory saver itself.
    """
    if checkpointer is None:
        raise ValueError("Inject a checkpointer; production requires a durable saver")
    if max_search_rounds < 1:
        raise ValueError("max_search_rounds must be positive")
    p = ports if ports is not None else DisabledPorts()
    g = StateGraph(State)

    def criteria(s: State) -> dict:
        return {"profile_ref": p.interpret_criteria(s["run_id"])}

    def m365(s: State) -> dict:
        if "m365" not in s.get("providers", []):
            return {"m365_analysis_ref": ""}
        return {"m365_analysis_ref": p.m365_criteria_analysis(s["run_id"], s["profile_ref"])}

    def synthesis(s: State) -> dict:
        return {"profile_ref": p.synthesize_criteria(s["run_id"], s["profile_ref"], s.get("m365_analysis_ref") or None)}

    def review_profile(s: State) -> dict:
        decision = _decision(interrupt({"kind": "profile_review", "run_id": s["run_id"], "revision": s["profile_ref"]}), {"approve", "revise"}, s["profile_ref"])
        return {"profile_decision": decision["decision"]}

    def commit_profile(s: State) -> dict:
        return {"profile_version": p.commit_profile(s["run_id"], s["profile_ref"], s["profile_ref"])}

    def plan_search(s: State) -> dict:
        round_number = s.get("search_round", 0) + 1
        if round_number > max_search_rounds:
            raise ValueError("Search broadening budget exhausted")
        return {"query_ref": p.plan_search(s["run_id"], s["profile_version"], round_number), "search_round": round_number}

    def mid(s: State) -> dict:
        return {"mid_ref": p.search_mid(s["run_id"], s["query_ref"])}

    def iscc(s: State) -> dict:
        return {"iscc_ref": p.search_iscc(s["run_id"], s["query_ref"])}

    def union(s: State) -> dict:
        candidate_revision, coverage_ref = p.union_and_coverage(s["run_id"], s["mid_ref"], s["iscc_ref"])
        return {"candidate_set_revision": candidate_revision, "coverage_ref": coverage_ref}

    def coverage(s: State) -> dict:
        decision = _decision(interrupt({"kind": "coverage_review", "run_id": s["run_id"], "coverage_ref": s["coverage_ref"]}), {"broaden", "proceed"})
        return {"coverage_decision": decision["decision"]}

    def select(s: State) -> dict:
        return {"selected_fields_ref": p.select_sources(s["run_id"], s["candidate_set_revision"])}

    def prepare(s: State) -> dict:
        plan_id, revision = p.prepare_plan(s["run_id"], s["profile_version"], s["candidate_set_revision"], s["selected_fields_ref"])
        return {"plan_id": plan_id, "plan_revision": revision}

    def plan_review(s: State) -> dict:
        decision = _decision(interrupt({"kind": "plan_review", "plan_id": s["plan_id"], "revision": s["plan_revision"]}), {"approve", "edit"}, s["plan_revision"])
        return {"plan_decision": decision["decision"], "approved_by": decision.get("analyst_id", "")}

    def enqueue(s: State) -> dict:
        if not s.get("approved_by"):
            raise ValueError("Authenticated analyst identity is required")
        return {"job_set_ref": p.approve_and_enqueue(s["plan_id"], s["plan_revision"], s["approved_by"])}

    def settle(s: State) -> dict:
        return {"result_ref": p.validate_join_persist(s["job_set_ref"])}

    def question(s: State) -> dict:
        providers = s.get("providers", [])
        if not providers or len(providers) != len(set(providers)) or set(providers) - {"llm_suite", "m365"}:
            raise ValueError("Question providers must be LLMSuite, M365 or both")
        return {"job_set_ref": p.enqueue_question(s["task_id"], providers, s["question_ref"])}

    def answers(s: State) -> dict:
        return {"answer_refs": p.collect_answers(s["job_set_ref"])}

    for name, fn in (("criteria", criteria), ("m365", m365), ("synthesis", synthesis),
                     ("review_profile", review_profile), ("commit_profile", commit_profile),
                     ("plan_search", plan_search), ("mid", mid), ("iscc", iscc),
                     ("union", union), ("coverage", coverage), ("select", select),
                     ("prepare", prepare), ("plan_review", plan_review), ("enqueue", enqueue),
                     ("settle", settle), ("question", question), ("answers", answers)):
        g.add_node(name, fn)
    g.add_conditional_edges(START, lambda s: "question" if s.get("mode") == "question" else "criteria")
    g.add_edge("criteria", "m365")
    g.add_edge("m365", "synthesis")
    g.add_edge("synthesis", "review_profile")
    g.add_conditional_edges("review_profile", lambda s: "commit_profile" if s["profile_decision"] == "approve" else "criteria")
    g.add_edge("commit_profile", "plan_search")
    g.add_edge("plan_search", "mid")
    g.add_edge("mid", "iscc")
    g.add_edge("iscc", "union")
    g.add_edge("union", "coverage")
    g.add_conditional_edges("coverage", lambda s: "plan_search" if s["coverage_decision"] == "broaden" else "select")
    g.add_edge("select", "prepare")
    g.add_edge("prepare", "plan_review")
    g.add_conditional_edges("plan_review", lambda s: "enqueue" if s["plan_decision"] == "approve" else "select")
    g.add_edge("enqueue", "settle")
    g.add_edge("settle", END)
    g.add_edge("question", "answers")
    g.add_edge("answers", END)
    return g.compile(checkpointer=checkpointer)
