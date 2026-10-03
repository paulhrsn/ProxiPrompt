"""ASI:One client (OpenAI-compatible) with tolerant JSON extraction."""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

logger = logging.getLogger("proxiprompt.llm")

ASI_BASE_URL = "https://api.asi1.ai/v1"
DEFAULT_MODEL = "asi1"  # ASI:One docs: asi1 (also asi1-mini / asi1-ultra)
TIMEOUT_S = 20.0


class LLMError(RuntimeError):
    """Raised when the LLM is unavailable or returns unusable output."""


def llm_enabled() -> bool:
    return bool(os.environ.get("ASI_ONE_API_KEY", "").strip())


def model_name() -> str:
    return os.environ.get("ASI_ONE_MODEL", "").strip() or DEFAULT_MODEL


_FENCE_RE = re.compile(r"^\s*```(?:json|JSON)?\s*\n?(.*?)\n?\s*```\s*$", re.S)


def parse_json_text(text: str) -> dict[str, Any]:
    """Parse a JSON object from model text, tolerating code fences and prose around it."""
    if not isinstance(text, str) or not text.strip():
        raise ValueError("empty model output")
    s = text.strip()
    m = _FENCE_RE.match(s)
    if m:
        s = m.group(1).strip()
    try:
        obj = json.loads(s)
    except json.JSONDecodeError:
        # Fall back to the outermost {...} span.
        start, end = s.find("{"), s.rfind("}")
        if start == -1 or end <= start:
            raise
        obj = json.loads(s[start : end + 1])
    if not isinstance(obj, dict):
        raise ValueError("model output is not a JSON object")
    return obj


def _client():
    from openai import AsyncOpenAI

    return AsyncOpenAI(
        base_url=os.environ.get("ASI_ONE_BASE_URL", ASI_BASE_URL),
        api_key=os.environ["ASI_ONE_API_KEY"],
        timeout=TIMEOUT_S,
        max_retries=0,
    )


async def _chat(system: str, user: str) -> str:
    client = _client()
    try:
        resp = await client.chat.completions.create(
            model=model_name(),
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=0.2,
            max_tokens=1500,
        )
    finally:
        await client.close()
    return str(resp.choices[0].message.content or "")


async def complete_json(system: str, user: str, schema_hint: str = "") -> dict[str, Any]:
    """Ask the model for a JSON object. Retries once on a parse failure.

    ``schema_hint`` is appended to the system prompt to describe the expected shape.
    Raises ``LLMError`` on transport errors or if both attempts are unparseable.
    """
    if not llm_enabled():
        raise LLMError("ASI_ONE_API_KEY not set")

    sys_prompt = system.strip()
    if schema_hint:
        sys_prompt += "\n\nReturn ONLY one JSON object (no prose, no code fences) shaped like:\n" + schema_hint.strip()
    else:
        sys_prompt += "\n\nReturn ONLY one JSON object (no prose, no code fences)."

    last_err: Exception | None = None
    prompt = user
    for attempt in range(2):
        try:
            text = await _chat(sys_prompt, prompt)
        except Exception as exc:  # transport / auth / timeout
            logger.warning("ASI:One request failed: %s", exc)
            raise LLMError(f"ASI:One request failed: {exc}") from exc
        try:
            return parse_json_text(text)
        except (ValueError, json.JSONDecodeError) as exc:
            last_err = exc
            logger.warning("ASI:One returned unparseable JSON (attempt %d): %s", attempt + 1, exc)
            prompt = user + "\n\nYour previous reply was not valid JSON. Reply with ONLY the JSON object."
    raise LLMError(f"unparseable JSON from model: {last_err}")
