/**
 * In-memory stand-in for the worker's `DbConnection`, for testing `tick()` without
 * a running SpacetimeDB.
 *
 * It mirrors the OBSERVABLE behaviour of the worker reducers in
 * `spacetimedb/src/{client,worker,lib}.ts`: autoinc ids, `client_key` / `dedup_key` /
 * `resp_key` idempotency, the recipient cap, requester exclusion, location freshness,
 * and query/job transition validation. Reducers that reject must reject here too —
 * several of the bugs these tests cover were *silent rollbacks*, only observable if
 * the fake refuses the same input the real reducer refuses.
 *
 * Those modules cannot be imported directly: they pull `spacetimedb/server`, which
 * resolves to a `spacetime:` URL and only loads inside the database runtime. The
 * constants below are therefore copied, and `loop.test.ts` has a drift test that
 * reads `spacetimedb/src/lib.ts` as text and asserts they still agree.
 */
import { Identity, Timestamp } from "spacetimedb";

// Mirrors spacetimedb/src/lib.ts — kept honest by the drift test in loop.test.ts.
export const MAX_RECIPIENTS_PER_JOB = 20;
export const LOCATION_MAX_AGE_S = 21600;

export const QUERY_TRANSITIONS: Record<string, readonly string[]> = {
  planning: ["clarifying", "collecting", "synthesizing", "insufficient", "refused", "failed", "cancelled"],
  clarifying: ["planning", "cancelled"],
  collecting: ["collecting", "synthesizing", "answered", "insufficient", "failed", "cancelled"],
  synthesizing: ["synthesizing", "answered", "insufficient", "failed"],
  answered: ["answered"],
  insufficient: ["answered", "insufficient"],
  refused: [],
  failed: [],
  cancelled: [],
};

export const JOB_TRANSITIONS: Record<string, readonly string[]> = {
  collecting: ["collecting", "synthesizing", "done", "expired"],
  synthesizing: ["synthesizing", "done", "expired"],
  done: [],
  expired: [],
};

export const ts = (ms: number): Timestamp => new Timestamp(BigInt(Math.round(ms)) * 1000n);
export const tsMicros = (micros: bigint): Timestamp => new Timestamp(micros);

/** Deterministic identity from a short label, so tests can name people "n1", "asker", … */
export function identityFor(label: string): Identity {
  let hex = "";
  for (let i = 0; i < label.length; i++) hex += label.charCodeAt(i).toString(16).padStart(2, "0");
  return Identity.fromString(hex.slice(0, 64).padEnd(64, "0"));
}
export const hexFor = (label: string): string => identityFor(label).toHexString();

// ---------- row shapes (camelCase, as the TS bindings expose them) ----------
export interface PlaceRow { id: string; name: string; category: string; lat: number; lng: number; address: string; community: string }
export interface QueryRow {
  id: bigint; requester: Identity; placeId: string; text: string; status: string;
  evidenceJobId?: bigint; planJson?: string; clarificationJson?: string; clarificationChoice?: string;
  answerJson?: string; createdAt: Timestamp; updatedAt: Timestamp; clientRequestId: string; idemKey: string; svc: number;
}
export interface QueryEventRow { id: bigint; queryId: bigint; kind: string; message: string; createdAt: Timestamp; svc: number }
export interface EvidenceJobRow {
  id: bigint; clientKey: string; placeId: string; intentKey: string; dimensionKeysJson: string; status: string;
  planJson: string; createdAt: Timestamp; deadlineAt: Timestamp; deadlinePassed?: boolean; recipientsCount: number; confidenceJson?: string; svc: number;
}
export interface PromptBatchRow { id: bigint; jobId: bigint; placeId: string; question: string; controlsJson: string; createdAt: Timestamp; expiresAt: Timestamp; svc: number }
export interface PromptRecipientRow { id: bigint; batchId: bigint; jobId: bigint; responder: Identity; notifiedAt?: Timestamp; responded: boolean; svc: number }
export interface PromptResponseRow { id: bigint; batchId: bigint; responder: Identity; answersJson: string; note: string; createdAt: Timestamp; respKey: string; svc: number }
export interface ObservationRow {
  id: bigint; placeId: string; dimension: string; value: string; valueLabel: string; ordinal?: number;
  kind: string; sourceType: string; sourceId: string; contributor?: Identity; verifiedNearby: boolean;
  observedAt: Timestamp; expiresAt: Timestamp; invalidated: boolean; dedupKey: string; svc: number;
}
export interface PostRow {
  id: bigint; author: Identity; attribution: string; placeId: string; community: string; text: string;
  createdAt: Timestamp; deleted: boolean; hidden: boolean; summary: string; freshnessState: string;
  freshnessNote: string; commentCount: number; claimsJson?: string; svc: number;
}
export interface CommentRow { id: bigint; postId: bigint; author: Identity; attribution: string; text: string; createdAt: Timestamp; deleted: boolean; hidden: boolean; svc: number }
export interface UserLocationRow { identity: Identity; lat: number; lng: number; accuracyM: number; source: string; claimedPlaceId?: string; capturedAt: Timestamp; svc: number }
export interface UserProfileRow { identity: Identity; username: string; avatarSeed: string; defaultAttribution: string; notificationsPaused: boolean; isAdmin: boolean; createdAt: Timestamp; svc: number }
export interface DeviceRow { id: bigint; owner: Identity; endpoint: string; p256Dh: string; auth: string; userAgent: string; active: boolean; createdAt: Timestamp; svc: number }
export interface AnswerNotificationRow {
  key:string; queryId:bigint; owner:Identity; title:string; body:string; url:string; tag:string;
  state:string; attempts:number; nextAttemptAt:Timestamp; createdAt:Timestamp; svc:number;
}
export interface ImpactEventRow { id: bigint; contributor: Identity; sourceType: string; sourceId: string; queryId: bigint; kind: string; createdAt: Timestamp; dedupKey: string; svc: number }
export interface WatchRow {
  id: bigint; owner: Identity; placeId: string; text: string; status: string;
  dimensionKeysJson: string; targetJson: string; lastValue: string;
  expiresAt: Timestamp; svc: number;
}

interface Tables {
  place: PlaceRow[];
  svcQuery: QueryRow[];
  svcQueryEvent: QueryEventRow[];
  svcEvidenceJob: EvidenceJobRow[];
  svcPromptBatch: PromptBatchRow[];
  svcPromptRecipient: PromptRecipientRow[];
  svcPromptResponse: PromptResponseRow[];
  svcObservation: ObservationRow[];
  svcPost: PostRow[];
  svcComment: CommentRow[];
  svcUserLocation: UserLocationRow[];
  svcUserPresence: {connectionId:string; identity:Identity; lastSeenAt:Timestamp; svc:number}[];
  svcUserProfile: UserProfileRow[];
  svcDevice: DeviceRow[];
  svcImpactEvent: ImpactEventRow[];
  svcWatch: WatchRow[];
  svcAnswerNotification: AnswerNotificationRow[];
}

/** A rejection from a reducer. The real module throws SenderError; the shape does not matter to loop.ts. */
export class ReducerError extends Error {}

export interface FakeConn {
  db: { [K in keyof Tables]: { iter(): Iterable<Tables[K][number]> } };
  reducers: Record<string, (args: never) => Promise<void>>;
  /** Direct access for arranging state and asserting results. */
  rows: Tables;
  /** Reducer calls recorded in order, for asserting idempotency and call counts. */
  calls: { name: string; args: unknown }[];
  /** Forces the next call of `name` to throw, simulating a crash mid-sequence. */
  failOnce(name: string): void;
  /**
   * When true, `workerSetQueryStatus` validates and records the transition but does not
   * update the row until `flush()`. This models the real subscription lag: the worker can
   * re-read a query and still see the status it had before its own write landed.
   */
  deferStatusWrites: boolean;
  /** Applies any status writes held back by `deferStatusWrites`. */
  flush(): void;
  /** Frozen clock, in ms. Reducers stamp rows with it. */
  now: number;
}

export function makeFakeConn(now: number): FakeConn {
  const rows: Tables = {
    place: [], svcQuery: [], svcQueryEvent: [], svcEvidenceJob: [], svcPromptBatch: [],
    svcPromptRecipient: [], svcPromptResponse: [], svcObservation: [], svcPost: [],
    svcComment: [], svcUserLocation: [], svcUserPresence: [], svcUserProfile: [], svcDevice: [], svcImpactEvent: [],
    svcWatch: [], svcAnswerNotification: [],
  };
  const calls: { name: string; args: unknown }[] = [];
  const failures = new Set<string>();
  const nextId = (() => {
    const counters = new Map<string, bigint>();
    return (table: string) => {
      const n = (counters.get(table) ?? 0n) + 1n;
      counters.set(table, n);
      return n;
    };
  })();

  const conn = { now } as FakeConn;
  const stamp = () => ts(conn.now);

  const findQuery = (id: bigint) => {
    const q = rows.svcQuery.find((r) => r.id === id);
    if (!q) throw new ReducerError(`Query ${id} not found`);
    return q;
  };
  const transitionQuery = (q: QueryRow, to: string) => {
    if (!(QUERY_TRANSITIONS[q.status] ?? []).includes(to)) {
      throw new ReducerError(`Invalid query transition ${q.status} -> ${to}`);
    }
  };
  const requirePlace = (placeId: string) => {
    const p = rows.place.find((r) => r.id === placeId);
    if (!p) throw new ReducerError(`Unknown place '${placeId}'`);
    return p;
  };

  const reducers: Record<string, (args: never) => Promise<void>> = {};
  const define = <A>(name: string, fn: (args: A) => void) => {
    reducers[name] = async (args: never) => {
      calls.push({ name, args });
      if (failures.has(name)) {
        failures.delete(name);
        throw new ReducerError(`injected failure in ${name}`);
      }
      fn(args as unknown as A);
    };
  };

  // ---------- queries ----------
  define<{ queryId: bigint; kind: string; message: string }>("workerAddQueryEvent", (a) => {
    findQuery(a.queryId);
    rows.svcQueryEvent.push({ id: nextId("event"), queryId: a.queryId, kind: a.kind, message: a.message, createdAt: stamp(), svc: 0 });
  });

  define<{ queryId: bigint; planJson: string }>("workerSetQueryPlan", (a) => {
    const q = findQuery(a.queryId);
    if (q.status !== "planning") throw new ReducerError(`Cannot set plan while query is ${q.status}`);
    q.planJson = a.planJson;
    q.updatedAt = stamp();
  });

  const pendingStatus: { q: QueryRow; status: string }[] = [];
  define<{ queryId: bigint; status: string }>("workerSetQueryStatus", (a) => {
    const q = findQuery(a.queryId);
    transitionQuery(q, a.status);
    if (conn.deferStatusWrites) {
      pendingStatus.push({ q, status: a.status });
      return;
    }
    q.status = a.status;
    q.updatedAt = stamp();
  });

  define<{ queryId: bigint; clarificationJson: string }>("workerSetClarification", (a) => {
    const q = findQuery(a.queryId);
    transitionQuery(q, "clarifying");
    q.status = "clarifying";
    q.clarificationJson = a.clarificationJson;
    q.clarificationChoice = undefined;
  });

  define<{ queryId: bigint; answerJson: string; status: string }>("workerSetAnswer", (a) => {
    if (!["answered", "insufficient", "refused", "failed"].includes(a.status)) {
      throw new ReducerError("status must be answered|insufficient|refused|failed");
    }
    const q = findQuery(a.queryId);
    transitionQuery(q, a.status);
    const changed=q.status!==a.status || q.answerJson!==a.answerJson;
    const previous=q.status;
    q.status = a.status;
    q.answerJson = a.answerJson;
    q.updatedAt = stamp();
    const key=`${q.id}:${q.updatedAt.microsSinceUnixEpoch}`;
    if (changed && !rows.svcAnswerNotification.some(n=>n.key===key)) {
      const answer=JSON.parse(a.answerJson);
      rows.svcAnswerNotification.push({key,queryId:q.id,owner:q.requester,
        title:previous === 'answered' ? `Updated answer: ${answer.headline}` : answer.headline ?? 'Your answer is ready',
        body:a.status==='insufficient' ? 'Nobody nearby answered in time' : `${answer.confidence?.level ?? 'Low'} confidence`,
        url:`/#/q/${q.id}`,tag:`answer-${q.id}`,state:'pending',attempts:0,nextAttemptAt:stamp(),createdAt:stamp(),svc:0});
    }
  });

  define<{key:string;outcome:string}>("workerMarkAnswerNotification",a=>{
    const row=rows.svcAnswerNotification.find(n=>n.key===a.key);
    if (!row || row.state!=='pending') return;
    if (!['sent','retry','expired'].includes(a.outcome)) throw new ReducerError('Unknown notification outcome');
    row.attempts++; row.state=a.outcome==='retry' ? 'pending' : a.outcome;
    row.nextAttemptAt=ts(conn.now+Math.min(120000,10000*2**Math.min(row.attempts-1,4)));
  });

  // ---------- evidence jobs ----------
  define<{jobId: bigint; planJson: string; dimensionKeysJson: string}>("workerMergeJobPlan", (a) => {
    const job = rows.svcEvidenceJob.find(j => j.id === a.jobId);
    if (!job || job.status !== "collecting") throw new ReducerError("Only collecting jobs can add requirements");
    if ((JSON.parse(job.dimensionKeysJson) as string[]).some(k => !JSON.parse(a.dimensionKeysJson).includes(k))) {
      throw new ReducerError("Existing requirements cannot be removed");
    }
    job.planJson = a.planJson;
    job.dimensionKeysJson = a.dimensionKeysJson;
  });
  define<{deviceId: bigint}>("workerDeactivateDevice", (a) => {
    const device = rows.svcDevice.find(d => d.id === a.deviceId);
    if (device) device.active = false;
  });
  define<{
    clientKey: string; placeId: string; intentKey: string; dimensionKeysJson: string; planJson: string; deadlineAtMicros: bigint;
  }>("workerCreateJob", (a) => {
    // checkString('client_key', …, 8, 128) in the real reducer: a `job-${id}` key is too
    // short for single-digit ids, which failed every early query until the live e2e caught it.
    if (a.clientKey.trim().length < 8 || a.clientKey.length > 128) {
      throw new ReducerError("client_key must be at least 8 characters");
    }
    if (rows.svcEvidenceJob.some((j) => j.clientKey === a.clientKey)) return; // idempotent
    requirePlace(a.placeId);
    const dims = JSON.parse(a.dimensionKeysJson);
    if (!Array.isArray(dims) || dims.length === 0) throw new ReducerError("dimension_keys_json must be a non-empty array");
    if (a.deadlineAtMicros <= BigInt(conn.now) * 1000n) throw new ReducerError("deadline_at must be in the future");
    rows.svcEvidenceJob.push({
      id: nextId("job"), clientKey: a.clientKey, placeId: a.placeId, intentKey: a.intentKey,
      dimensionKeysJson: a.dimensionKeysJson, status: "collecting", planJson: a.planJson,
      createdAt: stamp(), deadlineAt: tsMicros(a.deadlineAtMicros), deadlinePassed: false, recipientsCount: 0, svc: 0,
    });
  });

  define<{ queryId: bigint; jobId: bigint }>("workerAttachQuery", (a) => {
    const q = findQuery(a.queryId);
    const job = rows.svcEvidenceJob.find((j) => j.id === a.jobId);
    if (!job) throw new ReducerError(`Job ${a.jobId} not found`);
    if (q.evidenceJobId === a.jobId) return; // idempotent
    if (q.evidenceJobId !== undefined) throw new ReducerError("Query is already attached to a job");
    if (q.status !== "planning") throw new ReducerError(`Cannot attach a query that is ${q.status}`);
    if (q.placeId !== job.placeId) throw new ReducerError("Query and job are for different places");
    if (job.status === "expired") throw new ReducerError("Job has expired");
    for (const r of rows.svcPromptRecipient.filter((r) => r.jobId === a.jobId)) {
      if (r.responder.isEqual(q.requester)) throw new ReducerError("Requester is already a recipient of this job");
    }
    q.evidenceJobId = a.jobId;
  });

  define<{ jobId: bigint; status: string; confidenceJson: string }>("workerSetJobStatus", (a) => {
    const job = rows.svcEvidenceJob.find((j) => j.id === a.jobId);
    if (!job) throw new ReducerError(`Job ${a.jobId} not found`);
    if (!(JOB_TRANSITIONS[job.status] ?? []).includes(a.status)) {
      throw new ReducerError(`Invalid job transition ${job.status} -> ${a.status}`);
    }
    job.status = a.status;
    if (a.confidenceJson) job.confidenceJson = a.confidenceJson;
  });

  // The whole batch is atomic: any failing guardrail rejects every recipient with it.
  define<{
    jobId: bigint; question: string; controlsJson: string; expiresAtMicros: bigint; recipientIdentitiesJson: string;
  }>("workerCreatePromptBatch", (a) => {
    const job = rows.svcEvidenceJob.find((j) => j.id === a.jobId);
    if (!job) throw new ReducerError(`Job ${a.jobId} not found`);
    if (job.status !== "collecting") throw new ReducerError(`Job is ${job.status}; prompts need collecting`);
    if (!a.question.trim() || a.question.length > 300) throw new ReducerError("question must be 1-300 characters");
    const controls = JSON.parse(a.controlsJson);
    if (!Array.isArray(controls) || controls.length < 1 || controls.length > 3) {
      throw new ReducerError("controls_json must be an array of 1-3 controls");
    }
    if (a.expiresAtMicros <= BigInt(conn.now) * 1000n) throw new ReducerError("expires_at must be in the future");

    const incoming: string[] = JSON.parse(a.recipientIdentitiesJson);
    if (!Array.isArray(incoming) || incoming.length === 0) throw new ReducerError("recipient_identities_json must be non-empty");
    if (new Set(incoming).size !== incoming.length) throw new ReducerError("Duplicate recipient in request");

    const existing = rows.svcPromptRecipient.filter((r) => r.jobId === a.jobId);
    if (existing.length + incoming.length > MAX_RECIPIENTS_PER_JOB) {
      throw new ReducerError(`A job may have at most ${MAX_RECIPIENTS_PER_JOB} recipients (${existing.length} already)`);
    }
    const already = new Set(existing.map((r) => r.responder.toHexString()));
    const requesters = new Set(
      rows.svcQuery.filter((q) => q.evidenceJobId === a.jobId).map((q) => q.requester.toHexString()),
    );
    for (const hex of incoming) {
      if (already.has(hex)) throw new ReducerError(`Recipient ${hex.slice(0, 8)}… was already asked about this job`);
      if (requesters.has(hex)) throw new ReducerError(`Recipient ${hex.slice(0, 8)}… is the requester of a query on this job`);
      const profile = rows.svcUserProfile.find((p) => p.identity.toHexString() === hex);
      if (!profile) throw new ReducerError(`Recipient ${hex.slice(0, 8)}… has no profile`);
      if (profile.notificationsPaused) throw new ReducerError(`Recipient ${hex.slice(0, 8)}… has paused notifications`);
      const loc = rows.svcUserLocation.find((l) => l.identity.toHexString() === hex);
      if (!loc) throw new ReducerError(`Recipient ${hex.slice(0, 8)}… has no location`);
      if (conn.now - Number(loc.capturedAt.microsSinceUnixEpoch / 1000n) > LOCATION_MAX_AGE_S * 1000) {
        throw new ReducerError(`Recipient ${hex.slice(0, 8)}… has a stale location`);
      }
    }

    const batchId = nextId("batch");
    rows.svcPromptBatch.push({
      id: batchId, jobId: a.jobId, placeId: job.placeId, question: a.question.trim(),
      controlsJson: JSON.stringify(controls), createdAt: stamp(), expiresAt: tsMicros(a.expiresAtMicros), svc: 0,
    });
    for (const hex of incoming) {
      rows.svcPromptRecipient.push({
        id: nextId("recipient"), batchId, jobId: a.jobId,
        responder: Identity.fromString(hex), notifiedAt: undefined, responded: false, svc: 0,
      });
    }
    job.recipientsCount = existing.length + incoming.length;
  });

  define<{ recipientId: bigint }>("workerMarkNotified", (a) => {
    const r = rows.svcPromptRecipient.find((row) => row.id === a.recipientId);
    if (!r) throw new ReducerError(`Recipient ${a.recipientId} not found`);
    if (!r.notifiedAt) r.notifiedAt = stamp();
  });

  // ---------- observations / impact ----------
  define<{
    placeId: string; dimension: string; value: string; valueLabel: string; ordinal?: number; kind: string;
    sourceType: string; sourceId: string; contributor?: Identity; verifiedNearby: boolean;
    observedAtMicros: bigint; expiresAtMicros: bigint;
  }>("workerAddObservation", (a) => {
    requirePlace(a.placeId);
    if (!/^[a-z0-9_:-]+$/.test(a.dimension)) throw new ReducerError("dimension has invalid characters");
    if (!["objective", "subjective"].includes(a.kind)) throw new ReducerError("kind must be objective|subjective");
    if (!["response", "post", "comment"].includes(a.sourceType)) throw new ReducerError("bad source_type");
    if (a.expiresAtMicros <= a.observedAtMicros) throw new ReducerError("expires_at must be after observed_at");
    const dedupKey = `${a.sourceType}:${a.sourceId}:${a.dimension}`;
    if (rows.svcObservation.some((o) => o.dedupKey === dedupKey)) return; // idempotent
    rows.svcObservation.push({
      id: nextId("observation"), placeId: a.placeId, dimension: a.dimension, value: a.value,
      valueLabel: a.valueLabel, ordinal: a.ordinal, kind: a.kind, sourceType: a.sourceType,
      sourceId: a.sourceId, contributor: a.contributor, verifiedNearby: a.verifiedNearby,
      observedAt: tsMicros(a.observedAtMicros), expiresAt: tsMicros(a.expiresAtMicros),
      invalidated: false, dedupKey, svc: 0,
    });
  });

  define<{ observationId: bigint }>("workerInvalidateObservation", (a) => {
    const o = rows.svcObservation.find((row) => row.id === a.observationId);
    if (!o) throw new ReducerError(`Observation ${a.observationId} not found`);
    o.invalidated = true;
    rows.svcImpactEvent = rows.svcImpactEvent.filter(i => i.sourceId !== String(o.id) && i.sourceId !== o.sourceId);
  });

  define<{ contributor: Identity; sourceType: string; sourceId: string; queryId: bigint; kind: string }>(
    "workerRecordImpact",
    (a) => {
      if (a.kind !== "helped" && a.kind !== "avoided_prompt") throw new ReducerError("bad impact kind");
      findQuery(a.queryId);
      const dedupKey = `${a.contributor.toHexString()}:${a.sourceType}:${a.sourceId}:${a.queryId}:${a.kind}`;
      if (rows.svcImpactEvent.some((e) => e.dedupKey === dedupKey)) return;
      rows.svcImpactEvent.push({
        id: nextId("impact"), contributor: a.contributor, sourceType: a.sourceType, sourceId: a.sourceId,
        queryId: a.queryId, kind: a.kind, createdAt: stamp(), dedupKey, svc: 0,
      });
    },
  );

  define<{ watchId: bigint; dimensionKeysJson: string; targetJson: string }>("workerArmWatch", (a) => {
    const w = rows.svcWatch.find((row) => row.id === a.watchId);
    if (!w) throw new ReducerError(`Watch ${a.watchId} not found`);
    w.dimensionKeysJson = a.dimensionKeysJson;
    w.targetJson = a.targetJson;
    w.status = "active";
  });

  define<{ watchId: bigint; lastValue: string }>("workerNoteWatch", (a) => {
    const w = rows.svcWatch.find((row) => row.id === a.watchId);
    if (!w || w.status !== "active") return;
    w.lastValue = a.lastValue;
  });

  define<{ watchId: bigint; reason: string }>("workerRetireWatch", (a) => {
    const w = rows.svcWatch.find((row) => row.id === a.watchId);
    if (!w || w.status === "expired" || w.status === "cancelled") return;
    if (!a.reason.trim()) throw new ReducerError("reason must be at least 1 character");
    w.status = "expired";
    w.lastValue = a.reason.trim();
  });

  // ---------- posts ----------
  define<{ postId: bigint; summary: string; claimsJson: string; freshnessState: string; freshnessNote: string }>(
    "workerSetPostSummary",
    (a) => {
      const p = rows.svcPost.find((row) => row.id === a.postId);
      if (!p) throw new ReducerError(`Post ${a.postId} not found`);
      if (p.deleted || p.hidden) throw new ReducerError("Post was removed");
      p.summary = a.summary;
      p.claimsJson = a.claimsJson || undefined;
      p.freshnessState = a.freshnessState;
      p.freshnessNote = a.freshnessNote;
    },
  );

  // Every table is a live view over its array, so reducers and assertions see the same rows.
  // Spelled out rather than built in a loop: a mapped assignment cannot be typed without a cast.
  conn.db = {
    place: { iter: () => rows.place },
    svcQuery: { iter: () => rows.svcQuery },
    svcQueryEvent: { iter: () => rows.svcQueryEvent },
    svcEvidenceJob: { iter: () => rows.svcEvidenceJob },
    svcPromptBatch: { iter: () => rows.svcPromptBatch },
    svcPromptRecipient: { iter: () => rows.svcPromptRecipient },
    svcPromptResponse: { iter: () => rows.svcPromptResponse },
    svcObservation: { iter: () => rows.svcObservation },
    svcPost: { iter: () => rows.svcPost },
    svcComment: { iter: () => rows.svcComment },
    svcAnswerNotification: {iter:()=>rows.svcAnswerNotification},
    svcUserLocation: { iter: () => rows.svcUserLocation },
    svcUserPresence: { iter: () => rows.svcUserPresence },
    svcUserProfile: { iter: () => rows.svcUserProfile },
    svcDevice: { iter: () => rows.svcDevice },
    svcImpactEvent: { iter: () => rows.svcImpactEvent },
    svcWatch: { iter: () => rows.svcWatch },
  };
  conn.reducers = reducers;
  conn.rows = rows;
  conn.calls = calls;
  conn.failOnce = (name: string) => failures.add(name);
  conn.deferStatusWrites = false;
  conn.flush = () => {
    for (const { q, status } of pendingStatus.splice(0)) {
      q.status = status;
      q.updatedAt = stamp();
    }
  };
  return conn;
}

// ---------- arrangement helpers ----------

export function addPlace(conn: FakeConn, over: Partial<PlaceRow> = {}): PlaceRow {
  const place: PlaceRow = {
    id: "shapiro-undergraduate-library", name: "Shapiro Undergraduate Library", category: "library",
    lat: 42.2757, lng: -83.7382, address: "919 S University Ave", community: "umich-annarbor", ...over,
  };
  conn.rows.place.push(place);
  return place;
}

export function addUser(
  conn: FakeConn,
  label: string,
  opts: {
    lat?: number; lng?: number; source?: string; ageMs?: number; device?: boolean;
    paused?: boolean; claimedPlaceId?: string; foreground?: boolean;
  } = {},
): Identity {
  const identity = identityFor(label);
  if (opts.foreground !== false) conn.rows.svcUserPresence.push({
    connectionId: label, identity, lastSeenAt: ts(conn.now), svc: 0,
  });
  conn.rows.svcUserProfile.push({
    identity, username: label, avatarSeed: label, defaultAttribution: "anonymous",
    notificationsPaused: opts.paused ?? false, isAdmin: false, createdAt: ts(conn.now), svc: 0,
  });
  if (opts.lat !== undefined && opts.lng !== undefined) {
    conn.rows.svcUserLocation.push({
      identity, lat: opts.lat, lng: opts.lng, accuracyM: 12, source: opts.source ?? "demo",
      claimedPlaceId: opts.claimedPlaceId, capturedAt: ts(conn.now - (opts.ageMs ?? 60_000)), svc: 0,
    });
  }
  if (opts.device !== false) {
    conn.rows.svcDevice.push({
      id: BigInt(conn.rows.svcDevice.length + 1), owner: identity, endpoint: `https://push.example/${label}`,
      p256Dh: "dGVzdA", auth: "dGVzdA", userAgent: "test", active: true, createdAt: ts(conn.now), svc: 0,
    });
  }
  return identity;
}

export function addQuery(conn: FakeConn, requester: Identity, placeId: string, text: string): QueryRow {
  const id = BigInt(conn.rows.svcQuery.length + 1);
  const row: QueryRow = {
    id, requester, placeId, text, status: "planning", evidenceJobId: undefined, planJson: undefined,
    clarificationJson: undefined, clarificationChoice: undefined, answerJson: undefined,
    createdAt: ts(conn.now), updatedAt: ts(conn.now),
    clientRequestId: `crid-${id}`, idemKey: `${requester.toHexString()}:crid-${id}`, svc: 0,
  };
  conn.rows.svcQuery.push(row);
  return row;
}

/** Meters offset in latitude, for placing someone a known distance from a place. */
export const metersNorth = (lat: number, meters: number): number => lat + meters / 111_195;
