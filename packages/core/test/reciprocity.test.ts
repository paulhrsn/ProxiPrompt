import { describe, expect, it } from "vitest";
import { RECIPROCITY_CAP, RECIPROCITY_WINDOW_MS, reciprocityCredit } from "../src/reciprocity";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const answer = (ageMs: number) => ({ createdAtMs: NOW - ageMs, pass: false });
const pass = (ageMs: number) => ({ createdAtMs: NOW - ageMs, pass: true });

describe("reciprocityCredit", () => {
  it("is zero with no responses", () => {
    expect(reciprocityCredit([], NOW)).toBe(0);
  });

  it("counts real answers", () => {
    expect(reciprocityCredit([answer(HOUR), answer(2 * HOUR), answer(3 * HOUR)], NOW)).toBe(3);
  });

  it("does not count a not_here pass", () => {
    expect(reciprocityCredit([answer(HOUR), pass(HOUR), pass(2 * HOUR)], NOW)).toBe(1);
  });

  it("only counts the last 24 hours", () => {
    expect(RECIPROCITY_WINDOW_MS).toBe(24 * HOUR);
    expect(reciprocityCredit([answer(23 * HOUR), answer(25 * HOUR), answer(48 * HOUR)], NOW)).toBe(1);
  });

  it("is capped at 5", () => {
    expect(RECIPROCITY_CAP).toBe(5);
    const many = Array.from({ length: 9 }, (_, i) => answer(i * 1000));
    expect(reciprocityCredit(many, NOW)).toBe(5);
  });

  it("ignores responses dated in the future", () => {
    expect(reciprocityCredit([answer(-HOUR)], NOW)).toBe(0);
  });
});
