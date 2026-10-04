import httpx
import pytest

from proxiprompt_agent import bridge
from proxiprompt_agent.agent import extract_text, reply_message
from proxiprompt_agent.places import resolve_place
from uagents_core.contrib.protocols.chat import ChatMessage, EndSessionContent, TextContent
from datetime import datetime, timezone
from uuid import uuid4


def test_resolve_place_from_catalog():
    assert resolve_place("Is Shapiro Library busy right now?").id == "shapiro-undergraduate-library"
    assert resolve_place("how's the south quad dining line").id == "south-quad-dining"
    assert resolve_place("what is the meaning of life") is None


def test_chat_message_helpers():
    m = ChatMessage(timestamp=datetime.now(timezone.utc), msg_id=uuid4(), content=[TextContent(type="text", text="hi"), TextContent(type="text", text="there")])
    assert extract_text(m) == "hi there"
    out = reply_message("ok")
    assert isinstance(out.content[-1], EndSessionContent) and out.content[0].text == "ok"


async def test_no_orchestrator_replies_with_plan():
    reply, pending = await bridge.handle_chat_text("Is Shapiro Library busy right now?", "agent1abc")
    assert pending is None
    assert "Shapiro Undergraduate Library" in reply and "isn't connected" in reply and "crowd level" in reply


async def test_no_orchestrator_refusal():
    reply, pending = await bridge.handle_chat_text("is my ex at the library", "agent1abc")
    assert pending is None
    assert "can't" in reply.lower()


async def test_orchestrator_poll_returns_headline_confidence_sources():
    state = {"polls": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            assert request.url.path == "/asi/query"
            import json
            assert json.loads(request.content) == {"text": "Is Shapiro busy?", "sender": "agent1abc"}
            return httpx.Response(200, json={"id": "abc"})
        state["polls"] += 1
        if state["polls"] < 2:
            return httpx.Response(200, json={"status": "collecting", "progress": "asking 2 people"})
        return httpx.Response(200, json={"status": "answered", "headline": "Shapiro is moderately busy.", "confidence": {"level": "High"}, "sources": "2 recent nearby reports"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        reply, pending = await bridge.run_orchestrated("Is Shapiro busy?", "agent1abc", "http://orc", total_s=5, interval_s=0.01, client=c)
    assert pending is None
    assert reply == "Shapiro is moderately busy.\nConfidence: High\nBased on 2 recent nearby reports\nAnswers come from people physically near the place, not from guesses."


async def test_orchestrator_timeout_gives_progress_message():
    def handler(request):
        return httpx.Response(200, json={"id": "abc"} if request.method == "POST" else {"status": "collecting", "progress": "asking 2 people"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        reply, pending = await bridge.run_orchestrated("q", "s", "http://orc", total_s=0.05, interval_s=0.01, client=c)
    assert pending == "abc"
    assert "Still working" in reply and "asking 2 people" in reply
    assert "I'll send the answer here" in reply


async def test_orchestrator_unreachable():
    def handler(request):
        raise httpx.ConnectError("down")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        reply, pending = await bridge.run_orchestrated("q", "s", "http://orc", client=c)
    assert pending is None
    assert "couldn't reach" in reply


async def test_leading_agent_mention_is_stripped_before_submitting(monkeypatch):
    """ASI:One prefixes "@agent1q…" when a chat targets this agent; it is not part of the question."""
    seen = {}

    async def fake_run(text, sender, url):
        seen["text"] = text
        return "ok"

    monkeypatch.setenv("ORCHESTRATOR_URL", "http://orc")
    monkeypatch.setattr(bridge, "run_orchestrated", fake_run)
    await bridge.handle_chat_text("@agent1q2n246t50502rk048qful37rqmf3sv9yna6z9gsdlynr3lqrcmzhj7p3ncs is the dude open rn", "s")
    assert seen["text"] == "is the dude open rn"
    await bridge.handle_chat_text("@proxipromptagent  @agent1abc is Shapiro busy?", "s")
    assert seen["text"] == "is Shapiro busy?"
    await bridge.handle_chat_text("is the line at @ the union long", "s")
    assert seen["text"] == "is the line at @ the union long"


async def test_follow_up_poll_returns_a_late_answer():
    state = {"polls": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        state["polls"] += 1
        if state["polls"] < 2:
            return httpx.Response(200, json={"status": "collecting", "progress": "asking 2 people"})
        return httpx.Response(200, json={"status": "answered", "headline": "Seats opened up.", "confidence": "High", "source_count": 2})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        text = await bridge.poll_until_done("http://orc", "abc", total_s=2, interval_s=0.01, client=c)
    assert text == "Seats opened up.\nConfidence: High\nBased on 2 recent nearby reports\nAnswers come from people physically near the place, not from guesses."


def _recording_handler(seen: list):
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.method == "POST":
            return httpx.Response(200, json={"id": "abc"})
        return httpx.Response(200, json={"status": "answered", "headline": "Quiet."})

    return handler


async def test_bridge_token_is_sent_on_every_orchestrator_request(monkeypatch):
    monkeypatch.setenv("ORCH_BRIDGE_TOKEN", "s3cret")
    seen: list[httpx.Request] = []
    async with httpx.AsyncClient(transport=httpx.MockTransport(_recording_handler(seen))) as c:
        reply, _ = await bridge.run_orchestrated("Is Shapiro busy?", "agent1abc", "http://orc", total_s=5, interval_s=0.01, client=c)
    assert reply.startswith("Quiet.")
    assert [r.method for r in seen] == ["POST", "GET"]
    assert all(r.headers["authorization"] == "Bearer s3cret" for r in seen)


async def test_follow_up_poll_sends_the_bridge_token(monkeypatch):
    monkeypatch.setenv("ORCH_BRIDGE_TOKEN", "s3cret")
    seen: list[httpx.Request] = []
    async with httpx.AsyncClient(transport=httpx.MockTransport(_recording_handler(seen))) as c:
        await bridge.poll_until_done("http://orc", "abc", total_s=5, interval_s=0.01, client=c)
    assert seen and all(r.headers["authorization"] == "Bearer s3cret" for r in seen)


async def test_no_authorization_header_without_a_bridge_token(monkeypatch):
    monkeypatch.delenv("ORCH_BRIDGE_TOKEN", raising=False)
    seen: list[httpx.Request] = []
    async with httpx.AsyncClient(transport=httpx.MockTransport(_recording_handler(seen))) as c:
        await bridge.run_orchestrated("Is Shapiro busy?", "agent1abc", "http://orc", total_s=5, interval_s=0.01, client=c)
    assert seen and all("authorization" not in r.headers for r in seen)


@pytest.mark.asyncio
@pytest.mark.parametrize("connected", [True, False])
async def test_health_reports_actual_worker_readiness(monkeypatch, connected):
    monkeypatch.setenv("ORCHESTRATOR_URL", "http://orch.test")
    async with httpx.AsyncClient(transport=httpx.MockTransport(
        lambda request: httpx.Response(200, json={"ok": True, "connected": connected})
    )) as client:
        assert await bridge.orchestrator_ready(client) is connected
