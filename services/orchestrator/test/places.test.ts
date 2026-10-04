import { describe, expect, it } from "vitest";
import { catalogHits, hitsFromGoogle, mergePlaces } from "../src/places";

describe("place search", () => {
  it("matches catalog aliases without a Google key", () => {
    expect(catalogHits("ugli").map((p) => p.id)).toContain("shapiro-undergraduate-library");
    expect(catalogHits("")).toEqual([]);
  });

  it("keeps catalog hits ahead of Google results", () => {
    const local = catalogHits("shapiro");
    const remote = hitsFromGoogle([
      {
        id: "ChIJcafe",
        displayName: { text: "A cafe" },
        formattedAddress: "Ann Arbor, MI",
        location: { latitude: 42.28, longitude: -83.74 },
        primaryType: "cafe",
      },
    ]);
    const merged = mergePlaces(local, remote);
    expect(merged[0]?.id).toBe(local[0]?.id);
    expect(merged.map((p) => p.id)).toContain("ChIJcafe");
  });
});
