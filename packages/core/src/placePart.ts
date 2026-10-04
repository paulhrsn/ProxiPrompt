export interface PlacePart {
  kind: "floor" | "line" | "area";
  /** Short phrase from the question, such as "third floor". */
  label: string;
  /** Asked of someone nearby. */
  prompt: string;
  /** They can see a different part of the place and should be skipped. */
  passLabel: string;
}

const FLOOR_RE =
  /\b(\d+(?:st|nd|rd|th)?\s+floor|(?:first|second|third|fourth|fifth|sixth|seventh|ground|main|top|upper|lower|basement)\s+floor|floor\s+\d+)\b/i;
const LINE_RE = /\b(?:the\s+)?(?:line|queue)\b/i;
const AREA_RE = /\b(entrance|atrium|courtyard|lobby|patio|terrace|food court|basement)\b/i;

/** A floor, line, or smaller area named in the question. Null when the question is about the whole place. */
export function placePart(text: string): PlacePart | null {
  const raw = text || "";
  const floor = raw.match(FLOOR_RE);
  if (floor?.[1]) {
    const label = floor[1].toLowerCase().replace(/\s+/g, " ");
    return { kind: "floor", label, prompt: `Can you check the ${label}?`, passLabel: "Not my floor" };
  }
  const line = raw.match(LINE_RE);
  if (line) {
    return { kind: "line", label: "the line", prompt: "Can you see the line?", passLabel: "Not at the line" };
  }
  const area = raw.match(AREA_RE);
  if (area?.[1]) {
    const label = area[1].toLowerCase();
    return { kind: "area", label, prompt: `Can you check the ${label}?`, passLabel: "Not there" };
  }
  return null;
}
