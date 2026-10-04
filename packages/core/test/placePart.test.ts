import { describe, expect, it } from "vitest";
import { placePart } from "../src/placePart";

describe("placePart", () => {
  it("names a floor and offers a pass", () => {
    const part = placePart("Is there a quiet seat on the first floor?");
    expect(part?.kind).toBe("floor");
    expect(part?.label).toBe("first floor");
    expect(part?.passLabel).toBe("Not my floor");
    expect(part?.prompt).toContain("first floor");
  });

  it("treats a line as its own check", () => {
    expect(placePart("How long is the line at Pierpont?")?.passLabel).toBe("Not at the line");
  });

  it("returns nothing when the question is about the whole place", () => {
    expect(placePart("Is Shapiro quiet right now?")).toBeNull();
  });
});
