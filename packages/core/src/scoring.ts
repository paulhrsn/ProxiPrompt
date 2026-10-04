import type { DimensionKind } from "./dimensions";

export type SourceType = "response" | "post" | "comment" | "social";
export type ConfidenceLevel = "High" | "Medium" | "Low";

export interface ScoringObservation {
  id: string;
  dimension: string;
  value: string;
  valueLabel: string;
  ordinal: number | null;
  kind: DimensionKind;
  sourceType: SourceType;
  verifiedNearby: boolean;
  contributorId: string;
  observedAtMs: number;
  expiresAtMs: number;
  invalidated: boolean;
  /** 0.5–1.2, default 1.0 (P1). */
  reliability?: number;
}

export interface RequiredDimension {
  key: string;
  kind: DimensionKind;
}

export interface ScoreInput {
  observations: ScoringObservation[];
  required: RequiredDimension[];
  nowMs: number;
  /** Defaults to 0.6 (SPEC §8). */
  sufficientScore?: number;
}

export interface DimensionScore {
  key: string;
  support: number;
  agreement: number;
  conf: number;
  modalValue: string | null;
  modalLabel: string | null;
  /** Usable (non-zero weight) observations. */
  count: number;
  /**
   * Support from firsthand observations only (everything except `social`).
   * Sufficiency gates on this so scraped posts can inform an answer but never
   * carry one on their own (SPEC §1.1: never answer without fresh evidence).
   */
  firsthandSupport: number;
}

export interface ObservationFactor {
  id: string;
  dimension: string;
  freshness: number;
  sourceWeight: number;
  reliability: number;
  weight: number;
  contradicted: boolean;
}

export type ConflictSeverity = "moderate" | "severe";

/** Fresh firsthand reports on one dimension that materially disagree. */
export interface DimensionConflict {
  dimension: string;
  severity: ConflictSeverity;
  /** Distinct value labels involved, ordered low to high when ordinals exist. */
  labels: string[];
}

export interface ScoreResult {
  /** Final score: rawScore capped by ceiling. */
  score: number;
  rawScore: number;
  ceiling: number;
  level: ConfidenceLevel;
  sufficient: boolean;
  dimensions: DimensionScore[];
  missingDimensions: string[];
  /** Dimensions whose fresh firsthand reports disagree; each one caps `level`. */
  conflicts: DimensionConflict[];
  /**
   * Distinct contributor ids among usable FIRSTHAND observations on required
   * dimensions (social excluded). This is the number shown as "N nearby reports".
   */
  contributors: number;
  /** For the diagnostics drawer. */
  factors: {
    observations: ObservationFactor[];
    contributorIds: string[];
    sufficientScore: number;
    objectiveSupportMin: number;
  };
}

export const SOURCE_WEIGHTS = {
  responseVerified: 1.0,
  responseUnverified: 0.7,
  postVerified: 0.8,
  postUnverified: 0.55,
  comment: 0.5,
  social: 0.35,
} as const;

const KIND_WEIGHT: Record<DimensionKind, number> = { objective: 1.0, subjective: 0.5 };
const OBJECTIVE_SUPPORT_MIN = 0.5;
const DEFAULT_SUFFICIENT_SCORE = 0.6;
/** Score caps (just under the level boundaries) applied when reports disagree. */
const CONFLICT_CAP: Record<ConflictSeverity, number> = { moderate: 0.69, severe: 0.44 };
/** The dissenting side must carry at least this share of the weight to count. */
const CONFLICT_MIN_SHARE = 0.2;

export function sourceWeight(sourceType: SourceType, verifiedNearby: boolean): number {
  switch (sourceType) {
    case "response":
      return verifiedNearby ? SOURCE_WEIGHTS.responseVerified : SOURCE_WEIGHTS.responseUnverified;
    case "post":
      return verifiedNearby ? SOURCE_WEIGHTS.postVerified : SOURCE_WEIGHTS.postUnverified;
    case "comment":
      return SOURCE_WEIGHTS.comment;
    case "social":
      return SOURCE_WEIGHTS.social;
  }
}

/** freshness = clamp(1 − (age/ttl)², 0, 1); 0 if expired or invalidated. */
export function freshness(
  observedAtMs: number,
  expiresAtMs: number,
  nowMs: number,
  invalidated: boolean,
): number {
  if (invalidated || nowMs >= expiresAtMs) return 0;
  const ttl = expiresAtMs - observedAtMs;
  if (ttl <= 0) return 0;
  const age = Math.max(0, nowMs - observedAtMs);
  return Math.min(1, Math.max(0, 1 - (age / ttl) ** 2));
}

/** Evidence ceiling by number of independent contributors. */
export function ceilingFor(contributors: number): number {
  if (contributors <= 0) return 0;
  if (contributors === 1) return 0.6;
  if (contributors === 2) return 0.8;
  return 0.95;
}

export function levelFor(score: number): ConfidenceLevel {
  if (score >= 0.7) return "High";
  if (score >= 0.45) return "Medium";
  return "Low";
}

/**
 * Sufficient when score ≥ threshold and every objective required dimension has
 * firsthand support ≥ 0.5. Social evidence counts toward the score but not
 * toward this gate, so a place with only scraped posts still prompts people.
 */
export function isSufficient(
  score: number,
  dimensions: { key: string; firsthandSupport: number }[],
  required: RequiredDimension[],
  sufficientScore = DEFAULT_SUFFICIENT_SCORE,
): boolean {
  if (score < sufficientScore) return false;
  return required
    .filter((r) => r.kind === "objective")
    .every(
      (r) => (dimensions.find((d) => d.key === r.key)?.firsthandSupport ?? 0) >= OBJECTIVE_SUPPORT_MIN,
    );
}

interface Weighted {
  obs: ScoringObservation;
  factor: ObservationFactor;
}

/** Weight every observation on `dimension`, applying the contradiction rule. */
function weighDimension(
  observations: ScoringObservation[],
  nowMs: number,
): Weighted[] {
  const items: Weighted[] = observations.map((obs) => {
    const fresh = freshness(obs.observedAtMs, obs.expiresAtMs, nowMs, obs.invalidated);
    const reliability = Math.min(1.2, Math.max(0.5, obs.reliability ?? 1));
    return {
      obs,
      factor: {
        id: obs.id,
        dimension: obs.dimension,
        freshness: fresh,
        sourceWeight: sourceWeight(obs.sourceType, obs.verifiedNearby),
        reliability,
        weight: 0,
        contradicted: false,
      },
    };
  });

  // Contradiction: a newer live observation ≥2 ordinal steps away halves older freshness.
  for (const older of items) {
    if (older.factor.freshness === 0 || older.obs.ordinal === null) continue;
    const contradicted = items.some(
      (n) =>
        n.factor.freshness > 0 &&
        n.obs.ordinal !== null &&
        n.obs.observedAtMs > older.obs.observedAtMs &&
        Math.abs(n.obs.ordinal - older.obs.ordinal!) >= 2,
    );
    if (contradicted) {
      older.factor.contradicted = true;
      older.factor.freshness /= 2;
    }
  }

  for (const it of items) {
    const f = it.factor;
    f.weight = Math.min(1, f.freshness * f.sourceWeight * f.reliability);
  }
  return items;
}

/**
 * Fresh firsthand reports disagree when their ordinals span 2+ steps (3+ is severe), or, with no
 * ordinals, when distinct values each carry real weight. A lone sliver of dissent is ignored.
 */
function detectConflict(key: string, items: Weighted[]): DimensionConflict | null {
  const live = items.filter((i) => i.factor.weight > 0 && i.obs.sourceType !== "social");
  if (live.length < 2) return null;
  const total = live.reduce((t, i) => t + i.factor.weight, 0);
  const ordinal = live.filter((i) => i.obs.ordinal !== null);
  const labelsOf = (xs: Weighted[]) => {
    const seen = new Map<string, number>();
    for (const i of xs) if (!seen.has(i.obs.valueLabel)) seen.set(i.obs.valueLabel, i.obs.ordinal ?? 0);
    return [...seen.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([l]) => l);
  };
  if (ordinal.length === live.length) {
    const ords = ordinal.map((i) => i.obs.ordinal!);
    const lo = Math.min(...ords);
    const hi = Math.max(...ords);
    const spread = hi - lo;
    if (spread < 2) return null;
    const mid = (lo + hi) / 2;
    const below = live.filter((i) => i.obs.ordinal! < mid).reduce((t, i) => t + i.factor.weight, 0);
    const above = live.filter((i) => i.obs.ordinal! > mid).reduce((t, i) => t + i.factor.weight, 0);
    if (Math.min(below, above) / total < CONFLICT_MIN_SHARE) return null;
    return { dimension: key, severity: spread >= 3 ? "severe" : "moderate", labels: labelsOf(live) };
  }
  const byValue = new Map<string, number>();
  for (const i of live) byValue.set(i.obs.value, (byValue.get(i.obs.value) ?? 0) + i.factor.weight);
  if (byValue.size < 2) return null;
  if (1 - Math.max(...byValue.values()) / total < CONFLICT_MIN_SHARE) return null;
  return { dimension: key, severity: "moderate", labels: labelsOf(live) };
}

function scoreDimension(key: string, items: Weighted[]): DimensionScore {
  const usable = items.filter((i) => i.factor.weight > 0);
  if (usable.length === 0) {
    return { key, support: 0, agreement: 0, conf: 0, modalValue: null, modalLabel: null, count: 0, firsthandSupport: 0 };
  }

  const support = 1 - usable.reduce((p, i) => p * (1 - i.factor.weight), 1);
  const firsthandSupport =
    1 -
    usable
      .filter((i) => i.obs.sourceType !== "social")
      .reduce((p, i) => p * (1 - i.factor.weight), 1);

  // Modal value = highest total weight; ties go to the most recently observed.
  const groups = new Map<string, { weight: number; newest: Weighted }>();
  for (const i of usable) {
    const g = groups.get(i.obs.value);
    if (!g) groups.set(i.obs.value, { weight: i.factor.weight, newest: i });
    else {
      g.weight += i.factor.weight;
      if (i.obs.observedAtMs > g.newest.obs.observedAtMs) g.newest = i;
    }
  }
  let modal = [...groups.values()][0]!;
  for (const g of groups.values()) {
    if (
      g.weight > modal.weight ||
      (g.weight === modal.weight && g.newest.obs.observedAtMs > modal.newest.obs.observedAtMs)
    ) {
      modal = g;
    }
  }

  const modalOrdinal = modal.newest.obs.ordinal;
  let agreeing = 0;
  let total = 0;
  for (const i of usable) {
    total += i.factor.weight;
    if (i.obs.value === modal.newest.obs.value) agreeing += i.factor.weight;
    else if (
      modalOrdinal !== null &&
      i.obs.ordinal !== null &&
      Math.abs(i.obs.ordinal - modalOrdinal) === 1
    ) {
      agreeing += 0.5 * i.factor.weight;
    }
  }
  const agreement = total > 0 ? agreeing / total : 0;

  return {
    key,
    support,
    agreement,
    conf: support * agreement,
    modalValue: modal.newest.obs.value,
    modalLabel: modal.newest.obs.valueLabel,
    count: usable.length,
    firsthandSupport,
  };
}

/** Deterministic evidence scoring, SPEC §8. */
export function scoreEvidence(input: ScoreInput): ScoreResult {
  const { observations, required, nowMs } = input;
  const sufficientScore = input.sufficientScore ?? DEFAULT_SUFFICIENT_SCORE;

  const allFactors: ObservationFactor[] = [];
  const dimensions: DimensionScore[] = [];
  const conflicts: DimensionConflict[] = [];
  const contributorIds = new Set<string>();

  for (const req of required) {
    const items = weighDimension(
      observations.filter((o) => o.dimension === req.key),
      nowMs,
    );
    allFactors.push(...items.map((i) => i.factor));
    // Social posts have no identified contributor, so counting them would inflate both the
    // ceiling and the "N nearby reports" shown to the requester. Firsthand sources only.
    for (const i of items) {
      if (i.factor.weight > 0 && i.obs.sourceType !== "social") contributorIds.add(i.obs.contributorId);
    }
    dimensions.push(scoreDimension(req.key, items));
    const conflict = detectConflict(req.key, items);
    if (conflict) conflicts.push(conflict);
  }

  let weightedSum = 0;
  let weightTotal = 0;
  for (const req of required) {
    const w = KIND_WEIGHT[req.kind];
    weightedSum += w * dimensions.find((d) => d.key === req.key)!.conf;
    weightTotal += w;
  }
  const rawScore = weightTotal > 0 ? weightedSum / weightTotal : 0;
  const ceiling = ceilingFor(contributorIds.size);
  const conflictCap = conflicts.length
    ? Math.min(...conflicts.map((c) => CONFLICT_CAP[c.severity]))
    : 1;
  const score = Math.min(rawScore, ceiling, conflictCap);

  return {
    score,
    rawScore,
    ceiling,
    level: levelFor(score),
    sufficient: isSufficient(score, dimensions, required, sufficientScore),
    dimensions,
    missingDimensions: dimensions.filter((d) => d.count === 0).map((d) => d.key),
    conflicts,
    contributors: contributorIds.size,
    factors: {
      observations: allFactors,
      contributorIds: [...contributorIds],
      sufficientScore,
      objectiveSupportMin: OBJECTIVE_SUPPORT_MIN,
    },
  };
}
