export interface RankablePost {
  id: string;
  createdAtMs: number;
  /** 0–1, from freshnessNote().maxFreshness. */
  maxFreshness: number;
  verifiedNearby: boolean;
  recentSubstantiveComments: number;
}

const RECENCY_WINDOW_MS = 24 * 3_600_000;
const COMMENTS_FOR_FULL_SCORE = 3;

/** score = 0.55·max_claim_freshness + 0.15·verified + 0.15·recent_substantive_comments + 0.15·recency */
export function utilityScore(post: RankablePost, nowMs: number): number {
  const freshness = Math.min(1, Math.max(0, post.maxFreshness));
  const verified = post.verifiedNearby ? 1 : 0;
  const comments = Math.min(1, post.recentSubstantiveComments / COMMENTS_FOR_FULL_SCORE);
  const recency = Math.min(1, Math.max(0, 1 - (nowMs - post.createdAtMs) / RECENCY_WINDOW_MS));
  return 0.55 * freshness + 0.15 * verified + 0.15 * comments + 0.15 * recency;
}

/** 'useful' = utility score (ties newest first); 'recent' = strict newest first. Returns a new array. */
export function rankPosts<T extends RankablePost>(
  posts: T[],
  mode: "useful" | "recent",
  nowMs: number,
): T[] {
  if (mode === "recent") return [...posts].sort((a, b) => b.createdAtMs - a.createdAtMs);
  return posts
    .map((p) => ({ p, s: utilityScore(p, nowMs) }))
    .sort((a, b) => b.s - a.s || b.p.createdAtMs - a.p.createdAtMs)
    .map((x) => x.p);
}
