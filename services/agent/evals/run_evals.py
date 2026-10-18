"""LLM eval: precision, recall and due-date accuracy per provider on 30 labelled emails.

    cd services/agent
    python -m evals.run_evals                      # every configured provider + heuristic baseline
    python -m evals.run_evals --providers groq,heuristic --verbose

Keys come from the environment or the repo-root .env. Each provider runs ALONE (no failover),
so the numbers describe that model, through the full pipeline (triage, grounding, dates, dedupe).
This is the only place real LLMs are called; unit tests never do.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from app.config import Settings, load_env_file
from app.llm.registry import build_providers
from app.llm.router import LLMRouter
from app.llm.store import InMemoryStore
from app.pipeline.orchestrator import Pipeline
from app.schemas import ExtractRequest, ExtractResponse
from evals.metrics import Metrics, score

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
DATASET = HERE / "dataset.json"


@dataclass
class Row:
    provider: str
    model: str
    status: str  # ok | partial | failed
    metrics: Metrics
    seconds: float
    tasks: int
    note: str


def load_dataset(path: Path = DATASET) -> dict[str, Any]:
    data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return data


def build_request(dataset: dict[str, Any]) -> ExtractRequest:
    return ExtractRequest.model_validate(
        {
            "user": dataset["user"],
            "emails": [case["email"] for case in dataset["cases"]],
            "options": {"horizon_days": 7, "use_llm_briefing": False},
        }
    )


async def evaluate(
    router: LLMRouter, dataset: dict[str, Any], settings: Settings
) -> tuple[ExtractResponse, Metrics, float]:
    started = time.perf_counter()
    response = await Pipeline(router, settings).run(build_request(dataset))
    return response, score(dataset, response.tasks), time.perf_counter() - started


def _pct(x: float) -> str:
    return f"{x * 100:.0f}%"


def render_table(rows: list[Row]) -> str:
    head = (
        "| Provider | Model | Precision | Recall | F1 | Date acc. | Type acc. | Tasks | "
        "Time (s) | Status |"
    )
    lines = [head, "|" + "---|" * 10]
    for r in rows:
        m = r.metrics
        if r.status == "failed":
            lines.append(
                f"| {r.provider} | {r.model} | - | - | - | - | - | - | "
                f"{r.seconds:.1f} | failed: {r.note} |"
            )
            continue
        status = r.status if r.status == "ok" else f"{r.status}: {r.note}"
        lines.append(
            f"| {r.provider} | {r.model} | {_pct(m.precision)} | {_pct(m.recall)} | "
            f"{_pct(m.f1)} | {_pct(m.date_accuracy)} | {_pct(m.type_accuracy)} | {r.tasks} | "
            f"{r.seconds:.1f} | {status} |"
        )
    return "\n".join(lines)


def render_details(rows: list[Row]) -> str:
    out: list[str] = []
    for r in rows:
        m = r.metrics
        out.append(f"\n### {r.provider} ({r.model})\n")
        for title, items in (
            ("Missed (false negatives)", m.misses),
            ("False positives", m.false_positives),
            ("Wrong due dates", m.date_errors),
        ):
            out.append(f"**{title}:** {len(items)}")
            out.extend(f"- {i}" for i in items)
            out.append("")
    return "\n".join(out)


async def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    parser.add_argument("--providers", help="comma list; default = every configured provider")
    parser.add_argument("--dataset", type=Path, default=DATASET)
    parser.add_argument("--out", type=Path, default=HERE / "results")
    parser.add_argument("--concurrency", type=int, default=2)
    parser.add_argument("--verbose", action="store_true", help="print misses and false positives")
    args = parser.parse_args(argv)

    load_env_file(REPO_ROOT / ".env")
    dataset = load_dataset(args.dataset)
    settings = Settings(internal_api_key="eval", extract_concurrency=args.concurrency)

    async with httpx.AsyncClient() as client:
        providers = build_providers(os.environ, client)
        wanted = [n.strip() for n in args.providers.split(",")] if args.providers else None
        selected = [p for p in providers if (wanted is None or p.name in wanted)]
        missing = [n for n in (wanted or []) if n not in {p.name for p in selected}]
        if missing:
            print(f"unknown providers: {', '.join(missing)}", file=sys.stderr)
        rows: list[Row] = []
        for p in selected:
            if not p.is_configured():
                continue
            print(f"evaluating {p.name}/{p.model} ...", file=sys.stderr, flush=True)
            router = LLMRouter([p], InMemoryStore(), timeout_s=settings.llm_timeout_s)
            response, metrics, seconds = await evaluate(router, dataset, settings)
            extract = next(s for s in response.trace if s.step == "extract")
            counts = extract.counts or {}
            failed = counts.get("failed_batches", 0)
            status = (
                "failed"
                if failed and failed == counts.get("batches")
                else "partial"
                if failed
                else "ok"
            )
            note = f"{failed}/{counts.get('batches')} batches failed" if failed else ""
            if status == "failed":
                note = (extract.detail or "all batches failed")[:80]
            rows.append(Row(p.name, p.model, status, metrics, seconds, len(response.tasks), note))

    table = render_table(rows)
    print("\n" + table)
    if args.verbose:
        print(render_details(rows))

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "latest.json").write_text(
        json.dumps(
            [
                {
                    "provider": r.provider,
                    "model": r.model,
                    "status": r.status,
                    "seconds": round(r.seconds, 2),
                    "tasks": r.tasks,
                    **r.metrics.summary(),
                    "misses": r.metrics.misses,
                    "false_positives": r.metrics.false_positives,
                    "date_errors": r.metrics.date_errors,
                }
                for r in rows
            ],
            indent=2,
        ),
        encoding="utf-8",
    )
    (args.out / "latest.md").write_text(
        f"# Eval results\n\nDataset: {len(dataset['cases'])} emails "
        f"(now = {dataset['user']['now']}).\n\n{table}\n{render_details(rows)}\n",
        encoding="utf-8",
    )
    print(f"\nwrote {args.out / 'latest.md'}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
