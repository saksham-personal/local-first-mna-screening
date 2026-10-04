"""Strict, all-or-nothing parser for a frozen screening batch manifest."""

from __future__ import annotations

from decimal import Decimal, InvalidOperation
import re
from typing import Mapping, Sequence


class ParseError(ValueError):
    pass


_SEPARATOR = re.compile(r"^:?-{3,}:?$")
_INT = re.compile(r"[1-9][0-9]*\Z")


def _cells(line: str) -> list[str]:
    if not line.startswith("|") or not line.endswith("|"):
        raise ParseError("Every table line must begin and end with a pipe")
    # Escaped pipes are allowed as literal cell data; no other Markdown constructs
    # are interpreted. HTML, nested tables and prose remain inert strings.
    parts = re.split(r"(?<!\\)\|", line[1:-1])
    return [part.replace(r"\|", "|").strip() for part in parts]


def parse_markdown_result(
    markdown: str,
    requested_columns: Sequence[str],
    index_to_pk: Mapping[int, str],
    *,
    score_columns: Sequence[str] = ("Fit Score",),
) -> list[dict]:
    """Validate exact header and manifest equality, then join by immutable index.

    No row is returned on any validation error. The caller must bind this manifest
    to the job/attempt; model-emitted company identifiers are never accepted.
    """
    columns = tuple(requested_columns)
    if not columns or any(not c or c.strip() != c or "|" in c for c in columns):
        raise ParseError("Requested columns must be nonblank canonical names")
    if len(set(c.casefold() for c in columns)) != len(columns) or any(c.casefold() == "index" for c in columns):
        raise ParseError("Requested columns must be unique and cannot include index")
    if not index_to_pk or any(type(index) is not int or index < 1 for index in index_to_pk):
        raise ParseError("Frozen batch manifest must contain unique positive integer indexes")
    if any(not isinstance(pk, str) or not pk for pk in index_to_pk.values()):
        raise ParseError("Frozen batch manifest has an invalid pk")
    lines = markdown.strip().splitlines()
    if len(lines) != len(index_to_pk) + 2 or any(not line.strip() for line in lines):
        raise ParseError("Expected only one complete Markdown table, with no prose")
    header = _cells(lines[0].strip())
    expected_header = ["index", *columns]
    if header != expected_header:
        raise ParseError(f"Header must be exactly {expected_header!r}")
    separator = _cells(lines[1].strip())
    if len(separator) != len(expected_header) or any(not _SEPARATOR.fullmatch(cell) for cell in separator):
        raise ParseError("Malformed Markdown separator")
    found: dict[int, dict] = {}
    for line_no, line in enumerate(lines[2:], start=3):
        values = _cells(line.strip())
        if len(values) != len(expected_header):
            raise ParseError(f"Line {line_no}: wrong cell count")
        raw_index = values[0]
        if not _INT.fullmatch(raw_index):
            raise ParseError(f"Line {line_no}: invalid index")
        index = int(raw_index)
        if index not in index_to_pk:
            raise ParseError(f"Line {line_no}: index outside frozen batch")
        if index in found:
            raise ParseError(f"Line {line_no}: duplicate index {index}")
        output = dict(zip(columns, values[1:], strict=True))
        for score_name in score_columns:
            if score_name not in output:
                continue
            raw_score = output[score_name]
            if raw_score != "CHECK":
                try:
                    score = Decimal(raw_score)
                except InvalidOperation as exc:
                    raise ParseError(f"Line {line_no}: invalid {score_name}") from exc
                if not score.is_finite() or score < 0 or score > 10:
                    raise ParseError(f"Line {line_no}: {score_name} outside 0..10")
        found[index] = {"index": index, "pk": index_to_pk[index], "output_values": output}
    if set(found) != set(index_to_pk):
        raise ParseError("Missing batch indexes")
    return [found[index] for index in sorted(found)]
