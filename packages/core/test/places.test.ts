import { describe, expect, it } from "vitest";
import { resolveCatalogPlace } from "../src/places";

describe("resolveCatalogPlace", () => {
  it("matches Shapiro aliases", () => {
    expect(resolveCatalogPlace("Is Shapiro worth going to if I need somewhere quiet?")?.id).toBe(
      "shapiro-undergraduate-library",
    );
    expect(resolveCatalogPlace("how busy is the UGLi")?.id).toBe("shapiro-undergraduate-library");
  });

  it("prefers the longer alias", () => {
    expect(resolveCatalogPlace("south quad dining vs the union")?.id).toBe("south-quad-dining");
  });
});
