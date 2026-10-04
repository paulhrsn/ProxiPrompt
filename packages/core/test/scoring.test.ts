import { describe, expect, it } from "vitest";
import {
  SOURCE_WEIGHTS,
  ceilingFor,
  freshness,
  levelFor,
  scoreEvidence,
  type ScoringObservation,
} from "../src/scoring";

const NOW = 1_700_000_000_000;
const TTL_MS = 900_000;

function obs(over: Partial<ScoringObservation> & { id: string }): ScoringObservation {
  return {
    dimension: "noise_level",
    value: "quiet",
    valueLabel: "Quiet",
    ordinal: 1,
    kind: "objective",
    sourceType: "response",
    verifiedNearby: true,
    contributorId: over.id,
    observedAtMs: NOW,
    expiresAtMs: NOW + TTL_MS,
    invalidated: false,
    ...over,
  };
}

const REQ_NOISE = [{ key: "noise_level", kind: "objective" as const }];

describe("freshness", () => {
  it("is 1 at age 0, 0.75 at half ttl, 0 at ttl", () => {
    expect(freshness(NOW, NOW + TTL_MS, NOW, false)).toBe(1);
    expect(freshness(NOW, NOW + TTL_MS, NOW + TTL_MS / 2, false)).toBeCloseTo(0.75, 10);
    expect(freshness(NOW, NOW + TTL_MS, NOW + TTL_MS, false)).toBe(0);
  });

  it("is 0 when past expiry or invalidated", () => {
    expect(freshness(NOW, NOW + TTL_MS, NOW + TTL_MS + 1000, false)).toBe(0);
    expect(freshness(NOW, NOW + TTL_MS, NOW, true)).toBe(0);
  });
});

describe("tables", () => {
  it("source weights per SPEC §8", () => {
    expect(SOURCE_WEIGHTS).toEqual({
      responseVerified: 1.0,
      responseUnverified: 0.7,
      postVerified: 0.8,
      postUnverified: 0.55,
      comment: 0.5,
      social: 0.35,
    });
  });

  it("ceiling by independent contributor count", () => {
    expect(ceilingFor(0)).toBe(0);
    expect(ceilingFor(1)).toBe(0.6);
    expect(ceilingFor(2)).toBe(0.8);
    expect(ceilingFor(3)).toBe(0.95);
    expect(ceilingFor(7)).toBe(0.95);
  });

  it("level thresholds", () => {
    expect(levelFor(0.7)).toBe("High");
    expect(levelFor(0.699)).toBe("Medium");
    expect(levelFor(0.45)).toBe("Medium");
    expect(levelFor(0.449)).toBe("Low");
  });
});

describe("scoreEvidence", () => {
  it("returns zero / insufficient with no observations", () => {
    const r = scoreEvidence({ observations: [], required: REQ_NOISE, nowMs: NOW });
    expect(r.score).toBe(0);
    expect(r.sufficient).toBe(false);
    expect(r.level).toBe("Low");
    expect(r.missingDimensions).toEqual(["noise_level"]);
    expect(r.contributors).toBe(0);
  });

  it("caps a single contributor at 0.6 even with several observations", () => {
    const r = scoreEvidence({
      observations: [
        obs({ id: "a1", contributorId: "u1" }),
        obs({ id: "a2", contributorId: "u1" }),
        obs({ id: "a3", contributorId: "u1" }),
      ],
      required: REQ_NOISE,
      nowMs: NOW,
    });
    expect(r.contributors).toBe(1);
    expect(r.rawScore).toBeCloseTo(1, 10);
    expect(r.ceiling).toBe(0.6);
    expect(r.score).toBe(0.6);
    expect(r.level).toBe("Medium");
  });

  it("two agreeing fresh verified responses → sufficient, score = ceiling 0.8, High (math)", () => {
    const nowMs = NOW + 300_000; // age 300 s of 900 s ttl
    const r = scoreEvidence({
      observations: [obs({ id: "a" }), obs({ id: "b" })],
      required: REQ_NOISE,
      nowMs,
    });
    const w = 1 - (1 / 3) ** 2; // 0.8889
    const support = 1 - (1 - w) ** 2; // 0.98765
    const dim = r.dimensions[0]!;
    expect(dim.support).toBeCloseTo(support, 6);
    expect(dim.agreement).toBe(1);
    expect(dim.conf).toBeCloseTo(support, 6);
    expect(dim.modalValue).toBe("quiet");
    expect(dim.modalLabel).toBe("Quiet");
    expect(dim.count).toBe(2);
    expect(r.rawScore).toBeCloseTo(support, 6);
    expect(r.contributors).toBe(2);
    expect(r.ceiling).toBe(0.8);
    expect(r.score).toBe(0.8);
    expect(r.level).toBe("High");
    expect(r.sufficient).toBe(true);
    expect(r.missingDimensions).toEqual([]);
  });

  it("excludes stale / expired / invalidated observations", () => {
    const r = scoreEvidence({
      observations: [
        obs({ id: "old", observedAtMs: NOW - 2 * TTL_MS, expiresAtMs: NOW - TTL_MS }),
        obs({ id: "bad", invalidated: true }),
      ],
      required: REQ_NOISE,
      nowMs: NOW,
    });
    expect(r.dimensions[0]!.count).toBe(0);
    expect(r.missingDimensions).toEqual(["noise_level"]);
    expect(r.contributors).toBe(0);
    expect(r.sufficient).toBe(false);
    expect(r.factors.observations.find((o) => o.id === "old")?.weight).toBe(0);
  });

  it("agreement: values one ordinal step from the modal count half", () => {
    const r = scoreEvidence({
      observations: [
        obs({ id: "a", value: "quiet", ordinal: 2, observedAtMs: NOW - 1000 }),
        obs({ id: "b", value: "moderate", ordinal: 3, observedAtMs: NOW }),
      ],
      required: REQ_NOISE,
      nowMs: NOW,
    });
    // tie on weight → the newest value is modal; the other is one step away → half credit
    expect(r.dimensions[0]!.modalValue).toBe("moderate");
    expect(r.dimensions[0]!.agreement).toBeCloseTo(0.75, 2);
  });

  it("agreement: two or more steps away counts zero; exact weight share decides modal", () => {
    const r = scoreEvidence({
      observations: [
        obs({ id: "a", value: "quiet", ordinal: 1 }),
        obs({ id: "b", value: "quiet", ordinal: 1 }),
        obs({ id: "c", value: "loud", ordinal: 4 }),
      ],
      required: REQ_NOISE,
      nowMs: NOW,
    });
    expect(r.dimensions[0]!.modalValue).toBe("quiet");
    expect(r.dimensions[0]!.agreement).toBeCloseTo(2 / 3, 6);
  });

  it("agreement: null ordinals only match exact values", () => {
    const r = scoreEvidence({
      observations: [
        obs({ id: "a", value: "yes", ordinal: null }),
        obs({ id: "b", value: "no", ordinal: null, observedAtMs: NOW - 10 }),
      ],
      required: REQ_NOISE,
      nowMs: NOW,
    });
    expect(r.dimensions[0]!.agreement).toBeCloseTo(0.5, 2);
  });

  it("contradiction: newer obs ≥2 ordinal steps away halves older freshness", () => {
    const base = {
      required: REQ_NOISE,
      nowMs: NOW,
    };
    const older = obs({
      id: "older",
      value: "quiet",
      ordinal: 1,
      observedAtMs: NOW - 300_000,
      expiresAtMs: NOW - 300_000 + TTL_MS,
    });
    const newer = obs({ id: "newer", value: "loud", ordinal: 4 });
    const r = scoreEvidence({ ...base, observations: [older, newer] });
    const fOlder = r.factors.observations.find((o) => o.id === "older")!;
    const w = 1 - (1 / 3) ** 2;
    expect(fOlder.contradicted).toBe(true);
    expect(fOlder.freshness).toBeCloseTo(w / 2, 6);
    expect(r.factors.observations.find((o) => o.id === "newer")!.contradicted).toBe(false);
    // newer value dominates the modal
    expect(r.dimensions[0]!.modalValue).toBe("loud");
  });

  it("contradiction: one ordinal step is not a contradiction; null ordinals never contradict", () => {
    const older = obs({ id: "o", ordinal: 2, observedAtMs: NOW - 1000 });
    const newer = obs({ id: "n", value: "moderate", ordinal: 3 });
    const r = scoreEvidence({ observations: [older, newer], required: REQ_NOISE, nowMs: NOW });
    expect(r.factors.observations.find((o) => o.id === "o")!.contradicted).toBe(false);

    const o2 = obs({ id: "o2", ordinal: null, observedAtMs: NOW - 1000 });
    const n2 = obs({ id: "n2", value: "x", ordinal: 5 });
    const r2 = scoreEvidence({ observations: [o2, n2], required: REQ_NOISE, nowMs: NOW });
    expect(r2.factors.observations.find((o) => o.id === "o2")!.contradicted).toBe(false);
  });

  it("source weights scale observation weight", () => {
    const r = scoreEvidence({
      observations: [obs({ id: "s", sourceType: "social", verifiedNearby: false })],
      required: REQ_NOISE,
      nowMs: NOW,
    });
    expect(r.factors.observations[0]!.sourceWeight).toBe(0.35);
    expect(r.dimensions[0]!.support).toBeCloseTo(0.35, 6);
    expect(r.sufficient).toBe(false); // objective support < 0.5
  });

  it("requires objective support ≥ 0.5 per objective dimension; subjective may be weaker", () => {
    const required = [
      { key: "noise_level", kind: "objective" as const },
      { key: "seating_availability", kind: "objective" as const },
    ];
    const r = scoreEvidence({
      observations: [
        obs({ id: "a", contributorId: "u1" }),
        obs({ id: "b", contributorId: "u2" }),
        obs({ id: "c", contributorId: "u3" }),
      ],
      required,
      nowMs: NOW,
    });
    // seating has no support → missing, not sufficient
    expect(r.missingDimensions).toEqual(["seating_availability"]);
    expect(r.sufficient).toBe(false);
  });

  it("weights objective 1.0 and subjective 0.5 in the overall mean", () => {
    const required = [
      { key: "noise_level", kind: "objective" as const },
      { key: "worth_it", kind: "subjective" as const },
    ];
    const r = scoreEvidence({
      observations: [
        obs({ id: "a", contributorId: "u1" }),
        obs({ id: "b", contributorId: "u2" }),
        obs({ id: "c", contributorId: "u3" }),
      ],
      required,
      nowMs: NOW,
    });
    // objective conf 1, subjective conf 0 → 1.0 / 1.5
    expect(r.rawScore).toBeCloseTo(1 / 1.5, 6);
    expect(r.sufficient).toBe(true); // 0.667 ≥ 0.6, objective support ok
  });

  it("honors a custom sufficiency threshold", () => {
    const r = scoreEvidence({
      observations: [obs({ id: "a", contributorId: "u1" })],
      required: REQ_NOISE,
      nowMs: NOW,
      sufficientScore: 0.7,
    });
    expect(r.score).toBe(0.6);
    expect(r.sufficient).toBe(false);
  });
});

describe("social evidence never carries an answer on its own", () => {
  const social = (id: string) =>
    obs({ id, sourceType: "social", verifiedNearby: false, contributorId: `anon:${id}`, ordinal: null });

  it("is never sufficient without a firsthand observation", () => {
    const r = scoreEvidence({
      observations: [social("s1"), social("s2"), social("s3")],
      required: REQ_NOISE,
      nowMs: NOW,
    });
    // Support is real (three 0.35-weight posts agree) but none of it is firsthand.
    expect(r.dimensions[0]!.support).toBeGreaterThan(0.5);
    expect(r.dimensions[0]!.firsthandSupport).toBe(0);
    expect(r.sufficient).toBe(false);
  });

  it("does not count toward contributors or the ceiling", () => {
    const r = scoreEvidence({
      observations: [social("s1"), social("s2"), social("s3")],
      required: REQ_NOISE,
      nowMs: NOW,
    });
    expect(r.contributors).toBe(0);
    expect(r.ceiling).toBe(0);
    expect(r.score).toBe(0);
  });

  it("still informs the score alongside a firsthand response", () => {
    const r = scoreEvidence({
      // Half-aged response (weight 0.75) so support does not already saturate at 1.
      observations: [obs({ id: "a", contributorId: "u1", observedAtMs: NOW - TTL_MS / 2 }), social("s1")],
      required: REQ_NOISE,
      nowMs: NOW,
    });
    expect(r.contributors).toBe(1);
    expect(r.dimensions[0]!.support).toBeGreaterThan(r.dimensions[0]!.firsthandSupport);
    expect(r.sufficient).toBe(true);
  });
});

describe("conflicting firsthand reports", () => {
  const req = [{ key: "seating_availability", kind: "objective" as const }];
  const seat = (id: string, label: string, ordinal: number | null, over: Partial<ScoringObservation> = {}) =>
    obs({ id, dimension: "seating_availability", value: label.toLowerCase(), valueLabel: label, ordinal, ...over });

  it("agreeing reports are not flagged and keep High", () => {
    const r = scoreEvidence({
      observations: [seat("a", "Plenty", 4), seat("b", "Plenty", 4), seat("c", "Some", 3)],
      required: req,
      nowMs: NOW,
    });
    expect(r.conflicts).toEqual([]);
    expect(r.level).toBe("High");
  });

  it("an ordinal spread of 3 (plenty vs none) caps at Low and exposes the conflict", () => {
    const r = scoreEvidence({
      observations: [seat("a", "Plenty", 4), seat("b", "Plenty", 4), seat("c", "None", 1)],
      required: req,
      nowMs: NOW,
    });
    expect(r.conflicts).toEqual([{ dimension: "seating_availability", severity: "severe", labels: ["None", "Plenty"] }]);
    expect(r.level).toBe("Low");
    expect(r.score).toBeLessThan(0.45);
    expect(r.rawScore).toBeGreaterThan(r.score);
  });

  it("an ordinal spread of 2 caps at Medium", () => {
    const r = scoreEvidence({
      observations: [seat("a", "Plenty", 4), seat("b", "Plenty", 4), seat("c", "A few", 2)],
      required: req,
      nowMs: NOW,
    });
    expect(r.conflicts[0]?.severity).toBe("moderate");
    expect(r.level).toBe("Medium");
  });

  it("a spread of 1 is not a conflict", () => {
    const r = scoreEvidence({
      observations: [seat("a", "Plenty", 4), seat("b", "Some", 3)],
      required: req,
      nowMs: NOW,
    });
    expect(r.conflicts).toEqual([]);
  });

  it("ignores expired reports and social posts", () => {
    const r = scoreEvidence({
      observations: [
        seat("a", "Plenty", 4),
        seat("b", "Plenty", 4),
        seat("old", "None", 1, { invalidated: true }),
        seat("soc", "None", 1, { sourceType: "social" }),
      ],
      required: req,
      nowMs: NOW,
    });
    expect(r.conflicts).toEqual([]);
  });

  it("distinct values without ordinals (yes vs no) is a moderate conflict", () => {
    const q = [{ key: "other:ask", kind: "objective" as const }];
    const r = scoreEvidence({
      observations: [
        obs({ id: "a", dimension: "other:ask", value: "yes", valueLabel: "Yes", ordinal: null }),
        obs({ id: "b", dimension: "other:ask", value: "no", valueLabel: "No", ordinal: null }),
      ],
      required: q,
      nowMs: NOW,
    });
    expect(r.conflicts[0]?.severity).toBe("moderate");
  });
});
