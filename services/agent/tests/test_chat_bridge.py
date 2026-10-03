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
    reply = await bridge.handle_chat_text("Is Shapiro Library busy right now?", "agent1abc")
    assert "Shapiro Undergraduate Library" in reply and "isn't connected" in reply and "crowd level" in reply


async def test_no_orchestrator_refusal():
    reply = await bridge.handle_chat_text("is my ex at the library", "agent1abc")
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
        reply = await bridge.run_orchestrated("Is Shapiro busy?", "agent1abc", "http://orc", total_s=5, interval_s=0.01, client=c)
    assert reply == "Shapiro is moderately busy. Confidence: High. Sources: 2 recent nearby reports."


async def test_orchestrator_timeout_gives_progress_message():
    def handler(request):
        return httpx.Response(200, json={"id": "abc"} if request.method == "POST" else {"status": "collecting", "progress": "asking 2 people"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        reply = await bridge.run_orchestrated("q", "s", "http://orc", total_s=0.05, interval_s=0.01, client=c)
    assert "Still working" in reply and "asking 2 people" in reply


async def test_orchestrator_unreachable():
    def handler(request):
        raise httpx.ConnectError("down")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        reply = await bridge.run_orchestrated("q", "s", "http://orc", client=c)
    assert "couldn't reach" in reply
