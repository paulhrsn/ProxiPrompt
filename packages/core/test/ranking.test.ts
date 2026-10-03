import { describe, expect, it } from "vitest";
import { rankPosts, utilityScore, type RankablePost } from "../src/ranking";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

function post(over: Partial<RankablePost> & { id: string }): RankablePost {
  return {
    createdAtMs: NOW,
    maxFreshness: 0,
    verifiedNearby: false,
    recentSubstantiveComments: 0,
    ...over,
  };
}

describe("utilityScore", () => {
  it("is 0.55·freshness + 0.15·verified + 0.15·comments + 0.15·recency", () => {
    const s = utilityScore(
      post({ id: "a", maxFreshness: 1, verifiedNearby: true, recentSubstantiveComments: 3 }),
      NOW,
    );
    expect(s).toBeCloseTo(0.55 + 0.15 + 0.15 + 0.15, 10);
    expect(utilityScore(post({ id: "b", createdAtMs: NOW - 48 * HOUR }), NOW)).toBe(0);
  });

  it("caps the comment contribution (3+ substantive comments is full)", () => {
    const a = utilityScore(post({ id: "a", recentSubstantiveComments: 3 }), NOW);
    const b = utilityScore(post({ id: "b", recentSubstantiveComments: 30 }), NOW);
    expect(a).toBe(b);
  });
});

describe("rankPosts", () => {
  const fresh = post({ id: "fresh", createdAtMs: NOW - 5 * 60_000, maxFreshness: 0.97 });
  const busyOld = post({
    id: "busyOld",
    createdAtMs: NOW - 5 * HOUR,
    maxFreshness: 0,
    recentSubstantiveComments: 10,
    verifiedNearby: true,
  });

  it("useful mode prefers a fresh post over an older post with more comments", () => {
    expect(rankPosts([busyOld, fresh], "useful", NOW).map((p) => p.id)).toEqual(["fresh", "busyOld"]);
  });

  it("recent mode is strict time order, newest first", () => {
    const newest = post({ id: "newest", createdAtMs: NOW - 1000, maxFreshness: 0 });
    expect(rankPosts([busyOld, newest, fresh], "recent", NOW).map((p) => p.id)).toEqual([
      "newest",
      "fresh",
      "busyOld",
    ]);
  });

  it("does not mutate its input and breaks useful ties by newest", () => {
    const a = post({ id: "a", createdAtMs: NOW - 2000 });
    const b = post({ id: "b", createdAtMs: NOW - 1000 });
    const input = [a, b];
    const out = rankPosts(input, "recent", NOW);
    expect(input.map((p) => p.id)).toEqual(["a", "b"]);
    expect(out.map((p) => p.id)).toEqual(["b", "a"]);
  });
});
