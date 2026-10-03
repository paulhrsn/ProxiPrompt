export type DimensionKind = "objective" | "subjective";
export type Volatility = "high" | "medium" | "low";

export interface DimensionDef {
  key: string;
  label: string;
  kind: DimensionKind;
  volatility: Volatility;
}

/** Controlled vocabulary, SPEC §6. */
export const DIMENSIONS: readonly DimensionDef[] = [
  { key: "seating_availability", label: "Seating availability", kind: "objective", volatility: "high" },
  { key: "crowd_level", label: "Crowd level", kind: "objective", volatility: "high" },
  { key: "wait_time", label: "Wait time", kind: "objective", volatility: "high" },
  { key: "line_length", label: "Line length", kind: "objective", volatility: "high" },
  { key: "noise_level", label: "Noise level", kind: "objective", volatility: "high" },
  { key: "equipment_availability", label: "Equipment availability", kind: "objective", volatility: "high" },
  { key: "parking_availability", label: "Parking availability", kind: "objective", volatility: "high" },
  { key: "food_availability", label: "Food availability", kind: "objective", volatility: "medium" },
  { key: "open_status", label: "Open status", kind: "objective", volatility: "low" },
  { key: "event_status", label: "Event status", kind: "objective", volatility: "medium" },
  { key: "cleanliness", label: "Cleanliness", kind: "objective", volatility: "medium" },
  { key: "temperature", label: "Temperature", kind: "objective", volatility: "medium" },
  { key: "atmosphere", label: "Atmosphere", kind: "subjective", volatility: "medium" },
  { key: "worth_it", label: "Worth it", kind: "subjective", volatility: "medium" },
];

export const TTL_BOUNDS: Record<Volatility, { min: number; max: number; default: number }> = {
  high: { min: 300, max: 1800, default: 900 },
  medium: { min: 1800, max: 14400, default: 5400 },
  low: { min: 14400, max: 172800, default: 43200 },
};

export function getDimension(key: string): DimensionDef | undefined {
  return DIMENSIONS.find((d) => d.key === key);
}

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Returns the canonical key for a vocabulary key or `other:<slug>`;
 * null if the key is not allowed.
 */
export function normalizeDimensionKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase().startsWith("other:")) {
    const slug = slugify(trimmed.slice("other:".length));
    return slug ? `other:${slug}` : null;
  }
  const slug = slugify(trimmed);
  return getDimension(slug) ? slug : null;
}

/** Clamp a proposed TTL (seconds) into the volatility's bounds; default if missing/invalid. */
export function clampTtl(volatility: Volatility, proposed: number | null | undefined): number {
  const b = TTL_BOUNDS[volatility];
  if (typeof proposed !== "number" || !Number.isFinite(proposed) || proposed <= 0) return b.default;
  return Math.min(b.max, Math.max(b.min, proposed));
}
