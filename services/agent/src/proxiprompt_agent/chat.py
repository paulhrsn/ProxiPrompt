"""Chat-facing copy and routing for ASI:One: greetings, help, place list, no-place replies.

Everything here is deterministic except the optional chit-chat classifier, which may only
choose between two labels; it never produces text that is shown to the user.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from . import llm
from .places import CATALOG

logger = logging.getLogger("proxiprompt.chat")

_EXAMPLES = (
    "Is Shapiro Undergraduate Library busy right now?",
    "How long is the line at Zingerman's Delicatessen?",
    "Is there seating at the Michigan Union?",
)

_CATEGORY_LABELS = (
    ("library", "Libraries"),
    ("student_union", "Student unions"),
    ("academic", "Academic"),
    ("gym", "Gyms"),
    ("dining", "Dining halls"),
    ("restaurant", "Restaurants"),
    ("park", "Outdoors"),
    ("transit", "Transit"),
    ("stadium", "Stadiums"),
)

_GREETING = re.compile(
    r"^(?:hi+|hello+|hey+|heya|hiya|yo|howdy|sup|hola|greetings|thanks|thank you|thx|ok|okay|cool|test|testing"
    r"|good (?:morning|afternoon|evening)|what'?s up|how are you|hey there|hi there|hello there)(?:\s+(?:there|agent|proxiprompt|bot))?$"
)
_HELP = re.compile(
    r"\bhelp\b|what (?:can|do) you (?:do|know how)|what do you do|who are you|what are you|what is this|what is proxiprompt"
    r"|how (?:does|do) (?:this|it|you) work|how can you help|what can i ask|what should i ask|\bcapabilit"
)
_LIST = re.compile(
    r"\b(?:list|show|which|what|any|all|supported|available)\b.{0,30}\b(?:places|locations|spots|buildings|catalog)\b"
    r"|\b(?:places|locations|buildings)\b.{0,25}\b(?:know|cover|support|available|ask)\b"
    r"|\bwhere can i ask\b|\bcatalog\b"
)


def _normalize(text: str) -> str:
    t = re.sub(r"[^\w\s']", " ", (text or "").lower())
    return re.sub(r"\s+", " ", t).strip()


def classify(text: str) -> str:
    """Heuristic intent for text with no resolvable place: empty|greeting|help|list|unsure."""
    t = _normalize(text)
    if not t:
        return "empty"
    if _LIST.search(t):
        return "list"
    if _GREETING.match(t):
        return "greeting"
    if _HELP.search(t):
        return "help"
    return "unsure"


def help_reply() -> str:
    lines = [
        "Hi, I'm ProxiPrompt. I tell you what a place is like right now (crowds, noise, seating, lines, wait times) "
        "using reports from people physically nearby, never guesses.",
        "Try asking:",
        *[f"- {q}" for q in _EXAMPLES],
        'Say "list places" to see everywhere I cover.',
    ]
    return "\n".join(lines)


def places_reply() -> str:
    by_cat: dict[str, list[str]] = {}
    for p in CATALOG:
        by_cat.setdefault(p.category, []).append(p.name)
    known = {c for c, _ in _CATEGORY_LABELS}
    lines = ["I cover these places around Ann Arbor:"]
    for cat, label in _CATEGORY_LABELS:
        if cat in by_cat:
            lines.append(f"{label}: {', '.join(by_cat[cat])}")
    others = [n for c, names in by_cat.items() if c not in known for n in names]
    if others:
        lines.append(f"Other: {', '.join(others)}")
    lines.append(f"Ask about any of them, e.g. {_EXAMPLES[0]}")
    return "\n".join(lines)


def no_place_reply() -> str:
    names = ", ".join(p.name for p in CATALOG[:4])
    return (
        f"I don't recognise a place in that. I can only report on places I know, like {names}. "
        f'Say "list places" for the full list, or try: {_EXAMPLES[0]}'
    )


def age_text(seconds: float) -> str:
    if seconds < 90:
        return "just now"
    if seconds < 5400:
        return f"{round(seconds / 60)} min ago"
    return f"{round(seconds / 3600)} h ago"


_CLASSIFY_SYSTEM = (
    "Classify one chat message sent to a campus place-conditions bot. 'chitchat' means small talk, a greeting, thanks, "
    "or a question about the bot itself. 'place_question' means anything else. Do not answer the message."
)


async def llm_is_chitchat(text: str) -> bool:
    """Ask ASI:One to pick a label for an unsure message. Any failure means False (deterministic fallback)."""
    if not llm.llm_enabled():
        return False
    try:
        out: dict[str, Any] = await llm.complete_json(_CLASSIFY_SYSTEM, text, '{"kind": "chitchat" | "place_question"}')
    except Exception as exc:
        logger.warning("chit-chat classification failed: %s", exc)
        return False
    return out.get("kind") == "chitchat"
