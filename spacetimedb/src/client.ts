// Client-callable reducers. Every one validates input and throws SenderError with a clear message.
import { ScheduleAt, t } from 'spacetimedb/server';
import spacetimedb from './schema';
import {
  COMMENT_RATE_LIMIT_PER_HOUR,
  PLACE_RATE_LIMIT_PER_HOUR,
  POST_RATE_LIMIT_PER_HOUR,
  MICROS_PER_S,
  QUERY_RATE_LIMIT_PER_HOUR,
  SERVICE_QUERY_RATE_LIMIT_PER_HOUR,
  REPORT_RATE_LIMIT_PER_HOUR,
  addEvent,
  checkAttribution,
  checkBlocklist,
  checkFinite,
  checkRaw,
  checkString,
  consumeRate,
  fail,
  isPlainObject,
  isService,
  ownQuery,
  parseJson,
  requirePlace,
  requireProfile,
  requireService,
  ts,
  transitionQuery,
} from './lib';

// ---------- profile / devices / location ----------
export const heartbeat = spacetimedb.reducer({ active: t.bool() }, (ctx, { active }) => {
  requireProfile(ctx);
  if (!ctx.connectionId) fail('Foreground presence requires a connected browser');
  const key = ctx.connectionId.toHexString();
  const previous = ctx.db.user_presence.connection_id.find(key);
  if (!active) {
    if (previous) ctx.db.user_presence.connection_id.delete(key);
    return;
  }
  const next = { connection_id: key, identity: ctx.sender, last_seen_at: ctx.timestamp, svc: 0 };
  if (previous) ctx.db.user_presence.connection_id.update(next);
  else ctx.db.user_presence.insert(next);
});

export const disconnected = spacetimedb.clientDisconnected((ctx) => {
  if (ctx.connectionId) ctx.db.user_presence.connection_id.delete(ctx.connectionId.toHexString());
});

export const set_profile = spacetimedb.reducer(
  { username: t.string(), default_attribution: t.string(), avatar_seed: t.string() },
  (ctx, { username, default_attribution, avatar_seed }) => {
    if (typeof username !== 'string' || !/^[a-z0-9_]{3,20}$/.test(username)) {
      fail('username must be 3-20 characters: lowercase letters, digits, underscore');
    }
    checkAttribution(default_attribution);
    const seed = checkString('avatar_seed', avatar_seed, 1, 64);

    const holder = ctx.db.user_profile.username.find(username);
    if (holder && !holder.identity.isEqual(ctx.sender)) fail('That username is taken');

    const existing = ctx.db.user_profile.identity.find(ctx.sender);
    if (existing) {
      // Never touches is_admin / notifications_paused / created_at.
      ctx.db.user_profile.identity.update({ ...existing, username, default_attribution, avatar_seed: seed });
    } else {
      ctx.db.user_profile.insert({
        identity: ctx.sender,
        username,
        avatar_seed: seed,
        default_attribution,
        notifications_paused: false,
        is_admin: false,
        created_at: ctx.timestamp,
        svc: 0,
      });
    }
  }
);

export const set_notifications_paused = spacetimedb.reducer({ paused: t.bool() }, (ctx, { paused }) => {
  const p = requireProfile(ctx);
  ctx.db.user_profile.identity.update({ ...p, notifications_paused: paused });
});

export const register_device = spacetimedb.reducer(
  { endpoint: t.string(), p256dh: t.string(), auth: t.string(), user_agent: t.string() },
  (ctx, { endpoint, p256dh, auth, user_agent }) => {
    checkRaw('endpoint', endpoint, 8, 2048);
    if (!endpoint.startsWith('https://')) fail('endpoint must be an https:// push endpoint');
    checkRaw('p256dh', p256dh, 1, 256);
    checkRaw('auth', auth, 1, 128);
    const ua = checkRaw('user_agent', user_agent ?? '', 0, 300);

    const existing = ctx.db.device.endpoint.find(endpoint);
    if (existing) {
      // Same browser endpoint re-registering (possibly after switching accounts): the latest registrant owns it,
      // so pushes never go to a previous account's identity.
      ctx.db.device.id.update({ ...existing, owner: ctx.sender, p256dh, auth, user_agent: ua, active: true });
    } else {
      ctx.db.device.insert({
        id: 0n,
        owner: ctx.sender,
        endpoint,
        p256dh,
        auth,
        user_agent: ua,
        active: true,
        created_at: ctx.timestamp,
        svc: 0,
      });
    }
  }
);

export const deactivate_device = spacetimedb.reducer({ endpoint: t.string() }, (ctx, { endpoint }) => {
  const d = ctx.db.device.endpoint.find(endpoint);
  if (!d || !d.owner.isEqual(ctx.sender)) fail('Device not found');
  ctx.db.device.id.update({ ...d, active: false });
});

export const update_location = spacetimedb.reducer(
  { lat: t.f64(), lng: t.f64(), accuracy_m: t.f64(), source: t.string(), claimed_place_id: t.string().optional() },
  (ctx, { lat, lng, accuracy_m, source, claimed_place_id }) => {
    checkFinite('lat', lat, -90, 90);
    checkFinite('lng', lng, -180, 180);
    checkFinite('accuracy_m', accuracy_m, 0, 100_000);
    if (source !== 'gps' && source !== 'demo') fail("source must be 'gps' or 'demo'");
    // An empty string clears the claim. A non-empty one must name a place we know, so a
    // stale or hand-crafted id cannot make someone eligible for a place that does not exist.
    let claimed: string | undefined;
    if (claimed_place_id && claimed_place_id.length > 0) {
      claimed = requirePlace(ctx, checkString('claimed_place_id', claimed_place_id, 1, 200)).id;
    }
    const row = {
      identity: ctx.sender,
      lat,
      lng,
      accuracy_m,
      source,
      claimed_place_id: claimed,
      captured_at: ctx.timestamp,
      svc: 0,
    };
    if (ctx.db.user_location.identity.find(ctx.sender)) ctx.db.user_location.identity.update(row);
    else ctx.db.user_location.insert(row);
  }
);

// ---------- places ----------
// Anyone may create a place (Google Places autocomplete result / curated catalog). Existing places are only
// modified by the service identity or an admin; for everyone else a repeat upsert is a harmless no-op, so the
// web app can call this on every selection without being able to move a place for other users.
export const upsert_place = spacetimedb.reducer(
  {
    id: t.string(),
    name: t.string(),
    category: t.string(),
    lat: t.f64(),
    lng: t.f64(),
    address: t.string(),
    community: t.string(),
  },
  (ctx, args) => {
    const id = checkString('id', args.id, 1, 160);
    const name = checkString('name', args.name, 1, 120);
    const category = checkString('category', args.category, 0, 40);
    const address = checkString('address', args.address, 0, 200);
    const community = checkString('community', args.community, 1, 40);
    if (!/^[a-z0-9-]+$/.test(community)) fail('community must be lowercase letters, digits, dashes');
    checkFinite('lat', args.lat, -90, 90);
    checkFinite('lng', args.lng, -180, 180);
    checkBlocklist('name', name);

    const existing = ctx.db.place.id.find(id);
    if (existing) {
      const admin = ctx.db.user_profile.identity.find(ctx.sender)?.is_admin === true;
      if (isService(ctx) || admin) {
        ctx.db.place.id.update({ id, name, category, lat: args.lat, lng: args.lng, address, community });
      }
      return;
    }
    consumeRate(ctx, 'places', PLACE_RATE_LIMIT_PER_HOUR);
    ctx.db.place.insert({ id, name, category, lat: args.lat, lng: args.lng, address, community });
  }
);

// ---------- queries ----------
export const submit_query = spacetimedb.reducer(
  { client_request_id: t.string(), place_id: t.string(), text: t.string() },
  (ctx, { client_request_id, place_id, text }) => {
    // The service identity submits on behalf of ASI:One chat users (SPEC §9). It has no
    // profile, so it skips the profile requirement, and it gets its own hourly budget:
    // sharing one user's 10/h would starve the relay, but no cap would let anyone with an
    // ASI:One chat flood nearby users with prompts.
    const viaService = isService(ctx);
    if (!viaService) requireProfile(ctx);
    const crid = checkString('client_request_id', client_request_id, 1, 64);
    const body = checkString('text', text, 3, 300);

    const idem_key = `${ctx.sender.toHexString()}:${crid}`;
    if (ctx.db.query.idem_key.find(idem_key)) return; // idempotent retry: no new row, no rate-limit charge

    requirePlace(ctx, place_id);
    checkBlocklist('text', body);
    if (viaService) consumeRate(ctx, 'service_queries', SERVICE_QUERY_RATE_LIMIT_PER_HOUR);
    else consumeRate(ctx, 'queries', QUERY_RATE_LIMIT_PER_HOUR);

    const q = ctx.db.query.insert({
      id: 0n,
      requester: ctx.sender,
      place_id,
      text: body,
      status: 'planning',
      evidence_job_id: undefined,
      plan_json: undefined,
      clarification_json: undefined,
      clarification_choice: undefined,
      answer_json: undefined,
      created_at: ctx.timestamp,
      updated_at: ctx.timestamp,
      client_request_id: crid,
      idem_key,
      svc: 0,
    });
    addEvent(ctx, q.id, 'planning', 'Understanding your question');
  }
);

function choiceAllowed(clarificationJson: string | undefined | null, choice: string): boolean {
  if (!clarificationJson) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(clarificationJson);
  } catch {
    return true;
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.options) || parsed.options.length === 0) return true;
  for (const o of parsed.options) {
    if (typeof o === 'string' && o === choice) return true;
    if (isPlainObject(o) && [o.value, o.label, o.id].some((x) => typeof x === 'string' && x === choice)) return true;
  }
  return false;
}

export const answer_clarification = spacetimedb.reducer(
  { query_id: t.u64(), choice: t.string() },
  (ctx, { query_id, choice }) => {
    const q = ownQuery(ctx, query_id);
    const c = checkString('choice', choice, 1, 200);
    if (q.status !== 'clarifying') fail(`Query is ${q.status}, not clarifying`);
    if (!choiceAllowed(q.clarification_json, c)) fail('choice is not one of the offered options');
    transitionQuery(ctx, q, 'planning');
    ctx.db.query.id.update({ ...q, status: 'planning', clarification_choice: c, updated_at: ctx.timestamp });
    addEvent(ctx, q.id, 'planning', 'Understanding your question');
  }
);

export const cancel_query = spacetimedb.reducer({ query_id: t.u64() }, (ctx, { query_id }) => {
  const q = ownQuery(ctx, query_id);
  transitionQuery(ctx, q, 'cancelled');
  ctx.db.query.id.update({ ...q, status: 'cancelled', updated_at: ctx.timestamp });
  addEvent(ctx, q.id, 'cancelled', 'Cancelled');
});

// ---------- prompt responses ----------
// Design choice: submit_response only validates and stores the raw response. The WORKER converts responses into
// observations (worker_add_observation) because TTL clamping, dimension vocabulary and `verified_nearby`
// logic live in packages/core and must not be duplicated inside the (deterministic) module.
// answers_json format: JSON object { "<dimension_key>": "<option value>" } using the keys/values from the batch's
// controls_json (an array of { dimension_key, label, options:[{value,label,ordinal}] }).
export const submit_response = spacetimedb.reducer(
  { batch_id: t.u64(), answers_json: t.string(), note: t.string() },
  (ctx, { batch_id, answers_json, note }) => {
    const batch = ctx.db.prompt_batch.id.find(batch_id);
    if (!batch) fail('Prompt not found');

    let recipient;
    for (const r of ctx.db.prompt_recipient.batch_id.filter(batch_id)) {
      if (r.responder.isEqual(ctx.sender)) recipient = r;
    }
    if (!recipient) fail('Prompt not found'); // same message as missing: do not reveal who was asked
    if (recipient.responded) fail('You already responded to this prompt');
    if (ctx.timestamp.microsSinceUnixEpoch > batch.expires_at.microsSinceUnixEpoch) fail('This prompt has expired');

    const cleanNote = checkString('note', note ?? '', 0, 280);
    if (cleanNote) checkBlocklist('note', cleanNote);

    const answers = parseJson('answers_json', answers_json, 4000);
    if (!isPlainObject(answers) || Object.keys(answers).length === 0) {
      fail('answers_json must be a non-empty JSON object of { dimension_key: option value }');
    }
    const controls = JSON.parse(batch.controls_json) as Array<{
      dimension_key: string;
      options: Array<{ value: string }>;
    }>;
    for (const [key, value] of Object.entries(answers)) {
      const control = controls.find((c) => c.dimension_key === key);
      if (!control) fail(`Unexpected answer for '${key}'`);
      if (typeof value !== 'string' || !control.options.some((o) => o.value === value)) {
        fail(`Invalid answer for '${key}'`);
      }
    }

    const resp_key = `${batch_id}:${ctx.sender.toHexString()}`;
    if (ctx.db.prompt_response.resp_key.find(resp_key)) fail('You already responded to this prompt');
    ctx.db.prompt_response.insert({
      id: 0n,
      batch_id,
      responder: ctx.sender,
      answers_json: JSON.stringify(answers),
      note: cleanNote,
      created_at: ctx.timestamp,
      resp_key,
      svc: 0,
    });
    ctx.db.prompt_recipient.id.update({ ...recipient, responded: true });
  }
);

// ---------- Live Pulse ----------
export const create_post = spacetimedb.reducer(
  { place_id: t.string(), text: t.string(), attribution: t.string() },
  (ctx, { place_id, text, attribution }) => {
    requireProfile(ctx);
    const body = checkString('text', text, 1, 280);
    checkAttribution(attribution);
    const pl = requirePlace(ctx, place_id);
    checkBlocklist('text', body);
    consumeRate(ctx, 'posts', POST_RATE_LIMIT_PER_HOUR);
    ctx.db.post.insert({
      id: 0n,
      author: ctx.sender,
      attribution,
      place_id,
      community: pl.community,
      text: body,
      created_at: ctx.timestamp,
      deleted: false,
      hidden: false,
      summary: '',
      freshness_state: 'pending',
      freshness_note: '',
      comment_count: 0,
      claims_json: undefined,
      svc: 0,
    });
  }
);

export const create_comment = spacetimedb.reducer(
  { post_id: t.u64(), text: t.string(), attribution: t.string() },
  (ctx, { post_id, text, attribution }) => {
    requireProfile(ctx);
    const body = checkString('text', text, 1, 280);
    checkAttribution(attribution);
    const p = ctx.db.post.id.find(post_id);
    if (!p || p.deleted || p.hidden) fail('Post not found');
    checkBlocklist('text', body);
    consumeRate(ctx, 'comments', COMMENT_RATE_LIMIT_PER_HOUR);
    ctx.db.comment.insert({
      id: 0n,
      post_id,
      author: ctx.sender,
      attribution,
      text: body,
      created_at: ctx.timestamp,
      deleted: false,
      hidden: false,
      svc: 0,
    });
    ctx.db.post.id.update({ ...p, comment_count: p.comment_count + 1 });
  }
);

function invalidateContribution(ctx: any, sourceId: string) {
  for (const o of ctx.db.observation.iter()) {
    if (o.source_id !== sourceId) continue;
    if (!o.invalidated) ctx.db.observation.id.update({ ...o, invalidated: true });
    for (const impact of [...ctx.db.impact_event.iter()]) {
      if (impact.source_id === String(o.id) || impact.source_id === sourceId) ctx.db.impact_event.id.delete(impact.id);
    }
  }
}

function removePost(ctx: any, p: any, mode: 'deleted' | 'hidden') {
  invalidateContribution(ctx, `post:${p.id}`);
  for (const comment of ctx.db.comment.post_id.filter(p.id)) invalidateContribution(ctx, `comment:${comment.id}`);
  ctx.db.post.id.update({ ...p, [mode]: true, text: '', summary: '', claims_json: undefined, comment_count: 0 });
}

function removeComment(ctx: any, c: any, mode: 'deleted' | 'hidden') {
  invalidateContribution(ctx, `comment:${c.id}`);
  ctx.db.comment.id.update({ ...c, [mode]: true, text: '' });
  const p = ctx.db.post.id.find(c.post_id);
  if (p && p.comment_count > 0) ctx.db.post.id.update({ ...p, comment_count: p.comment_count - 1 });
}

export const delete_post = spacetimedb.reducer({ post_id: t.u64() }, (ctx, { post_id }) => {
  const p = ctx.db.post.id.find(post_id);
  if (!p || !p.author.isEqual(ctx.sender) || p.deleted) fail('Post not found');
  removePost(ctx, p, 'deleted');
});

export const delete_comment = spacetimedb.reducer({ comment_id: t.u64() }, (ctx, { comment_id }) => {
  const c = ctx.db.comment.id.find(comment_id);
  if (!c || !c.author.isEqual(ctx.sender) || c.deleted) fail('Comment not found');
  if (!c.hidden) removeComment(ctx, c, 'deleted');
  else ctx.db.comment.id.update({ ...c, deleted: true, text: '' });
});

export const report_content = spacetimedb.reducer(
  { target_type: t.string(), target_id: t.u64(), reason: t.string() },
  (ctx, { target_type, target_id, reason }) => {
    requireProfile(ctx);
    if (target_type !== 'post' && target_type !== 'comment') fail("target_type must be 'post' or 'comment'");
    const r = checkString('reason', reason, 1, 200);
    const target = target_type === 'post' ? ctx.db.post.id.find(target_id) : ctx.db.comment.id.find(target_id);
    if (!target || target.deleted) fail('Content not found');
    const dedup_key = `${ctx.sender.toHexString()}:${target_type}:${target_id}`;
    if (ctx.db.report.dedup_key.find(dedup_key)) fail('You already reported this');
    consumeRate(ctx, 'reports', REPORT_RATE_LIMIT_PER_HOUR);
    ctx.db.report.insert({
      id: 0n,
      reporter: ctx.sender,
      target_type,
      target_id,
      reason: r,
      created_at: ctx.timestamp,
      dedup_key,
      svc: 0,
    });
  }
);

export const admin_hide = spacetimedb.reducer(
  { target_type: t.string(), target_id: t.u64() },
  (ctx, { target_type, target_id }) => {
    const me = ctx.db.user_profile.identity.find(ctx.sender);
    if (!me || !me.is_admin) fail('Admin only');
    if (target_type === 'post') {
      const p = ctx.db.post.id.find(target_id);
      if (!p) fail('Post not found');
      if (!p.hidden) removePost(ctx, p, 'hidden');
    } else if (target_type === 'comment') {
      const c = ctx.db.comment.id.find(target_id);
      if (!c) fail('Comment not found');
      if (!c.hidden && !c.deleted) removeComment(ctx, c, 'hidden');
      else if (!c.hidden) ctx.db.comment.id.update({ ...c, hidden: true });
    } else {
      fail("target_type must be 'post' or 'comment'");
    }
  }
);

const WATCH_MAX_S = 3 * 60 * 60;
const WATCH_MIN_S = 2;

// ---------- standing watches ----------
export const create_watch = spacetimedb.reducer(
  { client_request_id: t.string(), place_id: t.string(), text: t.string(), duration_s: t.u64() },
  (ctx, { client_request_id, place_id, text, duration_s }) => {
    requireProfile(ctx);
    const crid = checkString('client_request_id', client_request_id, 1, 64);
    const body = checkString('text', text, 3, 300);
    const idem_key = `${ctx.sender.toHexString()}:${crid}`;
    if (ctx.db.watch.idem_key.find(idem_key)) return;
    requirePlace(ctx, place_id);
    checkBlocklist('text', body);
    const seconds = duration_s === 0n ? BigInt(WATCH_MAX_S) : duration_s;
    if (seconds < BigInt(WATCH_MIN_S) || seconds > BigInt(WATCH_MAX_S)) {
      fail(`duration_s must be between ${WATCH_MIN_S} and ${WATCH_MAX_S}, or 0 for the 3 hour maximum`);
    }
    let active = 0;
    for (const w of ctx.db.watch.owner.filter(ctx.sender)) {
      if (w.status === 'planning' || w.status === 'active') active += 1;
    }
    if (active >= 5) fail('You already have 5 watches running');
    consumeRate(ctx, 'watches', QUERY_RATE_LIMIT_PER_HOUR);
    const expires = ctx.timestamp.microsSinceUnixEpoch + seconds * MICROS_PER_S;
    const row = ctx.db.watch.insert({
      id: 0n,
      owner: ctx.sender,
      place_id,
      text: body,
      idem_key,
      dimension_keys_json: '[]',
      target_json: '',
      status: 'planning',
      last_value: '',
      last_notified_at: undefined,
      created_at: ctx.timestamp,
      expires_at: ts(expires),
      svc: 0,
    });
    ctx.db.watch_expiry_schedule.insert({
      scheduled_id: 0n,
      scheduled_at: ScheduleAt.time(expires),
      watch_id: row.id,
    });
  }
);

export const cancel_watch = spacetimedb.reducer({ watch_id: t.u64() }, (ctx, { watch_id }) => {
  const w = ctx.db.watch.id.find(watch_id);
  if (!w || !w.owner.isEqual(ctx.sender)) fail('Watch not found');
  if (w.status === 'cancelled' || w.status === 'expired') return;
  ctx.db.watch.id.update({ ...w, status: 'cancelled' });
});

// ---------- service role bootstrap ----------
// On new/reset DBs only the publisher recorded by init may bootstrap the service role.
// Non-destructive updates retain an existing role; no caller can claim it again.
function requireModuleOwner(ctx: any) {
  const owner = ctx.db.module_owner.id.find(0);
  if (!owner || !owner.identity.isEqual(ctx.sender)) fail('Only the recorded module owner may bootstrap service identities');
}

export const claim_service_role = spacetimedb.reducer((ctx) => {
  if (ctx.db.service_role.count() > 0n) fail('Service role has already been claimed');
  requireModuleOwner(ctx);
  ctx.db.service_role.insert({ identity: ctx.sender, created_at: ctx.timestamp, svc: 0 });
});

export const grant_service_role = spacetimedb.reducer({ identity:t.identity() }, (ctx, {identity}) => {
  requireModuleOwner(ctx);
  if (!ctx.db.service_role.identity.find(identity)) {
    ctx.db.service_role.insert({identity, created_at:ctx.timestamp, svc:0});
  }
});

export const add_service_identity = spacetimedb.reducer({ identity: t.identity() }, (ctx, { identity }) => {
  requireService(ctx);
  if (ctx.db.service_role.identity.find(identity)) return;
  ctx.db.service_role.insert({ identity, created_at: ctx.timestamp, svc: 0 });
});
