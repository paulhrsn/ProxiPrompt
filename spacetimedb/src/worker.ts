// Worker-only reducers: sender must be in `service_role`. These hold the authoritative guardrails the
// orchestrator cannot bypass (state machine, recipient caps, location freshness, requester exclusion).
import { ScheduleAt, t } from 'spacetimedb/server';
import spacetimedb, { gc_schedule, job_deadline_schedule, prompt_expiry_schedule, watch_expiry_schedule } from './schema';
import {
  JOB_TRANSITIONS,
  LOCATION_MAX_AGE_S,
  MAX_RECIPIENTS_PER_JOB,
  MICROS_PER_HOUR,
  MICROS_PER_S,
  addEvent,
  checkRaw,
  checkString,
  fail,
  type Ctx,
  getQuery,
  identityFromHex,
  isPlainObject,
  parseJson,
  queriesForJob,
  recipientsForJob,
  requirePlace,
  requireService,
  transitionQuery,
  ts,
} from './lib';

const KINDS = ['objective', 'subjective'];
const SOURCE_TYPES = ['response', 'post', 'comment', 'social'];
const MAX_TTL_S = 172_800n; // SPEC §6: longest TTL bound (low volatility)

// ---------- queries ----------
export const worker_set_query_plan = spacetimedb.reducer(
  { query_id: t.u64(), plan_json: t.string() },
  (ctx, { query_id, plan_json }) => {
    requireService(ctx);
    const q = getQuery(ctx, query_id);
    if (q.status !== 'planning') fail(`Cannot set plan while query is ${q.status}`);
    parseJson('plan_json', plan_json, 20_000);
    ctx.db.query.id.update({ ...q, plan_json, updated_at: ctx.timestamp });
  }
);

export const worker_set_query_status = spacetimedb.reducer(
  { query_id: t.u64(), status: t.string() },
  (ctx, { query_id, status }) => {
    requireService(ctx);
    const q = getQuery(ctx, query_id);
    transitionQuery(ctx, q, status);
    ctx.db.query.id.update({ ...q, status, updated_at: ctx.timestamp });
  }
);

export const worker_add_query_event = spacetimedb.reducer(
  { query_id: t.u64(), kind: t.string(), message: t.string() },
  (ctx, { query_id, kind, message }) => {
    requireService(ctx);
    getQuery(ctx, query_id);
    addEvent(ctx, query_id, checkString('kind', kind, 1, 40), checkString('message', message, 1, 280));
  }
);

// planning -> clarifying, storing the question/options for the requester.
export const worker_set_clarification = spacetimedb.reducer(
  { query_id: t.u64(), clarification_json: t.string() },
  (ctx, { query_id, clarification_json }) => {
    requireService(ctx);
    const q = getQuery(ctx, query_id);
    const parsed = parseJson('clarification_json', clarification_json, 4000);
    if (!isPlainObject(parsed) || typeof parsed.question !== 'string') {
      fail('clarification_json must be an object with a question');
    }
    transitionQuery(ctx, q, 'clarifying');
    ctx.db.query.id.update({
      ...q,
      status: 'clarifying',
      clarification_json,
      clarification_choice: undefined,
      updated_at: ctx.timestamp,
    });
  }
);

export const worker_set_answer = spacetimedb.reducer(
  { query_id: t.u64(), answer_json: t.string(), status: t.string() },
  (ctx, { query_id, answer_json, status }) => {
    requireService(ctx);
    if (!['answered', 'insufficient', 'refused', 'failed'].includes(status)) {
      fail('status must be one of answered|insufficient|refused|failed');
    }
    const q = getQuery(ctx, query_id);
    parseJson('answer_json', answer_json, 60_000);
    transitionQuery(ctx, q, status);
    ctx.db.query.id.update({ ...q, status, answer_json, updated_at: ctx.timestamp });
  }
);

// ---------- evidence jobs ----------
// Reducers cannot return values. The worker supplies a unique `client_key` (e.g. a UUID) that is stored on the row and
// is UNIQUE; it then finds the new row through its svc_evidence_job subscription by that key. Retrying with the same
// key is a no-op, which makes job creation idempotent across worker restarts.
export const worker_create_job = spacetimedb.reducer(
  {
    client_key: t.string(),
    place_id: t.string(),
    intent_key: t.string(),
    dimension_keys_json: t.string(),
    plan_json: t.string(),
    deadline_at_micros: t.u64(),
  },
  (ctx, a) => {
    requireService(ctx);
    const client_key = checkString('client_key', a.client_key, 8, 128);
    if (ctx.db.evidence_job.client_key.find(client_key)) return;
    requirePlace(ctx, a.place_id);
    const intent_key = checkString('intent_key', a.intent_key, 1, 200);
    const dims = parseJson('dimension_keys_json', a.dimension_keys_json, 2000);
    if (!Array.isArray(dims) || dims.length === 0 || dims.some((d) => typeof d !== 'string')) {
      fail('dimension_keys_json must be a non-empty JSON array of strings');
    }
    parseJson('plan_json', a.plan_json, 20_000);
    const now = ctx.timestamp.microsSinceUnixEpoch;
    if (a.deadline_at_micros <= now) fail('deadline_at must be in the future');
    if (a.deadline_at_micros > now + 86_400n * MICROS_PER_S) fail('deadline_at must be within 24 hours');
    const job = ctx.db.evidence_job.insert({
      id: 0n,
      client_key,
      place_id: a.place_id,
      intent_key,
      dimension_keys_json: a.dimension_keys_json,
      status: 'collecting',
      plan_json: a.plan_json,
      created_at: ctx.timestamp,
      deadline_at: ts(a.deadline_at_micros),
      deadline_passed: false,
      recipients_count: 0,
      confidence_json: undefined,
      svc: 0,
    });
    ctx.db.job_deadline_schedule.insert({
      scheduled_id: 0n,
      scheduled_at: ScheduleAt.time(a.deadline_at_micros),
      job_id: job.id,
    });
  }
);

export const job_deadline_reached = spacetimedb.reducer(
  { onSchedule: job_deadline_schedule },
  { schedule: job_deadline_schedule.rowType },
  (ctx, { schedule }) => {
    // Scheduled reducers run as the module identity. A client can still call this reducer.
    if (!ctx.sender.isEqual(ctx.identity)) fail('Only the scheduler can run a job deadline');
    const job = ctx.db.evidence_job.id.find(schedule.job_id);
    if (!job || (job.status !== 'collecting' && job.status !== 'synthesizing')) return;
    let dims: string[] = [];
    try {
      const parsed = JSON.parse(job.dimension_keys_json);
      if (Array.isArray(parsed)) dims = parsed.filter((d) => typeof d === 'string');
    } catch {
      dims = [];
    }
    const now = ctx.timestamp.microsSinceUnixEpoch;
    const wanted = new Set(dims);
    let fresh = false;
    for (const o of ctx.db.observation.place_id.filter(job.place_id)) {
      if (o.invalidated || o.expires_at.microsSinceUnixEpoch <= now) continue;
      if (wanted.has(o.dimension)) {
        fresh = true;
        break;
      }
    }
    for (const q of queriesForJob(ctx, job)) {
      if (!['planning', 'collecting', 'synthesizing'].includes(q.status)) continue;
      addEvent(ctx, q.id, 'deadline', "Time's up");
      if (fresh) continue;
      const place = ctx.db.place.id.find(job.place_id);
      const placeName = place?.name ?? 'this place';
      let planner = 'heuristic';
      try {
        const parsed = JSON.parse(job.plan_json) as { planner?: string };
        if (parsed.planner === 'llm' || parsed.planner === 'heuristic') planner = parsed.planner;
      } catch {
        /* the answer still has to close */
      }
      transitionQuery(ctx, q, 'insufficient');
      ctx.db.query.id.update({
        ...q,
        status: 'insufficient',
        answer_json: JSON.stringify({
          headline: `Not enough fresh evidence about ${placeName}.`,
          recommendation: 'insufficient',
          summary: 'Nobody nearby answered in time, and cached reports were too old or missing.',
          supporting: [],
          caveats: ['Try again shortly — a later answer will use any late responses.'],
          planner,
          confidence: { score: 0, level: 'Low', ceiling: 0 },
        }),
        updated_at: ctx.timestamp,
      });
    }
    if (fresh) {
      ctx.db.evidence_job.id.update({ ...job, deadline_passed: true });
      return;
    }
    if ((JOB_TRANSITIONS[job.status] ?? []).includes('expired')) {
      ctx.db.evidence_job.id.update({ ...job, status: 'expired', deadline_passed: true });
    }
  }
);

export const worker_attach_query = spacetimedb.reducer(
  { query_id: t.u64(), job_id: t.u64() },
  (ctx, { query_id, job_id }) => {
    requireService(ctx);
    const q = getQuery(ctx, query_id);
    const job = ctx.db.evidence_job.id.find(job_id);
    if (!job) fail(`Job ${job_id} not found`);
    if (q.evidence_job_id === job_id) return; // idempotent
    if (q.evidence_job_id !== undefined && q.evidence_job_id !== null) fail('Query is already attached to a job');
    if (q.status !== 'planning') fail(`Cannot attach a query that is ${q.status}`);
    if (q.place_id !== job.place_id) fail('Query and job are for different places');
    if (job.status === 'expired') fail('Job has expired');
    // The requester must never be among the people asked about their own question.
    for (const r of recipientsForJob(ctx, job_id)) {
      if (r.responder.isEqual(q.requester)) fail('Requester is already a recipient of this job');
    }
    ctx.db.query.id.update({ ...q, evidence_job_id: job_id, updated_at: ctx.timestamp });
  }
);

export const worker_set_job_status = spacetimedb.reducer(
  { job_id: t.u64(), status: t.string(), confidence_json: t.string() },
  (ctx, { job_id, status, confidence_json }) => {
    requireService(ctx);
    const job = ctx.db.evidence_job.id.find(job_id);
    if (!job) fail(`Job ${job_id} not found`);
    if (!(JOB_TRANSITIONS[job.status] ?? []).includes(status)) fail(`Invalid job transition ${job.status} -> ${status}`);
    let confidence: string | undefined;
    if (confidence_json && confidence_json.length > 0) {
      parseJson('confidence_json', confidence_json, 20_000);
      confidence = confidence_json;
    }
    ctx.db.evidence_job.id.update({ ...job, status, confidence_json: confidence ?? job.confidence_json });
  }
);

// Creates one batch + its recipients atomically. Throws (rolling back everything) if ANY guardrail fails.
export const worker_create_prompt_batch = spacetimedb.reducer(
  {
    job_id: t.u64(),
    question: t.string(),
    controls_json: t.string(),
    expires_at_micros: t.u64(),
    recipient_identities_json: t.string(),
  },
  (ctx, a) => {
    requireService(ctx);
    const job = ctx.db.evidence_job.id.find(a.job_id);
    if (!job) fail(`Job ${a.job_id} not found`);
    if (job.status !== 'collecting') fail(`Job is ${job.status}; prompts can only be created while collecting`);

    const question = checkString('question', a.question, 1, 300);
    let controls = parseJson('controls_json', a.controls_json, 6000);
    if (isPlainObject(controls) && Array.isArray(controls.controls)) controls = controls.controls;
    if (!Array.isArray(controls) || controls.length < 1 || controls.length > 3) {
      fail('controls_json must be an array of 1-3 controls');
    }
    for (const c of controls as unknown[]) {
      if (
        !isPlainObject(c) ||
        typeof c.dimension_key !== 'string' ||
        !Array.isArray(c.options) ||
        c.options.length === 0 ||
        c.options.some((o) => !isPlainObject(o) || typeof o.value !== 'string')
      ) {
        fail('each control needs a dimension_key and options[{value,...}]');
      }
    }

    const now = ctx.timestamp.microsSinceUnixEpoch;
    if (a.expires_at_micros <= now) fail('expires_at must be in the future');
    if (a.expires_at_micros > now + 86_400n * MICROS_PER_S) fail('expires_at must be within 24 hours');

    const raw = parseJson('recipient_identities_json', a.recipient_identities_json, 4000);
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((r) => typeof r !== 'string')) {
      fail('recipient_identities_json must be a non-empty JSON array of identity hex strings');
    }
    const incoming = (raw as string[]).map((h) => identityFromHex('recipient', h));
    const seen = new Set<string>();
    for (const id of incoming) {
      const hex = id.toHexString();
      if (seen.has(hex)) fail(`Duplicate recipient ${hex.slice(0, 8)}… in request`);
      seen.add(hex);
    }

    const existing = recipientsForJob(ctx, job.id);
    if (existing.length + incoming.length > MAX_RECIPIENTS_PER_JOB) {
      fail(`A job may have at most ${MAX_RECIPIENTS_PER_JOB} recipients in total (${existing.length} already)`);
    }
    const already = new Set(existing.map((r) => r.responder.toHexString()));
    const requesters = new Set(queriesForJob(ctx, job).map((q) => q.requester.toHexString()));
    const maxAgeMicros = BigInt(LOCATION_MAX_AGE_S) * MICROS_PER_S;

    for (const id of incoming) {
      const hex = id.toHexString();
      const label = `${hex.slice(0, 8)}…`;
      if (already.has(hex)) fail(`Recipient ${label} was already asked about this job`);
      if (requesters.has(hex)) fail(`Recipient ${label} is the requester of a query on this job`);
      const profile = ctx.db.user_profile.identity.find(id);
      if (!profile) fail(`Recipient ${label} has no profile`);
      if (profile.notifications_paused) fail(`Recipient ${label} has paused notifications`);
      const loc = ctx.db.user_location.identity.find(id);
      if (!loc) fail(`Recipient ${label} has no location`);
      if (now - loc.captured_at.microsSinceUnixEpoch > maxAgeMicros) {
        fail(`Recipient ${label} has a stale location (older than ${LOCATION_MAX_AGE_S}s)`);
      }
    }

    const batch = ctx.db.prompt_batch.insert({
      id: 0n,
      job_id: job.id,
      place_id: job.place_id,
      question,
      controls_json: JSON.stringify(controls),
      created_at: ctx.timestamp,
      expires_at: ts(a.expires_at_micros),
      expired: false,
      svc: 0,
    });
    ctx.db.prompt_expiry_schedule.insert({
      scheduled_id: 0n,
      scheduled_at: ScheduleAt.time(a.expires_at_micros),
      batch_id: batch.id,
    });
    for (const id of incoming) {
      ctx.db.prompt_recipient.insert({
        id: 0n,
        batch_id: batch.id,
        job_id: job.id,
        responder: id,
        notified_at: undefined,
        responded: false,
        svc: 0,
      });
    }
    ctx.db.evidence_job.id.update({ ...job, recipients_count: existing.length + incoming.length });
  }
);

export const prompt_expired = spacetimedb.reducer(
  { onSchedule: prompt_expiry_schedule },
  { schedule: prompt_expiry_schedule.rowType },
  (ctx, { schedule }) => {
    if (!ctx.sender.isEqual(ctx.identity)) fail('Only the scheduler can expire a prompt');
    const batch = ctx.db.prompt_batch.id.find(schedule.batch_id);
    if (!batch || batch.expired) return;
    ctx.db.prompt_batch.id.update({ ...batch, expired: true });
  }
);

export const worker_mark_notified = spacetimedb.reducer({ recipient_id: t.u64() }, (ctx, { recipient_id }) => {
  requireService(ctx);
  const r = ctx.db.prompt_recipient.id.find(recipient_id);
  if (!r) fail(`Recipient ${recipient_id} not found`);
  if (r.notified_at === undefined || r.notified_at === null) {
    ctx.db.prompt_recipient.id.update({ ...r, notified_at: ctx.timestamp });
  }
});

// ---------- observations / impact ----------
export const worker_add_observation = spacetimedb.reducer(
  {
    place_id: t.string(),
    dimension: t.string(),
    value: t.string(),
    value_label: t.string(),
    ordinal: t.i32().optional(),
    kind: t.string(),
    source_type: t.string(),
    source_id: t.string(),
    contributor: t.identity().optional(),
    verified_nearby: t.bool(),
    observed_at_micros: t.u64(),
    expires_at_micros: t.u64(),
  },
  (ctx, a) => {
    requireService(ctx);
    requirePlace(ctx, a.place_id);
    const dimension = checkString('dimension', a.dimension, 1, 64);
    if (!/^[a-z0-9_:-]+$/.test(dimension)) fail('dimension has invalid characters');
    const value = checkString('value', a.value, 1, 120);
    const value_label = checkString('value_label', a.value_label, 1, 200);
    if (!KINDS.includes(a.kind)) fail('kind must be objective|subjective');
    if (!SOURCE_TYPES.includes(a.source_type)) fail('source_type must be response|post|comment|social');
    const source_id = checkString('source_id', a.source_id, 1, 128);
    const now = ctx.timestamp.microsSinceUnixEpoch;
    if (a.observed_at_micros > now + 60n * MICROS_PER_S) fail('observed_at cannot be in the future');
    if (a.expires_at_micros <= a.observed_at_micros) fail('expires_at must be after observed_at');
    if (a.expires_at_micros - a.observed_at_micros > MAX_TTL_S * MICROS_PER_S) fail('TTL exceeds 172800 s');

    const dedup_key = `${a.source_type}:${source_id}:${dimension}`;
    if (ctx.db.observation.dedup_key.find(dedup_key)) return; // idempotent (worker restart / re-processing)

    ctx.db.observation.insert({
      id: 0n,
      place_id: a.place_id,
      dimension,
      value,
      value_label,
      ordinal: a.ordinal,
      kind: a.kind,
      source_type: a.source_type,
      source_id,
      contributor: a.contributor,
      verified_nearby: a.verified_nearby,
      observed_at: ts(a.observed_at_micros),
      expires_at: ts(a.expires_at_micros),
      invalidated: false,
      dedup_key,
      svc: 0,
    });
  }
);

export const worker_invalidate_observation = spacetimedb.reducer(
  { observation_id: t.u64() },
  (ctx, { observation_id }) => {
    requireService(ctx);
    const o = ctx.db.observation.id.find(observation_id);
    if (!o) fail(`Observation ${observation_id} not found`);
    if (!o.invalidated) ctx.db.observation.id.update({ ...o, invalidated: true });
  }
);

export const worker_record_impact = spacetimedb.reducer(
  {
    contributor: t.identity(),
    source_type: t.string(),
    source_id: t.string(),
    query_id: t.u64(),
    kind: t.string(),
  },
  (ctx, a) => {
    requireService(ctx);
    if (!SOURCE_TYPES.includes(a.source_type)) fail('source_type must be response|post|comment|social');
    if (a.kind !== 'helped' && a.kind !== 'avoided_prompt') fail("kind must be 'helped' or 'avoided_prompt'");
    const source_id = checkString('source_id', a.source_id, 1, 128);
    getQuery(ctx, a.query_id);
    const dedup_key = `${a.contributor.toHexString()}:${a.source_type}:${source_id}:${a.query_id}:${a.kind}`;
    if (ctx.db.impact_event.dedup_key.find(dedup_key)) return;
    ctx.db.impact_event.insert({
      id: 0n,
      contributor: a.contributor,
      source_type: a.source_type,
      source_id,
      query_id: a.query_id,
      kind: a.kind,
      created_at: ctx.timestamp,
      dedup_key,
      svc: 0,
    });
  }
);

// ---------- posts ----------
export const worker_set_post_summary = spacetimedb.reducer(
  {
    post_id: t.u64(),
    summary: t.string(),
    claims_json: t.string(),
    freshness_state: t.string(),
    freshness_note: t.string(),
  },
  (ctx, a) => {
    requireService(ctx);
    const p = ctx.db.post.id.find(a.post_id);
    if (!p) fail(`Post ${a.post_id} not found`);
    if (p.deleted || p.hidden) fail('Post was removed');
    const summary = checkString('summary', a.summary, 0, 400);
    const freshness_state = checkRaw('freshness_state', a.freshness_state, 1, 40);
    if (!/^[a-z_]+$/.test(freshness_state)) fail('freshness_state must be lowercase letters/underscore');
    const freshness_note = checkString('freshness_note', a.freshness_note, 0, 120);
    let claims: string | undefined;
    if (a.claims_json && a.claims_json.length > 0) {
      const parsed = parseJson('claims_json', a.claims_json, 8000);
      if (!Array.isArray(parsed)) fail('claims_json must be a JSON array');
      claims = a.claims_json;
    }
    ctx.db.post.id.update({ ...p, summary, claims_json: claims, freshness_state, freshness_note });
  }
);

// ---------- admin ----------
// Only the service identity can grant/revoke the admin flag (is_admin is otherwise unreachable from clients).
export const worker_set_admin = spacetimedb.reducer(
  { identity: t.identity(), is_admin: t.bool() },
  (ctx, { identity, is_admin }) => {
    requireService(ctx);
    const p = ctx.db.user_profile.identity.find(identity);
    if (!p) fail('That identity has no profile');
    ctx.db.user_profile.identity.update({ ...p, is_admin });
  }
);

export const watch_expired = spacetimedb.reducer(
  { onSchedule: watch_expiry_schedule },
  { schedule: watch_expiry_schedule.rowType },
  (ctx, { schedule }) => {
    if (!ctx.sender.isEqual(ctx.identity)) fail('Only the scheduler can expire a watch');
    const w = ctx.db.watch.id.find(schedule.watch_id);
    if (!w || w.status === 'expired' || w.status === 'cancelled') return;
    ctx.db.watch.id.update({ ...w, status: 'expired' });
  }
);

export const worker_arm_watch = spacetimedb.reducer(
  { watch_id: t.u64(), dimension_keys_json: t.string(), target_json: t.string() },
  (ctx, { watch_id, dimension_keys_json, target_json }) => {
    requireService(ctx);
    const w = ctx.db.watch.id.find(watch_id);
    if (!w) fail(`Watch ${watch_id} not found`);
    if (w.status !== 'planning' && w.status !== 'active') return;
    parseJson('dimension_keys_json', dimension_keys_json, 2000);
    parseJson('target_json', target_json, 2000);
    ctx.db.watch.id.update({
      ...w,
      dimension_keys_json,
      target_json,
      status: 'active',
    });
  }
);

export const worker_note_watch = spacetimedb.reducer(
  { watch_id: t.u64(), last_value: t.string() },
  (ctx, { watch_id, last_value }) => {
    requireService(ctx);
    const w = ctx.db.watch.id.find(watch_id);
    if (!w || w.status !== 'active') return;
    const value = checkString('last_value', last_value, 0, 200);
    ctx.db.watch.id.update({
      ...w,
      last_value: value,
      last_notified_at: value ? ctx.timestamp : w.last_notified_at,
    });
  }
);

// A watch whose question is not "open seats" or "quiet" cannot be armed. Leave it ended
// with a reason, instead of sitting on "Setting up" for the whole three hours.
export const worker_retire_watch = spacetimedb.reducer(
  { watch_id: t.u64(), reason: t.string() },
  (ctx, { watch_id, reason }) => {
    requireService(ctx);
    const w = ctx.db.watch.id.find(watch_id);
    if (!w || w.status === 'expired' || w.status === 'cancelled') return;
    const note = checkString('reason', reason, 1, 200);
    ctx.db.watch.id.update({ ...w, status: 'expired', last_value: note });
  }
);

// Normal LATE_ACCEPT_S. Demo's shorter window sits inside this, and the database
// does not know which mode the worker is in, so cleanup waits out the longer one.
const GC_KEEP_AFTER_EXPIRY_S = 600n;
const GC_INTERVAL_S = 600n;
const RATE_BUCKET_KEEP_HOURS = 2n;

function rateWindow(key: string): bigint | null {
  const cut = key.lastIndexOf(':');
  if (cut < 0) return null;
  try {
    return BigInt(key.slice(cut + 1));
  } catch {
    return null;
  }
}

function ensureGcSchedule(ctx: Ctx): void {
  for (const _row of ctx.db.gc_schedule.iter()) return;
  ctx.db.gc_schedule.insert({
    scheduled_id: 0n,
    scheduled_at: ScheduleAt.interval(GC_INTERVAL_S * MICROS_PER_S),
  });
}

function collectGarbage(ctx: Ctx): void {
  const now = ctx.timestamp.microsSinceUnixEpoch;
  const cutoff = now - GC_KEEP_AFTER_EXPIRY_S * MICROS_PER_S;
  for (const o of [...ctx.db.observation.iter()]) {
    if (o.expires_at.microsSinceUnixEpoch < cutoff) ctx.db.observation.id.delete(o.id);
  }
  const hour = now / MICROS_PER_HOUR;
  for (const row of [...ctx.db.rate_bucket.iter()]) {
    const window = rateWindow(row.key);
    if (window !== null && hour - window >= RATE_BUCKET_KEEP_HOURS) ctx.db.rate_bucket.key.delete(row.key);
  }
}

export const init = spacetimedb.init((ctx) => {
  ensureGcSchedule(ctx);
});

export const worker_ensure_gc = spacetimedb.reducer({}, (ctx) => {
  requireService(ctx);
  ensureGcSchedule(ctx);
});

export const gc_due = spacetimedb.reducer(
  { onSchedule: gc_schedule },
  { schedule: gc_schedule.rowType },
  (ctx, _args) => {
    if (!ctx.sender.isEqual(ctx.identity)) fail('Only the scheduler can collect garbage');
    collectGarbage(ctx);
  }
);

export const worker_collect_garbage = spacetimedb.reducer({}, (ctx) => {
  requireService(ctx);
  collectGarbage(ctx);
});

// ---------- dev ----------
// Clears all activity so a dev/demo session can start over. Accounts, devices, locations,
// places and the service role stay, so nobody has to sign up, enable push or set a location
// again. Service-only; the orchestrator exposes it only when ENABLE_DEV_WIPE=1.
export const worker_dev_wipe = spacetimedb.reducer({}, (ctx) => {
  requireService(ctx);
  const byId = [
    ctx.db.query_event, ctx.db.prompt_response, ctx.db.prompt_recipient, ctx.db.prompt_batch,
    ctx.db.observation, ctx.db.impact_event, ctx.db.report, ctx.db.comment, ctx.db.post,
    ctx.db.query, ctx.db.evidence_job, ctx.db.watch,
  ] as any[];
  for (const table of byId) {
    for (const id of [...table.iter()].map((r: any) => r.id)) table.id.delete(id);
  }
  for (const row of [...ctx.db.job_deadline_schedule.iter()]) ctx.db.job_deadline_schedule.scheduled_id.delete(row.scheduled_id);
  for (const row of [...ctx.db.prompt_expiry_schedule.iter()]) ctx.db.prompt_expiry_schedule.scheduled_id.delete(row.scheduled_id);
  for (const row of [...ctx.db.watch_expiry_schedule.iter()]) ctx.db.watch_expiry_schedule.scheduled_id.delete(row.scheduled_id);
  for (const key of [...ctx.db.rate_bucket.iter()].map((r) => r.key)) ctx.db.rate_bucket.key.delete(key);
});
