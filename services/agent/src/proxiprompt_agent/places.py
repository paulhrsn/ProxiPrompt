"""Curated Ann Arbor place catalog (SPEC §5) used to resolve places in Chat Protocol messages.

Coordinates are approximate. The authoritative catalog lives with the web app / orchestrator;
this copy only lets the agent turn "Is Shapiro busy?" into a PlanRequest when no orchestrator
is connected.
"""

from __future__ import annotations

import re

from .models import Place

# (id, name, category, lat, lng, aliases)
_CATALOG: list[tuple[str, str, str, float, float, tuple[str, ...]]] = [
    ("shapiro-undergraduate-library", "Shapiro Undergraduate Library", "library", 42.2757, -83.7382, ("shapiro", "ugli", "undergrad library")),
    ("hatcher-graduate-library", "Hatcher Graduate Library", "library", 42.2763, -83.7385, ("hatcher", "grad library")),
    ("michigan-union", "Michigan Union", "student_union", 42.2750, -83.7413, ("michigan union", "the union")),
    ("duderstadt-center", "Duderstadt Center", "library", 42.2909, -83.7168, ("duderstadt", "dude")),
    ("pierpont-commons", "Pierpont Commons", "student_union", 42.2915, -83.7163, ("pierpont",)),
    ("ross-school-of-business", "Ross School of Business", "academic", 42.2733, -83.7388, ("ross", "ross school")),
    ("ccrb", "Central Campus Recreation Building", "gym", 42.2756, -83.7316, ("ccrb", "central campus rec")),
    ("ims", "Intramural Sports Building", "gym", 42.2696, -83.7399, ("ims", "intramural")),
    ("nccrb", "North Campus Recreation Building", "gym", 42.2928, -83.7137, ("nccrb", "north campus rec")),
    ("south-quad-dining", "South Quad Dining", "dining", 42.2735, -83.7425, ("south quad",)),
    ("mosher-jordan-dining", "Mosher-Jordan Dining", "dining", 42.2779, -83.7300, ("mosher", "mojo")),
    ("east-quad-dining", "East Quad Dining", "dining", 42.2731, -83.7347, ("east quad",)),
    ("the-diag", "The Diag", "park", 42.2767, -83.7409, ("diag",)),
    ("zingermans-delicatessen", "Zingerman's Delicatessen", "restaurant", 42.2829, -83.7478, ("zingerman", "zingermans")),
    ("blake-transit-center", "Blake Transit Center", "transit", 42.2800, -83.7488, ("blake", "transit center")),
    ("michigan-stadium", "Michigan Stadium", "stadium", 42.2658, -83.7487, ("stadium", "big house")),
]

CATALOG: list[Place] = [Place(id=i, name=n, category=c, lat=la, lng=lo) for i, n, c, la, lo, _ in _CATALOG]
_ALIASES: list[tuple[re.Pattern[str], Place]] = []
for (_i, _n, _c, _la, _lo, _aliases), _p in zip(_CATALOG, CATALOG):
    for term in (_n.lower(), *_aliases):
        _ALIASES.append((re.compile(r"\b" + re.escape(term) + r"\b"), _p))
# Longest alias first so "south quad" wins over a shorter overlapping term.
_ALIASES.sort(key=lambda pair: -len(pair[0].pattern))


def resolve_place(text: str) -> Place | None:
    t = (text or "").lower()
    for pat, place in _ALIASES:
        if pat.search(t):
            return place
    return None
