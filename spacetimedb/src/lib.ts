// Shared helpers + constants for reducers.
import { SenderError } from 'spacetimedb/server';
import { Identity, Timestamp } from 'spacetimedb';

// ---------- constants ----------
/** A recipient's location must be this fresh (seconds, relative to ctx.timestamp) when a batch is created. */
export const LOCATION_MAX_AGE_S = 21600;
export const MAX_RECIPIENTS_PER_JOB = 5;
export const QUERY_RATE_LIMIT_PER_HOUR = 10;
export const POST_RATE_LIMIT_PER_HOUR = 10;
export const COMMENT_RATE_LIMIT_PER_HOUR = 30;
export const PLACE_RATE_LIMIT_PER_HOUR = 30;
export const REPORT_RATE_LIMIT_PER_HOUR = 30;
export const MICROS_PER_S = 1_000_000n;
export const MICROS_PER_HOUR = 3_600_000_000n;

export const QUERY_STATUSES = [
  'planning',
  'clarifying',
  'collecting',
  'synthesizing',
  'answered',
  'insufficient',
  'refused',
  'failed',
  'cancelled',
] as const;
export type QueryStatus = (typeof QUERY_STATUSES)[number];

/** Allowed query transitions (SPEC §7 + task brief). Anything not listed is rejected. */
export const QUERY_TRANSITIONS: Record<string, readonly string[]> = {
  planning: ['clarifying', 'collecting', 'synthesizing', 'refused', 'failed', 'cancelled'],
  clarifying: ['planning', 'cancelled'],
  // collecting -> collecting and synthesizing -> synthesizing are no-ops, allowed on
  // purpose: the worker reads queries through a subscription that can lag its own writes,
  // so it may re-send a status it has already set. Rejecting that failed the whole query.
  collecting: ['collecting', 'synthesizing', 'answered', 'insufficient', 'failed', 'cancelled'],
  synthesizing: ['synthesizing', 'answered', 'insufficient', 'failed'],
  answered: ['answered'],
  // SPEC §7 step 9: a response that lands after the deadline still becomes evidence, and
  // may turn "not enough" into a real answer within LATE_ACCEPT_S. Without this edge the
  // asker is stuck on "insufficient" while the answer sits in the database.
  insufficient: ['answered', 'insufficient'],
  refused: [],
  failed: [],
  cancelled: [],
};

export const JOB_TRANSITIONS: Record<string, readonly string[]> = {
  collecting: ['collecting', 'synthesizing', 'done', 'expired'], // collecting->collecting = confidence refresh
  synthesizing: ['synthesizing', 'done', 'expired'],
  done: [],
  expired: [],
};

// Deliberately small; this is the "simple blocklist filter" from SPEC §12, not a moderation system.
const BLOCKLIST = ['kill yourself', 'kys', 'nigger', 'nigga', 'faggot', 'retard', 'cunt', 'rape you'];

// ---------- validation ----------
export function fail(msg: string): never {
  throw new SenderError(msg);
}

export function checkString(name: string, v: string, min: number, max: number): string {
  if (typeof v !== 'string') fail(`${name} must be a string`);
  const s = v.trim();
  if (s.length < min) fail(`${name} must be at least ${min} character${min === 1 ? '' : 's'}`);
  if (s.length > max) fail(`${name} must be at most ${max} characters`);
  return s;
}

/** Like checkString but does not trim (for opaque blobs such as endpoints / JSON). */
export function checkRaw(name: string, v: string, min: number, max: number): string {
  if (typeof v !== 'string') fail(`${name} must be a string`);
  if (v.length < min) fail(`${name} must be at least ${min} character${min === 1 ? '' : 's'}`);
  if (v.length > max) fail(`${name} must be at most ${max} characters`);
  return v;
}

export function checkBlocklist(name: string, text: string): void {
  const lower = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  for (const bad of BLOCKLIST) {
    if (lower.includes(` ${bad} `)) fail(`${name} contains language that is not allowed`);
  }
}

export function checkAttribution(v: string): string {
  if (v !== 'anonymous' && v !== 'profile') fail("attribution must be 'anonymous' or 'profile'");
  return v;
}

export function checkFinite(name: string, v: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${name} must be a finite number`);
  if (v < min || v > max) fail(`${name} must be between ${min} and ${max}`);
  return v;
}

export function parseJson(name: string, raw: string, maxLen: number): unknown {
  checkRaw(name, raw, 1, maxLen);
  try {
    return JSON.parse(raw);
  } catch {
    return fail(`${name} must be valid JSON`);
  }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function identityFromHex(name: string, hex: string): Identity {
  try {
    return Identity.fromString(hex.startsWith('0x') ? hex.slice(2) : hex);
  } catch {
    return fail(`${name}: invalid identity hex '${hex}'`);
  }
}

export function ts(micros: bigint): Timestamp {
  return new Timestamp(micros);
}

// ---------- context helpers (ctx is the reducer context; typed loosely to avoid circular generics) ----------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Ctx = any;

export function requireProfile(ctx: Ctx) {
  const p = ctx.db.user_profile.identity.find(ctx.sender);
  if (!p) fail('Create a profile first (set_profile)');
  return p;
}

export function requireService(ctx: Ctx): void {
  if (!ctx.db.service_role.identity.find(ctx.sender)) fail('Only the service identity may call this reducer');
}

export function isService(ctx: Ctx): boolean {
  return !!ctx.db.service_role.identity.find(ctx.sender);
}

/** Fixed-window per-identity rate limit (1 hour windows). Throws when exceeded. Rolled back with the reducer. */
export function consumeRate(ctx: Ctx, kind: string, limit: number): void {
  const window = ctx.timestamp.microsSinceUnixEpoch / MICROS_PER_HOUR;
  const key = `${ctx.sender.toHexString()}:${kind}:${window}`;
  const row = ctx.db.rate_bucket.key.find(key);
  if (row) {
    if (row.count >= limit) fail(`Rate limit reached: at most ${limit} ${kind} per hour`);
    ctx.db.rate_bucket.key.update({ ...row, count: row.count + 1 });
  } else {
    ctx.db.rate_bucket.insert({ key, count: 1 });
  }
}

export function addEvent(ctx: Ctx, queryId: bigint, kind: string, message: string): void {
  ctx.db.query_event.insert({
    id: 0n,
    query_id: queryId,
    kind,
    message,
    created_at: ctx.timestamp,
    svc: 0,
  });
}

export function transitionQuery(ctx: Ctx, q: { status: string }, to: string): void {
  if (!(QUERY_STATUSES as readonly string[]).includes(to)) fail(`Unknown query status '${to}'`);
  const allowed = QUERY_TRANSITIONS[q.status] ?? [];
  if (!allowed.includes(to)) fail(`Invalid query transition ${q.status} -> ${to}`);
}

export function getQuery(ctx: Ctx, id: bigint) {
  const q = ctx.db.query.id.find(id);
  if (!q) fail(`Query ${id} not found`);
  return q;
}

export function ownQuery(ctx: Ctx, id: bigint) {
  const q = getQuery(ctx, id);
  // Same message for "not yours" and "missing" would hide existence; the id space is small and ids are not secret,
  // but we avoid confirming existence of other people's queries anyway.
  if (!q.requester.isEqual(ctx.sender)) fail(`Query ${id} not found`);
  return q;
}

export function requirePlace(ctx: Ctx, placeId: string) {
  const p = ctx.db.place.id.find(placeId);
  if (!p) fail(`Unknown place '${placeId}' (call upsert_place first)`);
  return p;
}

/** All queries attached to a job (same place index, filtered on evidence_job_id). */
export function queriesForJob(ctx: Ctx, job: { id: bigint; place_id: string }) {
  const out = [];
  for (const q of ctx.db.query.place_id.filter(job.place_id)) {
    if (q.evidence_job_id !== undefined && q.evidence_job_id !== null && q.evidence_job_id === job.id) out.push(q);
  }
  return out;
}

export function recipientsForJob(ctx: Ctx, jobId: bigint) {
  return [...ctx.db.prompt_recipient.job_id.filter(jobId)];
}
