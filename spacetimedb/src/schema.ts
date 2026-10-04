// ProxiPrompt SpacetimeDB module — schema.
//
// Conventions
//  - Table / column names are snake_case in the database. The TS client bindings expose camelCase
//    (e.g. `created_at` -> `createdAt`, table `user_profile` -> `conn.db.userProfile`).
//  - Every table is PRIVATE unless noted. Clients only ever read `place` plus the views in views.ts.
//  - Tables the worker must read carry a constant `svc` column (always 0, btree-indexed). It exists only so
//    the `svc_*` query-builder views can semijoin against `service_role` (see views.ts).
import { schema, table, t } from 'spacetimedb/server';

// ---------- identity / profile ----------
export const user_profile = table(
  { name: 'user_profile' },
  {
    identity: t.identity().primaryKey(),
    username: t.string().unique(),
    avatar_seed: t.string(),
    default_attribution: t.string(), // 'anonymous' | 'profile'
    notifications_paused: t.bool(),
    is_admin: t.bool(),
    created_at: t.timestamp(),
    svc: t.u8().index('btree'),
  }
);

export const device = table(
  { name: 'device' },
  {
    id: t.u64().primaryKey().autoInc(),
    owner: t.identity().index('btree'),
    endpoint: t.string().unique(),
    p256dh: t.string(),
    auth: t.string(),
    user_agent: t.string(),
    active: t.bool(),
    created_at: t.timestamp(),
    svc: t.u8().index('btree'),
  }
);

export const user_location = table(
  { name: 'user_location' },
  {
    identity: t.identity().primaryKey(),
    lat: t.f64(),
    lng: t.f64(),
    accuracy_m: t.f64(),
    source: t.string(), // 'gps' | 'demo'
    // The building the user explicitly said they are in. Adjacent campus buildings are
    // 70-80 m apart, inside phone GPS error, so coordinates alone cannot tell Duderstadt
    // from Pierpont. When set, routing trusts this over the coordinates (SPEC §4).
    claimed_place_id: t.string().optional(),
    captured_at: t.timestamp(),
    svc: t.u8().index('btree'),
  }
);

// ---------- places (PUBLIC) ----------
export const place = table(
  { name: 'place', public: true },
  {
    id: t.string().primaryKey(), // google place_id or curated slug
    name: t.string(),
    category: t.string(),
    lat: t.f64(),
    lng: t.f64(),
    address: t.string(),
    community: t.string().index('btree'),
  }
);

// ---------- queries ----------
export const query = table(
  { name: 'query' },
  {
    id: t.u64().primaryKey().autoInc(),
    requester: t.identity().index('btree'),
    place_id: t.string().index('btree'),
    text: t.string(),
    status: t.string(), // planning|clarifying|collecting|synthesizing|answered|insufficient|refused|failed|cancelled
    evidence_job_id: t.u64().optional(),
    plan_json: t.string().optional(),
    clarification_json: t.string().optional(),
    clarification_choice: t.string().optional(),
    answer_json: t.string().optional(),
    created_at: t.timestamp(),
    updated_at: t.timestamp(),
    client_request_id: t.string(),
    idem_key: t.string().unique(), // `${requesterHex}:${client_request_id}`
    svc: t.u8().index('btree'),
  }
);

export const query_event = table(
  { name: 'query_event' },
  {
    id: t.u64().primaryKey().autoInc(),
    query_id: t.u64().index('btree'),
    kind: t.string(),
    message: t.string(),
    created_at: t.timestamp(),
    svc: t.u8().index('btree'),
  }
);

// ---------- evidence jobs / prompts ----------
export const evidence_job = table(
  { name: 'evidence_job' },
  {
    id: t.u64().primaryKey().autoInc(),
    // Worker-supplied unique key so the worker can find the row it just created (reducers return nothing).
    client_key: t.string().unique(),
    place_id: t.string().index('btree'),
    intent_key: t.string(),
    dimension_keys_json: t.string(),
    status: t.string(), // collecting|synthesizing|done|expired
    plan_json: t.string(),
    created_at: t.timestamp(),
    deadline_at: t.timestamp(),
    recipients_count: t.u32(),
    confidence_json: t.string().optional(),
    svc: t.u8().index('btree'),
  }
);

export const prompt_batch = table(
  { name: 'prompt_batch' },
  {
    id: t.u64().primaryKey().autoInc(),
    job_id: t.u64().index('btree'),
    place_id: t.string(),
    question: t.string(),
    controls_json: t.string(),
    created_at: t.timestamp(),
    expires_at: t.timestamp(),
    svc: t.u8().index('btree'),
  }
);

export const prompt_recipient = table(
  { name: 'prompt_recipient' },
  {
    id: t.u64().primaryKey().autoInc(),
    batch_id: t.u64().index('btree'),
    job_id: t.u64().index('btree'),
    responder: t.identity().index('btree'),
    notified_at: t.timestamp().optional(),
    responded: t.bool(),
    svc: t.u8().index('btree'),
  }
);

export const prompt_response = table(
  { name: 'prompt_response' },
  {
    id: t.u64().primaryKey().autoInc(),
    batch_id: t.u64().index('btree'),
    responder: t.identity().index('btree'),
    answers_json: t.string(),
    note: t.string(),
    created_at: t.timestamp(),
    resp_key: t.string().unique(), // `${batch_id}:${responderHex}` — one response per (batch, responder)
    svc: t.u8().index('btree'),
  }
);

export const observation = table(
  { name: 'observation' },
  {
    id: t.u64().primaryKey().autoInc(),
    place_id: t.string().index('btree'),
    dimension: t.string(),
    value: t.string(),
    value_label: t.string(),
    ordinal: t.i32().optional(),
    kind: t.string(), // objective|subjective
    source_type: t.string(), // response|post|comment|social
    source_id: t.string(),
    contributor: t.identity().optional(), // private; absent for social
    verified_nearby: t.bool(),
    observed_at: t.timestamp(),
    expires_at: t.timestamp(),
    invalidated: t.bool(),
    dedup_key: t.string().unique(), // `${source_type}:${source_id}:${dimension}`
    svc: t.u8().index('btree'),
  }
);

// ---------- Live Pulse ----------
export const post = table(
  { name: 'post' },
  {
    id: t.u64().primaryKey().autoInc(),
    author: t.identity().index('btree'),
    attribution: t.string(), // anonymous|profile
    place_id: t.string().index('btree'),
    community: t.string(),
    text: t.string(),
    created_at: t.timestamp(),
    deleted: t.bool(),
    hidden: t.bool(),
    summary: t.string(),
    freshness_state: t.string(),
    freshness_note: t.string(),
    comment_count: t.u32(),
    claims_json: t.string().optional(),
    svc: t.u8().index('btree'),
  }
);

export const comment = table(
  { name: 'comment' },
  {
    id: t.u64().primaryKey().autoInc(),
    post_id: t.u64().index('btree'),
    author: t.identity().index('btree'),
    attribution: t.string(),
    text: t.string(),
    created_at: t.timestamp(),
    deleted: t.bool(),
    hidden: t.bool(),
    svc: t.u8().index('btree'),
  }
);

// ---------- impact / safety / infra ----------
export const impact_event = table(
  { name: 'impact_event' },
  {
    id: t.u64().primaryKey().autoInc(),
    contributor: t.identity().index('btree'),
    source_type: t.string(),
    source_id: t.string(),
    query_id: t.u64(),
    kind: t.string(), // helped|avoided_prompt
    created_at: t.timestamp(),
    dedup_key: t.string().unique(),
    svc: t.u8().index('btree'),
  }
);

export const report = table(
  { name: 'report' },
  {
    id: t.u64().primaryKey().autoInc(),
    reporter: t.identity().index('btree'),
    target_type: t.string(), // post|comment
    target_id: t.u64(),
    reason: t.string(),
    created_at: t.timestamp(),
    dedup_key: t.string().unique(),
    svc: t.u8().index('btree'),
  }
);

export const rate_bucket = table(
  { name: 'rate_bucket' },
  {
    key: t.string().primaryKey(), // `${identityHex}:${kind}:${hourWindow}`
    count: t.u32(),
  }
);

export const service_role = table(
  { name: 'service_role' },
  {
    identity: t.identity().primaryKey(),
    created_at: t.timestamp(),
    svc: t.u8().index('btree'),
  }
);

const spacetimedb = schema({
  user_profile,
  device,
  user_location,
  place,
  query,
  query_event,
  evidence_job,
  prompt_batch,
  prompt_recipient,
  prompt_response,
  observation,
  post,
  comment,
  impact_event,
  report,
  rate_bucket,
  service_role,
});
export default spacetimedb;
