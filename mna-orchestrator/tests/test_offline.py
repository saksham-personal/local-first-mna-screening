import concurrent.futures
import os
import tempfile
import unittest
from contextlib import closing, contextmanager
from pathlib import Path

from mna_orchestrator.parser import ParseError, parse_markdown_result
from mna_orchestrator.plans import batch_manifests, plan_revision, resolve_output_columns
from mna_orchestrator.projection import project_company
from mna_orchestrator.scheduler import OperationalQueue


@contextmanager
def sqlite_path():
    fd, name = tempfile.mkstemp(suffix=".sqlite", dir=Path(__file__).parent)
    os.close(fd)
    path = Path(name)
    try:
        yield path
    finally:
        path.unlink(missing_ok=True)


class ParserTests(unittest.TestCase):
    def test_shuffled_complete_batch_joins_only_manifest_pk(self):
        rows = parse_markdown_result(
            "|index|Fit Score|Rationale|\n|---|---|---|\n|2|CHECK|Unknown|\n|1|8.5|Supported|",
            ["Fit Score", "Rationale"], {1: "immutable-pk-A", 2: "immutable-pk-B"},
        )
        self.assertEqual([row["pk"] for row in rows], ["immutable-pk-A", "immutable-pk-B"])
        self.assertEqual(rows[1]["output_values"]["Fit Score"], "CHECK")

    def test_rejects_missing_duplicate_wrong_header_out_of_scope_and_bad_score(self):
        base = "|index|Fit Score|\n|---|---|\n{}"
        bad = ["|1|8|", "|1|8|\n|1|7|", "|1|8|\n|3|7|", "|1|11|\n|2|7|", "|1|8|\n|2|oops|"]
        for value in bad:
            with self.subTest(value=value), self.assertRaises(ParseError):
                parse_markdown_result(base.format(value), ["Fit Score"], {1: "A", 2: "B"})
        with self.assertRaises(ParseError):
            parse_markdown_result("|index|pk|\n|---|---|\n|1|A|", ["Fit Score"], {1: "A"})
        with self.assertRaises(ParseError):
            parse_markdown_result("text\n|index|Rationale|\n|---|---|\n|1|yes|", ["Rationale"], {1: "A"})

    def test_score_optional(self):
        result = parse_markdown_result("|index|Rationale|\n|---|---|\n|1|No score requested|", ["Rationale"], {1: "A"})
        self.assertEqual(result[0]["output_values"], {"Rationale": "No score requested"})

    def test_global_indexes_in_second_batch_and_wrong_batch_rejected(self):
        manifest = {index: f"pk-{index}" for index in range(26, 51)}
        table = "|index|Rationale|\n|---|---|\n" + "\n".join(
            f"|{index}|row {index}|" for index in range(50, 25, -1)
        )
        rows = parse_markdown_result(table, ["Rationale"], manifest)
        self.assertEqual([row["index"] for row in rows], list(range(26, 51)))
        self.assertEqual(rows[0]["pk"], "pk-26")
        wrong_batch = "|index|Rationale|\n|---|---|\n" + "\n".join(
            f"|{index}|row {index}|" for index in range(1, 26)
        )
        with self.assertRaises(ParseError):
            parse_markdown_result(wrong_batch, ["Rationale"], manifest)


class PlanAndProjectionTests(unittest.TestCase):
    def test_schema_resolution_rejects_ambiguous_and_reserved_declarations(self):
        self.assertEqual(resolve_output_columns("Fit Score (0-10 or CHECK); Rationale\nProduct ownership"), ["Fit Score", "Rationale", "Product ownership"])
        for text in ("index; Rationale", "Rationale; rationale", "Score;; Rationale", "Please assess fit and explain why."):
            with self.subTest(text=text), self.assertRaises(ValueError):
                resolve_output_columns(text)

    def test_all_2001_rows_batch_without_loss(self):
        manifests = batch_manifests([f"pk-{i}" for i in range(2001)], 25)
        self.assertEqual(len(manifests), 81)
        self.assertEqual(sum(map(len, manifests)), 2001)
        self.assertEqual(manifests[1][26], "pk-25")
        self.assertEqual(manifests[-1], {2001: "pk-2000"})

    def test_every_bound_plan_field_changes_revision(self):
        from mna_orchestrator.plans import BOUND_FIELDS
        plan = {key: "v" for key in BOUND_FIELDS}
        original = plan_revision(plan)
        for key in BOUND_FIELDS:
            changed = dict(plan, **{key: "other"})
            self.assertNotEqual(plan_revision(changed), original, key)

    def test_independent_fallback_and_run_scoped_labeled_descriptions(self):
        rows = [
            {"source": "PB", "row_id": "pb1", "ingested_at": "1", "name": "PB Co", "website": "N/A", "description": "PB text", "pb_id": "PB-7", "linkedin_url": ""},
            {"source": "MID", "row_id": "mid1", "ingested_at": "1", "name": "MID Co", "website": "mid.example", "description": "MID text"},
            {"source": "ISCC", "run_id": "R", "row_id": "i1", "ingested_at": "1", "description": "ISCC current"},
            {"source": "ISCC", "run_id": "OTHER", "row_id": "i2", "ingested_at": "2", "description": "LEAK"},
        ]
        projection = project_company(rows, run_id="R")
        self.assertEqual(projection["Company Name"], "PB Co")
        self.assertEqual(projection["Website"], "mid.example")
        self.assertEqual(projection["Description"], "PB: PB text\nMID: MID text\nISCC: ISCC current")
        self.assertEqual(projection["PBId"], "PB-7")
        self.assertEqual(projection["LinkedIn URL"], "")


class QueueTests(unittest.TestCase):
    def test_shared_gate_concurrency_retry_and_restart(self):
        with sqlite_path() as path:
            now = [1000.0]
            q = OperationalQueue(path, clock=lambda: now[0])
            for i in range(10):
                q.enqueue(f"job-{i}", "rev", "llm_suite")

            def reserve(i):
                local = OperationalQueue(path, clock=lambda: now[0])
                assert local.lease(f"job-{i}", f"worker-{i}")
                return local.reserve_llmsuite(f"job-{i}", f"attempt-{i}", "screening" if i % 2 else "question", f"worker-{i}")

            with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
                outcomes = list(pool.map(reserve, range(10)))
            self.assertEqual(sum(result is None for result in outcomes), 7)
            self.assertEqual(sum(result is not None for result in outcomes), 3)
            restarted = OperationalQueue(path, clock=lambda: now[0])
            self.assertFalse(restarted.lease("job-7", "retry-before-window"))
            now[0] = 1060.002
            waiting = [i for i in range(10) if restarted.get(f"job-{i}")["status"] == "WAITING_RATE"]
            for i in waiting:
                self.assertTrue(restarted.lease(f"job-{i}", "retry"))
                self.assertIsNone(restarted.reserve_llmsuite(f"job-{i}", f"retry-{i}", "retry", "retry"))
            with self.assertRaises(ValueError):
                restarted.reserve_llmsuite(f"job-{waiting[0]}", f"retry-{waiting[0]}", "retry", "retry")

    def test_ambiguous_sent_request_not_requeued(self):
        with sqlite_path() as path:
            q = OperationalQueue(path, clock=lambda: 100.0)
            q.enqueue("job", "rev", "llm_suite")
            self.assertTrue(q.lease("job", "w"))
            q.reserve_llmsuite("job", "attempt", "criteria", "w")
            q.mark_ambiguous("job", "timeout after send")
            self.assertFalse(q.lease("job", "new-worker"))
            self.assertEqual(q.get("job")["status"], "AMBIGUOUS")

    def test_confirmed_429_waits_and_consumes_slot(self):
        with sqlite_path() as path:
            now = [100.0]
            q = OperationalQueue(path, clock=lambda: now[0])
            q.enqueue("job", "rev", "llm_suite")
            self.assertTrue(q.lease("job", "w"))
            self.assertIsNone(q.reserve_llmsuite("job", "first", "criteria", "w"))
            q.retry_after_response("job", retry_after=130.0)
            self.assertFalse(q.lease("job", "w2"))
            now[0] = 130.0
            self.assertTrue(q.lease("job", "w2"))
            self.assertIsNone(q.reserve_llmsuite("job", "second", "retry", "w2"))
            import sqlite3
            with closing(sqlite3.connect(path)) as db:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM llm_dispatches").fetchone()[0], 2)


try:
    from langgraph.checkpoint.memory import InMemorySaver
    from langgraph.types import Command
    from mna_orchestrator.graph import build_graph
except ImportError:
    InMemorySaver = None


@unittest.skipIf(InMemorySaver is None, "LangGraph unavailable")
class GraphTests(unittest.TestCase):
    class FakePorts:
        def __init__(self):
            self.calls = []

        def _call(self, name, *args):
            self.calls.append((name, args))
            return name + "-ref"

        def interpret_criteria(self, run_id): return self._call("criteria", run_id)
        def m365_criteria_analysis(self, run_id, profile_ref): return self._call("m365", run_id, profile_ref)
        def synthesize_criteria(self, run_id, profile_ref, m365_ref): return self._call("synthesis", run_id, profile_ref, m365_ref)
        def commit_profile(self, run_id, profile_ref, approved_revision): return self._call("profile", run_id, profile_ref, approved_revision)
        def plan_search(self, run_id, profile_version, round_number): return self._call("search_plan", run_id, profile_version, round_number)
        def search_mid(self, run_id, query_ref): return self._call("mid", run_id, query_ref)
        def search_iscc(self, run_id, query_ref): return self._call("iscc", run_id, query_ref)
        def union_and_coverage(self, run_id, mid_ref, iscc_ref): return self._call("union", run_id, mid_ref, iscc_ref), "coverage-ref"
        def select_sources(self, run_id, candidate_revision): return self._call("select", run_id, candidate_revision)
        def prepare_plan(self, run_id, profile_version, candidate_revision, selected_ref): return "plan-id", "plan-revision"
        def approve_and_enqueue(self, plan_id, plan_revision, analyst_id): return self._call("enqueue", plan_id, plan_revision, analyst_id)
        def validate_join_persist(self, job_set_ref): return self._call("persist", job_set_ref)
        def enqueue_question(self, task_id, providers, question_ref): return self._call("question", task_id, providers, question_ref)
        def collect_answers(self, job_set_ref): return [self._call("answer", job_set_ref)]

    def test_three_interrupts_broaden_and_resume(self):
        ports = self.FakePorts()
        graph = build_graph(ports, checkpointer=InMemorySaver())
        config = {"configurable": {"thread_id": "screening-1"}}
        result = graph.invoke({"mode": "screening", "run_id": "R"}, config)
        self.assertEqual(result["__interrupt__"][0].value["kind"], "profile_review")
        self.assertFalse(any(name == "profile" for name, _ in ports.calls))
        result = graph.invoke(Command(resume={"decision": "approve", "revision": "synthesis-ref"}), config)
        self.assertEqual(result["__interrupt__"][0].value["kind"], "coverage_review")
        result = graph.invoke(Command(resume={"decision": "broaden"}), config)
        self.assertEqual(result["__interrupt__"][0].value["kind"], "coverage_review")
        self.assertEqual(sum(name == "search_plan" for name, _ in ports.calls), 2)
        result = graph.invoke(Command(resume={"decision": "proceed"}), config)
        self.assertEqual(result["__interrupt__"][0].value["kind"], "plan_review")
        self.assertFalse(any(name == "enqueue" for name, _ in ports.calls))
        result = graph.invoke(Command(resume={"decision": "approve", "revision": "plan-revision", "analyst_id": "analyst-1"}), config)
        self.assertEqual(result["result_ref"], "persist-ref")
        self.assertEqual(sum(name == "enqueue" for name, _ in ports.calls), 1)

    def test_question_route_separate_attributed_providers_no_scores(self):
        ports = self.FakePorts()
        graph = build_graph(ports, checkpointer=InMemorySaver())
        state = graph.invoke({"mode": "question", "task_id": "Q", "question_ref": "q-ref", "providers": ["llm_suite", "m365"]}, {"configurable": {"thread_id": "question-1"}})
        self.assertEqual(state["answer_refs"], ["answer-ref"])
        self.assertEqual([name for name, _ in ports.calls], ["question", "answer"])
        self.assertNotIn("result_ref", state)

    def test_profile_revision_and_plan_edit_loop_with_optional_m365(self):
        ports = self.FakePorts()
        graph = build_graph(ports, checkpointer=InMemorySaver())
        config = {"configurable": {"thread_id": "screening-edit"}}
        result = graph.invoke({"mode": "screening", "run_id": "R", "providers": ["m365"]}, config)
        self.assertEqual(result["__interrupt__"][0].value["kind"], "profile_review")
        self.assertEqual(sum(name == "m365" for name, _ in ports.calls), 1)
        result = graph.invoke(Command(resume={"decision": "revise", "revision": "synthesis-ref"}), config)
        self.assertEqual(result["__interrupt__"][0].value["kind"], "profile_review")
        self.assertEqual(sum(name == "criteria" for name, _ in ports.calls), 2)
        result = graph.invoke(Command(resume={"decision": "approve", "revision": "synthesis-ref"}), config)
        result = graph.invoke(Command(resume={"decision": "proceed"}), config)
        self.assertEqual(result["__interrupt__"][0].value["kind"], "plan_review")
        result = graph.invoke(Command(resume={"decision": "edit", "revision": "plan-revision"}), config)
        self.assertEqual(result["__interrupt__"][0].value["kind"], "plan_review")
        self.assertEqual(sum(name == "select" for name, _ in ports.calls), 2)
        self.assertFalse(any(name == "enqueue" for name, _ in ports.calls))


if __name__ == "__main__":
    unittest.main()
