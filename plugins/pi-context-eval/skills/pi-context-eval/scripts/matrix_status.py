#!/usr/bin/env python3
"""Print a compact, deterministic view of a Saffron matrix state file."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Summarize pi-context Saffron matrix-state.json"
    )
    parser.add_argument("matrix", type=Path, help="matrix directory or matrix-state.json")
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    return parser.parse_args()


def load_state(raw_path: Path) -> tuple[Path, dict[str, Any]]:
    path = raw_path.expanduser().resolve()
    if path.is_dir():
        path = path / "matrix-state.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise SystemExit(f"matrix state not found: {path}") from error
    except json.JSONDecodeError as error:
        raise SystemExit(f"invalid matrix state JSON: {path}: {error}") from error
    if not isinstance(value, dict) or not isinstance(value.get("cells"), dict):
        raise SystemExit(f"unsupported matrix state shape: {path}")
    for cell_id, cell in value["cells"].items():
        if not isinstance(cell, dict):
            raise SystemExit(f"unsupported matrix cell shape: {path}: {cell_id}")
    return path, value


def judge_summary(report: dict[str, Any]) -> tuple[int | None, str | None]:
    judge = report.get("judge")
    if not isinstance(judge, dict):
        return None, None
    verdict = judge.get("verdict")
    if not isinstance(verdict, dict):
        return None, None
    overall = verdict.get("overall")
    if not isinstance(overall, dict):
        return None, None
    score = overall.get("score")
    tier = overall.get("modelTier")
    # The versioned judge artifact accepts only integer 0-3 scores. Do not
    # normalize invalid floats or booleans into apparently valid evidence.
    valid_score = (
        score
        if isinstance(score, int) and not isinstance(score, bool) and 0 <= score <= 3
        else None
    )
    return valid_score, tier if isinstance(tier, str) else None


def normalize_cell(cell_id: str, cell: dict[str, Any]) -> dict[str, Any]:
    report = cell.get("report") if isinstance(cell.get("report"), dict) else {}
    sandbox = report.get("sandbox") if isinstance(report.get("sandbox"), dict) else {}
    lock = report.get("lock") if isinstance(report.get("lock"), dict) else {}
    score, tier = judge_summary(report)
    invalid = report.get("infrastructureInvalid")
    if isinstance(invalid, dict):
        invalid = invalid.get("reason") or invalid.get("code") or json.dumps(invalid, sort_keys=True)
    run_error = report.get("runError")
    if isinstance(run_error, dict):
        run_error = run_error.get("message") or json.dumps(run_error, sort_keys=True)
    return {
        "id": cell.get("id") or cell_id,
        "state": cell.get("status"),
        "attempts": cell.get("attempts", 0),
        "classification": cell.get("classification"),
        "reason": cell.get("reason"),
        "reportStatus": report.get("status"),
        "judgeScore": score,
        "judgeTier": tier,
        "infrastructureInvalid": invalid,
        "runError": run_error,
        "formalEvidenceEligible": sandbox.get("formalEvidenceEligible"),
        "lockReleased": lock.get("released"),
        "reportPath": cell.get("reportPath"),
    }


def main() -> None:
    args = parse_args()
    path, state = load_state(args.matrix)
    cells = [normalize_cell(cell_id, cell) for cell_id, cell in state["cells"].items()]
    provenance = state.get("pinnedProvenance")
    head_sha = provenance.get("headSha") if isinstance(provenance, dict) else None
    summary = {
        "matrixState": str(path),
        "status": state.get("status"),
        "matrixRunId": state.get("matrixRunId"),
        "headSha": head_sha,
        "secretSeedSha256": state.get("secretSeedSha256"),
        "cells": cells,
    }
    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return

    print(
        f"matrix={summary['matrixRunId']} status={summary['status']} "
        f"head={summary['headSha']} seedSha256={summary['secretSeedSha256']}"
    )
    for cell in cells:
        judge = "-"
        if cell["judgeScore"] is not None:
            judge = f"{cell['judgeScore']}/{cell['judgeTier'] or '-'}"
        print(
            f"{cell['id']}: state={cell['state']} attempts={cell['attempts']} "
            f"class={cell['classification'] or '-'} report={cell['reportStatus'] or '-'} "
            f"judge={judge} formal={cell['formalEvidenceEligible']} "
            f"lockReleased={cell['lockReleased']}"
        )
        for label, value in (
            ("reason", cell["reason"]),
            ("infrastructure", cell["infrastructureInvalid"]),
            ("runError", cell["runError"]),
        ):
            if value:
                print(f"  {label}: {value}")
        if cell["reportPath"]:
            print(f"  report: {cell['reportPath']}")


if __name__ == "__main__":
    main()
