import { describe, expect, it } from "vitest";
import { formatAge, freshnessNote, type PostClaim } from "../src/freshness";

const NOW = 1_700_000_000_000;
const minAgo = (m: number) => NOW - m * 60_000;

function claim(over: Partial<PostClaim> = {}): PostClaim {
  return {
    dimension: "noise_level",
    volatility: "high",
    ttlS: 900,
    observedAtMs: minAgo(3),
    ordinal: 1,
    ...over,
  };
}

describe("formatAge", () => {
  it("formats seconds into short strings", () => {
    expect(formatAge(0)).toBe("just now");
    expect(formatAge(20)).toBe("just now");
    expect(formatAge(60)).toBe("1 min ago");
    expect(formatAge(180)).toBe("3 min ago");
    expect(formatAge(3600)).toBe("1 h ago");
    expect(formatAge(4 * 3600 + 600)).toBe("4 h ago");
    expect(formatAge(2 * 86400 + 5000)).toBe("2 d ago");
  });
});

describe("freshnessNote", () => {
  it("fresh: age within half the ttl", () => {
    const r = freshnessNote({ claims: [claim()], comments: [], nowMs: NOW });
    expect(r.state).toBe("fresh");
    expect(r.note).toBe("Fresh · 3 min ago");
    expect(r.maxFreshness).toBeCloseTo(1 - (180 / 900) ** 2, 10);
  });

  it("aging: past half ttl, still before expiry; high volatility says changes fast", () => {
    const r = freshnessNote({ claims: [claim({ observedAtMs: minAgo(10) })], comments: [], nowMs: NOW });
    expect(r.state).toBe("aging");
    expect(r.note).toBe("Aging · changes fast");
    expect(r.maxFreshness).toBeGreaterThan(0);
    expect(r.maxFreshness).toBeLessThan(0.75);
  });

  it("aging with non-high volatility shows the age", () => {
    const r = freshnessNote({
      claims: [claim({ volatility: "medium", ttlS: 5400, dimension: "atmosphere", observedAtMs: minAgo(60) })],
      comments: [],
      nowMs: NOW,
    });
    expect(r.state).toBe("aging");
    expect(r.note).toBe("Aging · 1 h ago");
  });

  it("context: past ttl", () => {
    const r = freshnessNote({
      claims: [claim({ observedAtMs: NOW - 4 * 3600 * 1000 })],
      comments: [],
      nowMs: NOW,
    });
    expect(r.state).toBe("context");
    expect(r.note).toBe("Context only · 4 h ago");
    expect(r.maxFreshness).toBe(0);
  });

  it("context with no claims", () => {
    const r = freshnessNote({ claims: [], comments: [], nowMs: NOW });
    expect(r.state).toBe("context");
    expect(r.maxFreshness).toBe(0);
  });

  it("uses the freshest claim as reference", () => {
    const r = freshnessNote({
      claims: [claim({ observedAtMs: minAgo(40) }), claim({ dimension: "crowd_level", observedAtMs: minAgo(2) })],
      comments: [],
      nowMs: NOW,
    });
    expect(r.state).toBe("fresh");
    expect(r.note).toBe("Fresh · 2 min ago");
  });

  it("mixed: same-dimension claims ≥2 ordinal steps apart", () => {
    const r = freshnessNote({
      claims: [claim({ ordinal: 1, observedAtMs: minAgo(5) }), claim({ ordinal: 4, observedAtMs: minAgo(2) })],
      comments: [],
      nowMs: NOW,
    });
    expect(r.state).toBe("mixed");
    expect(r.note).toBe("Mixed reports");
  });

  it("claims one step apart are not mixed", () => {
    const r = freshnessNote({
      claims: [claim({ ordinal: 2, observedAtMs: minAgo(5) }), claim({ ordinal: 3, observedAtMs: minAgo(2) })],
      comments: [],
      nowMs: NOW,
    });
    expect(r.state).toBe("fresh");
  });

  it("reinforced: a recent comment after an aging claim refreshes it", () => {
    const r = freshnessNote({
      claims: [claim({ observedAtMs: minAgo(10) })],
      comments: [{ atMs: minAgo(1) }],
      nowMs: NOW,
    });
    expect(r.state).toBe("reinforced");
    expect(r.note).toBe("Recently reinforced");
    // freshness measured from the comment: 1 − (60/900)²
    expect(r.maxFreshness).toBeCloseTo(1 - (60 / 900) ** 2, 10);
  });

  it("a stale comment does not reinforce", () => {
    const r = freshnessNote({
      claims: [claim({ observedAtMs: minAgo(40) })],
      comments: [{ atMs: minAgo(30) }],
      nowMs: NOW,
    });
    expect(r.state).toBe("context");
  });

  it("a comment older than the claim does not reinforce", () => {
    const r = freshnessNote({
      claims: [claim({ observedAtMs: minAgo(3) })],
      comments: [{ atMs: minAgo(4) }],
      nowMs: NOW,
    });
    expect(r.state).toBe("fresh");
  });
});
