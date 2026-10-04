"""Normalization and deterministic validation of an asker's question (SPEC §8.1).

A freeform question is quoted to strangers near the place, so its text is tidied here before
anything else sees it. Normalization never paraphrases: rules N1-N8 only remove noise and
contact details. The ASI:One review in ``planner`` is the agentic layer on top of this.
"""

from __future__ import annotations

import re
import unicodedata

MAX_QUESTION_CHARS = 200
MIN_LETTERS = 3

# N1: zero-width, bidi-control and other format characters (category Cf) plus C0/C1 controls.
_INVISIBLE = {"Cc", "Cf"}

# N7: contact details. Order matters: URLs before emails before handles.
_URL = re.compile(r"\b(?:https?://|www\.)\S+|\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io|biz|info|co|me|ly|gg|xyz)\b(?:/\S*)?", re.I)
_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b")
_HANDLE = re.compile(r"(?<!\w)@\w{2,}")
_PHONE = re.compile(r"(?<!\w)(?:\+?\d{1,2}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\w)|(?<!\w)\d{3}[\s.-]\d{4}(?!\w)")

_FILLER_TAIL = re.compile(r"(?:[\s,]*\b(?:lmk|pls|plz|please|thanks|thx|ty|asap)\b[\s!.?,]*)+$", re.I)


def _strip_invisible(text: str) -> str:
    out = []
    for ch in text:
        if ch in "\n\t\r":
            out.append(" ")
        elif unicodedata.category(ch) not in _INVISIBLE:
            out.append(ch)
    return "".join(out)


def _unshout(text: str) -> str:
    letters = [c for c in text if c.isalpha()]
    if len(letters) >= 8 and sum(c.isupper() for c in letters) / len(letters) >= 0.8:
        return text.lower()
    return text


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    cut = text[: limit - 2]  # room for "…" and the terminal "?"
    if " " in cut:
        cut = cut[: cut.rfind(" ")]
    return cut.rstrip(" ,;:-") + "…"


def normalize_question(text: str) -> str:
    """Apply N1-N8. Returns "" when nothing meaningful is left."""
    s = unicodedata.normalize("NFKC", text or "")  # N1
    s = _strip_invisible(s)  # N1
    for pattern in (_URL, _EMAIL, _HANDLE, _PHONE):  # N7
        s = pattern.sub(" ", s)
    s = " ".join(s.split())  # N2
    s = re.sub(r"\.{4,}", "...", s)  # N3
    s = re.sub(r"[?!]{2,}", lambda m: "?" if "?" in m.group(0) else "!", s)  # N3
    s = re.sub(r"(\w)\1{3,}", r"\1\1\1", s)  # N4
    s = _unshout(s)  # N5
    s = _FILLER_TAIL.sub("", s).strip()  # N6
    s = s.strip(" ,;:-")
    if not s:
        return ""
    s = s[0].upper() + s[1:]  # N8
    if not s.endswith(("?", ".", "!")):
        s = _truncate(s, MAX_QUESTION_CHARS - 1) + "?"
    else:
        s = _truncate(s, MAX_QUESTION_CHARS)
        if s.endswith("…"):
            s += "?"
    return s


_REFUSAL_EMPTY = "Ask a question about what's happening at the place right now."


def validate_question(normalized: str) -> str | None:
    """V1: a refusal reason when the normalized text carries no question, else None."""
    if sum(c.isalpha() for c in normalized) < MIN_LETTERS:
        return _REFUSAL_EMPTY
    return None
