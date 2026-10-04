"""Workflow bridge used by the Chat Protocol handler.

With ``ORCHESTRATOR_URL`` set: POST ``{text, sender}`` to ``/asi/query`` and poll
``/asi/query/{id}`` for up to ~45 s, then reply with headline + confidence + sources.
Without it: reply with the plan (what evidence would be gathered and from whom) and say
that the live network is not connected.

Orchestrator contract assumed here (the orchestrator owns it; the parsing below is tolerant):
  POST /asi/query            {text, sender}  ->  {id, status?, place?}
  GET  /asi/query/{id}       ->  {status: pending|collecting|answered|insufficient|refused|failed,
                                  headline?, confidence?: "High"|{level,...}, sources?: str|int|list,
                                  message?, progress?}
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
import uuid
from typing import Any

import httpx

from . import planner
from .models import PlanRequest
from .places import resolve_place

logger = logging.getLogger("proxiprompt.bridge")

POLL_TOTAL_S = 45.0
POLL_INTERVAL_S = 2.0
# After the first "still working" reply, keep watching until a late answer can land.
FOLLOW_UP_TOTAL_S = 180.0
HTTP_TIMEOUT_S = 10.0

_DONE = {"answered", "insufficient", "refused", "failed", "cancelled", "done"}


def orchestrator_url() -> str:
    return os.environ.get("ORCHESTRATOR_URL", "").strip().rstrip("/")


def _auth_headers() -> dict[str, str]:
    token = os.environ.get("ORCH_BRIDGE_TOKEN", "").strip()
    return {"Authorization": f"Bearer {token}"} if token else {}


def _confidence_text(data: dict[str, Any]) -> str | None:
    c = data.get("confidence")
    if isinstance(c, dict):
        c = c.get("level")
    if isinstance(c, str) and c:
        return c
    c = data.get("confidence_level")
    return c if isinstance(c, str) and c else None


def _sources_text(data: dict[str, Any]) -> str | None:
    s = data.get("sources")
    if isinstance(s, str) and s:
        return s
    if isinstance(s, list) and s:
        return ", ".join(str(x.get("label") if isinstance(x, dict) else x) for x in s[:4])
    if isinstance(s, int):
        return f"{s} recent nearby report{'s' if s != 1 else ''}"
    n = data.get("source_count")
    if isinstance(n, int):
        return f"{n} recent nearby report{'s' if n != 1 else ''}"
    return None


def format_result(data: dict[str, Any]) -> str:
    status = str(data.get("status", "")).lower()
    if status == "refused":
        return data.get("message") or "I can't help with that question. ProxiPrompt only reports current conditions at a place."
    if status in ("failed", "cancelled"):
        return data.get("message") or "Something went wrong while answering that. Please try again."
    headline = data.get("headline") or data.get("message")
    if status == "insufficient" and not headline:
        headline = "Not enough fresh evidence to answer that right now."
    parts = [str(headline or "No answer yet.")]
    conf = _confidence_text(data)
    if conf:
        parts.append(f"Confidence: {conf}.")
    src = _sources_text(data)
    if src:
        parts.append(f"Sources: {src}.")
    return " ".join(parts)


async def _poll_once(client: httpx.AsyncClient, base_url: str, qid: str) -> dict[str, Any] | None:
    try:
        g = await client.get(f"{base_url}/asi/query/{qid}", headers=_auth_headers())
        g.raise_for_status()
        data = g.json()
    except Exception as exc:
        logger.warning("orchestrator poll failed: %s", exc)
        return None
    return data if isinstance(data, dict) else None


async def poll_until_done(base_url: str, qid: str, *, total_s: float, interval_s: float = POLL_INTERVAL_S,
                           client: httpx.AsyncClient | None = None) -> str | None:
    """Keep asking the orchestrator until the query finishes. None if it never does."""
    own = client is None
    client = client or httpx.AsyncClient(timeout=HTTP_TIMEOUT_S)
    try:
        deadline = time.monotonic() + total_s
        while time.monotonic() < deadline:
            await asyncio.sleep(interval_s)
            last = await _poll_once(client, base_url, qid)
            if last and str(last.get("status", "")).lower() in _DONE:
                return format_result(last)
        return None
    finally:
        if own:
            await client.aclose()


async def run_orchestrated(text: str, sender: str, base_url: str,
                           *, total_s: float = POLL_TOTAL_S, interval_s: float = POLL_INTERVAL_S,
                           client: httpx.AsyncClient | None = None) -> tuple[str, str | None]:
    """Reply text, plus a query id when the answer is not ready yet and a follow-up should be sent."""
    own = client is None
    client = client or httpx.AsyncClient(timeout=HTTP_TIMEOUT_S)
    try:
        try:
            r = await client.post(f"{base_url}/asi/query", json={"text": text, "sender": sender}, headers=_auth_headers())
            r.raise_for_status()
            created = r.json()
        except Exception as exc:
            logger.warning("orchestrator submit failed: %s", exc)
            return "I couldn't reach the ProxiPrompt network right now. Please try again in a minute.", None
        qid = created.get("id") or created.get("query_id")
        if str(created.get("status", "")).lower() in _DONE:
            return format_result(created), None
        if not qid:
            return "The ProxiPrompt network accepted your question but didn't return a tracking id.", None

        deadline = time.monotonic() + total_s
        last: dict[str, Any] = created
        while time.monotonic() < deadline:
            await asyncio.sleep(interval_s)
            polled = await _poll_once(client, base_url, str(qid))
            if polled is None:
                continue
            last = polled
            if str(last.get("status", "")).lower() in _DONE:
                return format_result(last), None
        progress = last.get("progress") or last.get("message") or "asking people near the place"
        return (
            f"Still working on it ({progress}). Real people near the place are being asked, which can take a minute "
            f"or two. I'll send the answer here when it is ready."
        ), str(qid)
    finally:
        if own:
            await client.aclose()


async def plan_only_reply(text: str) -> str:
    """No orchestrator: describe what would be done."""
    place = resolve_place(text)
    if place is None:
        from .models import Place

        place = Place(id="unknown-place", name="the place you mentioned", category="", lat=42.2780, lng=-83.7382)
    req = PlanRequest(query_id=f"chat-{uuid.uuid4().hex[:8]}", text=text, place=place, now_iso="", recent_evidence=[])
    plan = await planner.plan(req)
    note = "(The live ProxiPrompt network isn't connected to this agent right now, so I can't collect real answers yet.)"
    if plan.refusal:
        return f"{plan.refusal.reason} {note}"
    dims = ", ".join(d.label.lower() for d in plan.dimensions)
    lines = [f"Here's how I'd answer that for {place.name}: I'd check recent reports for {dims}."]
    if plan.survey:
        lines.append(
            f"If nothing fresh exists, I'd ask {plan.responder_count} people within {plan.responder_radius_m} m of {place.name}: "
            f"\"{plan.survey.question}\""
        )
    lines.append(note)
    if place.id == "unknown-place":
        lines.append("I also couldn't match a campus place in your message; name one (e.g. Shapiro Library).")
    return " ".join(lines)


# ASI:One prefixes the addressed agent ("@agent1q…" or "@handle") to the message text.
_LEADING_MENTIONS = re.compile(r"^(?:\s*@[\w.-]+)+\s*")


async def handle_chat_text(text: str, sender: str) -> tuple[str, str | None]:
    """Reply text, and the orchestrator query id when a later answer should be pushed back to the chat."""
    text = _LEADING_MENTIONS.sub("", text or "")
    url = orchestrator_url()
    if url:
        return await run_orchestrated(text, sender, url)
    return await plan_only_reply(text), None
