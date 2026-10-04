// Views: the ONLY way clients read private data.
//
//  my_*       per-sender views (ViewContext) — a user sees only their own rows.
//  pulse_*    public anonymous views — Live Pulse posts/comments with author identity stripped.
//  svc_*      worker views — return ALL rows of a private table iff ctx.sender is in `service_role`, else nothing.
//
// Worker views are query-builder views: `service_role WHERE identity = <sender>` right-semijoined to the table on the
// constant `svc` column. The query engine maintains them incrementally (no .iter() re-scan on every change).
import { t } from 'spacetimedb/server';
import { requesterAnswer } from './lib';
import spacetimedb, {
  comment,
  answer_notification,
  device,
  evidence_job,
  impact_event,
  observation,
  post,
  prompt_batch,
  prompt_recipient,
  prompt_response,
  query,
  query_event,
  report,
  user_location,
  user_presence,
  user_profile,
  watch,
} from './schema';

// ======================= per-sender views =======================
export const my_profile = spacetimedb.view(
  { name: 'my_profile', public: true },
  t.option(user_profile.rowType),
  (ctx) => {
    const p=ctx.db.user_profile.identity.find(ctx.sender);
    return p ? {...p,username:ctx.db.demo_name.identity.find(ctx.sender)?.display_name??p.username} : undefined;
  }
);

export const my_devices = spacetimedb.view({ name: 'my_devices', public: true }, t.array(device.rowType), (ctx) => [
  ...ctx.db.device.owner.filter(ctx.sender),
]);

export const my_location = spacetimedb.view(
  { name: 'my_location', public: true },
  t.option(user_location.rowType),
  (ctx) => ctx.db.user_location.identity.find(ctx.sender) ?? undefined
);

export const my_watches = spacetimedb.view({ name: 'my_watches', public: true }, t.array(watch.rowType), (ctx) => [
  ...ctx.db.watch.owner.filter(ctx.sender),
]);

export const my_queries = spacetimedb.view({ name: 'my_queries', public: true }, t.array(query.rowType), (ctx) => [
  ...ctx.db.query.requester.filter(ctx.sender),
].map((q) => ({ ...q, answer_json: requesterAnswer(q.answer_json) })));

export const my_query_events = spacetimedb.view(
  { name: 'my_query_events', public: true },
  t.array(query_event.rowType),
  (ctx) => {
    const out = [];
    for (const q of ctx.db.query.requester.filter(ctx.sender)) {
      for (const e of ctx.db.query_event.query_id.filter(q.id)) out.push(e);
    }
    return out;
  }
);

const PromptForMe = t.row('PromptForMe', {
  batch_id: t.u64().primaryKey(),
  recipient_id: t.u64(),
  place_id: t.string(),
  place_name: t.string(),
  place_category: t.string(),
  place_address: t.string(),
  question: t.string(),
  controls_json: t.string(),
  created_at: t.timestamp(),
  expires_at: t.timestamp(),
  notified_at: t.timestamp().optional(),
  responded: t.bool(),
  expired: t.bool(),
});

// Prompts addressed to the caller. Deliberately omits job id, requester, other recipients and any query data.
export const my_prompts = spacetimedb.view({ name: 'my_prompts', public: true }, t.array(PromptForMe), (ctx) => {
  const out = [];
  for (const r of ctx.db.prompt_recipient.responder.filter(ctx.sender)) {
    const b = ctx.db.prompt_batch.id.find(r.batch_id);
    if (!b) continue;
    const pl = ctx.db.place.id.find(b.place_id);
    out.push({
      batch_id: b.id,
      recipient_id: r.id,
      place_id: b.place_id,
      place_name: pl?.name ?? '',
      place_category: pl?.category ?? '',
      place_address: pl?.address ?? '',
      question: b.question,
      controls_json: b.controls_json,
      created_at: b.created_at,
      expires_at: b.expires_at,
      notified_at: r.notified_at ?? undefined,
      responded: r.responded,
      expired: b.expired,
    });
  }
  return out;
});

export const my_impact = spacetimedb.view(
  { name: 'my_impact', public: true },
  t.array(impact_event.rowType),
  (ctx) => [...ctx.db.impact_event.contributor.filter(ctx.sender)]
);

const MyPostId = t.row('MyPostId', { post_id: t.u64().primaryKey() });
const MyCommentId = t.row('MyCommentId', { comment_id: t.u64().primaryKey() });

// "Which posts/comments are mine" — ids only, so clients compute is_mine without learning anyone else's identity.
export const my_posts = spacetimedb.view({ name: 'my_posts', public: true }, t.array(MyPostId), (ctx) => {
  const out = [];
  for (const p of ctx.db.post.author.filter(ctx.sender)) if (!p.deleted && !p.hidden) out.push({ post_id: p.id });
  return out;
});

export const my_comments = spacetimedb.view({ name: 'my_comments', public: true }, t.array(MyCommentId), (ctx) => {
  const out = [];
  for (const c of ctx.db.comment.author.filter(ctx.sender)) if (!c.deleted && !c.hidden) out.push({ comment_id: c.id });
  return out;
});

// ======================= public Live Pulse views =======================
const PulsePost = t.row('PulsePost', {
  id: t.u64().primaryKey(),
  attribution: t.string(),
  author_label: t.string(), // username when attribution='profile', otherwise "Anonymous"
  author_avatar_seed: t.string().optional(), // only when attribution='profile'
  place_id: t.string(),
  community: t.string(),
  text: t.string(),
  created_at: t.timestamp(),
  summary: t.string(),
  freshness_state: t.string(),
  freshness_note: t.string(),
  comment_count: t.u32(),
  claims_json: t.string().optional(),
  // Whether the author's location vouched for this post when it was summarised. SPEC §10's
  // ranking weights it at 0.15; without it here the client has to guess, and guessed false.
  verified_nearby: t.bool(),
});

const PulseComment = t.row('PulseComment', {
  id: t.u64().primaryKey(),
  post_id: t.u64(),
  attribution: t.string(),
  author_label: t.string(),
  author_avatar_seed: t.string().optional(),
  text: t.string(),
  created_at: t.timestamp(),
});

// NOTE: scans `post` (procedural views may .iter() in 2.10.2; re-evaluated on any post/profile change — fine at
// hackathon scale). Removed (deleted/hidden) rows are excluded; author identity is never emitted.
export const pulse_posts = spacetimedb.anonymousView({ name: 'pulse_posts', public: true }, t.array(PulsePost), (ctx) => {
  const out = [];
  // One pass over observations: which posts had a verified-nearby author. Place-level only,
  // so this exposes no coordinates (SPEC §3).
  const verifiedPosts = new Set<string>();
  for (const o of ctx.db.observation.iter()) {
    if (o.source_type === 'post' && o.verified_nearby) verifiedPosts.add(o.source_id);
  }
  for (const p of ctx.db.post.iter()) {
    if (p.deleted || p.hidden) continue;
    const prof = p.attribution === 'profile' ? ctx.db.user_profile.identity.find(p.author) : undefined;
    out.push({
      id: p.id,
      attribution: prof ? 'profile' : 'anonymous',
      author_label: prof ? ctx.db.demo_name.identity.find(prof.identity)?.display_name??prof.username : 'Anonymous',
      author_avatar_seed: prof ? prof.avatar_seed : undefined,
      place_id: p.place_id,
      community: p.community,
      text: p.text,
      created_at: p.created_at,
      summary: p.summary,
      freshness_state: p.freshness_state,
      freshness_note: p.freshness_note,
      comment_count: p.comment_count,
      claims_json: p.claims_json ?? undefined,
      verified_nearby: verifiedPosts.has(`post:${p.id}`),
    });
  }
  return out;
});

export const pulse_comments = spacetimedb.anonymousView(
  { name: 'pulse_comments', public: true },
  t.array(PulseComment),
  (ctx) => {
    const out = [];
    for (const c of ctx.db.comment.iter()) {
      if (c.deleted || c.hidden) continue;
      const parent = ctx.db.post.id.find(c.post_id);
      if (!parent || parent.deleted || parent.hidden) continue;
      const prof = c.attribution === 'profile' ? ctx.db.user_profile.identity.find(c.author) : undefined;
      out.push({
        id: c.id,
        post_id: c.post_id,
        attribution: prof ? 'profile' : 'anonymous',
        author_label: prof ? ctx.db.demo_name.identity.find(prof.identity)?.display_name??prof.username : 'Anonymous',
        author_avatar_seed: prof ? prof.avatar_seed : undefined,
        text: c.text,
        created_at: c.created_at,
      });
    }
    return out;
  }
);

// ======================= worker views (service_role only) =======================
// Each returns every row of the underlying private table when ctx.sender ∈ service_role, otherwise an empty set.
export const svc_user_profile = spacetimedb.view(
  { name: 'svc_user_profile', public: true },
  t.array(user_profile.rowType),
  (ctx) =>
    ctx.from.service_role
      .where((s) => s.identity.eq(ctx.sender))
      .rightSemijoin(ctx.from.user_profile, (s, r) => s.svc.eq(r.svc))
);

export const svc_device = spacetimedb.view({ name: 'svc_device', public: true }, t.array(device.rowType), (ctx) =>
  ctx.from.service_role
    .where((s) => s.identity.eq(ctx.sender))
    .rightSemijoin(ctx.from.device, (s, r) => s.svc.eq(r.svc))
);

export const svc_user_location = spacetimedb.view(
  { name: 'svc_user_location', public: true },
  t.array(user_location.rowType),
  (ctx) =>
    ctx.from.service_role
      .where((s) => s.identity.eq(ctx.sender))
      .rightSemijoin(ctx.from.user_location, (s, r) => s.svc.eq(r.svc))
);

export const svc_watch = spacetimedb.view({ name: 'svc_watch', public: true }, t.array(watch.rowType), (ctx) =>
  ctx.from.service_role
    .where((s) => s.identity.eq(ctx.sender))
    .rightSemijoin(ctx.from.watch, (s, r) => s.svc.eq(r.svc))
);

export const svc_query = spacetimedb.view({ name: 'svc_query', public: true }, t.array(query.rowType), (ctx) =>
  ctx.from.service_role
    .where((s) => s.identity.eq(ctx.sender))
    .rightSemijoin(ctx.from.query, (s, r) => s.svc.eq(r.svc))
);

export const svc_query_event = spacetimedb.view(
  { name: 'svc_query_event', public: true },
  t.array(query_event.rowType),
  (ctx) =>
    ctx.from.service_role
      .where((s) => s.identity.eq(ctx.sender))
      .rightSemijoin(ctx.from.query_event, (s, r) => s.svc.eq(r.svc))
);

export const svc_evidence_job = spacetimedb.view(
  { name: 'svc_evidence_job', public: true },
  t.array(evidence_job.rowType),
  (ctx) =>
    ctx.from.service_role
      .where((s) => s.identity.eq(ctx.sender))
      .rightSemijoin(ctx.from.evidence_job, (s, r) => s.svc.eq(r.svc))
);

export const svc_prompt_batch = spacetimedb.view(
  { name: 'svc_prompt_batch', public: true },
  t.array(prompt_batch.rowType),
  (ctx) =>
    ctx.from.service_role
      .where((s) => s.identity.eq(ctx.sender))
      .rightSemijoin(ctx.from.prompt_batch, (s, r) => s.svc.eq(r.svc))
);

export const svc_prompt_recipient = spacetimedb.view(
  { name: 'svc_prompt_recipient', public: true },
  t.array(prompt_recipient.rowType),
  (ctx) =>
    ctx.from.service_role
      .where((s) => s.identity.eq(ctx.sender))
      .rightSemijoin(ctx.from.prompt_recipient, (s, r) => s.svc.eq(r.svc))
);

export const svc_prompt_response = spacetimedb.view(
  { name: 'svc_prompt_response', public: true },
  t.array(prompt_response.rowType),
  (ctx) =>
    ctx.from.service_role
      .where((s) => s.identity.eq(ctx.sender))
      .rightSemijoin(ctx.from.prompt_response, (s, r) => s.svc.eq(r.svc))
);

export const svc_observation = spacetimedb.view(
  { name: 'svc_observation', public: true },
  t.array(observation.rowType),
  (ctx) =>
    ctx.from.service_role
      .where((s) => s.identity.eq(ctx.sender))
      .rightSemijoin(ctx.from.observation, (s, r) => s.svc.eq(r.svc))
);

export const svc_post = spacetimedb.view({ name: 'svc_post', public: true }, t.array(post.rowType), (ctx) =>
  ctx.from.service_role
    .where((s) => s.identity.eq(ctx.sender))
    .rightSemijoin(ctx.from.post, (s, r) => s.svc.eq(r.svc))
);

export const svc_comment = spacetimedb.view({ name: 'svc_comment', public: true }, t.array(comment.rowType), (ctx) =>
  ctx.from.service_role
    .where((s) => s.identity.eq(ctx.sender))
    .rightSemijoin(ctx.from.comment, (s, r) => s.svc.eq(r.svc))
);

export const svc_impact_event = spacetimedb.view(
  { name: 'svc_impact_event', public: true },
  t.array(impact_event.rowType),
  (ctx) =>
    ctx.from.service_role
      .where((s) => s.identity.eq(ctx.sender))
      .rightSemijoin(ctx.from.impact_event, (s, r) => s.svc.eq(r.svc))
);

export const svc_report = spacetimedb.view({ name: 'svc_report', public: true }, t.array(report.rowType), (ctx) =>
  ctx.from.service_role
    .where((s) => s.identity.eq(ctx.sender))
    .rightSemijoin(ctx.from.report, (s, r) => s.svc.eq(r.svc))
);

export const svc_user_presence = spacetimedb.view(
  { name: 'svc_user_presence', public: true }, t.array(user_presence.rowType),
  (ctx) => ctx.from.service_role.where((s) => s.identity.eq(ctx.sender))
    .rightSemijoin(ctx.from.user_presence, (s, r) => s.svc.eq(r.svc))
);

export const svc_answer_notification = spacetimedb.view(
  {name:'svc_answer_notification', public:true},t.array(answer_notification.rowType),
  ctx=>ctx.from.service_role.where(s=>s.identity.eq(ctx.sender))
    .rightSemijoin(ctx.from.answer_notification,(s,r)=>s.svc.eq(r.svc))
);
