import { describe, expect, it } from "vitest";
import { inferWatchTarget, watchReading, type WatchObservation } from "../src/watch";

const now = 1_000_000;

function obs(over: Partial<WatchObservation> = {}): WatchObservation {
  return {
    dimension: "seating_availability",
    value: "plenty",
    valueLabel: "Plenty",
    observedAtMs: now - 12_000,
    expiresAtMs: now + 60_000,
    invalidated: false,
    sourceType: "response",
    ...over,
  };
}

describe("inferWatchTarget", () => {
  it("treats open seats as the open end of whatever options the survey used", () => {
    const target = inferWatchTarget("Tell me when seats open up", [], [
      {
        dimension_key: "seating_availability",
        options: [
          { value: "many_open", label: "Many open seats" },
          { value: "none_open", label: "No open seats" },
        ],
      },
    ]);
    expect(target).toMatchObject({ dimension: "seating_availability", phrase: "Seats opened up", metValues: ["many_open"] });
  });

  it("falls back to the vocabulary values when the survey is not in yet", () => {
    expect(inferWatchTarget("seats open")?.metValues).toEqual(["some", "plenty"]);
  });
});

describe("watchReading", () => {
  const target = inferWatchTarget("seats open")!;

  it("is met by plenty and not by a few, an expired report, or a social post", () => {
    expect(watchReading([obs()], target, now).met).toBe(true);
    expect(watchReading([obs({ value: "few", valueLabel: "A few" })], target, now).met).toBe(false);
    expect(watchReading([obs({ expiresAtMs: now - 1 })], target, now).met).toBe(false);
    expect(watchReading([obs({ sourceType: "social" })], target, now).met).toBe(false);
  });

  it("treats a matching label as open seats even when the option id differs", () => {
    const armed = inferWatchTarget("Tell me when seats open up", [], [
      {
        dimension_key: "seating_availability",
        options: [
          { value: "many_open", label: "Many open seats" },
          { value: "none_open", label: "No open seats" },
        ],
      },
    ])!;
    expect(armed.metValues).toEqual(["many_open"]);
    expect(watchReading([obs({ value: "many_seats", valueLabel: "Many open seats" })], armed, now).met).toBe(true);
    expect(watchReading([obs({ value: "none", valueLabel: "No open seats" })], armed, now).met).toBe(false);
  });
});
