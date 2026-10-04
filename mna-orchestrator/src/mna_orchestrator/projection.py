"""Pure source selection over run-scoped observations supplied by Rust."""

from __future__ import annotations

from typing import Iterable, Mapping


_NULLS = {"", "null", "n/a", "na", "none", "unknown"}


def usable(value: object) -> str:
    text = " ".join(str(value or "").split())
    return "" if text.casefold() in _NULLS else text


def latest(observations: Iterable[Mapping], source: str, field: str, *, run_id: str | None = None) -> tuple[str, str] | None:
    rows = [r for r in observations if r.get("source") == source and usable(r.get(field))]
    if source == "ISCC":
        if not run_id:
            raise ValueError("ISCC selection requires a run ID")
        rows = [r for r in rows if r.get("run_id") == run_id]
    if not rows:
        return None
    selected = max(rows, key=lambda r: (str(r.get("ingested_at", "")), str(r.get("row_id", ""))))
    return usable(selected[field]), str(selected["row_id"])


def project_company(observations: Iterable[Mapping], *, run_id: str) -> dict:
    """Independently fall back each field, retaining selected row lineage.

    Input must already be constrained to one Rust company identity and genuine
    source rows. PB-only identifiers and LinkedIn are never synthesized.
    """
    rows = tuple(observations)
    lineage = {}
    output = {}
    for target, field in (("Company Name", "name"), ("Website", "website")):
        selected = next((item for source in ("PB", "MID", "ISCC") if (item := latest(rows, source, field, run_id=run_id))), None)
        output[target] = selected[0] if selected else ""
        lineage[target] = selected[1] if selected else None
    descriptions = []
    for source in ("PB", "MID", "ISCC"):
        selected = latest(rows, source, "description", run_id=run_id)
        if selected:
            descriptions.append(f"{source}: {selected[0]}")
            lineage[f"{source}.Description"] = selected[1]
    output["Description"] = "\n".join(descriptions)
    for target, field in (("PBId", "pb_id"), ("LinkedIn URL", "linkedin_url")):
        selected = latest(rows, "PB", field, run_id=run_id)
        output[target] = selected[0] if selected else ""
        lineage[target] = selected[1] if selected else None
    output["lineage"] = lineage
    return output
