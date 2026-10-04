import { describe, expect, it } from "vitest";
import { getConfig } from "../src/config";
import { nextWaveCount, selectResponders, type Candidate } from "../src/routing";
import { CATALOG_PLACES } from "../src/places";

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

const base = { place, nowMs: NOW, config, radiusM: 150, count: 2, excludeIds: [], requesterIds: ["req"] };

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
      candidates: Array.from({ length: config.FIRST_WAVE + 2 }, (_, i) => cand(`u${i}`, 10 + i * 5)),
    });
    expect(r.selected).toHaveLength(config.FIRST_WAVE);
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

  it("excludes every requester attached to the job, not just the first", () => {
    const r = selectResponders({
      ...base,
      requesterIds: ["req", "req2"],
      candidates: [cand("req", 5), cand("req2", 10), cand("a", 30)],
    });
    expect(r.selected.map((s) => s.userId)).toEqual(["a"]);
    expect(r.excluded.map((e) => e.userId).sort()).toEqual(["req", "req2"]);
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

  it("does not ask a demo pin at Pierpont about Duderstadt", () => {
    const dude = CATALOG_PLACES.find((p) => p.id === "duderstadt-center")!;
    const pierpont = CATALOG_PLACES.find((p) => p.id === "pierpont-commons")!;
    const r = selectResponders({
      ...base,
      place: { lat: dude.lat, lng: dude.lng },
      candidates: [
        cand("at-dude", 0, { source: "demo", lat: dude.lat, lng: dude.lng }),
        cand("at-pierpont", 0, { source: "demo", lat: pierpont.lat, lng: pierpont.lng }),
      ],
    });
    expect(r.selected.map((s) => s.userId)).toEqual(["at-dude"]);
    expect(r.excluded).toMatchObject([{ userId: "at-pierpont", reason: "out_of_radius" }]);
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

describe("nextWaveCount", () => {
  const wave = { maxRecipients: 5, waveSize: 2, expandAfterMs: 30_000 };

  it("asks the first group immediately", () => {
    expect(nextWaveCount({ ...wave, alreadyAsked: 0, stillWaiting: 0, msSinceLastWave: 0 })).toBe(2);
  });

  it("waits out the timeout while the current group has not answered", () => {
    expect(nextWaveCount({ ...wave, alreadyAsked: 2, stillWaiting: 2, msSinceLastWave: 29_000 })).toBe(0);
  });

  it("asks a new group of the same size after the timeout", () => {
    expect(nextWaveCount({ ...wave, alreadyAsked: 2, stillWaiting: 2, msSinceLastWave: 30_000 })).toBe(2);
  });

  it("asks the next group as soon as everyone in this one has answered", () => {
    expect(nextWaveCount({ ...wave, alreadyAsked: 2, stillWaiting: 0, msSinceLastWave: 1_000 })).toBe(2);
  });

  it("does not ask past the recipient cap", () => {
    expect(nextWaveCount({ ...wave, alreadyAsked: 4, stillWaiting: 0, msSinceLastWave: 30_000 })).toBe(1);
    expect(nextWaveCount({ ...wave, alreadyAsked: 5, stillWaiting: 0, msSinceLastWave: 30_000 })).toBe(0);
  });
});

describe("adjacent buildings (GPS cannot separate them)", () => {
  // Duderstadt and Pierpont are 78 m apart, so a 150 m radius covers both. The real report:
  // of the two people asked about Duderstadt, one was standing in Pierpont.
  const inPierpont = (over: Partial<Candidate> = {}) =>
    cand("pierpont-person", 82, { nearestOtherBuildingM: 65, accuracyM: 10, ...over });

  it("does not ask someone sitting squarely on another building", () => {
    // Right on the Pierpont pin: 78 m from the target, 0 m from Pierpont.
    const r = selectResponders({
      ...base,
      candidates: [inPierpont({ nearestOtherBuildingM: 0, accuracyM: 10 })],
    });
    expect(r.selected).toEqual([]);
    expect(r.excluded[0]).toMatchObject({ userId: "pierpont-person", reason: "wrong_building" });
  });

  it("still asks when the gap is inside the GPS error, since the reading cannot settle it", () => {
    // 82 m from the target, 65 m from Pierpont. A 17 m gap between buildings that are
    // themselves 78 m apart proves nothing, so they are asked and ranked last instead.
    const r = selectResponders({ ...base, candidates: [inPierpont({ accuracyM: 40 })] });
    expect(r.selected.map((s) => s.userId)).toEqual(["pierpont-person"]);
    expect(r.selected[0]!.atTargetBuilding).toBe(false);
  });

  it("never trusts an accuracy figure tighter than the floor", () => {
    // 82 - 70 = 12 m gap with a claimed ±1 m fix: still inside GPS_CONFIDENCE_FLOOR_M.
    const r = selectResponders({
      ...base,
      candidates: [inPierpont({ accuracyM: 1, nearestOtherBuildingM: 70 })],
    });
    expect(r.selected.map((s) => s.userId)).toEqual(["pierpont-person"]);
  });

  it("asks whoever reads as inside the target first when both are plausible", () => {
    const r = selectResponders({
      ...base,
      count: 1,
      candidates: [
        cand("next-door", 60, { nearestOtherBuildingM: 50, accuracyM: 40 }),
        cand("inside-target", 90, { nearestOtherBuildingM: 140, accuracyM: 40 }),
      ],
    });
    expect(r.selected.map((s) => s.userId)).toEqual(["inside-target"]);
  });

  it("treats an unknown nearest building as no evidence either way", () => {
    const r = selectResponders({ ...base, candidates: [cand("unknown", 90)] });
    expect(r.selected.map((s) => s.userId)).toEqual(["unknown"]);
    expect(r.selected[0]!.atTargetBuilding).toBe(true);
  });
});

describe("an explicit building claim beats GPS", () => {
  const dude = CATALOG_PLACES.find((p) => p.id === "duderstadt-center")!;
  const target = { id: dude.id, lat: dude.lat, lng: dude.lng };

  it("never asks someone who says they are in a different building", () => {
    const r = selectResponders({
      ...base,
      place: target,
      // Standing right on the Duderstadt pin, but they told us they are in Pierpont.
      candidates: [cand("chin", 0, { claimedPlaceId: "pierpont-commons", lat: dude.lat, lng: dude.lng })],
    });
    expect(r.selected).toEqual([]);
    expect(r.excluded[0]).toMatchObject({ userId: "chin", reason: "wrong_building" });
  });

  it("trusts a claim on the target over a GPS reading that says next door", () => {
    // `cand` offsets from Shapiro, so place these two by hand relative to Duderstadt.
    const atDude = (meters: number) => ({ lat: dude.lat + meters / 111_195, lng: dude.lng });
    const r = selectResponders({
      ...base,
      place: target,
      count: 1,
      candidates: [
        { ...cand("closer-but-unclaimed", 0, { nearestOtherBuildingM: 5, accuracyM: 40 }), ...atDude(20) },
        { ...cand("claimed-target", 0, { claimedPlaceId: dude.id, nearestOtherBuildingM: 5, accuracyM: 40 }), ...atDude(80) },
      ],
    });
    expect(r.selected.map((s) => s.userId)).toEqual(["claimed-target"]);
  });

  it("ignores claims when the caller gives no place id", () => {
    const r = selectResponders({
      ...base,
      candidates: [cand("chin", 10, { claimedPlaceId: "pierpont-commons" })],
    });
    expect(r.selected.map((s) => s.userId)).toEqual(["chin"]);
  });
});

describe("the reported field scenario, end to end", () => {
  // Measured 2026-10-03 against the live DB: three friends on GPS, all asked about
  // Duderstadt, distances to the Duderstadt pin vs their nearest building (Pierpont).
  const field = [
    { id: "jerry", toTarget: 80, toNearestOther: 59 },
    { id: "shiyuan", toTarget: 83, toNearestOther: 78 },
    { id: "chin", toTarget: 82, toNearestOther: 65 },
  ];

  const candidatesWith = (accuracyM: number, claims: Record<string, string> = {}) =>
    field.map((f) => ({
      ...cand(f.id, f.toTarget, {
        accuracyM,
        nearestOtherBuildingM: f.toNearestOther,
        claimedPlaceId: claims[f.id],
      }),
    }));

  it("geometry alone cannot separate these three, and does not pretend to", () => {
    // Gaps of 21 m (jerry), 5 m (shiyuan) and 17 m (chin) between buildings 78 m apart.
    // Only jerry's clears GPS_CONFIDENCE_FLOOR_M, so the other two stay eligible — ranked
    // last, and the prompt asks them to confirm. The claim below is the actual fix.
    const r = selectResponders({ ...base, place: { id: "duderstadt-center", ...place }, candidates: candidatesWith(10) });
    expect(r.excluded).toMatchObject([{ userId: "jerry", reason: "wrong_building" }]);
    expect(r.selected.map((s) => s.userId)).toEqual(["chin", "shiyuan"]);
    expect(r.selected.every((s) => s.atTargetBuilding === false)).toBe(true);
  });

  it("with claims set, asks exactly the people who said they are in Duderstadt", () => {
    const r = selectResponders({
      ...base,
      place: { id: "duderstadt-center", ...place },
      candidates: candidatesWith(10, {
        jerry: "duderstadt-center",
        chin: "pierpont-commons",
        shiyuan: "duderstadt-center",
      }),
    });
    expect(r.selected.map((s) => s.userId).sort()).toEqual(["jerry", "shiyuan"]);
    expect(r.excluded).toMatchObject([{ userId: "chin", reason: "wrong_building" }]);
  });
});
