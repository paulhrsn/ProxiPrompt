import {
  findAttachableJob,
  freshnessNote,
  getConfig,
  getDimension,
  hasAmbiguousNeighbor,
  haversineM,
  nearestCatalogPlace,
  scoreEvidence,
  inferWatchTarget,
  watchReading,
  nextWaveCount,
  placePart,
  reciprocityCredit,
  selectResponders,
  type PlanResponse,
  type ScoringObservation,
  type Survey,
} from "@proxiprompt/core";
import { Identity } from "spacetimedb";
import type { DbConnection } from "../../../spacetimedb/bindings/index.js";
import { callPlan, callSummarize, callSynthesize } from "./agent.js";
import { pushEnabled, sendPush } from "./push.js";
import { hexOf, nowMs, parseJson, toMicros, toMs } from "./util.js";

type Conn = DbConnection;

const processedQueries = new Set<string>();
const processedResponses = new Set<string>();
const processedPosts = new Set<string>();
const jobLastWaveAt = new Map<string, number>();
const jobHandledPasses = new Map<string, Set<string>>();
const handledReactions = new Set<string>();
const lastEmptyWaveAt = new Map<string, number>();
const lastImpactPush = new Map<string, number>();
/** Last "Received k of N" message per query, so a 2s tick cannot repeat it. */
const lastReceivedEvent = new Map<string, string>();
/** Evidence signature behind each finished answer, so late updates fire once per change. */
const answeredSignature = new Map<string, string>();
const processedWatches = new Set<string>();
/** Queries already told about their reciprocal-priority boost. */
const boostAnnounced = new Set<string>();

/** Clears all in-memory tick state. Tests call this between cases. */
export function resetLoopState(): void {
  processedQueries.clear();
  processedResponses.clear();
  processedPosts.clear();
  jobLastWaveAt.clear();
  jobHandledPasses.clear();
  handledReactions.clear();
  lastEmptyWaveAt.clear();
  lastImpactPush.clear();
  lastReceivedEvent.clear();
  answeredSignature.clear();
  processedWatches.clear();
  boostAnnounced.clear();
}

function rows<T>(iter: Iterable<T> | undefined): T[] {
  return iter ? [...iter] : [];
}

function placeOf(conn: Conn, id: string) {
  return rows(conn.db.place.iter()).find((p) => p.id === id);
}

function sourceIsVisible(conn: Conn, sourceType: string, sourceId: string): boolean {
  if (sourceType === "post" && sourceId.startsWith("post:")) {
    const post = rows(conn.db.svcPost.iter()).find(p => String(p.id) === sourceId.slice(5));
    return !!post && !post.deleted && !post.hidden;
  }
  if (sourceType === "comment" && sourceId.startsWith("comment:")) {
    const comment = rows(conn.db.svcComment.iter()).find(c => String(c.id) === sourceId.slice(8));
    if (!comment || comment.deleted || comment.hidden) return false;
    const post = rows(conn.db.svcPost.iter()).find(p => p.id === comment.postId);
    return !!post && !post.deleted && !post.hidden;
  }
  return true;
}

function publicFactors(score: ReturnType<typeof scoreEvidence>) {
  const { contributorIds: _privateIds, ...safe } = score.factors;
  return safe;
}

function queryPlan(q: { planJson?: string }, fallback: PlanResponse): PlanResponse {
  return parseJson<PlanResponse | null>(q.planJson, null) ?? fallback;
}

function mergeJobPlans(a: PlanResponse, b: PlanResponse, placeName: string): PlanResponse {
  const dimensions = [...new Map([...a.dimensions, ...b.dimensions].map(d => [d.key, d])).values()];
  const controls = [...new Map([...(a.survey?.controls ?? []), ...(b.survey?.controls ?? [])]
    .map(c => [c.dimension_key, c])).values()];
  return { ...a, dimensions, survey: { allow_note: true, controls,
    question: dimensions.every(d => d.key.startsWith("other:")) ? (a.survey?.question ?? b.survey!.question)
      : `Quick question about ${placeName}: what are ${dimensions.map(d => d.label.toLowerCase()).join(" and ")} like right now?`,
  } };
}

function scoringObs(conn: Conn, placeId: string, now: number): ScoringObservation[] {
  return rows(conn.db.svcObservation.iter())
    .filter((o) => o.placeId === placeId && sourceIsVisible(conn, o.sourceType, o.sourceId))
    .map((o) => ({
      id: String(o.id),
      dimension: o.dimension,
      value: o.value,
      valueLabel: o.valueLabel,
      ordinal: o.ordinal ?? null,
      kind: o.kind as ScoringObservation["kind"],
      sourceType: o.sourceType as ScoringObservation["sourceType"],
      verifiedNearby: o.verifiedNearby,
      contributorId: hexOf(o.contributor) || `anon:${o.id}`,
      observedAtMs: toMs(o.observedAt),
      expiresAtMs: toMs(o.expiresAt),
      invalidated: o.invalidated,
    }))
    .filter((o) => o.expiresAtMs > now && !o.invalidated);
}

async function event(conn: Conn, queryId: bigint, kind: string, message: string) {
  await conn.reducers.workerAddQueryEvent({ queryId, kind, message });
}

/** SPEC §10: a post/comment is verified-nearby when its author's location is fresh and within 150 m. */
const POST_VERIFY_RADIUS_M = 150;

/** "Can you actually see this?" control. Its answers are never stored as evidence. */
const PRESENCE_KEY = "other:place_part";
/** worker_create_prompt_batch accepts 1-3 controls and rejects the batch otherwise. */
const MAX_PROMPT_CONTROLS = 3;

function isVerifiedNearby(
  loc:
    | {
        lat: number;
        lng: number;
        claimedPlaceId?: string | undefined;
        capturedAt: { microsSinceUnixEpoch: bigint };
      }
    | undefined,
  place: { id: string; lat: number; lng: number },
  cfg: ReturnType<typeof getConfig>,
  now: number,
): boolean {
  if (!loc) return false;
  if (now - toMs(loc.capturedAt) > cfg.LOCATION_MAX_AGE_S * 1000) return false;
  // Someone who said they are in another building is not nearby this one, whatever the
  // coordinates say; a claim on this place vouches for them even if GPS is off by 80 m.
  if (loc.claimedPlaceId && loc.claimedPlaceId !== place.id) return false;
  if (loc.claimedPlaceId === place.id) return true;
  return haversineM(loc.lat, loc.lng, place.lat, place.lng) < POST_VERIFY_RADIUS_M;
}

export async function tick(conn: Conn): Promise<void> {
  const demo = ["1", "true", "yes", "on"].includes((process.env.DEMO_MODE ?? "1").toLowerCase());
  const cfg = getConfig(demo);
  // Env switch for the experiment; anything but an explicit off keeps the config default.
  if (["0", "false", "no", "off"].includes((process.env.RECIPROCAL_PRIORITY ?? "").toLowerCase())) {
    cfg.RECIPROCAL_PRIORITY = false;
  }
  const now = nowMs();

  const stages: [string, () => Promise<void>][] = [
    ["invalidateRemovedContributions", () => invalidateRemovedContributions(conn)],
    ["ingestResponses", () => ingestResponses(conn, cfg, now)],
    ["summarizePendingPosts", () => summarizePendingPosts(conn, cfg, now)],
    ["processPlanningQueries", () => processPlanningQueries(conn, cfg, now)],
    ["advanceCollectingJobs", () => advanceCollectingJobs(conn, cfg, now)],
    ["updateLateAnswers", () => updateLateAnswers(conn, cfg, now)],
    ["evaluateWatches", () => evaluateWatches(conn, now)],
    ["deliverAnswerNotifications", () => deliverAnswerNotifications(conn, now)],
  ];
  for (const [name, run] of stages) {
    const t0 = Date.now();
    await run();
    const ms = Date.now() - t0;
    if (ms > 2000) console.log(`slow tick stage ${name}: ${ms} ms`);
  }
}

async function ingestResponses(conn: Conn, cfg: ReturnType<typeof getConfig>, now: number) {
  for (const r of rows(conn.db.svcPromptResponse.iter())) {
    const key = String(r.id);
    if (processedResponses.has(key)) continue;
    const batch = rows(conn.db.svcPromptBatch.iter()).find((b) => b.id === r.batchId);
    if (!batch) continue;
    const answers = parseJson<Record<string, string>>(r.answersJson, {});
    const controls = parseJson<Survey["controls"]>(batch.controlsJson, []);
    const job = rows(conn.db.svcEvidenceJob.iter()).find((j) => j.id === batch.jobId);
    const plan = job ? parseJson<PlanResponse>(job.planJson, null as unknown as PlanResponse) : null;
    if (Object.values(answers).includes("not_here")) {
      processedResponses.add(key);
      continue;
    }
    for (const [dim, value] of Object.entries(answers)) {
      if (dim === PRESENCE_KEY || value === "not_here") continue;
      const control = controls.find((c) => c.dimension_key === dim);
      const opt = control?.options.find((o) => o.value === value);
      const dimDef = getDimension(dim);
      const ttl = plan?.dimensions.find((d) => d.key === dim)?.proposed_ttl_s ?? 900;
      await conn.reducers.workerAddObservation({
        placeId: batch.placeId,
        dimension: dim,
        value,
        valueLabel: opt?.label ?? value,
        ordinal: opt?.ordinal ?? undefined,
        kind: dimDef?.kind ?? "objective",
        sourceType: "response",
        sourceId: `response:${r.id}`,
        contributor: r.responder,
        verifiedNearby: true,
        observedAtMicros: r.createdAt.microsSinceUnixEpoch,
        expiresAtMicros: toMicros(toMs(r.createdAt) + ttl * 1000),
      });
    }
    processedResponses.add(key);
    void cfg;
    void now;
  }
}

/**
 * Reciprocal priority credit for one user (SPEC §7): real answers in the last 24 hours,
 * capped at 5. Zero when the experiment is off. Only ever used to order and size the
 * requester's own work, never exposed to anyone else.
 */
function creditOf(conn: Conn, userHex: string, cfg: ReturnType<typeof getConfig>, now: number): number {
  if (!cfg.RECIPROCAL_PRIORITY) return 0;
  const mine = rows(conn.db.svcPromptResponse.iter())
    .filter((r) => hexOf(r.responder) === userHex)
    .map((r) => ({
      createdAtMs: toMs(r.createdAt),
      pass: Object.values(parseJson<Record<string, string>>(r.answersJson, {})).includes("not_here"),
    }));
  return reciprocityCredit(mine, now);
}

function passResponseIds(conn: Conn, jobId: bigint): string[] {
  const batchIds = new Set(rows(conn.db.svcPromptBatch.iter()).filter((b) => b.jobId === jobId).map((b) => b.id));
  const ids: string[] = [];
  for (const r of rows(conn.db.svcPromptResponse.iter())) {
    if (!batchIds.has(r.batchId)) continue;
    const answers = parseJson<Record<string, string>>(r.answersJson, {});
    if (Object.values(answers).includes("not_here")) ids.push(String(r.id));
  }
  return ids;
}

async function applyPostReactions(
  conn: Conn,
  post: { id: bigint; placeId: string },
  place: { id: string; lat: number; lng: number },
  claims: { dimension: string; value_label: string; kind: string; proposed_ttl_s: number; ordinal: number | null }[],
  cfg: ReturnType<typeof getConfig>,
  now: number,
) {
  const comments = rows(conn.db.svcComment.iter()).filter((c) => c.postId === post.id && !c.deleted && !c.hidden);
  for (const c of comments) {
    const key = `react:${c.id}`;
    if (handledReactions.has(key)) continue;
    const text = c.text.trim().toLowerCase();
    if (text !== "still true" && text !== "this changed") continue;
    if (text === "this changed") {
      const commentIds = new Set(comments.map((row) => `comment:${row.id}`));
      for (const o of rows(conn.db.svcObservation.iter())) {
        if (o.invalidated) continue;
        if (o.sourceId === `post:${post.id}` || commentIds.has(o.sourceId)) {
          await conn.reducers.workerInvalidateObservation({ observationId: o.id });
        }
      }
    } else {
      const loc = rows(conn.db.svcUserLocation.iter()).find((l) => l.identity.isEqual(c.author));
      const verified = isVerifiedNearby(loc, place, cfg, now);
      for (const claim of claims) {
        const ttl = claim.proposed_ttl_s || 900;
        await conn.reducers.workerAddObservation({
          placeId: post.placeId,
          dimension: claim.dimension,
          value: claim.value_label.toLowerCase().replace(/\s+/g, "_"),
          valueLabel: claim.value_label,
          ordinal: claim.ordinal ?? undefined,
          kind: claim.kind,
          sourceType: "comment",
          sourceId: `comment:${c.id}`,
          contributor: c.author,
          verifiedNearby: verified,
          observedAtMicros: c.createdAt.microsSinceUnixEpoch,
          expiresAtMicros: toMicros(toMs(c.createdAt) + ttl * 1000),
        });
      }
    }
    handledReactions.add(key);
  }
}

// Also repairs evidence created before transactional deletion invalidation was installed.
async function invalidateRemovedContributions(conn: Conn) {
  for (const observation of rows(conn.db.svcObservation.iter())) {
    if (!observation.invalidated && !sourceIsVisible(conn, observation.sourceType, observation.sourceId)) {
      await conn.reducers.workerInvalidateObservation({ observationId: observation.id });
    }
  }
}

async function summarizePendingPosts(conn: Conn, cfg: ReturnType<typeof getConfig>, now: number) {
  for (const p of rows(conn.db.svcPost.iter())) {
    if (p.deleted || p.hidden) continue;
    const key = `${p.id}:${p.commentCount}:${p.text}`;
    if (processedPosts.has(key) && p.freshnessState !== "pending") continue;
    const place = placeOf(conn, p.placeId);
    if (!place) continue;
    const comments = rows(conn.db.svcComment.iter())
      .filter((c) => c.postId === p.id && !c.deleted && !c.hidden && c.text)
      .map((c) => ({ text: c.text, age_s: (now - toMs(c.createdAt)) / 1000, atMs: toMs(c.createdAt) }));
    try {
      const sum = await callSummarize({
        post_id: String(p.id),
        place: { id: place.id, name: place.name, category: place.category, lat: place.lat, lng: place.lng },
        text: p.text,
        comments: comments.map((c) => ({ text: c.text, age_s: c.age_s })),
        now_iso: new Date(now).toISOString(),
      });
      const note = freshnessNote({
        claims: sum.claims.map((c) => ({
          dimension: c.dimension,
          volatility: c.volatility,
          ttlS: c.proposed_ttl_s,
          observedAtMs: toMs(p.createdAt),
          ordinal: c.ordinal,
        })),
        comments: comments.map((c) => ({ atMs: c.atMs })),
        nowMs: now,
      });
      await conn.reducers.workerSetPostSummary({
        postId: p.id,
        summary: sum.summary,
        claimsJson: JSON.stringify(sum.claims),
        freshnessState: note.state,
        freshnessNote: note.note,
      });
      const loc = rows(conn.db.svcUserLocation.iter()).find((l) => l.identity.isEqual(p.author));
      const verified = isVerifiedNearby(loc, place, cfg, now);
      for (const claim of sum.claims) {
        await conn.reducers.workerAddObservation({
          placeId: p.placeId,
          dimension: claim.dimension,
          value: claim.value_label.toLowerCase().replace(/\s+/g, "_"),
          valueLabel: claim.value_label,
          ordinal: claim.ordinal ?? undefined,
          kind: claim.kind,
          sourceType: "post",
          sourceId: `post:${p.id}`,
          contributor: p.author,
          verifiedNearby: verified,
          observedAtMicros: p.createdAt.microsSinceUnixEpoch,
          expiresAtMicros: toMicros(toMs(p.createdAt) + claim.proposed_ttl_s * 1000),
        });
      }
      await applyPostReactions(conn, p, place, sum.claims, cfg, now);
      processedPosts.add(key);
    } catch (e) {
      console.warn("summarize post failed", p.id, (e as Error).message);
    }
  }
}

/**
 * A presence check uses one of the three survey slots. When the plan has more
 * dimensions than the remaining slots, drop opinions before objective checks so
 * a follow-up about seats or noise can reuse what was just collected.
 */
function fitPlanForPlace(
  plan: PlanResponse,
  place: { id: string; lat: number; lng: number },
): PlanResponse {
  if (!plan.survey || plan.refusal || plan.needs_clarification) return plan;
  const needsPresence = Boolean(placePart(plan.survey.question) || hasAmbiguousNeighbor(place));
  const slots = needsPresence ? MAX_PROMPT_CONTROLS - 1 : MAX_PROMPT_CONTROLS;
  const controls = plan.survey.controls.filter((c) => c.dimension_key !== PRESENCE_KEY);
  if (controls.length <= slots) return plan;
  const kindOf = new Map(plan.dimensions.map((d) => [d.key, d.kind]));
  const objective = controls.filter((c) => kindOf.get(c.dimension_key) !== "subjective");
  const subjective = controls.filter((c) => kindOf.get(c.dimension_key) === "subjective");
  const keptControls = [...objective, ...subjective].slice(0, slots);
  const kept = new Set(keptControls.map((c) => c.dimension_key));
  return {
    ...plan,
    dimensions: plan.dimensions.filter((d) => kept.has(d.key)),
    survey: { ...plan.survey, controls: keptControls },
  };
}

async function processPlanningQueries(conn: Conn, cfg: ReturnType<typeof getConfig>, now: number) {
  // Higher reciprocity credit is planned (and so prompted) first; created order breaks ties.
  const planning = rows(conn.db.svcQuery.iter())
    .filter((q) => q.status === "planning")
    .map((q) => ({ q, credit: creditOf(conn, hexOf(q.requester), cfg, now) }))
    .sort((a, b) => b.credit - a.credit || toMs(a.q.createdAt) - toMs(b.q.createdAt));
  for (const { q, credit } of planning) {
    const lock = String(q.id);
    if (processedQueries.has(lock) && q.planJson) continue;
    const place = placeOf(conn, q.placeId);
    if (!place) continue;
    const existing = scoringObs(conn, q.placeId, now);
    try {
      const plan = fitPlanForPlace(await callPlan({
        query_id: String(q.id),
        text: q.clarificationChoice ? `${q.text} (${q.clarificationChoice})` : q.text,
        place: { id: place.id, name: place.name, category: place.category, lat: place.lat, lng: place.lng },
        now_iso: new Date(now).toISOString(),
        recent_evidence: existing.map((o) => ({
          dimension: o.dimension,
          value_label: o.valueLabel,
          kind: o.kind,
          source_type: o.sourceType,
          age_s: (now - o.observedAtMs) / 1000,
          verified_nearby: o.verifiedNearby,
        })),
      }), place);
      await conn.reducers.workerSetQueryPlan({ queryId: q.id, planJson: JSON.stringify(plan) });

      if (plan.refusal) {
        await conn.reducers.workerSetAnswer({
          queryId: q.id,
          status: "refused",
          answerJson: JSON.stringify({ headline: plan.refusal.reason, recommendation: "insufficient", summary: plan.refusal.reason, supporting: [], caveats: [], planner: plan.planner }),
        });
        processedQueries.add(lock);
        continue;
      }
      if (plan.needs_clarification && plan.clarification) {
        await conn.reducers.workerSetClarification({ queryId: q.id, clarificationJson: JSON.stringify(plan.clarification) });
        processedQueries.add(lock);
        continue;
      }

      const jobs = rows(conn.db.svcEvidenceJob.iter()).map((j) => ({
        id: String(j.id),
        placeId: j.placeId,
        dimensionKeys: parseJson<string[]>(j.dimensionKeysJson, []),
        status: j.status,
        deadlineAtMs: toMs(j.deadlineAt),
        createdAtMs: toMs(j.createdAt),
        raw: j,
      }));
      const attach = findAttachableJob(jobs, q.placeId, plan.dimensions.map((d) => d.key), now);
      let jobId: bigint;
      if (attach) {
        jobId = BigInt(attach.id);
        const merged = mergeJobPlans(parseJson<PlanResponse>(jobs.find(j => j.id === attach.id)!.raw.planJson, plan), plan, place.name);
        await conn.reducers.workerMergeJobPlan({ jobId, planJson: JSON.stringify(merged),
          dimensionKeysJson: JSON.stringify(merged.dimensions.map(d => d.key)) });
        await conn.reducers.workerAttachQuery({ queryId: q.id, jobId });
        await event(conn, q.id, "collecting", "Joining an in-progress check for this place");
      } else {
        // Stable per query: worker_create_job dedupes on client_key, so a retry after a
        // crash or a mid-sequence throw is a no-op instead of a second job at this place.
        // The reducer requires at least 8 characters, so single-digit ids need the prefix.
        const clientKey = `job-query-${q.id}`;
        await conn.reducers.workerCreateJob({
          clientKey,
          placeId: q.placeId,
          intentKey: plan.intent_key,
          dimensionKeysJson: JSON.stringify(plan.dimensions.map((d) => d.key)),
          planJson: JSON.stringify(plan),
          deadlineAtMicros: toMicros(nowMs() + cfg.JOB_DEADLINE_S * 1000),
        });
        const created = rows(conn.db.svcEvidenceJob.iter()).find((j) => j.clientKey === clientKey);
        if (!created) throw new Error("job row did not appear");
        jobId = created.id;
        await conn.reducers.workerAttachQuery({ queryId: q.id, jobId });
      }

      if (credit > 0 && !boostAnnounced.has(lock)) {
        boostAnnounced.add(lock);
        await event(
          conn,
          q.id,
          "boost",
          `Priority boost: you answered ${credit} neighbor${credit === 1 ? "" : "s"} today`,
        );
      }

      const obs = scoringObs(conn, q.placeId, now);
      const score = scoreEvidence({
        observations: obs,
        required: plan.dimensions.map((d) => ({ key: d.key, kind: d.kind })),
        nowMs: now,
        sufficientScore: cfg.SUFFICIENT_SCORE,
      });
      const freshCount = obs.filter((o) => now - o.observedAtMs < 15 * 60_000).length;
      await event(
        conn,
        q.id,
        "checking",
        freshCount ? `Found ${freshCount} recent update${freshCount === 1 ? "" : "s"}` : "Checking recent updates",
      );

      if (score.sufficient) {
        await synthesizeQuery(conn, q.id, plan, place, obs, score, true);
      } else {
        await conn.reducers.workerSetQueryStatus({ queryId: q.id, status: "collecting" });
        await promptWave(conn, jobId, plan, place, cfg, nowMs(), "first");
      }
      processedQueries.add(lock);
    } catch (e) {
      console.error("plan query failed", q.id, e);
      try {
        await conn.reducers.workerSetAnswer({
          queryId: q.id,
          status: "failed",
          answerJson: JSON.stringify({ headline: "Something went wrong.", recommendation: "insufficient", summary: String((e as Error).message), supporting: [], caveats: [], planner: "heuristic" }),
        });
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Distance from this fix to the nearest catalog building that is NOT the target. Compared
 * against the distance to the target (and the fix's accuracy) this is what separates
 * "inside Duderstadt" from "inside Pierpont" 78 m away. Undefined when the catalog offers
 * no alternative, which selectResponders reads as no evidence either way.
 */
function nearestOtherBuildingM(
  loc: { lat: number; lng: number },
  place: { id: string },
): number | undefined {
  return nearestCatalogPlace(loc.lat, loc.lng, place.id)?.distanceM;
}

async function promptWave(
  conn: Conn,
  jobId: bigint,
  plan: PlanResponse,
  place: { id: string; name: string; lat: number; lng: number },
  cfg: ReturnType<typeof getConfig>,
  now: number,
  wave: "first" | "expand",
) {
  const job = rows(conn.db.svcEvidenceJob.iter()).find((j) => j.id === jobId);
  if (!job || job.status !== "collecting") return;
  const existing = rows(conn.db.svcPromptRecipient.iter()).filter((r) => r.jobId === jobId);
  const remaining = cfg.MAX_RECIPIENTS - existing.length;
  if (remaining <= 0) return;
  // The first wave reaches further for requesters who answered neighbors; later waves do not.
  const attachedQueries = rows(conn.db.svcQuery.iter()).filter((q) => q.evidenceJobId === jobId);
  const credit =
    wave === "first"
      ? Math.max(0, ...attachedQueries.map((q) => creditOf(conn, hexOf(q.requester), cfg, now)))
      : 0;
  const want = Math.min(cfg.FIRST_WAVE + credit, remaining);
  if (want <= 0) return;

  const devices = rows(conn.db.svcDevice.iter()).filter((d) => d.active);
  const deviceOwners = new Set(devices.map((d) => hexOf(d.owner)));
  const lastPrompt = new Map<string, number>();
  for (const r of rows(conn.db.svcPromptRecipient.iter())) {
    const t = r.notifiedAt ? toMs(r.notifiedAt) : toMs(undefined);
    const prev = lastPrompt.get(hexOf(r.responder)) ?? 0;
    if (t > prev) lastPrompt.set(hexOf(r.responder), t);
  }
  const attached = rows(conn.db.svcQuery.iter()).filter((q) => q.evidenceJobId === jobId);
  // Every attached requester, not just the first. worker_create_prompt_batch rejects the
  // whole batch if any recipient is a requester on this job, so missing one here makes the
  // entire wave roll back silently.
  const requesterIds = attached.map((q) => hexOf(q.requester));

  const foreground = new Set(rows(conn.db.svcUserPresence.iter())
    .filter((p) => now - toMs(p.lastSeenAt) < 120_000).map((p) => hexOf(p.identity)));
  const candidates = rows(conn.db.svcUserLocation.iter()).map((loc) => {
    const profile = rows(conn.db.svcUserProfile.iter()).find((p) => p.identity.isEqual(loc.identity));
    return {
      userId: hexOf(loc.identity),
      lat: loc.lat,
      lng: loc.lng,
      source: loc.source as "gps" | "demo",
      capturedAtMs: toMs(loc.capturedAt),
      // An open foreground session can receive prompts without a push subscription.
      hasActiveDevice: deviceOwners.has(hexOf(loc.identity)) || foreground.has(hexOf(loc.identity)),
      notificationsPaused: profile?.notificationsPaused ?? false,
      lastPromptedAtMs: lastPrompt.get(hexOf(loc.identity)) ?? null,
      accuracyM: loc.accuracyM,
      nearestOtherBuildingM: nearestOtherBuildingM(loc, place),
      claimedPlaceId: loc.claimedPlaceId ?? null,
    };
  });

  const picked = selectResponders({
    candidates,
    place,
    nowMs: now,
    config: cfg,
    radiusM: plan.responder_radius_m,
    count: want,
    excludeIds: existing.map((r) => hexOf(r.responder)),
    requesterIds,
  });
  if (picked.selected.length === 0) {
    const key = String(jobId);
    jobLastWaveAt.set(key, now);
    const last = lastEmptyWaveAt.get(key) ?? 0;
    if (now - last < 30_000) return;
    lastEmptyWaveAt.set(key, now);
    for (const q of attached) {
      // After a first wave has gone out, "no one nearby" reads as a contradiction of the
      // "Asking N people" line above it. The honest difference is nobody NEW.
      await event(
        conn,
        q.id,
        "waiting",
        existing.some(r => !r.responded && rows(conn.db.svcPromptBatch.iter()).some(b => b.id === r.batchId && !b.expired && toMs(b.expiresAt) > now))
          ? "No one else nearby to ask; waiting for pending responses"
          : existing.length ? "No pending responses; looking for more nearby people" : "No one nearby is available to ask right now",
      );
    }
    return;
  }
  lastEmptyWaveAt.delete(String(jobId));

  const survey = plan.survey;
  if (!survey) return;
  // The plan's survey question, never a requester's raw text: one job can serve several
  // queries, and SPEC §3 forbids prompts that identify or quote the requester.
  const question = survey.question.slice(0, 300);

  // A floor or area named in the question, else a plain "are you here?" when a neighbouring
  // catalog building is close enough that GPS cannot tell them apart. Without this, someone
  // in Pierpont has no way to decline a question about Duderstadt 78 m away, and their
  // answer is recorded as if they were inside the target place.
  const part = placePart(question);
  const presence = part
    ? { label: part.prompt, passLabel: part.passLabel }
    : hasAmbiguousNeighbor(place)
      // The card already names the place above, so repeating it here just reads badly.
      ? { label: "Are you there right now?", passLabel: `I'm not at ${place.name}` }
      : null;
  const kindOf = new Map(plan.dimensions.map((d) => [d.key, d.kind]));
  const needed = new Set<string>();
  const liveObs = scoringObs(conn, place.id, now);
  for (const q of attached.filter(q => ["planning", "collecting", "synthesizing"].includes(q.status))) {
    const ownPlan = queryPlan(q, plan);
    const ownScore = scoreEvidence({ observations: liveObs, required: ownPlan.dimensions, nowMs: now });
    for (const dimension of ownScore.dimensions) {
      if (dimension.support < 0.5 || dimension.conf < cfg.SUFFICIENT_SCORE) needed.add(dimension.key);
    }
  }
  const dimensionControls = survey.controls
    .filter((c) => c.dimension_key !== PRESENCE_KEY)
    // A presence control costs one of the three slots. Keep objective checks (seats, noise)
    // ahead of opinions so the dropped control is not the one a follow-up question needs.
    .sort((a, b) => Number(!needed.has(a.dimension_key)) - Number(!needed.has(b.dimension_key)) ||
      Number(kindOf.get(a.dimension_key) === "subjective") - Number(kindOf.get(b.dimension_key) === "subjective"));
  // The reducer accepts 1-3 controls and rejects the whole batch otherwise, so the presence
  // control costs one dimension slot rather than silently failing the wave.
  const controls = presence
    ? [
        {
          dimension_key: PRESENCE_KEY,
          label: presence.label,
          options: [
            { value: "here", label: "I can check", ordinal: 1 },
            { value: "not_here", label: presence.passLabel, ordinal: 0 },
          ],
        },
        ...dimensionControls.slice(0, MAX_PROMPT_CONTROLS - 1),
      ]
    : dimensionControls.slice(0, MAX_PROMPT_CONTROLS);
  await conn.reducers.workerCreatePromptBatch({
    jobId,
    question,
    controlsJson: JSON.stringify(controls),
    expiresAtMicros: toMicros(now + cfg.PROMPT_EXPIRY_S * 1000),
    recipientIdentitiesJson: JSON.stringify(picked.selected.map((s) => s.userId)),
  });
  jobLastWaveAt.set(String(jobId), now);

  const batch = rows(conn.db.svcPromptBatch.iter())
    .filter((b) => b.jobId === jobId)
    .sort((a, b) => Number(b.id - a.id))[0];
  const recips = rows(conn.db.svcPromptRecipient.iter()).filter((r) => r.jobId === jobId && !r.notifiedAt);
  for (const r of recips) {
    const device = devices.find((d) => d.owner.isEqual(r.responder));
    if (device && pushEnabled()) {
      await sendToDevice(
        conn, device,
        {
          title: `Quick question about ${place.name}`,
          body: survey.question.slice(0, 140),
          url: `/#/respond/${batch?.id ?? ""}`,
          tag: `prompt-${batch?.id}`,
        },
      );
    }
    await conn.reducers.workerMarkNotified({ recipientId: r.id });
  }
  for (const q of attached) {
    const n = picked.selected.length;
    const who = `${n} ${n === 1 ? "person" : "people"}`;
    const asking = wave === "expand"
      ? `No answer yet. Asking ${n} more near ${place.name}`
      : `Asking ${who} near ${place.name}`;
    await event(conn, q.id, "asking", asking);
    // `attached` was read before the batch was created, and the caller may already have
    // moved this query to collecting. Re-read, and tolerate losing the race: the reducer
    // rejects collecting -> collecting, which would otherwise fail the whole query.
    const live = rows(conn.db.svcQuery.iter()).find((row) => row.id === q.id);
    if (live?.status === "planning") {
      try {
        await conn.reducers.workerSetQueryStatus({ queryId: q.id, status: "collecting" });
      } catch (e) {
        console.warn("status nudge skipped for", String(q.id), (e as Error).message);
      }
    }
  }
}

async function advanceCollectingJobs(conn: Conn, cfg: ReturnType<typeof getConfig>, now: number) {
  for (const job of rows(conn.db.svcEvidenceJob.iter())) {
    if (job.status !== "collecting") continue;
    const plan = parseJson<PlanResponse | null>(job.planJson, null);
    if (!plan) continue;
    const place = placeOf(conn, job.placeId);
    if (!place) continue;
    const onJob = rows(conn.db.svcQuery.iter()).filter((q) => q.evidenceJobId === job.id);
    const attached = onJob.filter((q) => ["collecting", "planning", "synthesizing"].includes(q.status));
    // Nobody is waiting on this job any more — every query was cancelled or already closed.
    // Continuing would interrupt people for a question that no longer exists (SPEC §1:
    // interrupt the fewest people). The age guard avoids killing a job whose attach has
    // not yet arrived through the subscription.
    if (attached.length === 0 && now - toMs(job.createdAt) > cfg.EXPAND_AFTER_S * 1000) {
      await conn.reducers.workerSetJobStatus({
        jobId: job.id,
        status: "expired",
        confidenceJson: "",
      });
      continue;
    }
    if (attached.length === 0) continue;
    const obs = scoringObs(conn, job.placeId, now);
    const score = scoreEvidence({
      observations: obs,
      required: plan.dimensions.map((d) => ({ key: d.key, kind: d.kind })),
      nowMs: now,
      sufficientScore: cfg.SUFFICIENT_SCORE,
    });
    const recips = rows(conn.db.svcPromptRecipient.iter()).filter((r) => r.jobId === job.id);
    const answered = recips.filter((r) => r.responded).length;
    const pending = recips.filter(r => !r.responded && rows(conn.db.svcPromptBatch.iter())
      .some(b => b.id === r.batchId && !b.expired && toMs(b.expiresAt) > now)).length;
    for (const q of attached) {
      const timers = JSON.stringify({ start: toMs(job.createdAt), end: toMs(job.deadlineAt),
        expand: toMs(job.createdAt) + cfg.EXPAND_AFTER_S * 1000 });
      if (!rows(conn.db.svcQueryEvent.iter()).some(e => e.queryId === q.id && e.kind === "collection_timer" && e.message === timers))
        await event(conn, q.id, "collection_timer", timers);
      const message = pending ? `Waiting for ${pending} pending response${pending === 1 ? "" : "s"}`
        : recips.length ? "No pending responses; checking the evidence collected" : "Looking for nearby people to ask";
      const key = `${q.id}:pending`;
      if (lastReceivedEvent.get(key) !== message) {
        lastReceivedEvent.set(key, message);
        await event(conn, q.id, "pending", message);
      }
    }
    for (const q of attached) {
      if (!answered) continue;
      // recips.length is how many people were actually asked; plan.responder_count is only
      // what the plan requested. Emit once per distinct message, not once per 2s tick.
      const message = `Received ${answered} of ${recips.length}`;
      const key = `${q.id}:received`;
      if (lastReceivedEvent.get(key) === message) continue;
      lastReceivedEvent.set(key, message);
      await event(conn, q.id, "received", message);
    }

    // The database flags the deadline on its own clock. The timestamp check remains
    // so a job is not stuck when the schedule row was never written.
    const pastDeadline = job.deadlinePassed || now >= toMs(job.deadlineAt);
    const lastNotified = recips.reduce((max, r) => {
      const t = r.notifiedAt ? toMs(r.notifiedAt) : 0;
      return t > max ? t : max;
    }, 0);
    const lastWaveAt = Math.max(lastNotified, jobLastWaveAt.get(String(job.id)) ?? 0);
    const wantMore = nextWaveCount({
      alreadyAsked: recips.length,
      stillWaiting: recips.filter((r) => !r.responded).length,
      maxRecipients: cfg.MAX_RECIPIENTS,
      waveSize: cfg.FIRST_WAVE,
      msSinceLastWave: lastWaveAt ? now - lastWaveAt : Number.POSITIVE_INFINITY,
      expandAfterMs: cfg.EXPAND_AFTER_S * 1000,
    });

    for (const q of attached) {
      const ownPlan = queryPlan(q, plan);
      const ownScore = scoreEvidence({ observations: obs, required: ownPlan.dimensions, nowMs: now,
        sufficientScore: cfg.SUFFICIENT_SCORE });
      if (ownScore.sufficient) await synthesizeQuery(conn, q.id, ownPlan, place, obs, ownScore, false);
    }
    const waiting = attached.filter(q => {
      const live = rows(conn.db.svcQuery.iter()).find(row => row.id === q.id);
      return live && ["planning", "collecting", "synthesizing"].includes(live.status);
    });
    if (!waiting.length) {
      await conn.reducers.workerSetJobStatus({ jobId: job.id, status: "done", confidenceJson: JSON.stringify(score) });
      continue;
    }
    const passIds = passResponseIds(conn, job.id);
    const handled = jobHandledPasses.get(String(job.id)) ?? new Set<string>();
    const freshPasses = passIds.filter((id) => !handled.has(id));
    if (!pastDeadline && freshPasses.length > 0 && recips.length > 0 && recips.length < cfg.MAX_RECIPIENTS) {
      for (const id of passIds) handled.add(id);
      jobHandledPasses.set(String(job.id), handled);
      await promptWave(conn, job.id, plan, place, cfg, now, "expand");
      continue;
    }
    if (!pastDeadline && recips.length > 0 && wantMore > 0) {
      await promptWave(conn, job.id, plan, place, cfg, now, "expand");
      continue;
    }
    if (!pastDeadline && recips.length === 0) {
      const lastTry = jobLastWaveAt.get(String(job.id)) ?? 0;
      if (now - lastTry >= cfg.EXPAND_AFTER_S * 1000) {
        await promptWave(conn, job.id, plan, place, cfg, now, "first");
      }
      continue;
    }
    if (pastDeadline) {
      for (const q of waiting) {
        const ownPlan = queryPlan(q, plan);
        const ownScore = scoreEvidence({ observations: obs, required: ownPlan.dimensions, nowMs: now,
          sufficientScore: cfg.SUFFICIENT_SCORE });
        await synthesizeQuery(conn, q.id, ownPlan, place, obs, ownScore, false);
      }
      await conn.reducers.workerSetJobStatus({
        jobId: job.id,
        status: "expired",
        confidenceJson: JSON.stringify(score),
      });
    }
  }
}

/**
 * SPEC §7 step 9. A response can arrive after the job deadline — in demo mode the deadline
 * is 60 s while prompts stay open for 600 s — and `ingestResponses` already turns it into
 * an observation. Without this pass that evidence never reaches the person who asked: they
 * are left on "not enough fresh evidence" while the answer sits in the database.
 *
 * Re-scores finished queries for `LATE_ACCEPT_S` after their job's deadline and rewrites
 * the answer when the evidence has materially changed. Keyed on an evidence signature so
 * each change produces exactly one update, not one per 2 s tick.
 */
function evidenceSignature(answer: { sourceCount?: number; confidence?: {level?: string};
  dimensions?: {key: string; modalValue: string | null; count?: number}[];
  conflicts?: {dimension: string; severity: string; labels: string[]}[];
  factors?: {observations?: {id: string; weight: number}[]} }) {
  return JSON.stringify({ count: answer.sourceCount ?? 0, level: answer.confidence?.level ?? "Low",
    dimensions: (answer.dimensions ?? []).map(d => [d.key, d.modalValue, d.count === 0]).sort(),
    conflicts: answer.conflicts ?? [],
    sources: (answer.factors?.observations ?? []).filter(o => o.weight > 0).map(o => o.id).sort(),
  });
}

function scoreSignature(score: ReturnType<typeof scoreEvidence>) {
  return evidenceSignature({ sourceCount: score.contributors, confidence: score, dimensions: score.dimensions,
    conflicts: score.conflicts, factors: score.factors });
}

async function updateLateAnswers(conn: Conn, cfg: ReturnType<typeof getConfig>, now: number) {
  for (const q of rows(conn.db.svcQuery.iter())) {
    if (q.status !== "answered" && q.status !== "insufficient") continue;
    if (q.evidenceJobId === undefined || q.evidenceJobId === null) continue;
    const job = rows(conn.db.svcEvidenceJob.iter()).find(j => j.id === q.evidenceJobId);
    if (!job || now - toMs(job.deadlineAt) > cfg.LATE_ACCEPT_S * 1000) continue;
    const plan = queryPlan(q, parseJson<PlanResponse>(job.planJson, null as unknown as PlanResponse));
    if (!plan) continue;
    const place = placeOf(conn, q.placeId);
    if (!place) continue;
    const obs = scoringObs(conn, q.placeId, now);
    const score = scoreEvidence({ observations: obs, required: plan.dimensions, nowMs: now,
      sufficientScore: cfg.SUFFICIENT_SCORE });
    const signature = scoreSignature(score);
    const stored = parseJson<Parameters<typeof evidenceSignature>[0]>(q.answerJson, {});
    const previous = answeredSignature.get(String(q.id)) ?? evidenceSignature(stored);
    if (previous === signature) continue;
    // Empty insufficient answers need no rewrite just to add a diagnostics schema.
    if (q.status === "insufficient" && score.contributors === 0) continue;
    await synthesizeQuery(conn, q.id, plan, place, obs, score, false, "update");
    await event(conn, q.id, "updated", "Reports changed, updating the answer");
  }
}

/** Surfaces fresh firsthand disagreement in the caveats, since confidence alone hides why it is capped. */
function withConflictCaveat(caveats: string[], conflicts: ReturnType<typeof scoreEvidence>["conflicts"]): string[] {
  if (!conflicts.length) return caveats;
  const what = conflicts
    .map((c) => `${c.dimension.replace(/^other:/, "").replace(/_/g, " ")} (${c.labels.join(" vs ")})`)
    .join("; ");
  return [`Reports disagree on ${what}; confidence is capped.`, ...caveats];
}

async function sendToDevice(
  conn: Conn,
  device: { id: bigint; endpoint: string; p256Dh: string; auth: string },
  payload: Parameters<typeof sendPush>[1],
) {
  const result = await sendPush({ endpoint: device.endpoint, p256dh: device.p256Dh, auth: device.auth }, payload);
  if (result === "gone") await conn.reducers.workerDeactivateDevice({ deviceId: device.id });
  return result;
}

async function synthesizeQuery(
  conn: Conn,
  queryId: bigint,
  plan: PlanResponse,
  place: { id: string; name: string; category: string; lat: number; lng: number },
  obs: ScoringObservation[],
  score: ReturnType<typeof scoreEvidence>,
  cacheHit: boolean,
  mode: "first" | "update" = "first",
) {
  const q = rows(conn.db.svcQuery.iter()).find((row) => row.id === queryId);
  if (!q) return;
  if (q.status === "planning" || q.status === "collecting") {
    await conn.reducers.workerSetQueryStatus({ queryId, status: "synthesizing" });
  }
  if (mode === "first") {
    await event(conn, queryId, "enough", cacheHit ? "Reusing fresh evidence, no one interrupted" : score.contributors > 0 ? "Fresh reports collected" : "No fresh reports received");
  }
  // Only evidence for THIS question's dimensions. `obs` is everything live at the place, so
  // without this an unrelated query's observations reach the answer — the symptom was a
  // headline reading "answer is Yes and Yes", one Yes per question.
  const requiredKeys = new Set(plan.dimensions.map((d) => d.key));
  const used = obs.filter((o) => requiredKeys.has(o.dimension));
  const synth = await callSynthesize({
    query_id: String(queryId),
    text: q.text,
    canonical_intent: plan.canonical_intent,
    place: { id: place.id, name: place.name, category: place.category, lat: place.lat, lng: place.lng },
    dimensions: plan.dimensions,
    evidence: used.map((o) => ({
      id: o.id,
      dimension: o.dimension,
      value_label: o.valueLabel,
      kind: o.kind,
      source_type: o.sourceType,
      age_s: (nowMs() - o.observedAtMs) / 1000,
      verified_nearby: o.verifiedNearby,
      note: "",
    })),
    confidence: { score: score.score, level: score.level, ceiling: score.ceiling },
    missing_dimensions: score.missingDimensions,
  });
  // `obs` is every live observation at the place, including ones on dimensions this question
  // never asked about. score.contributors counts only sources on the required dimensions,
  // so this is the honest test for "we have an answer"
  // (SPEC §1.1: with no fresh evidence the result is explicitly insufficient).
  // answered -> insufficient is not a legal transition, so a refreshed answer that has become
  // unsure (for example after a late conflicting report) stays "answered" and says so in text.
  const status =
    q.status !== "answered" && (score.contributors === 0 || synth.recommendation === "insufficient")
      ? "insufficient" : "answered";
  // scoreEvidence already counts distinct firsthand contributors on the required dimensions
  // and derives the confidence ceiling from that same number, so reuse it: a separate count
  // over every observation at the place contradicts the confidence level shown next to it.
  const sourceCount = score.contributors;
  const newest = used.reduce((m, o) => Math.max(m, o.observedAtMs), 0);
  await conn.reducers.workerSetAnswer({
    queryId,
    status,
    answerJson: JSON.stringify({
      ...synth,
      caveats: withConflictCaveat(synth.caveats, score.conflicts),
      confidence: { score: score.score, level: score.level, ceiling: score.ceiling },
      conflicts: score.conflicts,
      sourceCount,
      updatedAtMs: newest || nowMs(),
      cacheHit,
      factors: publicFactors(score),
      dimensions: score.dimensions,
    }),
  });
  answeredSignature.set(String(queryId), scoreSignature(score));
  await event(
    conn,
    queryId,
    "ready",
    status !== "answered" ? "Not enough fresh evidence" : mode === "update" ? "Updated answer" : "Answer ready",
  );

  for (const o of used) {
    if (!o.contributorId || o.contributorId.startsWith("anon:")) continue;
    try {
      await conn.reducers.workerRecordImpact({
        contributor: Identity.fromString(o.contributorId.startsWith("0x") ? o.contributorId.slice(2) : o.contributorId),
        sourceType: o.sourceType,
        sourceId: o.id,
        queryId,
        kind: cacheHit ? "avoided_prompt" : "helped",
      });
      const last = lastImpactPush.get(o.contributorId) ?? 0;
      if (nowMs() - last > 60_000) {
        lastImpactPush.set(o.contributorId, nowMs());
        const device = rows(conn.db.svcDevice.iter()).find((d) => hexOf(d.owner) === o.contributorId && d.active);
        if (device && pushEnabled()) {
          await sendToDevice(
            conn, device,
            {
              title: "Your update helped someone",
              body: `Your report about ${place.name} answered a question.`,
              url: "/#/activity",
              tag: `impact-${queryId}`,
            },
          );
        }
      }
    } catch (e) {
      console.warn("impact record failed", (e as Error).message);
    }
  }

}

async function evaluateWatches(conn: Conn, now: number) {
  for (const w of rows(conn.db.svcWatch.iter())) {
    if (w.status === "expired" || w.status === "cancelled") continue;
    if (toMs(w.expiresAt) <= now) continue;
    const place = placeOf(conn, w.placeId);
    if (!place) continue;
    let target = parseJson<ReturnType<typeof inferWatchTarget>>(w.targetJson, null);
    if (w.status === "planning" || !target) {
      const lock = String(w.id);
      if (processedWatches.has(lock)) continue;
      processedWatches.add(lock);
      try {
        const plan = await callPlan({
          query_id: `watch-${w.id}`,
          text: w.text,
          place: { id: place.id, name: place.name, category: place.category, lat: place.lat, lng: place.lng },
          now_iso: new Date(now).toISOString(),
          recent_evidence: [],
        });
        const keys = plan.dimensions?.map((d) => d.key) ?? [];
        target = inferWatchTarget(w.text, keys, plan.survey?.controls ?? []);
        if (!target) {
          await conn.reducers.workerRetireWatch({
            watchId: w.id,
            reason: "I can only watch for open seats or a quiet room.",
          });
          continue;
        }
        await conn.reducers.workerArmWatch({
          watchId: w.id,
          dimensionKeysJson: JSON.stringify(keys.length ? keys : [target.dimension]),
          targetJson: JSON.stringify(target),
        });
      } catch (e) {
        processedWatches.delete(lock);
        console.warn("arm watch failed", w.id, (e as Error).message);
      }
      continue;
    }
    const reading = watchReading(
      scoringObs(conn, w.placeId, now).map((o) => ({
        dimension: o.dimension,
        value: o.value,
        valueLabel: o.valueLabel,
        observedAtMs: o.observedAtMs,
        expiresAtMs: o.expiresAtMs,
        invalidated: o.invalidated,
        sourceType: o.sourceType,
      })),
      target,
      now,
    );
    if (!reading.met || !reading.valueLabel) {
      if (w.lastValue) await conn.reducers.workerNoteWatch({ watchId: w.id, lastValue: "" });
      continue;
    }
    if (w.lastValue === reading.valueLabel) continue;
    await conn.reducers.workerNoteWatch({ watchId: w.id, lastValue: reading.valueLabel });
    const owner = hexOf(w.owner);
    const device = rows(conn.db.svcDevice.iter()).find((d) => hexOf(d.owner) === owner && d.active);
    const n = reading.contributors;
    if (device && pushEnabled()) {
      await sendToDevice(
        conn, device,
        {
          title: `${target.phrase} at ${place.name}`,
          body: `${reading.valueLabel} · ${n} report${n === 1 ? "" : "s"}`,
          url: "/#/activity",
          tag: `watch-${w.id}`,
        },
      );
    }
  }
}

// Delivery receipts are in the DB so restarting a worker does not forget pending or sent alerts.
async function deliverAnswerNotifications(conn: Conn, now: number) {
  for (const notification of rows(conn.db.svcAnswerNotification.iter())) {
    if (notification.state !== "pending" || toMs(notification.nextAttemptAt) > now) continue;
    if (now - toMs(notification.createdAt) > 600000) {
      await conn.reducers.workerMarkAnswerNotification({key:notification.key,outcome:"expired"});
      continue;
    }
    if (!pushEnabled()) continue;
    const devices=rows(conn.db.svcDevice.iter()).filter(d=>d.active && d.owner.isEqual(notification.owner));
    if (!devices.length) continue;
    let sent=false;
    for (const device of devices) {
      const result=await sendToDevice(conn,device,{title:notification.title,body:notification.body,
        url:notification.url,tag:notification.tag});
      if (result === "sent") sent=true;
    }
    await conn.reducers.workerMarkAnswerNotification({key:notification.key,outcome:sent ? "sent" : "retry"});
  }
}

