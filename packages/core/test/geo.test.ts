import { describe, expect, it } from "vitest";
import { haversineM } from "../src/geo";

describe("haversineM", () => {
  it("is 0 for identical points", () => {
    expect(haversineM(42.2758, -83.7372, 42.2758, -83.7372)).toBe(0);
  });

  it("Shapiro Library to Michigan Union ≈ 375 m", () => {
    const d = haversineM(42.2758, -83.7372, 42.275, -83.7417);
    expect(d).toBeGreaterThan(335);
    expect(d).toBeLessThan(415);
  });

  it("is symmetric", () => {
    expect(haversineM(1, 2, 3, 4)).toBeCloseTo(haversineM(3, 4, 1, 2), 6);
  });
});
