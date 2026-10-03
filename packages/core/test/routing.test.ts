import { describe, expect, it } from "vitest";
import { getConfig } from "../src/config";
import { selectResponders, type Candidate } from "../src/routing";

const NOW = 1_700_000_000_000;
const place = { lat: 42.2758, lng: -83.7372 }; // Shapiro
const config = getConfig(false);

// ~1° lat ≈ 111 km → 0.0001° ≈ 11 m
const near = (meters: number) => ({ lat: place.lat + meters / 111_195, lng: place.lng });

function cand(userId: string, meters: number, over: Partial<Candidate> = {}): Candidate {
  return {
    userId,
    ...near(meters),
    source: "gps",
    capturedAtMs: NOW - 60_000,
    hasActiveDevice: true,
    notificationsPaused: false,
    lastPromptedAtMs: null,
    ...over,
  };
}

const base = { place, nowMs: NOW, config, radiusM: 150, count: 2, excludeIds: [], requesterId: "req" };

describe("selectResponders", () => {
  it("selects the closest `count` eligible candidates, ranked by distance", () => {
    const r = selectResponders({
      ...base,
      candidates: [cand("c", 120), cand("a", 20), cand("b", 45), cand("d", 90)],
    });
    expect(r.selected.map((s) => s.userId)).toEqual(["a", "b"]);
    expect(r.selected[0]!.distanceM).toBeGreaterThan(15);
    expect(r.selected[0]!.distanceM).toBeLessThan(25);
    expect(r.selected[0]!.source).toBe("gps");
    expect(r.excluded).toEqual([]);
  });

  it("first wave uses config.FIRST_WAVE when count = FIRST_WAVE", () => {
    const r = selectResponders({
      ...base,
      count: config.FIRST_WAVE,
      candidates: [cand("a", 10), cand("b", 20), cand("c", 30)],
    });
    expect(r.selected).toHaveLength(2);
  });

  it("carries the location source (demo) through", () => {
    const r = selectResponders({ ...base, candidates: [cand("a", 20, { source: "demo" })] });
    expect(r.selected[0]!.source).toBe("demo");
  });

  it("excludes the requester", () => {
    const r = selectResponders({ ...base, candidates: [cand("req", 5)] });
    expect(r.selected).toEqual([]);
    expect(r.excluded).toEqual([{ userId: "req", reason: "requester" }]);
  });

  it("excludes already-asked users", () => {
    const r = selectResponders({ ...base, excludeIds: ["a"], candidates: [cand("a", 5)] });
    expect(r.excluded[0]).toMatchObject({ userId: "a", reason: "already_asked" });
  });

  it("excludes stale locations", () => {
    const r = selectResponders({
      ...base,
      candidates: [cand("a", 5, { capturedAtMs: NOW - (config.LOCATION_MAX_AGE_S + 1) * 1000 })],
    });
    expect(r.excluded[0]).toMatchObject({ userId: "a", reason: "stale_location" });
  });

  it("accepts a demo-mode old location that is stale only in normal mode", () => {
    const old = cand("a", 5, { capturedAtMs: NOW - 3 * 3600 * 1000, source: "demo" });
    expect(selectResponders({ ...base, candidates: [old] }).selected).toEqual([]);
    expect(
      selectResponders({ ...base, config: getConfig(true), candidates: [old] }).selected,
    ).toHaveLength(1);
  });

  it("excludes out-of-radius candidates with their distance", () => {
    const r = selectResponders({ ...base, candidates: [cand("far", 600)] });
    expect(r.excluded[0]).toMatchObject({ userId: "far", reason: "out_of_radius" });
    expect(r.excluded[0]!.distanceM).toBeGreaterThan(550);
  });

  it("excludes users with no active device", () => {
    const r = selectResponders({ ...base, candidates: [cand("a", 5, { hasActiveDevice: false })] });
    expect(r.excluded[0]).toMatchObject({ userId: "a", reason: "no_device" });
  });

  it("excludes users with paused notifications", () => {
    const r = selectResponders({ ...base, candidates: [cand("a", 5, { notificationsPaused: true })] });
    expect(r.excluded[0]).toMatchObject({ userId: "a", reason: "paused" });
  });

  it("excludes users in cooldown, but not after it elapses", () => {
    const inCooldown = cand("a", 5, { lastPromptedAtMs: NOW - (config.RESPONDER_COOLDOWN_S - 1) * 1000 });
    const done = cand("b", 6, { lastPromptedAtMs: NOW - (config.RESPONDER_COOLDOWN_S + 1) * 1000 });
    const r = selectResponders({ ...base, candidates: [inCooldown, done] });
    expect(r.excluded).toHaveLength(1);
    expect(r.excluded[0]).toMatchObject({ userId: "a", reason: "cooldown" });
    expect(r.selected.map((s) => s.userId)).toEqual(["b"]);
  });

  it("spec scenario: two near Shapiro selected, Union (~375 m) excluded at 150 m radius", () => {
    const union = { userId: "chinmay", lat: 42.275, lng: -83.7417 };
    const r = selectResponders({
      ...base,
      candidates: [
        cand("jerry", 20, { source: "demo" }),
        cand("shiyuan", 45, { source: "demo" }),
        { ...cand("chinmay", 0, { source: "demo" }), ...union },
      ],
    });
    expect(r.selected.map((s) => s.userId)).toEqual(["jerry", "shiyuan"]);
    expect(r.excluded).toMatchObject([{ userId: "chinmay", reason: "out_of_radius" }]);
  });
});
