"""Pydantic models mirroring SPEC §9, plus the dimension vocabulary (SPEC §6).

These are the *domain* models. The uAgents REST layer (``agent.py``) uses thin
``uagents.Model`` wrappers (pydantic v1 under the hood) and hands the payload to
these models for strict validation and clamping.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Kind = Literal["objective", "subjective"]
Volatility = Literal["high", "medium", "low"]
SourceType = Literal["response", "post", "comment", "social"]
Planner = Literal["llm", "heuristic"]
Recommendation = Literal["go", "maybe", "avoid", "insufficient"]
Level = Literal["High", "Medium", "Low"]

# ---------------------------------------------------------------------------
# Dimension vocabulary (SPEC §6) and TTL bounds
# ---------------------------------------------------------------------------

DIMENSION_VOCAB: dict[str, tuple[Kind, Volatility]] = {
    "seating_availability": ("objective", "high"),
    "crowd_level": ("objective", "high"),
    "wait_time": ("objective", "high"),
    "line_length": ("objective", "high"),
    "noise_level": ("objective", "high"),
    "equipment_availability": ("objective", "high"),
    "parking_availability": ("objective", "high"),
    "food_availability": ("objective", "medium"),
    "open_status": ("objective", "low"),
    "event_status": ("objective", "medium"),
    "cleanliness": ("objective", "medium"),
    "temperature": ("objective", "medium"),
    "atmosphere": ("subjective", "medium"),
    "worth_it": ("subjective", "medium"),
}

DIMENSION_LABELS: dict[str, str] = {
    "seating_availability": "Seating availability",
    "crowd_level": "Crowd level",
    "wait_time": "Wait time",
    "line_length": "Line length",
    "noise_level": "Noise level",
    "equipment_availability": "Equipment availability",
    "parking_availability": "Parking availability",
    "food_availability": "Food availability",
    "open_status": "Open status",
    "event_status": "Event status",
    "cleanliness": "Cleanliness",
    "temperature": "Temperature",
    "atmosphere": "Atmosphere",
    "worth_it": "Worth it",
}

# volatility -> (min_s, default_s, max_s)
TTL_BOUNDS: dict[str, tuple[int, int, int]] = {
    "high": (300, 900, 1800),
    "medium": (1800, 5400, 14400),
    "low": (14400, 43200, 172800),
}

RADIUS_MIN, RADIUS_DEFAULT, RADIUS_MAX = 50, 150, 500
RESPONDERS_MIN, RESPONDERS_DEFAULT, RESPONDERS_MAX = 1, 2, 5
MAX_CONTROLS = 3

_OTHER_RE = re.compile(r"^other:[a-z0-9][a-z0-9_-]{0,39}$")


def normalize_dimension_key(raw: str) -> str | None:
    """Return a canonical vocabulary / ``other:<slug>`` key, or None if unusable."""
    key = (raw or "").strip().lower().replace(" ", "_").replace("-", "_")
    if key in DIMENSION_VOCAB:
        return key
    if key.startswith("other:"):
        slug = re.sub(r"[^a-z0-9_-]+", "_", key[6:]).strip("_")[:40]
        cand = f"other:{slug}"
        if slug and _OTHER_RE.match(cand):
            return cand
    return None


def clamp_ttl(volatility: str, value: Any) -> int:
    lo, default, hi = TTL_BOUNDS.get(volatility, TTL_BOUNDS["medium"])
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:
        return default
    return int(min(hi, max(lo, value)))


def clamp_radius(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:
        return RADIUS_DEFAULT
    return int(min(RADIUS_MAX, max(RADIUS_MIN, value)))


def clamp_responder_count(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:
        return RESPONDERS_DEFAULT
    return int(min(RESPONDERS_MAX, max(RESPONDERS_MIN, round(value))))


def dimension_kind_volatility(key: str, kind: Any = None, volatility: Any = None) -> tuple[Kind, Volatility]:
    """Vocabulary keys take kind/volatility from SPEC §6; ``other:`` keys keep the proposal."""
    if key in DIMENSION_VOCAB:
        return DIMENSION_VOCAB[key]
    k: Kind = kind if kind in ("objective", "subjective") else "objective"
    v: Volatility = volatility if volatility in ("high", "medium", "low") else "medium"
    return k, v


def label_for(key: str) -> str:
    if key in DIMENSION_LABELS:
        return DIMENSION_LABELS[key]
    return key.split(":", 1)[-1].replace("_", " ").replace("-", " ").capitalize()


# ---------------------------------------------------------------------------
# Shared pieces
# ---------------------------------------------------------------------------


class _Base(BaseModel):
    model_config = ConfigDict(extra="ignore")


class Place(_Base):
    id: str
    name: str
    category: str = ""
    lat: float
    lng: float


class EvidenceItem(_Base):
    id: str = ""
    dimension: str
    value_label: str
    kind: Kind
    source_type: SourceType
    age_s: float = Field(ge=0)
    verified_nearby: bool
    note: str = ""


class RecentEvidence(_Base):
    dimension: str
    value_label: str
    kind: Kind
    source_type: SourceType
    age_s: float = Field(ge=0)
    verified_nearby: bool


class PlanDimension(_Base):
    key: str
    label: str = ""
    kind: Kind = "objective"
    volatility: Volatility = "high"
    proposed_ttl_s: int = 0

    @model_validator(mode="before")
    @classmethod
    def _canonicalize(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        key = normalize_dimension_key(str(data.get("key", "")))
        if key is None:
            raise ValueError(f"Unknown dimension key: {data.get('key')!r}")
        kind, vol = dimension_kind_volatility(key, data.get("kind"), data.get("volatility"))
        return {
            "key": key,
            "label": (data.get("label") or label_for(key)),
            "kind": kind,
            "volatility": vol,
            "proposed_ttl_s": clamp_ttl(vol, data.get("proposed_ttl_s")),
        }


class SurveyOption(_Base):
    value: str = Field(min_length=1)
    label: str = Field(min_length=1)
    ordinal: int

    @field_validator("value", mode="before")
    @classmethod
    def _str_value(cls, v: Any) -> Any:
        return str(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else v


class SurveyControl(_Base):
    dimension_key: str
    label: str = Field(min_length=1)
    options: list[SurveyOption] = Field(min_length=2, max_length=6)

    @field_validator("dimension_key", mode="before")
    @classmethod
    def _norm_key(cls, v: Any) -> Any:
        key = normalize_dimension_key(str(v))
        if key is None:
            raise ValueError(f"Unknown dimension key: {v!r}")
        return key


class Survey(_Base):
    question: str = Field(min_length=1)
    controls: list[SurveyControl] = Field(min_length=1, max_length=MAX_CONTROLS)
    allow_note: bool = True

    @model_validator(mode="before")
    @classmethod
    def _truncate_controls(cls, data: Any) -> Any:
        # Clamp rather than reject: more than 3 controls → keep the first 3.
        if isinstance(data, dict) and isinstance(data.get("controls"), list):
            data = {**data, "controls": data["controls"][:MAX_CONTROLS]}
        return data


class Clarification(_Base):
    question: str = Field(min_length=1)
    options: list[str] = Field(default_factory=list)


class Refusal(_Base):
    reason: str = Field(min_length=1)


# ---------------------------------------------------------------------------
# /plan
# ---------------------------------------------------------------------------


class PlanRequest(_Base):
    query_id: str
    text: str = Field(max_length=1000)  # submit_query caps at 300; this bounds direct /plan calls
    place: Place
    now_iso: str = ""
    recent_evidence: list[RecentEvidence] = Field(default_factory=list)


class PlanResponse(_Base):
    canonical_intent: str
    intent_key: str
    decision: str
    dimensions: list[PlanDimension]
    needs_clarification: bool = False
    clarification: Clarification | None = None
    survey: Survey | None = None
    responder_radius_m: int = RADIUS_DEFAULT
    responder_count: int = RESPONDERS_DEFAULT
    refusal: Refusal | None = None
    planner: Planner

    @field_validator("responder_radius_m", mode="before")
    @classmethod
    def _radius(cls, v: Any) -> int:
        return clamp_radius(v)

    @field_validator("responder_count", mode="before")
    @classmethod
    def _count(cls, v: Any) -> int:
        return clamp_responder_count(v)

    @field_validator("dimensions")
    @classmethod
    def _dedupe(cls, dims: list[PlanDimension]) -> list[PlanDimension]:
        seen: set[str] = set()
        out: list[PlanDimension] = []
        for d in dims:
            if d.key not in seen:
                seen.add(d.key)
                out.append(d)
        return out

    @model_validator(mode="after")
    def _consistency(self) -> "PlanResponse":
        proceeds = self.refusal is None and not self.needs_clarification
        if self.needs_clarification and self.clarification is None:
            raise ValueError("needs_clarification requires a clarification")
        if proceeds:
            if not self.dimensions:
                raise ValueError("A plan that proceeds needs at least one dimension")
            if self.survey is None:
                raise ValueError("A plan that proceeds needs a survey")
        if self.survey is not None:
            keys = {d.key for d in self.dimensions}
            for c in self.survey.controls:
                if c.dimension_key not in keys:
                    raise ValueError(f"Survey control references dimension not in plan: {c.dimension_key}")
        return self


# ---------------------------------------------------------------------------
# /synthesize
# ---------------------------------------------------------------------------


class Confidence(_Base):
    score: float
    level: Level
    ceiling: float


class SynthesizeRequest(_Base):
    query_id: str
    text: str
    canonical_intent: str = ""
    place: Place
    dimensions: list[PlanDimension] = Field(default_factory=list)
    evidence: list[EvidenceItem] = Field(default_factory=list)
    confidence: Confidence
    missing_dimensions: list[str] = Field(default_factory=list)


class SynthesizeResponse(_Base):
    headline: str = Field(min_length=1)
    recommendation: Recommendation
    summary: str
    supporting: list[str] = Field(default_factory=list)
    caveats: list[str] = Field(default_factory=list)
    planner: Planner


# ---------------------------------------------------------------------------
# /summarize_post
# ---------------------------------------------------------------------------


class PostComment(_Base):
    text: str
    age_s: float = Field(ge=0)


class SummarizePostRequest(_Base):
    post_id: str
    place: Place
    text: str
    comments: list[PostComment] = Field(default_factory=list)
    now_iso: str = ""


class PostClaim(_Base):
    dimension: str
    value_label: str
    kind: Kind = "objective"
    volatility: Volatility = "high"
    proposed_ttl_s: int = 0
    ordinal: int | None = None

    @model_validator(mode="before")
    @classmethod
    def _canonicalize(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        key = normalize_dimension_key(str(data.get("dimension", "")))
        if key is None:
            raise ValueError(f"Unknown dimension key: {data.get('dimension')!r}")
        kind, vol = dimension_kind_volatility(key, data.get("kind"), data.get("volatility"))
        ordinal = data.get("ordinal")
        if isinstance(ordinal, bool) or not isinstance(ordinal, int):
            ordinal = int(ordinal) if isinstance(ordinal, float) else None
        return {
            "dimension": key,
            "value_label": data.get("value_label", ""),
            "kind": kind,
            "volatility": vol,
            "proposed_ttl_s": clamp_ttl(vol, data.get("proposed_ttl_s")),
            "ordinal": ordinal,
        }


class SummarizePostResponse(_Base):
    summary: str = Field(min_length=1)
    claims: list[PostClaim] = Field(default_factory=list)
    planner: Planner
