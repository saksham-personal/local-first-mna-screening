"""Operational SQLite queue and one shared LLMSuite rolling-window gate.

This database is separate from Rust's authoritative domain store. It records
dispatch intent and leases; it never writes candidate membership or scores.
"""

from __future__ import annotations

import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Callable


class OperationalQueue:
    def __init__(self, path: str | Path, *, clock: Callable[[], float] = time.time):
        self.path = str(path)
        self.clock = clock
        with self._connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS jobs (
                    job_id TEXT PRIMARY KEY, plan_revision TEXT NOT NULL,
                    provider TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'READY',
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    lease_owner TEXT, lease_until REAL, next_eligible REAL NOT NULL DEFAULT 0,
                    last_error TEXT
                );
                CREATE TABLE IF NOT EXISTS llm_dispatches (
                    attempt_key TEXT PRIMARY KEY, job_id TEXT NOT NULL,
                    dispatched_at REAL NOT NULL, kind TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS llm_dispatches_time ON llm_dispatches(dispatched_at);
            """)

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        db.execute("PRAGMA busy_timeout=30000")
        try:
            yield db
        finally:
            db.close()

    def enqueue(self, job_id: str, plan_revision: str, provider: str) -> None:
        if not all((job_id, plan_revision, provider)):
            raise ValueError("Job identity, plan revision and provider are required")
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT plan_revision, provider FROM jobs WHERE job_id=?", (job_id,)).fetchone()
            if row and row != (plan_revision, provider):
                raise ValueError("Job ID already binds a different immutable plan or provider")
            db.execute("INSERT OR IGNORE INTO jobs(job_id, plan_revision, provider) VALUES(?,?,?)", (job_id, plan_revision, provider))
            db.commit()

    def lease(self, job_id: str, owner: str, *, seconds: float = 30) -> bool:
        now = self.clock()
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            changed = db.execute("""
                UPDATE jobs SET status='LEASED', lease_owner=?, lease_until=?
                WHERE job_id=? AND next_eligible<=? AND
                    (status IN ('READY','WAITING_RATE') OR
                     (status='LEASED' AND lease_until<=?))
            """, (owner, now + seconds, job_id, now, now)).rowcount
            db.commit()
            return changed == 1

    def reserve_llmsuite(self, job_id: str, attempt_key: str, kind: str, owner: str) -> float | None:
        """Reserve under BEGIN IMMEDIATE. Return next eligible time if rate-limited.

        Call immediately before a *single* LLMSuite request, including retries,
        orchestration, subagents, screening and questions. Caller owns the lease.
        Persisting a slot before transport may overcount a crash, safely.
        """
        now = self.clock()
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT provider,status,lease_owner,lease_until FROM jobs WHERE job_id=?", (job_id,)).fetchone()
            if not row or row[:3] != ("llm_suite", "LEASED", owner) or row[3] <= now:
                raise ValueError("An active LLMSuite job lease is required")
            if db.execute("SELECT 1 FROM llm_dispatches WHERE attempt_key=?", (attempt_key,)).fetchone():
                raise ValueError("Attempt key already reserved; ambiguous sends need reconciliation")
            timestamps = [r[0] for r in db.execute(
                "SELECT dispatched_at FROM llm_dispatches WHERE dispatched_at>? AND dispatched_at<=? ORDER BY dispatched_at",
                (now - 60, now),
            )]
            if len(timestamps) >= 7:
                next_time = timestamps[0] + 60.001
                db.execute("UPDATE jobs SET status='WAITING_RATE',lease_owner=NULL,lease_until=NULL,next_eligible=? WHERE job_id=?", (next_time, job_id))
                db.commit()
                return next_time
            db.execute("INSERT INTO llm_dispatches(attempt_key,job_id,dispatched_at,kind) VALUES(?,?,?,?)", (attempt_key, job_id, now, kind))
            db.execute("UPDATE jobs SET status='RUNNING',attempt_count=attempt_count+1 WHERE job_id=?", (job_id,))
            db.commit()
            return None

    def mark_ambiguous(self, job_id: str, error: str) -> None:
        """A timed-out sent request is held for reconciliation, never auto-retried."""
        with self._connect() as db:
            db.execute("UPDATE jobs SET status='AMBIGUOUS',last_error=?,lease_owner=NULL,lease_until=NULL WHERE job_id=? AND status='RUNNING'", (error, job_id))

    def retry_unsent(self, job_id: str, *, retry_after: float) -> None:
        """Only use when transport confirms no provider request was sent."""
        with self._connect() as db:
            db.execute("UPDATE jobs SET status='READY',next_eligible=?,lease_owner=NULL,lease_until=NULL WHERE job_id=? AND status='RUNNING'", (max(self.clock(), retry_after), job_id))

    def retry_after_response(self, job_id: str, *, retry_after: float, error: str = "rate limited") -> None:
        """For a confirmed 429/response: prior attempt still counts toward seven."""
        with self._connect() as db:
            db.execute("UPDATE jobs SET status='READY',next_eligible=?,last_error=?,lease_owner=NULL,lease_until=NULL WHERE job_id=? AND status='RUNNING'", (max(self.clock(), retry_after), error, job_id))

    def get(self, job_id: str) -> dict | None:
        with self._connect() as db:
            db.row_factory = sqlite3.Row
            row = db.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
            return dict(row) if row else None
