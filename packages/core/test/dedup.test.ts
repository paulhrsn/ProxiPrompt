import { describe, expect, it } from "vitest";
import { findAttachableJob, jaccard, type JobSummary } from "../src/dedup";

const NOW = 1_700_000_000_000;

function job(over: Partial<JobSummary> & { id: string }): JobSummary {
  return {
    placeId: "shapiro",
    dimensionKeys: ["noise_level", "seating_availability"],
    status: "collecting",
    deadlineAtMs: NOW + 60_000,
    createdAtMs: NOW - 10_000,
    ...over,
  };
}

describe("jaccard", () => {
  it("is |A∩B| / |A∪B|", () => {
    expect(jaccard(["a", "b"], ["a", "b"])).toBe(1);
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3, 10);
    expect(jaccard(["a"], ["b"])).toBe(0);
  });
  it("ignores duplicates and is 0 for two empty sets", () => {
    expect(jaccard(["a", "a"], ["a"])).toBe(1);
    expect(jaccard([], [])).toBe(0);
  });
});

describe("findAttachableJob", () => {
  const keys = ["noise_level", "seating_availability"];

  it("attaches to a collecting job at the same place with overlap", () => {
    expect(findAttachableJob([job({ id: "j1" })], "shapiro", keys, NOW)?.id).toBe("j1");
  });

  it("treats Jaccard = 0.5 as attachable and just below as not", () => {
    // {a,b} vs {a,b,c,d} → 0.5
    const j = job({ id: "j", dimensionKeys: ["noise_level", "seating_availability", "crowd_level", "wait_time"] });
    expect(findAttachableJob([j], "shapiro", keys, NOW)?.id).toBe("j");
    // {a,b} vs {a,b,c,d,e} → 0.4
    const j2 = job({
      id: "j2",
      dimensionKeys: ["noise_level", "seating_availability", "crowd_level", "wait_time", "line_length"],
    });
    expect(findAttachableJob([j2], "shapiro", keys, NOW)).toBeNull();
  });

  it("rejects other places, non-collecting jobs and jobs past deadline", () => {
    expect(findAttachableJob([job({ id: "x", placeId: "union" })], "shapiro", keys, NOW)).toBeNull();
    expect(findAttachableJob([job({ id: "x", status: "synthesizing" })], "shapiro", keys, NOW)).toBeNull();
    expect(findAttachableJob([job({ id: "x", status: "done" })], "shapiro", keys, NOW)).toBeNull();
    expect(findAttachableJob([job({ id: "x", deadlineAtMs: NOW })], "shapiro", keys, NOW)).toBeNull();
    expect(findAttachableJob([job({ id: "x", deadlineAtMs: NOW - 1 })], "shapiro", keys, NOW)).toBeNull();
  });

  it("picks highest overlap, then newest", () => {
    const partial = job({ id: "partial", dimensionKeys: ["noise_level", "crowd_level"], createdAtMs: NOW - 1 });
    const exactOld = job({ id: "exactOld", createdAtMs: NOW - 5000 });
    const exactNew = job({ id: "exactNew", createdAtMs: NOW - 1000 });
    expect(findAttachableJob([partial, exactOld, exactNew], "shapiro", keys, NOW)?.id).toBe("exactNew");
    expect(findAttachableJob([partial, exactOld], "shapiro", keys, NOW)?.id).toBe("exactOld");
  });

  it("returns null with no jobs", () => {
    expect(findAttachableJob([], "shapiro", keys, NOW)).toBeNull();
  });
});
