/** A standing condition. Met when the modal report's value is one of `metValues`. */
export interface WatchTarget {
  dimension: string;
  /** Short line for the notification, such as "Seats opened up". */
  phrase: string;
  /** Survey option values that count as the condition being true. */
  metValues: string[];
}

export interface WatchControl {
  dimension_key: string;
  options: { value: string; label: string }[];
}

export interface WatchObservation {
  dimension: string;
  value: string;
  valueLabel: string;
  observedAtMs: number;
  expiresAtMs: number;
  invalidated: boolean;
  sourceType: string;
}

export interface WatchReading {
  met: boolean;
  valueLabel: string | null;
  contributors: number;
  ageS: number;
}

const DEFAULT_MET: Record<string, string[]> = {
  seating_availability: ["some", "plenty"],
  noise_level: ["quiet", "very_quiet"],
};

/** True when a survey label (or a later report's label) describes the condition being met. */
export function labelLooksMet(dimension: string, label: string): boolean {
  const text = label.toLowerCase();
  if (dimension === "seating_availability") {
    return /plenty|some|many|several|available|\bopen\b/.test(text) && !/\bnone\b|\bno\b|\bfew\b|taken|full/.test(text);
  }
  if (dimension === "noise_level") {
    return /quiet|silent|peaceful/.test(text) && !/loud|noisy/.test(text);
  }
  return false;
}

function favorableValues(dimension: string, controls: WatchControl[]): string[] | null {
  const control = controls.find((c) => c.dimension_key === dimension);
  if (!control) return null;
  const good = control.options.filter((o) => labelLooksMet(dimension, `${o.label} ${o.value}`));
  return good.length ? good.map((o) => o.value) : null;
}

/**
 * What a "tell me when..." sentence is waiting on. Survey option labels win over a fixed
 * ordinal, because a model may number "many seats" as 0 and "none" as 3.
 */
export function inferWatchTarget(
  text: string,
  dimensionKeys: string[] = [],
  controls: WatchControl[] = [],
): WatchTarget | null {
  const t = (text || "").toLowerCase();
  let dimension: string | null = null;
  let phrase = "Update";
  if (/\bseats?\b|\btables?\b|\bopen\b/.test(t)) {
    dimension = "seating_availability";
    phrase = "Seats opened up";
  } else if (/\bquiet|\bloud|\bnois/.test(t)) {
    dimension = "noise_level";
    phrase = "It got quiet";
  } else {
    dimension = dimensionKeys.find((k) => k !== "worth_it" && !k.startsWith("other:")) ?? dimensionKeys[0] ?? null;
  }
  if (!dimension) return null;
  const fromSurvey = favorableValues(dimension, controls);
  const metValues = fromSurvey ?? DEFAULT_MET[dimension] ?? [];
  if (metValues.length === 0) return null;
  return { dimension, phrase, metValues };
}

/** Modal firsthand reading for one dimension. */
export function watchReading(observations: WatchObservation[], target: WatchTarget, nowMs: number): WatchReading {
  const wanted = new Set(target.metValues);
  const live = observations.filter(
    (o) =>
      o.dimension === target.dimension &&
      !o.invalidated &&
      o.expiresAtMs > nowMs,
  );
  if (live.length === 0) {
    return { met: false, valueLabel: null, contributors: 0, ageS: 0 };
  }
  const groups = new Map<string, { n: number; newest: WatchObservation }>();
  for (const o of live) {
    const g = groups.get(o.value);
    if (!g) groups.set(o.value, { n: 1, newest: o });
    else {
      g.n += 1;
      if (o.observedAtMs > g.newest.observedAtMs) g.newest = o;
    }
  }
  let modal = [...groups.values()][0]!;
  for (const g of groups.values()) {
    if (g.n > modal.n || (g.n === modal.n && g.newest.observedAtMs > modal.newest.observedAtMs)) modal = g;
  }
  const newest = Math.max(...live.map((o) => o.observedAtMs));
  const reading = modal.newest;
  return {
    // The watch is armed from its own plan, and the reports come from the question's plan.
    // Those two surveys often use different option ids for the same label ("many_open" vs "many_seats").
    met: wanted.has(reading.value) || labelLooksMet(target.dimension, `${reading.valueLabel} ${reading.value}`),
    valueLabel: reading.valueLabel,
    contributors: live.length,
    ageS: Math.max(0, (nowMs - newest) / 1000),
  };
}
