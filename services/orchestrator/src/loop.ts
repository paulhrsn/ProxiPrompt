import {
  findAttachableJob,
  freshnessNote,
  getConfig,
  getDimension,
  scoreEvidence,
  nextWaveCount,
  selectResponders,
  type PlanResponse,
  type ScoringObservation,
  type Survey,
} from "@proxiprompt/core";
import { Identity } from "spacetimedb";
import type { DbConnection } from "../../../spacetimedb/bindings/index.js";
import { callPlan, callSummarize, callSynthesize } from "./agent.js";
import { blueskyQueryForPlace, searchBluesky } from "./bluesky.js";
import { pushEnabled, sendPush } from "./push.js";
import { hexOf, nowMs, parseJson, toMicros, toMs } from "./util.js";

type Conn = DbConnection;

const processedQueries = new Set<string>();
const processedResponses = new Set<string>();
const processedPosts = new Set<string>();
const jobLastWaveAt = new Map<string, number>();
const lastEmptyWaveAt = new Map<string, number>();
const lastImpactPush = new Map<string, number>();

function rows<T>(iter: Iterable<T> | undefined): T[] {
  return iter ? [...iter] : [];
}

function placeOf(conn: Conn, id: string) {
  return rows(conn.db.place.iter()).find((p) => p.id === id);
}

function scoringObs(conn: Conn, placeId: string, now: number): ScoringObservation[] {
  return rows(conn.db.svcObservation.iter())
    .filter((o) => o.placeId === placeId)
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

export async function tick(conn: Conn): Promise<void> {
  const demo = ["1", "true", "yes", "on"].includes((process.env.DEMO_MODE ?? "1").toLowerCase());
  const cfg = getConfig(demo);
  const now = nowMs();

  await ingestResponses(conn, cfg, now);
  await summarizePendingPosts(conn, now);
  await processPlanningQueries(conn, cfg, now);
  await advanceCollectingJobs(conn, cfg, now);
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
    for (const [dim, value] of Object.entries(answers)) {
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

async function summarizePendingPosts(conn: Conn, now: number) {
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
      const verified =
        !!loc &&
        now - toMs(loc.capturedAt) < 1800_000 &&
        Math.hypot((loc.lat - place.lat) * 111_000, (loc.lng - place.lng) * 85_000) < 150;
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
      processedPosts.add(key);
    } catch (e) {
      console.warn("summarize post failed", p.id, (e as Error).message);
    }
  }
}

async function processPlanningQueries(conn: Conn, cfg: ReturnType<typeof getConfig>, now: number) {
  for (const q of rows(conn.db.svcQuery.iter())) {
    if (q.status !== "planning") continue;
    const lock = String(q.id);
    if (processedQueries.has(lock) && q.planJson) continue;
    const place = placeOf(conn, q.placeId);
    if (!place) continue;
    const existing = scoringObs(conn, q.placeId, now);
    try {
      const plan = await callPlan({
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
      });
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

      await maybeImportBluesky(conn, place, plan, now);

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
        await conn.reducers.workerAttachQuery({ queryId: q.id, jobId });
        await event(conn, q.id, "collecting", "Joining an in-progress check for this place");
      } else {
        const clientKey = `job-${q.id}-${Date.now().toString(36)}`;
        await conn.reducers.workerCreateJob({
          clientKey,
          placeId: q.placeId,
          intentKey: plan.intent_key,
          dimensionKeysJson: JSON.stringify(plan.dimensions.map((d) => d.key)),
          planJson: JSON.stringify(plan),
          deadlineAtMicros: toMicros(now + cfg.JOB_DEADLINE_S * 1000),
        });
        const created = rows(conn.db.svcEvidenceJob.iter()).find((j) => j.clientKey === clientKey);
        if (!created) throw new Error("job row did not appear");
        jobId = created.id;
        await conn.reducers.workerAttachQuery({ queryId: q.id, jobId });
      }

      const obs = scoringObs(conn, q.placeId, now);
      const score = scoreEvidence({
        observations: obs,
        required: plan.dimensions.map((d) => ({ key: d.key, kind: d.kind })),
        nowMs: now,
        sufficientScore: cfg.SUFFICIENT_SCORE,
      });
      const freshCount = obs.filter((o) => now - o.observedAtMs < 15 * 60_000).length;
      await event(conn, q.id, "checking", freshCount ? `Found ${freshCount} recent updates` : "Checking recent updates");

      if (score.sufficient) {
        await synthesizeQuery(conn, q.id, plan, place, obs, score, true);
      } else {
        await conn.reducers.workerSetQueryStatus({ queryId: q.id, status: "collecting" });
        await promptWave(conn, jobId, plan, place, cfg, now, "first");
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

async function maybeImportBluesky(
  conn: Conn,
  place: { id: string; name: string },
  plan: PlanResponse,
  now: number,
) {
  const posts = await searchBluesky(blueskyQueryForPlace(place.name));
  for (const p of posts.slice(0, 3)) {
    const dim = plan.dimensions[0];
    if (!dim) continue;
    await conn.reducers.workerAddObservation({
      placeId: place.id,
      dimension: dim.key,
      value: "social",
      valueLabel: p.text.slice(0, 80),
      ordinal: undefined,
      kind: dim.kind,
      sourceType: "social",
      sourceId: p.uri.slice(0, 120),
      contributor: undefined,
      verifiedNearby: false,
      observedAtMicros: toMicros(p.createdAtMs),
      expiresAtMicros: toMicros(p.createdAtMs + dim.proposed_ttl_s * 1000),
    });
  }
  void now;
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
  const want = Math.min(cfg.FIRST_WAVE, remaining);
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
  const requesterId = attached[0] ? hexOf(attached[0].requester) : "";

  const candidates = rows(conn.db.svcUserLocation.iter()).map((loc) => {
    const profile = rows(conn.db.svcUserProfile.iter()).find((p) => p.identity.isEqual(loc.identity));
    return {
      userId: hexOf(loc.identity),
      lat: loc.lat,
      lng: loc.lng,
      source: loc.source as "gps" | "demo",
      capturedAtMs: toMs(loc.capturedAt),
      // A fresh location means the app is open, so Activity can deliver the prompt even without Web Push.
      hasActiveDevice: deviceOwners.has(hexOf(loc.identity)) || now - toMs(loc.capturedAt) < 120_000,
      notificationsPaused: profile?.notificationsPaused ?? false,
      lastPromptedAtMs: lastPrompt.get(hexOf(loc.identity)) ?? null,
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
    requesterId,
  });
  if (picked.selected.length === 0) {
    const key = String(jobId);
    jobLastWaveAt.set(key, now);
    const last = lastEmptyWaveAt.get(key) ?? 0;
    if (now - last < 30_000) return;
    lastEmptyWaveAt.set(key, now);
    for (const q of attached) {
      await event(conn, q.id, "waiting", "No one nearby is available to ask right now");
    }
    return;
  }
  lastEmptyWaveAt.delete(String(jobId));

  const survey = plan.survey;
  if (!survey) return;
  await conn.reducers.workerCreatePromptBatch({
    jobId,
    question: (attached.map((q) => q.text.trim()).find(Boolean) || survey.question).slice(0, 300),
    controlsJson: JSON.stringify(survey.controls),
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
      const result = await sendPush(
        { endpoint: device.endpoint, p256dh: device.p256Dh, auth: device.auth },
        {
          title: `Quick question about ${place.name}`,
          body: (attached.map((q) => q.text.trim()).find(Boolean) || survey.question).slice(0, 140),
          url: `/respond/${batch?.id ?? ""}`,
          tag: `prompt-${batch?.id}`,
        },
      );
      if (result === "gone") {
        /* device may be stale; still mark notified so we don't loop */
      }
    }
    await conn.reducers.workerMarkNotified({ recipientId: r.id });
  }
  for (const q of attached) {
    const asking = wave === "expand"
      ? `No answer yet. Asking ${picked.selected.length} more people near ${place.name}`
      : `Asking ${picked.selected.length} people near ${place.name}`;
    await event(conn, q.id, "asking", asking);
    if (q.status === "planning") {
      await conn.reducers.workerSetQueryStatus({ queryId: q.id, status: "collecting" });
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
    const attached = rows(conn.db.svcQuery.iter()).filter((q) => q.evidenceJobId === job.id && ["collecting", "planning", "synthesizing"].includes(q.status));
    const obs = scoringObs(conn, job.placeId, now);
    const score = scoreEvidence({
      observations: obs,
      required: plan.dimensions.map((d) => ({ key: d.key, kind: d.kind })),
      nowMs: now,
      sufficientScore: cfg.SUFFICIENT_SCORE,
    });
    const recips = rows(conn.db.svcPromptRecipient.iter()).filter((r) => r.jobId === job.id);
    const answered = recips.filter((r) => r.responded).length;
    for (const q of attached) {
      if (answered) await event(conn, q.id, "received", `Received ${answered} of ${recips.length || plan.responder_count}`);
    }

    const pastDeadline = now >= toMs(job.deadlineAt);
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

    if (score.sufficient) {
      for (const q of attached) await synthesizeQuery(conn, q.id, plan, place, obs, score, false);
      await conn.reducers.workerSetJobStatus({ jobId: job.id, status: "done", confidenceJson: JSON.stringify(score) });
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
      for (const q of attached) {
        if (obs.length === 0) {
          await conn.reducers.workerSetAnswer({
            queryId: q.id,
            status: "insufficient",
            answerJson: JSON.stringify({
              headline: `Not enough fresh evidence about ${place.name}.`,
              recommendation: "insufficient",
              summary: "Nobody nearby answered in time, and cached reports were too old or missing.",
              supporting: [],
              caveats: ["Try again shortly — a later answer will use any late responses."],
              planner: plan.planner,
              confidence: { score: score.score, level: score.level, ceiling: score.ceiling },
              factors: score.factors,
            }),
          });
        } else {
          await synthesizeQuery(conn, q.id, plan, place, obs, score, false);
        }
      }
      await conn.reducers.workerSetJobStatus({
        jobId: job.id,
        status: "expired",
        confidenceJson: JSON.stringify(score),
      });
    }
  }
}

async function synthesizeQuery(
  conn: Conn,
  queryId: bigint,
  plan: PlanResponse,
  place: { id: string; name: string; category: string; lat: number; lng: number },
  obs: ScoringObservation[],
  score: ReturnType<typeof scoreEvidence>,
  cacheHit: boolean,
) {
  const q = rows(conn.db.svcQuery.iter()).find((row) => row.id === queryId);
  if (!q) return;
  if (q.status === "planning") {
    await conn.reducers.workerSetQueryStatus({ queryId, status: "synthesizing" });
  } else if (q.status === "collecting") {
    await conn.reducers.workerSetQueryStatus({ queryId, status: "synthesizing" });
  }
  await event(conn, queryId, "enough", cacheHit ? "Reusing fresh evidence — no one interrupted" : "Enough evidence");
  const synth = await callSynthesize({
    query_id: String(queryId),
    text: q.text,
    canonical_intent: plan.canonical_intent,
    place: { id: place.id, name: place.name, category: place.category, lat: place.lat, lng: place.lng },
    dimensions: plan.dimensions,
    evidence: obs.map((o) => ({
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
  const status = synth.recommendation === "insufficient" || obs.length === 0 ? "insufficient" : "answered";
  const sourceCount = new Set(obs.map((o) => o.contributorId)).size;
  const newest = obs.reduce((m, o) => Math.max(m, o.observedAtMs), 0);
  await conn.reducers.workerSetAnswer({
    queryId,
    status,
    answerJson: JSON.stringify({
      ...synth,
      confidence: { score: score.score, level: score.level, ceiling: score.ceiling },
      sourceCount,
      updatedAtMs: newest || nowMs(),
      cacheHit,
      factors: score.factors,
      dimensions: score.dimensions,
    }),
  });
  await event(conn, queryId, "ready", status === "answered" ? "Answer ready" : "Not enough fresh evidence");

  for (const o of obs) {
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
          await sendPush(
            { endpoint: device.endpoint, p256dh: device.p256Dh, auth: device.auth },
            {
              title: "Your update helped someone",
              body: `Your report about ${place.name} answered a question.`,
              url: "/activity",
              tag: `impact-${queryId}`,
            },
          );
        }
      }
    } catch (e) {
      console.warn("impact record failed", (e as Error).message);
    }
  }

  const requester = hexOf(q.requester);
  const device = rows(conn.db.svcDevice.iter()).find((d) => hexOf(d.owner) === requester && d.active);
  if (device && pushEnabled()) {
    await sendPush(
      { endpoint: device.endpoint, p256dh: device.p256Dh, auth: device.auth },
      {
        title: synth.headline,
        body: `${score.level} confidence · ${sourceCount} source${sourceCount === 1 ? "" : "s"}`,
        url: `/q/${queryId}`,
        tag: `answer-${queryId}`,
      },
    );
  }
}

export const _test = { scoringObs, processedQueries, processedResponses };
