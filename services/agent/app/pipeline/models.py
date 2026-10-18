"""Internal (non-contract) data passed between pipeline steps."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from app.pipeline.prioritize import PriorityResult
from app.pipeline.temporal import Resolution
from app.schemas import LlmExtractionItem


@dataclass(frozen=True)
class CleanEmail:
    id: str
    thread_id: str
    from_name: str | None
    from_email: str
    subject: str
    text: str  # cleaned + PII-redacted; the only body text any later step sees
    received_at: datetime
    labels: tuple[str, ...] = ()
    list_unsubscribe: bool = False
    redactions: int = 0


@dataclass
class WorkItem:
    email: CleanEmail
    raw: LlmExtractionItem
    extracted_by: str
    resolution: Resolution | None = None
    priority: PriorityResult | None = None
    notes: list[str] = field(default_factory=list)
