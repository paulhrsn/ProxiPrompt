"""REST integration: drives the real uAgent ASGI app (same handlers as `agent.run()`)."""

import httpx
import pytest

from proxiprompt_agent.agent import agent
from proxiprompt_agent.models import PlanResponse, SummarizePostResponse, SynthesizeResponse


@pytest.fixture
async def client():
    transport = httpx.ASGITransport(app=agent._server)
    async with httpx.AsyncClient(transport=transport, base_url="http://agent.test") as c:
        yield c


PLAN_BODY = {
    "query_id": "q-123",
    "text": "Is Shapiro worth going to if I need somewhere quiet to study?",
    "place": {"id": "shapiro-undergraduate-library", "name": "Shapiro Undergraduate Library", "category": "library", "lat": 42.2757, "lng": -83.7382},
    "now_iso": "2026-10-03T19:00:00Z",
    "recent_evidence": [
        {"dimension": "noise_level", "value_label": "Moderate", "kind": "objective", "source_type": "post", "age_s": 1500, "verified_nearby": False}
    ],
}


async def test_health(client):
    r = await client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok" and body["llm_configured"] is False


async def test_plan_returns_valid_plan_response(client):
    r = await client.post("/plan", json=PLAN_BODY)
    assert r.status_code == 200, r.text
    data = r.json()
    plan = PlanResponse.model_validate(data)
    assert plan.planner == "heuristic"
    assert {"noise_level", "seating_availability"} <= {d.key for d in plan.dimensions}
    assert 1 <= len(plan.survey.controls) <= 3
    assert set(data) == {
        "canonical_intent", "intent_key", "decision", "dimensions", "needs_clarification", "clarification",
        "survey", "responder_radius_m", "responder_count", "refusal", "planner",
    }


async def test_plan_refusal_over_rest(client):
    r = await client.post("/plan", json={**PLAN_BODY, "text": "where does Sarah Kim live"})
    assert r.status_code == 200
    assert r.json()["refusal"]["reason"] and r.json()["survey"] is None and r.json()["dimensions"] == []


async def test_plan_bad_request_is_400(client):
    r = await client.post("/plan", json={"query_id": "x"})
    assert r.status_code == 400


async def test_synthesize_over_rest(client):
    body = {
        "query_id": "q-123", "text": PLAN_BODY["text"], "canonical_intent": "x", "place": PLAN_BODY["place"],
        "dimensions": [{"key": "noise_level", "label": "Noise level", "kind": "objective", "volatility": "high", "proposed_ttl_s": 900}],
        "evidence": [{"id": "e1", "dimension": "noise_level", "value_label": "Quiet", "kind": "objective", "source_type": "response", "age_s": 12, "verified_nearby": True, "note": "library 2nd floor"}],
        "confidence": {"score": 0.62, "level": "Medium", "ceiling": 0.6},
        "missing_dimensions": ["seating_availability"],
    }
    r = await client.post("/synthesize", json=body)
    assert r.status_code == 200, r.text
    out = SynthesizeResponse.model_validate(r.json())
    assert out.recommendation in ("go", "maybe") and any("seating" in c for c in out.caveats)
    r2 = await client.post("/synthesize", json={**body, "evidence": []})
    assert r2.json()["recommendation"] == "insufficient"


async def test_summarize_post_over_rest(client):
    body = {"post_id": "p1", "place": PLAN_BODY["place"], "text": "Pretty loud near the entrance, almost no seats left.", "comments": [{"text": "agree", "age_s": 30}], "now_iso": "2026-10-03T19:00:00Z"}
    r = await client.post("/summarize_post", json=body)
    assert r.status_code == 200, r.text
    out = SummarizePostResponse.model_validate(r.json())
    assert {c.dimension for c in out.claims} >= {"noise_level", "seating_availability"}


def test_agent_server_binds_loopback_by_default():
    """/plan spends the ASI:One key; on 0.0.0.0 anyone on the network could call it."""
    import uagents.asgi

    from proxiprompt_agent import agent  # noqa: F401  (import applies the bind host)

    assert uagents.asgi.HOST == "127.0.0.1"
