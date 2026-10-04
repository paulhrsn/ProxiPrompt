import re

import pytest

from proxiprompt_agent import llm, planner
from proxiprompt_agent.models import PlanRequest, SummarizePostRequest, SynthesizeRequest

SHAPIRO_Q = "Is Shapiro worth going to if I need somewhere quiet to study?"


def plan_req(shapiro, text=SHAPIRO_Q):
    return PlanRequest(query_id="q1", text=text, place=shapiro, now_iso="2026-10-03T19:00:00Z", recent_evidence=[])


async def test_heuristic_plan_for_demo_question(shapiro):
    p = await planner.plan(plan_req(shapiro))
    keys = [d.key for d in p.dimensions]
    assert "noise_level" in keys and "seating_availability" in keys
    assert p.planner == "heuristic"
    assert p.refusal is None and not p.needs_clarification
    assert 1 <= len(p.survey.controls) <= 3
    assert {c.dimension_key for c in p.survey.controls} <= set(keys)
    for c in p.survey.controls:
        assert 3 <= len(c.options) <= 4
        assert [o.ordinal for o in c.options] == list(range(len(c.options)))
    assert p.responder_radius_m == 150 and p.responder_count == 2
    # The survey question is generated from place + dimensions, never the requester's own
    # words: one evidence job can serve several queries, and it must not identify or quote
    # whoever asked, nor imply the responder is the one who asked (SPEC §3).
    assert p.survey.question != SHAPIRO_Q
    assert p.survey.question.startswith("Quick question about Shapiro Undergraduate Library")
    assert "noise level" in p.survey.question
    for leak in ("someone asked", "they want", "a user"):
        assert leak not in p.survey.question.lower()


@pytest.mark.parametrize(
    "text,dim",
    [
        ("How long is the line at the Union?", "line_length"),
        ("Is there parking near the stadium?", "parking_availability"),
        ("Are any treadmills free?", "equipment_availability"),
        ("Is the dining hall open?", "open_status"),
        ("What's the vibe tonight?", "atmosphere"),
        ("Is it packed right now?", "crowd_level"),
        ("blah blah", "other:ask_"),  # freeform: key derived from the question itself
    ],
)
async def test_heuristic_keywords(shapiro, text, dim):
    p = await planner.plan(plan_req(shapiro, text))
    keys = [d.key for d in p.dimensions]
    assert any(k == dim or k.startswith(dim) for k in keys), keys
    assert len(p.dimensions) <= 3


async def test_canned_option_sets(shapiro):
    seat = planner.build_control("seating_availability")
    assert [o.label for o in seat.options] == ["None", "A few", "Some", "Plenty"]
    assert [o.label for o in planner.build_control("noise_level").options] == ["Quiet", "Moderate", "Loud"]
    assert [o.label for o in planner.build_control("wait_time").options] == ["None", "<5 min", "5–15 min", "15+ min"]
    assert [o.label for o in planner.build_control("crowd_level").options] == ["Empty", "Light", "Busy", "Packed"]


@pytest.mark.parametrize(
    "text",
    [
        "where does Sarah Kim live",
        "is my ex at the library",
        "Is Sarah Kim at Shapiro right now?",
        "who is inside the dorm room on 3rd floor",
        "can you track her around campus",
        "how many patients are in the waiting room at the clinic",
    ],
)
async def test_refusals(shapiro, text):
    p = await planner.plan(plan_req(shapiro, text))
    assert p.refusal is not None and p.refusal.reason
    assert p.dimensions == [] and p.survey is None


@pytest.mark.parametrize("text", [SHAPIRO_Q, "Is Michigan Union at capacity?", "Is the Diag busy?", "Is Shapiro Undergraduate Library in use?"])
async def test_not_refused(shapiro, text):
    assert (await planner.plan(plan_req(shapiro, text))).refusal is None


async def test_refusal_guard_runs_before_llm(shapiro, monkeypatch):
    monkeypatch.setenv("ASI_ONE_API_KEY", "k")

    async def boom(*a, **k):
        raise AssertionError("LLM must not be called for refused questions")

    monkeypatch.setattr(llm, "complete_json", boom)
    p = await planner.plan(plan_req(shapiro, "where does Sarah Kim live"))
    assert p.refusal is not None


def synth_req(shapiro, evidence, level="High", missing=()):
    return SynthesizeRequest.model_validate(
        {
            "query_id": "q1", "text": SHAPIRO_Q, "canonical_intent": "x", "place": shapiro,
            "dimensions": [{"key": "noise_level"}, {"key": "seating_availability"}],
            "evidence": evidence,
            "confidence": {"score": 0.8, "level": level, "ceiling": 0.8},
            "missing_dimensions": list(missing),
        }
    )


def ev(dim, label, kind="objective", age=20, verified=True, i="e1"):
    return {"id": i, "dimension": dim, "value_label": label, "kind": kind, "source_type": "response",
            "age_s": age, "verified_nearby": verified, "note": ""}


async def test_synthesize_empty_evidence_is_insufficient(shapiro):
    r = await planner.synthesize(synth_req(shapiro, [], level="Low", missing=["noise_level"]))
    assert r.recommendation == "insufficient"
    assert "insufficient" in r.headline.lower()
    assert r.supporting == []


async def test_synthesize_never_calls_llm_without_evidence(shapiro, monkeypatch):
    monkeypatch.setenv("ASI_ONE_API_KEY", "k")

    async def boom(*a, **k):
        raise AssertionError("no LLM without evidence")

    monkeypatch.setattr(llm, "complete_json", boom)
    r = await planner.synthesize(synth_req(shapiro, []))
    assert r.recommendation == "insufficient"


async def test_heuristic_synthesis_composes_modal_headline(shapiro):
    r = await planner.synthesize(
        synth_req(
            shapiro,
            [ev("noise_level", "Quiet", i="1"), ev("noise_level", "Quiet", i="2", age=40), ev("noise_level", "Loud", i="3", age=300),
             ev("seating_availability", "Plenty", i="4")],
        )
    )
    assert r.planner == "heuristic" and r.recommendation == "go"
    assert "Quiet" in r.headline and "Plenty" in r.headline and "Loud" not in r.headline
    assert r.headline.count(".") == 1  # one sentence


async def test_synthesis_cannot_exceed_low_confidence(shapiro):
    r = await planner.synthesize(synth_req(shapiro, [ev("noise_level", "Quiet")], level="Low"))
    assert r.recommendation == "maybe"
    assert any("low" in c.lower() for c in r.caveats)


async def test_subjective_evidence_framed_as_opinion(shapiro):
    r = await planner.synthesize(synth_req(shapiro, [ev("worth_it", "Worth it", kind="subjective")]))
    assert "people describe" in r.headline and "opinion" in r.headline.lower()
    assert any("opinion" in c.lower() for c in r.caveats)


def post_req(shapiro, text, comments=()):
    return SummarizePostRequest.model_validate(
        {"post_id": "p1", "place": shapiro, "text": text, "comments": list(comments), "now_iso": "2026-10-03T19:00:00Z"}
    )


async def test_summarize_post_heuristic(shapiro):
    r = await planner.summarize_post(post_req(shapiro, "Super quiet on the 2nd floor and plenty of open seats. Come on by!"))
    assert r.planner == "heuristic"
    assert r.summary.count(".") == 1 or r.summary.count("!") == 0  # single sentence
    dims = {c.dimension: c for c in r.claims}
    assert dims["noise_level"].ordinal == 0 and dims["noise_level"].value_label == "Quiet"
    assert dims["seating_availability"].ordinal == 3 and dims["seating_availability"].value_label == "Plenty"
    assert dims["noise_level"].proposed_ttl_s == 900 and dims["noise_level"].volatility == "high"


async def test_summarize_post_comment_adds_claim_and_no_claims_when_nothing_stated(shapiro):
    r = await planner.summarize_post(post_req(shapiro, "Studying here today.", [{"text": "line is long, like 20 min", "age_s": 60}]))
    assert {c.dimension for c in r.claims} >= {"wait_time"}
    r2 = await planner.summarize_post(post_req(shapiro, "Studying here today."))
    assert r2.claims == [] and r2.summary


async def test_freeform_question_keeps_the_asker_s_wording(shapiro):
    """A question matching no keyword must not become "what is the answer right now?"."""
    asked = "did they restock the white monsters"
    p = await planner.plan(plan_req(shapiro, asked))
    assert len(p.dimensions) == 1
    key = p.dimensions[0].key
    assert planner.is_freeform(key)
    assert "white monsters" in p.survey.question
    assert "the answer" not in p.survey.question.lower()
    assert p.survey.question.startswith(f"At {shapiro['name']}:")
    # Two different freeform questions about one place must not share an evidence job,
    # which findAttachableJob decides from the dimension sets.
    other = await planner.plan(plan_req(shapiro, "did anyone leave a blue umbrella"))
    assert other.dimensions[0].key != key


async def test_freeform_synthesis_does_not_say_answer_is(shapiro):
    asked = "did they restock the white monsters"
    key = planner.freeform_key(asked)
    req = SynthesizeRequest.model_validate(
        {
            "query_id": "q1", "text": asked, "canonical_intent": "x", "place": shapiro,
            "dimensions": [{"key": key, "label": asked}],
            "evidence": [ev(key, "Yes", i="1")],
            "confidence": {"score": 0.6, "level": "Medium", "ceiling": 0.6},
            "missing_dimensions": [],
        }
    )
    r = await planner.synthesize(req)
    assert "answer is" not in r.headline.lower()
    assert "answer is" not in r.summary.lower()
    assert "Yes" in r.headline
    # The hashed key must never surface in copy a human reads.
    for text in (r.headline, r.summary, *r.supporting):
        assert "ask_" not in text and not re.search(r"\bask [0-9a-f]{6,}", text.lower()), text
