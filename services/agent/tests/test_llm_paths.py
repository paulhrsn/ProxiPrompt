import json

import pytest

from proxiprompt_agent import llm, planner
from proxiprompt_agent.models import PlanRequest, SummarizePostRequest, SynthesizeRequest
from test_planner import SHAPIRO_Q, ev, plan_req, post_req, synth_req


@pytest.fixture
def with_key(monkeypatch):
    monkeypatch.setenv("ASI_ONE_API_KEY", "test-key")


def mock_llm(monkeypatch, result=None, exc=None):
    calls = []

    async def fake(system, user, schema_hint=""):
        calls.append((system, user))
        if exc:
            raise exc
        return result

    monkeypatch.setattr(llm, "complete_json", fake)
    return calls


# ---- parsing (llm.parse_json_text) -------------------------------------------------

def test_parse_handles_code_fences_and_prose():
    assert llm.parse_json_text('```json\n{"a": 1}\n```') == {"a": 1}
    assert llm.parse_json_text('```\n{"a": 1}\n```') == {"a": 1}
    assert llm.parse_json_text('Sure! Here you go: {"a": {"b": 2}} Hope that helps') == {"a": {"b": 2}}


@pytest.mark.parametrize("bad", ["", "not json", "[1,2]", "{broken"])
def test_parse_rejects_garbage(bad):
    with pytest.raises(ValueError):
        llm.parse_json_text(bad)


async def test_complete_json_retries_once_then_succeeds(with_key, monkeypatch):
    replies = iter(["totally not json", '```json\n{"ok": true}\n```'])
    seen = []

    async def fake_chat(system, user):
        seen.append(user)
        return next(replies)

    monkeypatch.setattr(llm, "_chat", fake_chat)
    assert await llm.complete_json("sys", "user", "{}") == {"ok": True}
    assert len(seen) == 2 and "not valid JSON" in seen[1]


async def test_complete_json_gives_up_after_second_failure(with_key, monkeypatch):
    async def fake_chat(system, user):
        return "nope"

    monkeypatch.setattr(llm, "_chat", fake_chat)
    with pytest.raises(llm.LLMError):
        await llm.complete_json("sys", "user")


# ---- plan with LLM -----------------------------------------------------------------

GOOD_PLAN = {
    "canonical_intent": "Whether Shapiro is quiet with seats right now",
    "intent_key": "ignored",
    "decision": "Whether to study at Shapiro",
    "dimensions": [
        {"key": "noise_level", "label": "Noise level", "kind": "objective", "volatility": "high", "proposed_ttl_s": 10},
        {"key": "seating_availability", "label": "Seating", "kind": "objective", "volatility": "high", "proposed_ttl_s": 999999},
        {"key": "made_up_dimension", "label": "x", "kind": "objective", "volatility": "high", "proposed_ttl_s": 900},
    ],
    "needs_clarification": False,
    "clarification": None,
    "survey": {
        "question": "How loud and how full is it at Shapiro right now?",
        "controls": [
            {"dimension_key": "noise_level", "label": "Noise", "options": [
                {"value": "quiet", "label": "Quiet", "ordinal": 0}, {"value": "mid", "label": "Moderate", "ordinal": 1}, {"value": "loud", "label": "Loud", "ordinal": 2}]},
        ],
        "allow_note": True,
    },
    "responder_radius_m": 9000,
    "responder_count": 12,
    "refusal": None,
}


async def test_llm_plan_is_validated_and_clamped(with_key, monkeypatch, shapiro):
    calls = mock_llm(monkeypatch, GOOD_PLAN)
    p = await planner.plan(plan_req(shapiro))
    assert len(calls) == 1
    assert p.planner == "llm"
    assert [d.key for d in p.dimensions] == ["noise_level", "seating_availability"]  # unknown key dropped
    assert [d.proposed_ttl_s for d in p.dimensions] == [300, 1800]  # clamped to high bounds
    assert p.responder_radius_m == 500 and p.responder_count == 5
    assert [c.dimension_key for c in p.survey.controls] == ["noise_level", "seating_availability"]  # missing control repaired
    assert p.intent_key == "shapiro-undergraduate-library:noise_level+seating_availability"


async def test_llm_survey_question_leaking_requester_is_replaced(with_key, monkeypatch, shapiro):
    bad = {**GOOD_PLAN, "survey": {**GOOD_PLAN["survey"], "question": "Someone asked: is it quiet near you?"}}
    mock_llm(monkeypatch, bad)
    p = await planner.plan(plan_req(shapiro))
    assert "Someone" not in p.survey.question and p.survey.question.startswith("Quick question about")


async def test_llm_refusal_honoured(with_key, monkeypatch, shapiro):
    mock_llm(monkeypatch, {"refusal": {"reason": "Not about a place."}, "dimensions": []})
    p = await planner.plan(plan_req(shapiro, "what is the meaning of life"))
    assert p.refusal.reason == "Not about a place." and p.planner == "llm"


@pytest.mark.parametrize(
    "result,exc",
    [
        ({"dimensions": []}, None),
        ({"dimensions": [{"key": "nonsense"}], "survey": None}, None),
        ({"needs_clarification": True, "clarification": None, "dimensions": [{"key": "noise_level"}]}, None),
        (None, llm.LLMError("unparseable JSON from model")),
        (None, RuntimeError("network down")),
    ],
)
async def test_invalid_llm_plan_falls_back_to_heuristic(with_key, monkeypatch, shapiro, result, exc):
    mock_llm(monkeypatch, result, exc)
    p = await planner.plan(plan_req(shapiro))
    assert p.planner == "heuristic"
    assert "noise_level" in [d.key for d in p.dimensions]


async def test_llm_clarification_passes_through(with_key, monkeypatch, shapiro):
    mock_llm(monkeypatch, {
        "canonical_intent": "x", "decision": "d", "dimensions": [{"key": "seating_availability"}],
        "needs_clarification": True, "clarification": {"question": "Which floor?", "options": ["Main", "Basement"]},
    })
    p = await planner.plan(plan_req(shapiro, "any seats?"))
    assert p.needs_clarification and p.clarification.options == ["Main", "Basement"] and p.survey is None


# ---- synthesize / summarize with LLM -----------------------------------------------

async def test_llm_synthesis_downgraded_at_low_confidence(with_key, monkeypatch, shapiro):
    mock_llm(monkeypatch, {"headline": "Go, it is quiet.", "recommendation": "go", "summary": "s", "supporting": ["a"], "caveats": []})
    r = await planner.synthesize(synth_req(shapiro, [ev("noise_level", "Quiet")], level="Low"))
    assert r.planner == "llm" and r.recommendation == "maybe"


async def test_bad_llm_synthesis_falls_back(with_key, monkeypatch, shapiro):
    mock_llm(monkeypatch, {"headline": "", "recommendation": "definitely"})
    r = await planner.synthesize(synth_req(shapiro, [ev("noise_level", "Quiet")]))
    assert r.planner == "heuristic" and r.recommendation == "go"


async def test_llm_summarize_post_one_sentence_and_vocab_only(with_key, monkeypatch, shapiro):
    mock_llm(monkeypatch, {
        "summary": "It is quiet at Shapiro. Seats are open.",
        "claims": [
            {"dimension": "noise_level", "value_label": "Quiet", "kind": "subjective", "volatility": "low", "proposed_ttl_s": 1, "ordinal": 0},
            {"dimension": "not_a_dimension", "value_label": "x", "kind": "objective", "volatility": "high", "proposed_ttl_s": 900, "ordinal": 1},
        ],
    })
    r = await planner.summarize_post(post_req(shapiro, "quiet"))
    assert r.planner == "llm" and r.summary == "It is quiet at Shapiro."
    assert len(r.claims) == 1 and r.claims[0].kind == "objective" and r.claims[0].proposed_ttl_s == 300


async def test_summarize_post_llm_failure_falls_back(with_key, monkeypatch, shapiro):
    mock_llm(monkeypatch, exc=llm.LLMError("boom"))
    r = await planner.summarize_post(post_req(shapiro, "Very quiet in here."))
    assert r.planner == "heuristic" and r.claims[0].dimension == "noise_level"
