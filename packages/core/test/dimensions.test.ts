import { describe, expect, it } from "vitest";
import {
  DIMENSIONS,
  TTL_BOUNDS,
  clampTtl,
  getDimension,
  normalizeDimensionKey,
} from "../src/dimensions";

describe("dimension vocabulary", () => {
  it("has the 14 SPEC §6 keys with kinds", () => {
    expect(DIMENSIONS).toHaveLength(14);
    expect(getDimension("noise_level")).toMatchObject({ kind: "objective", volatility: "high" });
    expect(getDimension("open_status")).toMatchObject({ kind: "objective", volatility: "low" });
    expect(getDimension("worth_it")).toMatchObject({ kind: "subjective", volatility: "medium" });
    expect(getDimension("atmosphere")?.kind).toBe("subjective");
  });

  it("returns undefined for unknown keys", () => {
    expect(getDimension("vibes")).toBeUndefined();
  });
});

describe("normalizeDimensionKey", () => {
  it("accepts vocabulary keys, tolerating case/spacing", () => {
    expect(normalizeDimensionKey("noise_level")).toBe("noise_level");
    expect(normalizeDimensionKey("  Noise Level ")).toBe("noise_level");
    expect(normalizeDimensionKey("seating-availability")).toBe("seating_availability");
  });

  it("accepts other:<slug> and normalizes the slug", () => {
    expect(normalizeDimensionKey("other:Printer Status")).toBe("other:printer_status");
    expect(normalizeDimensionKey("other:wifi_speed")).toBe("other:wifi_speed");
  });

  it("rejects unknown keys and empty other slugs", () => {
    expect(normalizeDimensionKey("vibes")).toBeNull();
    expect(normalizeDimensionKey("other:")).toBeNull();
    expect(normalizeDimensionKey("other:!!!")).toBeNull();
    expect(normalizeDimensionKey("")).toBeNull();
  });
});

describe("clampTtl", () => {
  it("has SPEC bounds", () => {
    expect(TTL_BOUNDS.high).toEqual({ min: 300, max: 1800, default: 900 });
    expect(TTL_BOUNDS.medium).toEqual({ min: 1800, max: 14400, default: 5400 });
    expect(TTL_BOUNDS.low).toEqual({ min: 14400, max: 172800, default: 43200 });
  });

  it("clamps into the volatility range", () => {
    expect(clampTtl("high", 10)).toBe(300);
    expect(clampTtl("high", 99999)).toBe(1800);
    expect(clampTtl("high", 600)).toBe(600);
    expect(clampTtl("low", 1)).toBe(14400);
    expect(clampTtl("medium", 100000)).toBe(14400);
  });

  it("uses the default when missing or invalid", () => {
    expect(clampTtl("high", undefined)).toBe(900);
    expect(clampTtl("high", null)).toBe(900);
    expect(clampTtl("medium", Number.NaN)).toBe(5400);
    expect(clampTtl("low", Infinity)).toBe(43200);
    expect(clampTtl("high", -5)).toBe(900);
    expect(clampTtl("high", 0)).toBe(900);
    expect(clampTtl("high", "900" as unknown as number)).toBe(900);
  });
});
