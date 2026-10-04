import { describe, expect, it } from "vitest";
import { busyness, chooseAnswer, seedPostText, PERSONAS, type Control } from "../src/neighbors";

/** Deterministic rng from a list that cycles. */
function seq(...vals: number[]) {
  let i = 0;
  return () => vals[i++ % vals.length];
}

/** Small LCG so distribution tests are reproducible. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const noise: Control = {
  dimension_key: "noise_level",
  label: "Noise level",
  options: [
    { value: "quiet", label: "Quiet", ordinal: 0 },
    { value: "moderate", label: "Moderate", ordinal: 1 },
    { value: "loud", label: "Loud", ordinal: 2 },
  ],
};
const seats: Control = {
  dimension_key: "seating_availability",
  label: "Open seats",
  options: [
    { value: "none", label: "None", ordinal: 0 },
    { value: "few", label: "A few", ordinal: 1 },
    { value: "some", label: "Some", ordinal: 2 },
    { value: "plenty", label: "Plenty", ordinal: 3 },
  ],
};
const freeform: Control = {
  dimension_key: "other:answer",
  label: "Your answer",
  options: [
    { value: "no", label: "No", ordinal: 0 },
    { value: "unsure", label: "Not sure", ordinal: 1 },
    { value: "yes", label: "Yes", ordinal: 2 },
  ],
};
const presence: Control = {
  dimension_key: "other:place_part",
  label: "Are you there right now?",
  options: [
    { value: "here", label: "I can check", ordinal: 1 },
    { value: "not_here", label: "I'm not at Shapiro", ordinal: 0 },
  ],
};

function tally(control: Control, category: string, hour: number, n = 600) {
  const rng = lcg(7);
  const counts: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const r = chooseAnswer({ controls: [control], placeCategory: category, hour, rng });
    const v = r.answers[control.dimension_key];
    counts[v] = (counts[v] ?? 0) + 1;
  }
  return counts;
}

describe("busyness", () => {
  it("libraries are quiet late and busy mid-afternoon", () => {
    expect(busyness("library", 23)).toBeLessThan(busyness("library", 15));
    expect(busyness("library", 3)).toBeLessThan(0.3);
  });
  it("dining peaks at meals and is empty between", () => {
    expect(busyness("dining", 12)).toBeGreaterThan(0.7);
    expect(busyness("dining", 18)).toBeGreaterThan(0.7);
    expect(busyness("dining", 15)).toBeLessThan(busyness("dining", 12));
  });
  it("stays within 0..1 for every category and hour", () => {
    for (const cat of ["library", "dining", "gym", "student_union", "park", "weird"]) {
      for (let h = 0; h < 24; h++) {
        const b = busyness(cat, h);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("chooseAnswer", () => {
  it("only ever returns values that exist in the control, one per dimension", () => {
    const rng = lcg(1);
    for (let i = 0; i < 200; i++) {
      const r = chooseAnswer({ controls: [noise, seats, freeform], placeCategory: "library", hour: 14, rng });
      expect(Object.keys(r.answers).sort()).toEqual(["noise_level", "other:answer", "seating_availability"]);
      for (const c of [noise, seats, freeform]) {
        expect(c.options.map((o) => o.value)).toContain(r.answers[c.dimension_key]);
      }
      expect(r.note.length).toBeLessThanOrEqual(280);
    }
  });

  it("a library late at night is mostly quiet with plenty of seats", () => {
    const n = tally(noise, "library", 23);
    expect(n.quiet).toBeGreaterThan(n.loud ?? 0);
    expect(n.quiet).toBeGreaterThan(300);
    const s = tally(seats, "library", 23);
    expect((s.plenty ?? 0) + (s.some ?? 0)).toBeGreaterThan((s.none ?? 0) + (s.few ?? 0));
  });

  it("a dining hall at lunch is busy and short on seats", () => {
    const s = tally(seats, "dining", 12);
    expect((s.none ?? 0) + (s.few ?? 0)).toBeGreaterThan((s.plenty ?? 0) + (s.some ?? 0));
  });

  it("still picks the less likely options sometimes", () => {
    const n = tally(noise, "library", 23);
    expect(Object.keys(n).length).toBeGreaterThan(1);
  });

  it("freeform questions get yes, no and not sure, mostly yes or no", () => {
    const f = tally(freeform, "library", 14);
    expect(f.yes).toBeGreaterThan(0);
    expect(f.no).toBeGreaterThan(0);
    expect(f.unsure).toBeGreaterThan(0);
    expect(f.unsure).toBeLessThan(f.yes + f.no);
  });

  it("passes with not_here only when a presence control exists, and then answers only the presence key", () => {
    const pass = chooseAnswer({ controls: [presence, noise], placeCategory: "library", hour: 14, rng: seq(0.001) });
    expect(pass.pass).toBe(true);
    expect(pass.answers).toEqual({ "other:place_part": "not_here" });
    expect(pass.note).toBe("");
    // No presence control: never a pass, even with the lowest roll.
    const none = chooseAnswer({ controls: [noise], placeCategory: "library", hour: 14, rng: seq(0.001) });
    expect(none.pass).toBe(false);
    expect(Object.keys(none.answers)).toEqual(["noise_level"]);
  });

  it("passes rarely", () => {
    const rng = lcg(3);
    let passes = 0;
    for (let i = 0; i < 1000; i++) {
      if (chooseAnswer({ controls: [presence, noise], placeCategory: "library", hour: 14, rng }).pass) passes++;
    }
    expect(passes).toBeGreaterThan(0);
    expect(passes).toBeLessThan(100);
  });

  it("when not passing, never sends the presence key (the form hides it)", () => {
    const r = chooseAnswer({ controls: [presence, noise], placeCategory: "library", hour: 14, rng: seq(0.99) });
    expect(r.pass).toBe(false);
    expect(Object.keys(r.answers)).toEqual(["noise_level"]);
  });

  it("handles unknown dimensions by picking one of their options", () => {
    const odd: Control = {
      dimension_key: "other:foo",
      label: "Foo",
      options: [
        { value: "low", label: "Low", ordinal: 0 },
        { value: "high", label: "High", ordinal: 2 },
      ],
    };
    const r = chooseAnswer({ controls: [odd], placeCategory: "library", hour: 9, rng: lcg(5) });
    expect(["low", "high"]).toContain(r.answers["other:foo"]);
  });

  it("returns an empty answer set for no controls without throwing", () => {
    const r = chooseAnswer({ controls: [], placeCategory: "library", hour: 9, rng: lcg(5) });
    expect(r.answers).toEqual({});
  });

  it("adds a note sometimes, never one that is empty-but-flagged or too long", () => {
    const rng = lcg(11);
    let withNote = 0;
    for (let i = 0; i < 300; i++) {
      const r = chooseAnswer({ controls: [noise], placeCategory: "library", hour: 14, rng });
      if (r.note) withNote++;
      expect(r.note.length).toBeLessThanOrEqual(280);
      expect(r.note).not.toMatch(/[\u2013\u2014]/);
    }
    expect(withNote).toBeGreaterThan(30);
    expect(withNote).toBeLessThan(200);
  });
});

describe("seedPostText", () => {
  it("is short, mentions nothing weird and has no dashes", () => {
    for (const cat of ["library", "dining", "gym", "student_union", "park", "transit", "other"]) {
      for (let i = 0; i < 20; i++) {
        const t = seedPostText(cat, 14, lcg(i + 1));
        expect(t.length).toBeGreaterThan(10);
        expect(t.length).toBeLessThanOrEqual(280);
        expect(t).not.toMatch(/[\u2013\u2014]/);
      }
    }
  });
});

describe("PERSONAS", () => {
  it("has valid unique usernames ending in _sim and a spread across places", () => {
    const names = PERSONAS.map((p) => p.username);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z0-9_]{3,20}$/);
    for (const n of names) expect(n.endsWith("_sim")).toBe(true);
    const first8 = PERSONAS.slice(0, 8).map((p) => p.placeId);
    expect(first8.filter((id) => id === "shapiro-undergraduate-library").length).toBeGreaterThanOrEqual(3);
    expect(first8).toContain("duderstadt-center");
    expect(first8).toContain("michigan-union");
    expect(first8).toContain("ccrb");
  });
});
