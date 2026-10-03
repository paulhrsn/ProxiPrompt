export interface BlueskyPost {
  uri: string;
  text: string;
  createdAtMs: number;
  handle: string;
}

/** Normalize a Bluesky searchPosts JSON payload into evidence-ready posts. */
export function parseSearchPosts(raw: unknown): BlueskyPost[] {
  if (!raw || typeof raw !== "object") return [];
  const posts = (raw as { posts?: unknown }).posts;
  if (!Array.isArray(posts)) return [];
  const out: BlueskyPost[] = [];
  for (const p of posts) {
    if (!p || typeof p !== "object") continue;
    const rec = p as {
      uri?: string;
      record?: { text?: string; createdAt?: string };
      author?: { handle?: string };
    };
    const text = rec.record?.text?.trim();
    const uri = rec.uri;
    if (!text || !uri) continue;
    const createdAtMs = rec.record?.createdAt ? Date.parse(rec.record.createdAt) : Date.now();
    out.push({
      uri,
      text: text.slice(0, 300),
      createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
      handle: rec.author?.handle ?? "unknown",
    });
  }
  return out;
}

export async function searchBluesky(query: string, limit = 8): Promise<BlueskyPost[]> {
  if (!["1", "true", "yes", "on"].includes((process.env.ENABLE_BLUESKY ?? "1").toLowerCase())) {
    return [];
  }
  const url = new URL("https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("sort", "latest");
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "ProxiPrompt/0.1 (hackathon; +https://proxiprompt.local)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    return parseSearchPosts(await res.json());
  } catch {
    return [];
  }
}

export function blueskyQueryForPlace(placeName: string, extra = "ProxiPromptDemo"): string {
  return `${placeName} ${extra}`.trim();
}
