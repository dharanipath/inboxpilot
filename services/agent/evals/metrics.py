"""Scoring: match predicted tasks to labelled ones and compute precision/recall/date accuracy.

A prediction matches an expected task when it is in the same *thread* and its evidence
contains one of the expected key phrases (normalised). Each expected task matches at most
once, so a duplicate the dedupe step missed counts as a false positive.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.pipeline.grounding import normalise
from app.schemas import Task


@dataclass
class Expected:
    case_id: str
    thread_id: str
    evidence: list[str]
    due_dates: list[str | None]
    types: list[str]
    optional: bool = False


@dataclass
class Metrics:
    tp: int = 0
    fp: int = 0
    fn: int = 0
    matched_optional: int = 0
    date_correct: int = 0
    type_correct: int = 0
    misses: list[str] = field(default_factory=list)
    false_positives: list[str] = field(default_factory=list)
    date_errors: list[str] = field(default_factory=list)

    @property
    def precision(self) -> float:
        predicted = self.tp + self.fp
        return self.tp / predicted if predicted else 1.0

    @property
    def recall(self) -> float:
        relevant = self.tp + self.fn
        return self.tp / relevant if relevant else 1.0

    @property
    def f1(self) -> float:
        p, r = self.precision, self.recall
        return 2 * p * r / (p + r) if p + r else 0.0

    @property
    def date_accuracy(self) -> float:
        return self.date_correct / self.tp if self.tp else 0.0

    @property
    def type_accuracy(self) -> float:
        return self.type_correct / self.tp if self.tp else 0.0

    def summary(self) -> dict[str, Any]:
        return {
            "precision": round(self.precision, 3),
            "recall": round(self.recall, 3),
            "f1": round(self.f1, 3),
            "date_accuracy": round(self.date_accuracy, 3),
            "type_accuracy": round(self.type_accuracy, 3),
            "tp": self.tp,
            "fp": self.fp,
            "fn": self.fn,
        }


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else [value]


def expected_from_dataset(dataset: dict[str, Any]) -> list[Expected]:
    out: list[Expected] = []
    for case in dataset["cases"]:
        email = case["email"]
        for exp in case["expected"]:
            out.append(
                Expected(
                    case_id=email["id"],
                    thread_id=email["thread_id"],
                    evidence=[normalise(e) for e in exp["evidence"]],
                    due_dates=_as_list(exp.get("due_date")),
                    types=_as_list(exp["type"]),
                    optional=bool(exp.get("optional", False)),
                )
            )
    return out


def score(dataset: dict[str, Any], tasks: list[Task]) -> Metrics:
    expected = expected_from_dataset(dataset)
    matched: set[int] = set()
    m = Metrics()

    for task in sorted(tasks, key=lambda t: -t.confidence):
        evidence = normalise(task.evidence)
        hit = next(
            (
                i
                for i, e in enumerate(expected)
                if i not in matched
                and e.thread_id == task.source.thread_id
                and any(k in evidence for k in e.evidence)
            ),
            None,
        )
        if hit is None:
            m.fp += 1
            m.false_positives.append(f"{task.email_id}: {task.title!r} <- {task.evidence!r}")
            continue
        matched.add(hit)
        e = expected[hit]
        m.tp += 1
        if e.optional:
            m.matched_optional += 1
        due = task.due_date.isoformat() if task.due_date else None
        if due in e.due_dates:
            m.date_correct += 1
        else:
            m.date_errors.append(
                f"{e.case_id}: got {due} ({task.date_source}, phrase={task.due_phrase!r}), "
                f"want {e.due_dates}"
            )
        if task.type in e.types:
            m.type_correct += 1

    for i, e in enumerate(expected):
        if i not in matched and not e.optional:
            m.fn += 1
            m.misses.append(f"{e.case_id}: {e.evidence[0]!r}")
    return m
