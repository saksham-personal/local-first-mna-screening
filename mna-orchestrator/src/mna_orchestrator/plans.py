"""Deterministic plan binding and exhaustive batch partitioning."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Mapping, Sequence


BOUND_FIELDS = (
    "mode", "run_id", "company_scope", "profile_version", "candidate_set_revision",
    "data_revision", "source_fields", "prompt", "output_columns", "output_rules",
    "provider", "deployment", "batch_size", "provider_options",
)


def resolve_output_columns(schema_text: str) -> list[str]:
    """Resolve a deliberately narrow editable schema for explicit analyst review.

    Accept semicolon or newline separated column declarations; optional simple
    parenthesized rules are retained in the plan's separate output_rules field.
    Unsupported syntax is rejected instead of guessed from arbitrary prose.
    """
    if not schema_text or len(schema_text) > 4000:
        raise ValueError("Output schema is empty or too long")
    declarations = re.split(r"[;\n]", schema_text)
    if any(not entry.strip() for entry in declarations):
        raise ValueError("Empty output column declaration")
    columns = []
    for declaration in declarations:
        match = re.fullmatch(r"\s*([A-Za-z][A-Za-z0-9 /_-]{0,79}?)\s*(?:\([^()]{1,160}\))?\s*", declaration)
        if not match:
            raise ValueError(f"Unrecognized output column declaration: {declaration!r}")
        column = " ".join(match.group(1).split())
        if column.casefold() == "index" or column.casefold() in {existing.casefold() for existing in columns}:
            raise ValueError("Duplicate or reserved output column")
        columns.append(column)
    return columns


def plan_revision(plan: Mapping) -> str:
    missing = [field for field in BOUND_FIELDS if field not in plan]
    if missing:
        raise ValueError(f"Plan missing bound fields: {missing}")
    payload = {field: plan[field] for field in BOUND_FIELDS}
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def batch_manifests(company_pks: Sequence[str], batch_size: int) -> list[dict[int, str]]:
    if batch_size <= 0 or len(set(company_pks)) != len(company_pks) or any(not pk for pk in company_pks):
        raise ValueError("Batch size and company identity list must be valid")
    return [
        {start + offset + 1: pk for offset, pk in enumerate(company_pks[start:start + batch_size])}
        for start in range(0, len(company_pks), batch_size)
    ]
