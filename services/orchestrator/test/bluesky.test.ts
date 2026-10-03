import { describe, expect, it } from "vitest";
import { blueskyQueryForPlace, parseSearchPosts } from "../src/bluesky";

describe("parseSearchPosts", () => {
  it("extracts text, uri, handle, and createdAt", () => {
    const posts = parseSearchPosts({
      posts: [
        {
          uri: "at://did:plc:abc/app.bsky.feed.post/1",
          author: { handle: "demo.bsky.social" },
          record: {
            text: "Shapiro third floor has plenty of seats but it’s getting loud. #ProxiPromptDemo",
            createdAt: "2026-10-03T18:00:00.000Z",
          },
        },
        { uri: "at://x", record: {} },
      ],
    });
    expect(posts).toHaveLength(1);
    expect(posts[0].handle).toBe("demo.bsky.social");
    expect(posts[0].text).toContain("Shapiro");
    expect(posts[0].createdAtMs).toBe(Date.parse("2026-10-03T18:00:00.000Z"));
  });

  it("returns empty for garbage", () => {
    expect(parseSearchPosts(null)).toEqual([]);
    expect(parseSearchPosts({})).toEqual([]);
  });
});

describe("blueskyQueryForPlace", () => {
  it("includes the place and demo tag", () => {
    expect(blueskyQueryForPlace("Shapiro Undergraduate Library")).toContain("Shapiro");
    expect(blueskyQueryForPlace("Shapiro Undergraduate Library")).toContain("ProxiPromptDemo");
  });
});
