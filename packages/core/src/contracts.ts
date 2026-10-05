import { z } from "zod";
import { clampTtl, getDimension, normalizeDimensionKey, type Volatility } from "./dimensions";

// ---------- shared pieces ----------

export const KindSchema = z.enum(["objective", "subjective"]);
export const VolatilitySchema = z.enum(["high", "medium", "low"]);
export const SourceTypeSchema = z.enum(["response", "post", "comment"]);
export const PlannerSchema = z.enum(["llm", "heuristic"]);
export const LevelSchema = z.enum(["High", "Medium", "Low"]);

export const PlaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: z.string(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type Place = z.infer<typeof PlaceSchema>;

/** Evidence passed to /synthesize. */
export const EvidenceItemSchema = z.object({
  id: z.string(),
  dimension: z.string(),
  value_label: z.string(),
  kind: KindSchema,
  source_type: SourceTypeSchema,
  age_s: z.number().nonnegative(),
  verified_nearby: z.boolean(),
  note: z.string().default(""),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

/** Evidence summary passed to /plan (no ids or notes). */
export const RecentEvidenceSchema = EvidenceItemSchema.omit({ id: true, note: true });
export type RecentEvidence = z.infer<typeof RecentEvidenceSchema>;

/** A dimension as sent in requests and returned (after clamping) by /plan. */
export const PlanDimensionSchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  kind: KindSchema,
  volatility: VolatilitySchema,
  proposed_ttl_s: z.number(),
});
export type PlanDimension = z.infer<typeof PlanDimensionSchema>;

const SurveyOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  ordinal: z.number().int(),
});

const SurveyControlSchema = z.object({
  dimension_key: z.string().min(1),
  label: z.string().min(1),
  options: z.array(SurveyOptionSchema).min(1),
});

export const SurveySchema = z.object({
  question: z.string().min(1),
  controls: z.array(SurveyControlSchema).min(1).max(3),
  allow_note: z.boolean().default(true),
});
export type Survey = z.infer<typeof SurveySchema>;

// ---------- requests ----------

export const PlanRequestSchema = z.object({
  query_id: z.string(),
  text: z.string(),
  place: PlaceSchema,
  now_iso: z.string(),
  recent_evidence: z.array(RecentEvidenceSchema),
});
export type PlanRequest = z.infer<typeof PlanRequestSchema>;

export const SynthesizeRequestSchema = z.object({
  query_id: z.string(),
  text: z.string(),
  canonical_intent: z.string(),
  place: PlaceSchema,
  dimensions: z.array(PlanDimensionSchema),
  evidence: z.array(EvidenceItemSchema),
  confidence: z.object({ score: z.number(), level: LevelSchema, ceiling: z.number() }),
  missing_dimensions: z.array(z.string()),
});
export type SynthesizeRequest = z.infer<typeof SynthesizeRequestSchema>;

export const SummarizePostRequestSchema = z.object({
  post_id: z.string(),
  place: PlaceSchema,
  text: z.string(),
  comments: z.array(z.object({ text: z.string(), age_s: z.number().nonnegative() })),
  now_iso: z.string(),
});
export type SummarizePostRequest = z.infer<typeof SummarizePostRequestSchema>;

// ---------- clamping helpers ----------

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function clampRadiusM(v: unknown): number {
  const n = num(v);
  return n === null ? 150 : Math.min(500, Math.max(50, n));
}

export function clampResponderCount(v: unknown): number {
  const n = num(v);
  return n === null ? 2 : Math.min(5, Math.max(1, Math.round(n)));
}

/** Vocabulary keys take their kind and volatility from SPEC §6; `other:` keys keep the agent's. */
function canonicalDimension(
  rawKey: string,
  kind: z.infer<typeof KindSchema>,
  volatility: Volatility,
): { key: string; kind: z.infer<typeof KindSchema>; volatility: Volatility } | null {
  const key = normalizeDimensionKey(rawKey);
  if (key === null) return null;
  const def = getDimension(key);
  return def
    ? { key, kind: def.kind, volatility: def.volatility }
    : { key, kind, volatility };
}

// ---------- /plan response ----------

const RawPlanResponseSchema = z.object({
  canonical_intent: z.string(),
  intent_key: z.string(),
  decision: z.string(),
  dimensions: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      kind: KindSchema,
      volatility: VolatilitySchema,
      proposed_ttl_s: z.unknown().optional(),
    }),
  ),
  needs_clarification: z.boolean(),
  clarification: z.object({ question: z.string(), options: z.array(z.string()) }).nullable(),
  survey: SurveySchema.nullable(),
  responder_radius_m: z.unknown().optional(),
  responder_count: z.unknown().optional(),
  refusal: z.object({ reason: z.string() }).nullable(),
  planner: PlannerSchema,
});

export const PlanResponseSchema = RawPlanResponseSchema.transform((raw, ctx) => {
  const fail = (message: string) => {
    ctx.addIssue({ code: "custom", message, input: raw });
    return z.NEVER;
  };

  const seen = new Set<string>();
  const dimensions: PlanDimension[] = [];
  for (const d of raw.dimensions) {
    const canon = canonicalDimension(d.key, d.kind, d.volatility);
    if (!canon) return fail(`Unknown dimension key: ${d.key}`);
    if (seen.has(canon.key)) return fail(`Duplicate dimension: ${canon.key}`);
    seen.add(canon.key);
    dimensions.push({
      key: canon.key,
      label: d.label,
      kind: canon.kind,
      volatility: canon.volatility,
      proposed_ttl_s: clampTtl(canon.volatility, num(d.proposed_ttl_s)),
    });
  }

  const proceeds = raw.refusal === null && !raw.needs_clarification;
  if (proceeds && dimensions.length === 0) return fail("A plan that proceeds needs at least one dimension");
  if (proceeds && raw.survey === null) return fail("A plan that proceeds needs a survey");

  let survey: Survey | null = null;
  if (raw.survey) {
    const controls = [];
    for (const c of raw.survey.controls) {
      const key = normalizeDimensionKey(c.dimension_key);
      if (key === null || !seen.has(key)) {
        return fail(`Survey control references a dimension not in the plan: ${c.dimension_key}`);
      }
      controls.push({ ...c, dimension_key: key });
    }
    survey = { ...raw.survey, controls };
  }

  return {
    canonical_intent: raw.canonical_intent,
    intent_key: raw.intent_key,
    decision: raw.decision,
    dimensions,
    needs_clarification: raw.needs_clarification,
    clarification: raw.clarification,
    survey,
    responder_radius_m: clampRadiusM(raw.responder_radius_m),
    responder_count: clampResponderCount(raw.responder_count),
    refusal: raw.refusal,
    planner: raw.planner,
  };
});
export type PlanResponse = z.output<typeof PlanResponseSchema>;

// ---------- /synthesize response ----------

export const SynthesizeResponseSchema = z.object({
  headline: z.string(),
  recommendation: z.enum(["go", "maybe", "avoid", "insufficient"]),
  summary: z.string(),
  supporting: z.array(z.string()).default([]),
  caveats: z.array(z.string()).default([]),
  planner: PlannerSchema,
});
export type SynthesizeResponse = z.infer<typeof SynthesizeResponseSchema>;

// ---------- /summarize_post response ----------

const RawClaimSchema = z.object({
  dimension: z.string(),
  value_label: z.string(),
  kind: KindSchema,
  volatility: VolatilitySchema,
  proposed_ttl_s: z.unknown().optional(),
  ordinal: z.number().int().nullable(),
});

export const SummarizePostResponseSchema = z
  .object({
    summary: z.string(),
    claims: z.array(RawClaimSchema),
    planner: PlannerSchema,
  })
  .transform((raw, ctx) => {
    const claims = [];
    for (const c of raw.claims) {
      const canon = canonicalDimension(c.dimension, c.kind, c.volatility);
      if (!canon) {
        ctx.addIssue({ code: "custom", message: `Unknown dimension key: ${c.dimension}`, input: raw });
        return z.NEVER;
      }
      claims.push({
        dimension: canon.key,
        value_label: c.value_label,
        kind: canon.kind,
        volatility: canon.volatility,
        proposed_ttl_s: clampTtl(canon.volatility, num(c.proposed_ttl_s)),
        ordinal: c.ordinal,
      });
    }
    return { summary: raw.summary, claims, planner: raw.planner };
  });
export type SummarizePostResponse = z.output<typeof SummarizePostResponseSchema>;

// ---------- parse helpers (validate + clamp; throw ZodError on invalid) ----------

export const parsePlanResponse = (raw: unknown): PlanResponse => PlanResponseSchema.parse(raw);
export const parseSynthesizeResponse = (raw: unknown): SynthesizeResponse =>
  SynthesizeResponseSchema.parse(raw);
export const parseSummarizePostResponse = (raw: unknown): SummarizePostResponse =>
  SummarizePostResponseSchema.parse(raw);
