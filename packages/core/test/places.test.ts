import { describe, expect, it } from "vitest";
import {
  CATALOG_PLACES,
  describeLocation,
  hasAmbiguousNeighbor,
  nearestCatalogPlace,
  neighboringPlaces,
  resolveCatalogPlace,
} from "../src/places";

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

describe("describeLocation", () => {
  it("does not pick between Duderstadt and Pierpont when the fix is between them", () => {
    const reading = describeLocation(42.2909, -83.7157);
    expect(reading.ambiguous).toBe(true);
    expect(reading.places.map((p) => p.id).sort()).toEqual(["duderstadt-center", "pierpont-commons"]);
    // Raw coordinates are noise to a person; the label names places only.
    expect(reading.label).toBe("Between Pierpont Commons and Duderstadt Center"); // nearest first
  });

  it("names a building when the fix is on that building and the neighbor is clearly farther", () => {
    const shapiro = CATALOG_PLACES.find((p) => p.id === "shapiro-undergraduate-library")!;
    const reading = describeLocation(shapiro.lat, shapiro.lng);
    expect(reading.ambiguous).toBe(false);
    expect(reading.places.map((p) => p.id)).toEqual(["shapiro-undergraduate-library"]);
    expect(reading.label).toBe("Near Shapiro Undergraduate Library");
  });

  it("says no known place is nearby instead of printing coordinates", () => {
    const reading = describeLocation(40, -80);
    expect(reading.places).toEqual([]);
    expect(reading.ambiguous).toBe(false);
    expect(reading.label).toBe("Not near a known place");
  });
});

describe("adjacent catalog buildings", () => {
  it("knows Duderstadt and Pierpont are too close for GPS to separate", () => {
    const dude = CATALOG_PLACES.find((p) => p.id === "duderstadt-center")!;
    expect(neighboringPlaces(dude).map((p) => p.id)).toContain("pierpont-commons");
    expect(hasAmbiguousNeighbor(dude)).toBe(true);
  });

  it("knows Michigan Stadium stands alone", () => {
    const stadium = CATALOG_PLACES.find((p) => p.id === "michigan-stadium")!;
    expect(neighboringPlaces(stadium)).toEqual([]);
    expect(hasAmbiguousNeighbor(stadium)).toBe(false);
  });

  it("names the nearest building to a point at any distance", () => {
    const pierpont = CATALOG_PLACES.find((p) => p.id === "pierpont-commons")!;
    const nearest = nearestCatalogPlace(pierpont.lat, pierpont.lng);
    expect(nearest?.place.id).toBe("pierpont-commons");
    expect(nearest?.distanceM).toBeCloseTo(0, 5);
  });
});
