"""ProxiPrompt Fetch.ai uAgent: REST endpoints for the orchestrator + Chat Protocol for ASI:One.

Run:  uv run python -m proxiprompt_agent.agent
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional
from uuid import uuid4

from uagents import Agent, Context, Model, Protocol
from uagents import asgi as uagents_asgi
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    EndSessionContent,
    TextContent,
    chat_protocol_spec,
)

from . import bridge, llm, planner
from .models import PlanRequest, SummarizePostRequest, SynthesizeRequest

logger = logging.getLogger("proxiprompt.agent")

_TRUTHY = {"1", "true", "yes", "on"}


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in _TRUTHY


# ---------------------------------------------------------------------------
# REST wire models (uagents.Model == pydantic v1). They mirror SPEC §9 so malformed
# requests get a 400 from uagents; the payload is then re-validated and clamped by
# the pydantic-v2 domain models in models.py. Responses are validated by the domain
# models before being returned, so the loose Dict fields here carry exact SPEC shapes.
# ---------------------------------------------------------------------------

Kind = Literal["objective", "subjective"]
SourceType = Literal["response", "post", "comment", "social"]


class PlaceW(Model):
    id: str
    name: str
    category: str = ""
    lat: float
    lng: float


class RecentEvidenceW(Model):
    dimension: str
    value_label: str
    kind: Kind
    source_type: SourceType
    age_s: float
    verified_nearby: bool


class EvidenceW(RecentEvidenceW):
    id: str = ""
    note: str = ""


class PlanReqW(Model):
    query_id: str
    text: str
    place: PlaceW
    now_iso: str = ""
    recent_evidence: List[RecentEvidenceW] = []


class PlanRespW(Model):
    canonical_intent: str
    intent_key: str
    decision: str
    dimensions: List[Dict[str, Any]]
    needs_clarification: bool
    clarification: Optional[Dict[str, Any]] = None
    survey: Optional[Dict[str, Any]] = None
    responder_radius_m: int
    responder_count: int
    refusal: Optional[Dict[str, Any]] = None
    planner: str


class ConfidenceW(Model):
    score: float
    level: Literal["High", "Medium", "Low"]
    ceiling: float


class SynthReqW(Model):
    query_id: str
    text: str
    canonical_intent: str = ""
    place: PlaceW
    dimensions: List[Dict[str, Any]] = []
    evidence: List[EvidenceW] = []
    confidence: ConfidenceW
    missing_dimensions: List[str] = []


class SynthRespW(Model):
    headline: str
    recommendation: str
    summary: str
    supporting: List[str]
    caveats: List[str]
    planner: str


class CommentW(Model):
    text: str
    age_s: float


class SummarizeReqW(Model):
    post_id: str
    place: PlaceW
    text: str
    comments: List[CommentW] = []
    now_iso: str = ""


class SummarizeRespW(Model):
    summary: str
    claims: List[Dict[str, Any]]
    planner: str


class HealthRespW(Model):
    status: str
    agent_address: str
    llm_configured: bool
    model: str
    orchestrator_connected: bool
    mailbox: bool


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------

_README = Path(__file__).resolve().parents[2] / "README.md"

USE_MAILBOX = os.environ.get("AGENT_MAILBOX", "").strip() == "1"
AGENT_PORT = int(os.environ.get("AGENT_PORT", "8001"))
_seed = os.environ.get("AGENT_SEED", "").strip()
if not _seed:
    _seed = "proxiprompt-dev-seed-not-for-production"
    logger.warning("AGENT_SEED not set; using an insecure dev seed (address will not match Agentverse registration)")

_agent_kwargs: Dict[str, Any] = dict(
    name="proxiprompt",
    seed=_seed,
    port=AGENT_PORT,
    mailbox=USE_MAILBOX,
    publish_agent_details=True,
    handle_messages_concurrently=True,  # chat polling can take ~45 s
    description=(
        "ProxiPrompt turns nearby humans into queryable, uncertainty-aware sensors: ask about a place's "
        "current crowd, noise, seating, lines or wait times and get an answer with confidence and provenance."
    ),
)
if _README.exists():
    _agent_kwargs["readme_path"] = str(_README)
if os.environ.get("AGENT_ENDPOINT", "").strip() and not USE_MAILBOX:
    _agent_kwargs["endpoint"] = [os.environ["AGENT_ENDPOINT"].strip()]
if os.environ.get("AGENT_HANDLE", "").strip():
    _agent_kwargs["handle"] = os.environ["AGENT_HANDLE"].strip()

agent = Agent(**_agent_kwargs)

# uagents hard-codes 0.0.0.0. /plan spends the ASI:One key, so stay on loopback unless the
# agent must take inbound traffic (AGENT_ENDPOINT mode on a host): then set AGENT_HOST=0.0.0.0.
# Mailbox mode is outbound-only and works on loopback.
uagents_asgi.HOST = os.environ.get("AGENT_HOST", "").strip() or "127.0.0.1"


@agent.on_rest_get("/health", HealthRespW)
async def health(ctx: Context) -> Dict[str, Any]:
    return {
        "status": "ok",
        "agent_address": agent.address,
        "llm_configured": llm.llm_enabled(),
        "model": llm.model_name(),
        "orchestrator_connected": bool(bridge.orchestrator_url()),
        "mailbox": USE_MAILBOX,
    }


def _domain(model_cls, wire: Model):
    """wire (pydantic v1) -> domain (pydantic v2). Validation errors surface as 400-style failures."""
    return model_cls.model_validate(wire.dict())


@agent.on_rest_post("/plan", PlanReqW, PlanRespW)
async def rest_plan(ctx: Context, req: PlanReqW) -> Dict[str, Any]:
    result = await planner.plan(_domain(PlanRequest, req))
    return result.model_dump(mode="json")


@agent.on_rest_post("/synthesize", SynthReqW, SynthRespW)
async def rest_synthesize(ctx: Context, req: SynthReqW) -> Dict[str, Any]:
    result = await planner.synthesize(_domain(SynthesizeRequest, req))
    return result.model_dump(mode="json")


@agent.on_rest_post("/summarize_post", SummarizeReqW, SummarizeRespW)
async def rest_summarize_post(ctx: Context, req: SummarizeReqW) -> Dict[str, Any]:
    result = await planner.summarize_post(_domain(SummarizePostRequest, req))
    return result.model_dump(mode="json")


# ---------------------------------------------------------------------------
# Chat Protocol (ASI:One discovery)
# ---------------------------------------------------------------------------

chat_proto = Protocol(spec=chat_protocol_spec)


def extract_text(msg: ChatMessage) -> str:
    return " ".join(item.text for item in msg.content if isinstance(item, TextContent)).strip()


def reply_message(text: str) -> ChatMessage:
    return ChatMessage(
        timestamp=datetime.now(timezone.utc),
        msg_id=uuid4(),
        content=[TextContent(type="text", text=text), EndSessionContent(type="end-session")],
    )


async def _send_follow_up(ctx: Context, sender: str, url: str, query_id: str) -> None:
    try:
        text = await bridge.poll_until_done(url, query_id, total_s=bridge.FOLLOW_UP_TOTAL_S)
    except Exception:
        ctx.logger.exception("follow-up poll failed")
        return
    if not text:
        return
    await ctx.send(sender, reply_message(text))


@chat_proto.on_message(ChatMessage)
async def on_chat(ctx: Context, sender: str, msg: ChatMessage):
    await ctx.send(sender, ChatAcknowledgement(timestamp=datetime.now(timezone.utc), acknowledged_msg_id=msg.msg_id))
    text = extract_text(msg)
    pending_id = None
    if not text:
        reply = "Ask me about current conditions at a place, e.g. “Is Shapiro Library busy right now?”"
    else:
        try:
            reply, pending_id = await bridge.handle_chat_text(text, sender)
        except Exception:
            ctx.logger.exception("chat workflow failed")
            reply, pending_id = "Something went wrong while handling that question. Please try again.", None
    await ctx.send(sender, reply_message(reply))
    if pending_id:
        url = bridge.orchestrator_url()
        asyncio.create_task(_send_follow_up(ctx, sender, url, pending_id))


@chat_proto.on_message(ChatAcknowledgement)
async def on_chat_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    pass


agent.include(chat_proto, publish_manifest=True)


def main() -> None:
    agent.run()


if __name__ == "__main__":
    main()
