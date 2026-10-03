import { describe, expect, it } from "vitest";
import {
  EvidenceItemSchema,
  PlaceSchema,
  PlanRequestSchema,
  SummarizePostRequestSchema,
  SynthesizeRequestSchema,
  parsePlanResponse,
  parseSummarizePostResponse,
  parseSynthesizeResponse,
} from "../src/contracts";

const place = { id: "shapiro", name: "Shapiro Library", category: "library", lat: 42.2758, lng: -83.7372 };

const control = (key: string) => ({
  dimension_key: key,
  label: "How loud is it?",
  options: [
    { value: "quiet", label: "Quiet", ordinal: 1 },
    { value: "loud", label: "Loud", ordinal: 3 },
  ],
});

function plan(over: Record<string, unknown> = {}) {
  return {
    canonical_intent: "quiet study spot at Shapiro",
    intent_key: "quiet_study",
    decision: "answer",
    dimensions: [
      { key: "noise_level", label: "Noise", kind: "objective", volatility: "high", proposed_ttl_s: 600 },
    ],
    needs_clarification: false,
    clarification: null,
    survey: { question: "Quick question about Shapiro", controls: [control("noise_level")], allow_note: true },
    responder_radius_m: 150,
    responder_count: 2,
    refusal: null,
    planner: "heuristic",
    ...over,
  };
}

describe("Place / EvidenceItem", () => {
  it("validates a place", () => {
    expect(PlaceSchema.parse(place)).toMatchObject(place);
    expect(() => PlaceSchema.parse({ ...place, lat: "x" })).toThrow();
    expect(() => PlaceSchema.parse({ ...place, lat: 91 })).toThrow();
  });

  it("validates an evidence item", () => {
    const item = {
      id: "o1",
      dimension: "noise_level",
      value_label: "Quiet",
      kind: "objective",
      source_type: "response",
      age_s: 12,
      verified_nearby: true,
      note: "",
    };
    expect(EvidenceItemSchema.parse(item)).toEqual(item);
    expect(() => EvidenceItemSchema.parse({ ...item, source_type: "tweet" })).toThrow();
  });
});

describe("request schemas", () => {
  it("PlanRequest", () => {
    const req = {
      query_id: "q1",
      text: "Is Shapiro quiet?",
      place,
      now_iso: "2026-10-03T19:00:00Z",
      recent_evidence: [
        {
          dimension: "noise_level",
          value_label: "Quiet",
          kind: "objective",
          source_type: "post",
          age_s: 1500,
          verified_nearby: false,
        },
      ],
    };
    expect(PlanRequestSchema.parse(req)).toEqual(req);
    expect(() => PlanRequestSchema.parse({ ...req, text: undefined })).toThrow();
  });

  it("SynthesizeRequest", () => {
    const req = {
      query_id: "q1",
      text: "t",
      canonical_intent: "ci",
      place,
      dimensions: [{ key: "noise_level", label: "Noise", kind: "objective", volatility: "high", proposed_ttl_s: 900 }],
      evidence: [],
      confidence: { score: 0.8, level: "High", ceiling: 0.8 },
      missing_dimensions: [],
    };
    expect(SynthesizeRequestSchema.parse(req)).toEqual(req);
    expect(() =>
      SynthesizeRequestSchema.parse({ ...req, confidence: { ...req.confidence, level: "Huge" } }),
    ).toThrow();
  });

  it("SummarizePostRequest", () => {
    const req = {
      post_id: "p1",
      place,
      text: "Pretty quiet on 2nd floor",
      comments: [{ text: "agree", age_s: 30 }],
      now_iso: "2026-10-03T19:00:00Z",
    };
    expect(SummarizePostRequestSchema.parse(req)).toEqual(req);
  });
});

describe("parsePlanResponse", () => {
  it("accepts a valid plan", () => {
    const r = parsePlanResponse(plan());
    expect(r.dimensions[0]).toMatchObject({ key: "noise_level", kind: "objective", volatility: "high" });
    expect(r.survey?.controls).toHaveLength(1);
    expect(r.planner).toBe("heuristic");
  });

  it("clamps TTLs by volatility, defaulting when missing", () => {
    const r = parsePlanResponse(
      plan({
        dimensions: [
          { key: "noise_level", label: "Noise", kind: "objective", volatility: "high", proposed_ttl_s: 999999 },
          { key: "seating_availability", label: "Seats", kind: "objective", volatility: "high", proposed_ttl_s: 5 },
          { key: "worth_it", label: "Worth it", kind: "subjective", volatility: "medium" },
        ],
        survey: {
          question: "q",
          controls: [control("noise_level"), control("seating_availability")],
          allow_note: true,
        },
      }),
    );
    expect(r.dimensions.map((d) => d.proposed_ttl_s)).toEqual([1800, 300, 5400]);
  });

  it("clamps responder radius 50–500 (default 150) and count 1–5 (default 2)", () => {
    expect(parsePlanResponse(plan({ responder_radius_m: 5 })).responder_radius_m).toBe(50);
    expect(parsePlanResponse(plan({ responder_radius_m: 9000 })).responder_radius_m).toBe(500);
    expect(parsePlanResponse(plan({ responder_radius_m: undefined })).responder_radius_m).toBe(150);
    expect(parsePlanResponse(plan({ responder_radius_m: Number.NaN })).responder_radius_m).toBe(150);
    expect(parsePlanResponse(plan({ responder_count: 0 })).responder_count).toBe(1);
    expect(parsePlanResponse(plan({ responder_count: 99 })).responder_count).toBe(5);
    expect(parsePlanResponse(plan({ responder_count: undefined })).responder_count).toBe(2);
    expect(parsePlanResponse(plan({ responder_count: 3.7 })).responder_count).toBe(4);
  });

  it("rejects unknown dimension keys but allows other:<slug>", () => {
    const bad = plan({
      dimensions: [{ key: "vibes", label: "Vibes", kind: "subjective", volatility: "medium" }],
      survey: { question: "q", controls: [control("vibes")], allow_note: true },
    });
    expect(() => parsePlanResponse(bad)).toThrow(/dimension/i);

    const ok = parsePlanResponse(
      plan({
        dimensions: [
          { key: "other:Printer Status", label: "Printers", kind: "objective", volatility: "high", proposed_ttl_s: 600 },
        ],
        survey: { question: "q", controls: [control("other:printer_status")], allow_note: true },
      }),
    );
    expect(ok.dimensions[0]!.key).toBe("other:printer_status");
    expect(ok.dimensions[0]!.proposed_ttl_s).toBe(600);
  });

  it("uses vocabulary kind and volatility for known keys (agent cannot relabel them)", () => {
    const r = parsePlanResponse(
      plan({
        dimensions: [
          { key: "noise_level", label: "Noise", kind: "subjective", volatility: "low", proposed_ttl_s: 100000 },
        ],
      }),
    );
    expect(r.dimensions[0]).toMatchObject({ kind: "objective", volatility: "high", proposed_ttl_s: 1800 });
  });

  it("survey must have 1–3 controls with ordinal integers", () => {
    const four = [1, 2, 3, 4].map(() => control("noise_level"));
    expect(() => parsePlanResponse(plan({ survey: { question: "q", controls: four, allow_note: true } }))).toThrow();
    expect(() => parsePlanResponse(plan({ survey: { question: "q", controls: [], allow_note: true } }))).toThrow();
    const badOrdinal = { ...control("noise_level"), options: [{ value: "q", label: "Q", ordinal: 1.5 }] };
    expect(() =>
      parsePlanResponse(plan({ survey: { question: "q", controls: [badOrdinal], allow_note: true } })),
    ).toThrow();
  });

  it("survey controls must reference planned dimensions", () => {
    expect(() =>
      parsePlanResponse(
        plan({ survey: { question: "q", controls: [control("crowd_level")], allow_note: true } }),
      ),
    ).toThrow(/survey/i);
  });

  it("accepts a refusal with no dimensions or survey", () => {
    const r = parsePlanResponse(
      plan({ decision: "refuse", dimensions: [], survey: null, refusal: { reason: "Targets a private person" } }),
    );
    expect(r.refusal?.reason).toMatch(/private/);
    expect(r.dimensions).toEqual([]);
  });

  it("accepts a clarification with options", () => {
    const r = parsePlanResponse(
      plan({
        decision: "clarify",
        dimensions: [],
        survey: null,
        needs_clarification: true,
        clarification: { question: "Which floor?", options: ["Main", "Basement"] },
      }),
    );
    expect(r.clarification?.options).toEqual(["Main", "Basement"]);
  });

  it("requires dimensions and a survey when the plan proceeds", () => {
    expect(() => parsePlanResponse(plan({ dimensions: [] }))).toThrow();
    expect(() => parsePlanResponse(plan({ survey: null }))).toThrow();
  });

  it("rejects duplicate dimension keys after normalization", () => {
    const d = { label: "Noise", kind: "objective", volatility: "high" };
    expect(() =>
      parsePlanResponse(plan({ dimensions: [{ key: "noise_level", ...d }, { key: "Noise Level", ...d }] })),
    ).toThrow(/duplicate/i);
  });

  it("rejects an invalid planner value", () => {
    expect(() => parsePlanResponse(plan({ planner: "gpt" }))).toThrow();
  });
});

describe("parseSynthesizeResponse", () => {
  const ok = {
    headline: "Quiet right now",
    recommendation: "go",
    summary: "Two nearby reports say it is quiet.",
    supporting: ["Quiet · 12 s ago"],
    caveats: [],
    planner: "llm",
  };
  it("accepts valid output", () => {
    expect(parseSynthesizeResponse(ok)).toEqual(ok);
  });
  it("rejects bad recommendation", () => {
    expect(() => parseSynthesizeResponse({ ...ok, recommendation: "yes" })).toThrow();
  });
  it("defaults supporting/caveats to []", () => {
    const { supporting: _s, caveats: _c, ...rest } = ok;
    expect(parseSynthesizeResponse(rest)).toMatchObject({ supporting: [], caveats: [] });
  });
});

describe("parseSummarizePostResponse", () => {
  const claim = {
    dimension: "noise_level",
    value_label: "Quiet",
    kind: "objective",
    volatility: "high",
    proposed_ttl_s: 600,
    ordinal: 1,
  };
  it("accepts valid output and clamps claim TTLs", () => {
    const r = parseSummarizePostResponse({
      summary: "Quiet upstairs.",
      claims: [{ ...claim, proposed_ttl_s: 5 }],
      planner: "heuristic",
    });
    expect(r.claims[0]!.proposed_ttl_s).toBe(300);
  });
  it("allows null ordinal and normalizes dimension keys", () => {
    const r = parseSummarizePostResponse({
      summary: "s",
      claims: [{ ...claim, dimension: "Noise Level", ordinal: null }],
      planner: "llm",
    });
    expect(r.claims[0]).toMatchObject({ dimension: "noise_level", ordinal: null });
  });
  it("rejects unknown dimensions", () => {
    expect(() =>
      parseSummarizePostResponse({ summary: "s", claims: [{ ...claim, dimension: "vibes" }], planner: "llm" }),
    ).toThrow(/dimension/i);
  });
});
