import type { Volatility } from "./dimensions";

export type FreshnessState = "fresh" | "aging" | "context" | "mixed" | "reinforced";

export interface PostClaim {
  dimension: string;
  volatility: Volatility;
  ttlS: number;
  observedAtMs: number;
  /** Used only to detect conflicting claims (≥2 ordinal steps apart on one dimension). */
  ordinal?: number | null;
}

/** Substantive comments only; the caller filters trivial ones. */
export interface PostComment {
  atMs: number;
}

export interface FreshnessInput {
  claims: PostClaim[];
  comments: PostComment[];
  nowMs: number;
}

export interface FreshnessNote {
  state: FreshnessState;
  note: string;
  /** 0–1; feeds Live Pulse ranking. */
  maxFreshness: number;
}

export function formatAge(seconds: number): string {
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

const freshnessOf = (ageS: number, ttlS: number) =>
  Math.min(1, Math.max(0, 1 - (Math.max(0, ageS) / ttlS) ** 2));

function hasConflict(claims: PostClaim[]): boolean {
  return claims.some((a) =>
    claims.some(
      (b) =>
        a.dimension === b.dimension &&
        a.ordinal != null &&
        b.ordinal != null &&
        b.observedAtMs > a.observedAtMs &&
        Math.abs(a.ordinal - b.ordinal) >= 2,
    ),
  );
}

/** Deterministic freshness note for a post (SPEC §10). No LLM involved. */
export function freshnessNote({ claims, comments, nowMs }: FreshnessInput): FreshnessNote {
  if (claims.length === 0) return { state: "context", note: "Context only", maxFreshness: 0 };

  // Reference claim = the freshest one (ties → newest).
  const scored = claims
    .filter((c) => c.ttlS > 0)
    .map((c) => {
      const ageS = (nowMs - c.observedAtMs) / 1000;
      return { claim: c, ageS, fresh: freshnessOf(ageS, c.ttlS) };
    })
    .sort((a, b) => b.fresh - a.fresh || b.claim.observedAtMs - a.claim.observedAtMs);
  const ref = scored[0];
  if (!ref) return { state: "context", note: "Context only", maxFreshness: 0 };

  if (hasConflict(claims)) {
    return { state: "mixed", note: "Mixed reports", maxFreshness: ref.fresh };
  }

  // A comment posted after the reference claim, still within half its ttl, reinforces it.
  const latestComment = Math.max(-Infinity, ...comments.map((c) => c.atMs));
  const commentAgeS = (nowMs - latestComment) / 1000;
  if (latestComment > ref.claim.observedAtMs && commentAgeS <= ref.claim.ttlS / 2) {
    return {
      state: "reinforced",
      note: "Recently reinforced",
      maxFreshness: Math.max(ref.fresh, freshnessOf(commentAgeS, ref.claim.ttlS)),
    };
  }

  const ratio = ref.ageS / ref.claim.ttlS;
  if (ratio <= 0.5) {
    return { state: "fresh", note: `Fresh · ${formatAge(ref.ageS)}`, maxFreshness: ref.fresh };
  }
  if (ratio < 1) {
    const note =
      ref.claim.volatility === "high" ? "Aging · changes fast" : `Aging · ${formatAge(ref.ageS)}`;
    return { state: "aging", note, maxFreshness: ref.fresh };
  }
  return { state: "context", note: `Context only · ${formatAge(ref.ageS)}`, maxFreshness: 0 };
}
