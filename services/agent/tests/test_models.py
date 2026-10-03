import pytest
from pydantic import ValidationError

from proxiprompt_agent.models import (
    PlanDimension,
    PlanResponse,
    PostClaim,
    Survey,
    clamp_radius,
    clamp_responder_count,
    clamp_ttl,
    normalize_dimension_key,
)


@pytest.mark.parametrize(
    "vol,value,expected",
    [
        ("high", 10, 300), ("high", 99999, 1800), ("high", 600, 600), ("high", None, 900), ("high", "x", 900),
        ("medium", 1, 1800), ("medium", 10**6, 14400), ("medium", None, 5400),
        ("low", 60, 14400), ("low", 10**7, 172800), ("low", None, 43200),
    ],
)
def test_ttl_clamped_to_volatility_bounds(vol, value, expected):
    assert clamp_ttl(vol, value) == expected


def test_radius_and_count_clamps():
    assert clamp_radius(10) == 50
    assert clamp_radius(9999) == 500
    assert clamp_radius(None) == 150
    assert clamp_radius(200) == 200
    assert clamp_responder_count(0) == 1
    assert clamp_responder_count(99) == 5
    assert clamp_responder_count(None) == 2
    assert clamp_responder_count(3) == 3


def test_dimension_key_normalization():
    assert normalize_dimension_key("Noise Level") == "noise_level"
    assert normalize_dimension_key("bogus") is None
    assert normalize_dimension_key("other:Study Rooms") == "other:study_rooms"


def test_plan_dimension_takes_kind_and_volatility_from_vocab_and_clamps_ttl():
    d = PlanDimension.model_validate({"key": "noise_level", "kind": "subjective", "volatility": "low", "proposed_ttl_s": 5})
    assert (d.kind, d.volatility, d.proposed_ttl_s) == ("objective", "high", 300)
    with pytest.raises(ValidationError):
        PlanDimension.model_validate({"key": "vibes_of_doom"})


def test_survey_truncates_to_three_controls_and_requires_one():
    ctrl = lambda k: {"dimension_key": k, "label": k, "options": [{"value": "a", "label": "A", "ordinal": 0}, {"value": "b", "label": "B", "ordinal": 1}]}
    s = Survey.model_validate({"question": "q?", "controls": [ctrl(k) for k in ("noise_level", "crowd_level", "wait_time", "line_length")]})
    assert len(s.controls) == 3
    with pytest.raises(ValidationError):
        Survey.model_validate({"question": "q?", "controls": []})


def test_plan_response_clamps_radius_and_count():
    ctrl = {"dimension_key": "noise_level", "label": "Noise", "options": [{"value": "q", "label": "Quiet", "ordinal": 0}, {"value": "l", "label": "Loud", "ordinal": 1}]}
    p = PlanResponse.model_validate(
        {
            "canonical_intent": "x", "intent_key": "k", "decision": "d",
            "dimensions": [{"key": "noise_level"}],
            "survey": {"question": "q?", "controls": [ctrl]},
            "responder_radius_m": 10_000, "responder_count": 0, "planner": "llm",
        }
    )
    assert p.responder_radius_m == 500 and p.responder_count == 1


def test_plan_response_rejects_survey_control_outside_plan():
    ctrl = {"dimension_key": "crowd_level", "label": "Crowd", "options": [{"value": "q", "label": "Quiet", "ordinal": 0}, {"value": "l", "label": "Loud", "ordinal": 1}]}
    with pytest.raises(ValidationError):
        PlanResponse.model_validate(
            {"canonical_intent": "x", "intent_key": "k", "decision": "d", "dimensions": [{"key": "noise_level"}],
             "survey": {"question": "q?", "controls": [ctrl]}, "planner": "llm"}
        )


def test_post_claim_clamps_ttl():
    c = PostClaim.model_validate({"dimension": "atmosphere", "value_label": "Lively", "proposed_ttl_s": 1, "ordinal": 2})
    assert c.kind == "subjective" and c.volatility == "medium" and c.proposed_ttl_s == 1800
