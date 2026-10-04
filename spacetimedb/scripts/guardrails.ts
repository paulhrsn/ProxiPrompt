// Re-runnable guardrail checks against a LOCAL published `proxiprompt` database.
//   pnpm --filter @proxiprompt/spacetimedb guardrails
// Every run uses fresh anonymous identities (separate WebSocket connections) and unique ids, so it can be repeated on
// the same database. The first run on a freshly published database also exercises the one-shot claim_service_role;
// the test worker token is kept in spacetimedb/.local/worker-token (git-ignored) for later runs.
import {
  connect,
  subscribe,
  eventually,
  sleep,
  errMessage,
  readWorkerToken,
  writeWorkerToken,
  DB,
  URI,
  type Client,
} from './lib.js';

type Any = any;
const run = Math.random().toString(36).slice(2, 7);
// The CLI checks below shell out to `spacetime`; point them at the same server as STDB_URI.
const CLI_SERVER = process.env.STDB_SERVER ?? 'local';
const slug = `gr-${run}`;
const nowMicros = () => BigInt(Date.now()) * 1000n;
const rows = (c: Client, table: string): Any[] => [...(c.conn.db as Any)[table].iter()];
const R = (c: Client) => c.conn.reducers as Any;

let passed = 0;
const failures: string[] = [];

async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const detail = await fn();
    passed++;
    console.log(`  ✓ ${name}${detail ? `  — ${detail}` : ''}`);
  } catch (e) {
    failures.push(`${name}: ${errMessage(e)}`);
    console.log(`  ✗ ${name}\n      ${errMessage(e)}`);
  }
}

/** Assert the promise rejects and the message matches; returns the message for the log. */
async function rejects(p: Promise<unknown>, re: RegExp): Promise<string> {
  try {
    await p;
  } catch (e) {
    const m = errMessage(e);
    if (!re.test(m)) throw new Error(`rejected, but with unexpected message: "${m}" (wanted ${re})`);
    return `rejected: "${m.replace(/^.*?(?=[A-Z])/s, '').slice(0, 90)}"`;
  }
  throw new Error('expected a rejection but the call succeeded');
}

const CONTROLS = JSON.stringify([
  {
    dimension_key: 'noise_level',
    label: 'How loud is it?',
    options: [
      { value: 'quiet', label: 'Quiet', ordinal: 1 },
      { value: 'loud', label: 'Loud', ordinal: 3 },
    ],
  },
]);

const VIEWS = [
  'my_profile',
  'my_devices',
  'my_location',
  'my_queries',
  'my_watches',
  'my_query_events',
  'my_prompts',
  'my_impact',
  'my_posts',
  'my_comments',
  'pulse_posts',
  'pulse_comments',
  'place',
];

async function newUser(tag: string, opts: { profile?: boolean; location?: boolean } = {}): Promise<Client & { username: string }> {
  const c = (await connect()) as Client & { username: string };
  c.username = `${tag}_${run}`;
  await subscribe(c, VIEWS.map((v) => `SELECT * FROM ${v}`));
  if (opts.profile !== false) {
    await R(c).setProfile({ username: c.username, defaultAttribution: 'anonymous', avatarSeed: `seed-${tag}` });
  }
  if (opts.location !== false) {
    await R(c).updateLocation({ lat: 42.27531, lng: -83.73781, accuracyM: 12, source: 'demo' });
  }
  return c;
}

const clients: Client[] = [];
let PUB: Client; // anonymous public viewer, created in the Live Pulse section
const track = <T extends Client>(c: T): T => (clients.push(c), c);

console.log(`Guardrail checks against ${URI}/${DB}  (run ${run})\n`);

// ============================================================================================
console.log('Setup');
const A = track(await newUser('a')); // requester
const B = track(await newUser('b')); // recipient
const C = track(await newUser('c')); // recipient
const D = track(await newUser('d', { location: false })); // profile, no location
const E = track(await newUser('e', { profile: false, location: false })); // no profile
const R3 = track(await newUser('r3'));
const R4 = track(await newUser('r4'));
const R5 = track(await newUser('r5'));
const R6 = track(await newUser('r6'));

// ============================================================================================
console.log('\nProfiles');
await check('profile creation + my_profile returns only own row', async () => {
  const mine = await eventually(() => rows(A, 'myProfile')[0], 3000, 'A profile');
  if (mine.username !== A.username) throw new Error('wrong profile');
  if (rows(A, 'myProfile').length !== 1) throw new Error('expected exactly 1 profile row');
  if (rows(B, 'myProfile')[0]?.username === A.username) throw new Error('B sees A profile');
  return `A sees "${mine.username}", is_admin=${mine.isAdmin}`;
});
await check('duplicate username (other identity) rejected', () =>
  rejects(R(D).setProfile({ username: A.username, defaultAttribution: 'anonymous', avatarSeed: 'x' }), /taken/));
await check('invalid username rejected', () =>
  rejects(R(D).setProfile({ username: 'Bad Name!', defaultAttribution: 'anonymous', avatarSeed: 'x' }), /username must be/));
await check('invalid default_attribution rejected', () =>
  rejects(R(D).setProfile({ username: `dd_${run}`, defaultAttribution: 'public', avatarSeed: 'x' }), /attribution/));
await check('submit_query without profile rejected', () =>
  rejects(R(E).submitQuery({ clientRequestId: 'x1', placeId: slug, text: 'Is it busy?' }), /profile/));

// ============================================================================================
console.log('\nLocation + places');
await check('update_location validates ranges and source', async () => {
  const m1 = await rejects(R(A).updateLocation({ lat: 91, lng: 0, accuracyM: 1, source: 'gps' }), /lat/);
  await rejects(R(A).updateLocation({ lat: 0, lng: 181, accuracyM: 1, source: 'gps' }), /lng/);
  await rejects(R(A).updateLocation({ lat: 0, lng: 0, accuracyM: 1, source: 'wifi' }), /source/);
  await rejects(R(A).updateLocation({ lat: NaN, lng: 0, accuracyM: 1, source: 'gps' }), /finite/);
  return m1;
});
await check('update_location rejects a claimed building that is not a known place', async () => {
  return await rejects(
    R(A).updateLocation({ lat: 42.2753, lng: -83.7378, accuracyM: 12, source: 'gps', claimedPlaceId: 'no-such-building' }),
    /Unknown place/,
  );
});
await check('upsert_place inserts; re-upsert by non-privileged user cannot move it', async () => {
  const args = { id: slug, name: 'Guardrail Library', category: 'library', lat: 42.2753, lng: -83.7378, address: '1 Test St', community: 'umich-annarbor' };
  await R(A).upsertPlace(args);
  await eventually(() => rows(A, 'place').find((p) => p.id === slug), 3000, 'place row');
  await R(B).upsertPlace({ ...args, lat: 10, lng: 10, name: 'Hijacked' });
  await sleep(250);
  const p = rows(B, 'place').find((x) => x.id === slug)!;
  if (p.name !== 'Guardrail Library' || p.lat !== 42.2753) throw new Error('place was modified by non-privileged user');
});
await check('private location is not readable by clients (no public table, other user view empty)', async () => {
  if (rows(B, 'myLocation').length !== 1) throw new Error('B should see its own location only');
  if (rows(D, 'myLocation').length !== 0) throw new Error('D has no location; must see none (not others)');
  const c = track(await connect());
  return rejects(subscribe(c, ['SELECT * FROM user_location']), /no such table|private/i);
});

// ============================================================================================
console.log('\nQueries: creation, idempotency, privacy, rate limit');
let q1 = 0n;
await check('submit_query creates a "planning" query + "Understanding your question" event', async () => {
  await R(A).submitQuery({ clientRequestId: 'req-1', placeId: slug, text: 'Is there a quiet seat right now?' });
  const q = await eventually(() => rows(A, 'myQueries').find((x) => x.clientRequestId === 'req-1'), 3000, 'query row');
  q1 = q.id;
  if (q.status !== 'planning') throw new Error(`status=${q.status}`);
  const ev = await eventually(() => rows(A, 'myQueryEvents').filter((e) => e.queryId === q1), 3000, 'event');
  if (ev[0].message !== 'Understanding your question') throw new Error(`event=${ev[0].message}`);
  return `query #${q1} status=${q.status}, event="${ev[0].message}"`;
});
await check('duplicate client_request_id is idempotent (no 2nd row, no 2nd event)', async () => {
  await R(A).submitQuery({ clientRequestId: 'req-1', placeId: slug, text: 'Is there a quiet seat right now?' });
  await sleep(300);
  const n = rows(A, 'myQueries').filter((x) => x.clientRequestId === 'req-1').length;
  const ev = rows(A, 'myQueryEvents').filter((e) => e.queryId === q1).length;
  if (n !== 1 || ev !== 1) throw new Error(`queries=${n} events=${ev}`);
  return 'still 1 query / 1 event after retry';
});
await check('same client_request_id from ANOTHER identity creates a separate query', async () => {
  await R(B).submitQuery({ clientRequestId: 'req-1', placeId: slug, text: 'Is the lobby crowded?' });
  await eventually(() => rows(B, 'myQueries').length === 1, 3000, 'B query');
});
await check('text length / unknown place validated', async () => {
  await rejects(R(A).submitQuery({ clientRequestId: 'r-short', placeId: slug, text: 'hi' }), /text/);
  await rejects(R(A).submitQuery({ clientRequestId: 'r-long', placeId: slug, text: 'x'.repeat(301) }), /text/);
  return rejects(R(A).submitQuery({ clientRequestId: 'r-place', placeId: 'nope-nowhere', text: 'Is it busy?' }), /Unknown place/);
});
await check("other users cannot see or cancel A's query", async () => {
  if (rows(C, 'myQueries').length !== 0) throw new Error('C sees queries that are not theirs');
  if (rows(C, 'myQueryEvents').length !== 0) throw new Error('C sees foreign events');
  return rejects(R(C).cancelQuery({ queryId: q1 }), /not found/);
});
await check('query rate limit: 10/h, 11th rejected', async () => {
  const F = track(await newUser('f', { location: false }));
  for (let i = 0; i < 10; i++) await R(F).submitQuery({ clientRequestId: `rl-${i}`, placeId: slug, text: `Question number ${i}` });
  return rejects(R(F).submitQuery({ clientRequestId: 'rl-10', placeId: slug, text: 'One too many' }), /Rate limit/);
});

// ============================================================================================
console.log('\nService role + worker authorization');
const workerToken = readWorkerToken();
let W = track(await connect(workerToken));
if (!workerToken) writeWorkerToken(W.token);
let claimedNow = false;
await check('owner-gated bootstrap rejects ordinary clients and authorizes the persistent worker', async () => {
  await rejects(R(A).grantServiceRole({identity:A.identity}), /recorded module owner/);
  try {
    await R(W).workerEnsureGc({});
  } catch (error) {
    if (!/Only the service/.test(errMessage(error))) throw error;
    // On a reset DB this proves the window before owner provisioning is closed.
    await rejects(R(A).claimServiceRole({}), /recorded module owner/);
    await rejects(R(W).claimServiceRole({}), /recorded module owner/);
    const {execFile}=await import('node:child_process');
    const {promisify}=await import('node:util');
    await promisify(execFile)('spacetime',['call','--server',CLI_SERVER,DB,'grant_service_role',JSON.stringify(W.hex),'-y'],{timeout:20000});
    await R(W).workerEnsureGc({});
    claimedNow=true;
  }
  await rejects(R(W).claimServiceRole({}), /already been claimed/);
  return claimedNow ? 'only publishing owner granted the service role' : 'existing authorized worker retained';
});
await check('service identity query relay is capped at 60/h', async () => {
  // Loops until rejected so a re-run inside the same hour (budget partly spent) still passes.
  for (let i = 0; i <= 60; i++) {
    const r = await R(W).submitQuery({ clientRequestId: `svc-rl-${run}-${i}`, placeId: slug, text: `Relay question ${i}` }).then(
      () => '',
      (e: Error) => errMessage(e),
    );
    if (/Rate limit reached: at most 60 service_queries/.test(r)) return `rejected after ${i} accepted this run`;
    if (r) throw new Error(`unexpected error: ${r}`);
  }
  throw new Error('61 relayed queries accepted in one hour');
});
await check('second identity cannot claim_service_role', () => rejects(R(D).claimServiceRole({}), /already been claimed/));
await check('non-service identity cannot add_service_identity', () =>
  rejects(R(D).addServiceIdentity({ identity: D.identity }), /Only the service/));
await check('worker-only reducers reject a non-service identity (all of them)', async () => {
  const calls: Array<[string, Any]> = [
    ['workerSetQueryPlan', { queryId: q1, planJson: '{}' }],
    ['workerSetQueryStatus', { queryId: q1, status: 'collecting' }],
    ['workerAddQueryEvent', { queryId: q1, kind: 'k', message: 'm' }],
    ['workerSetClarification', { queryId: q1, clarificationJson: '{"question":"q"}' }],
    ['workerCreateJob', { clientKey: 'abcdefghij', placeId: slug, intentKey: 'k', dimensionKeysJson: '["a"]', planJson: '{}', deadlineAtMicros: nowMicros() + 60_000_000n }],
    ['workerAttachQuery', { queryId: q1, jobId: 1n }],
    ['workerMergeJobPlan', {jobId:1n, planJson:'{}', dimensionKeysJson:'[]'}],
    ['workerDeactivateDevice', {deviceId:1n}],
    ['workerSetJobStatus', { jobId: 1n, status: 'done', confidenceJson: '' }],
    ['workerCreatePromptBatch', { jobId: 1n, question: 'q', controlsJson: CONTROLS, expiresAtMicros: nowMicros() + 60_000_000n, recipientIdentitiesJson: '[]' }],
    ['workerMarkNotified', { recipientId: 1n }],
    ['workerAddObservation', { placeId: slug, dimension: 'noise_level', value: 'quiet', valueLabel: 'Quiet', ordinal: 1, kind: 'objective', sourceType: 'response', sourceId: 'x', contributor: undefined, verifiedNearby: true, observedAtMicros: nowMicros(), expiresAtMicros: nowMicros() + 900_000_000n }],
    ['workerInvalidateObservation', { observationId: 1n }],
    ['workerSetAnswer', { queryId: q1, answerJson: '{}', status: 'answered' }],
    ['workerMarkAnswerNotification', {key:'no-such',outcome:'sent'}],
    ['workerSetPostSummary', { postId: 1n, summary: 's', claimsJson: '[]', freshnessState: 'fresh', freshnessNote: '' }],
    ['workerRecordImpact', { contributor: D.identity, sourceType: 'response', sourceId: 'x', queryId: q1, kind: 'helped' }],
    ['workerSetAdmin', { identity: D.identity, isAdmin: true }],
    ['workerArmWatch', { watchId: 1n, dimensionKeysJson: '["noise_level"]', targetJson: '{}' }],
    ['workerNoteWatch', { watchId: 1n, lastValue: 'Quiet' }],
    ['workerRetireWatch', { watchId: 1n, reason: 'not watchable' }],
    ['workerEnsureGc', {}],
    ['workerCollectGarbage', {}],
  ];
  for (const [name, args] of calls) {
    const m = await rejects(R(D)[name](args), /Only the service/);
    void m;
  }
  return `${calls.length}/${calls.length} worker reducers rejected for a non-service sender`;
});

// ---- worker read mechanism: svc_* views ----
await subscribe(W, [
  'svc_user_profile', 'svc_device', 'svc_user_location', 'svc_user_presence', 'svc_query', 'svc_answer_notification', 'svc_query_event', 'svc_evidence_job',
  'svc_prompt_batch', 'svc_prompt_recipient', 'svc_prompt_response', 'svc_observation', 'svc_post', 'svc_comment',
  'svc_impact_event', 'svc_report', 'svc_watch',
].map((v) => `SELECT * FROM ${v}`));
await check('foreground presence is connection-scoped, private, and removed on disconnect', async () => {
  const c1 = track(await newUser('fg'));
  const c2 = track(await connect(c1.token));
  await R(c1).heartbeat({ active: true });
  await R(c2).heartbeat({ active: true });
  const mine = () => rows(W, 'svcUserPresence').filter(p => p.identity.toHexString() === c1.hex);
  await eventually(() => mine().length === 2, 3000, 'two foreground connections');
  await R(c1).heartbeat({ active: false });
  await eventually(() => mine().length === 1, 3000, 'only hidden connection removed');
  c2.conn.disconnect();
  await eventually(() => mine().length === 0, 3000, 'disconnected connection removed');
  await rejects(R(E).heartbeat({ active: true }), /profile/);
  await subscribe(D, ['SELECT * FROM svc_user_presence']);
  if (rows(D, 'svcUserPresence').length) throw new Error('ordinary user can see foreground identities');
  await rejects(subscribe(track(await connect()), ['SELECT * FROM user_presence']), /no such table|private/i);
});
await check('worker read: svc_* views return ALL private rows to the service identity', async () => {
  const locs = rows(W, 'svcUserLocation').length;
  const qs = rows(W, 'svcQuery');
  const profiles = rows(W, 'svcUserProfile').length;
  if (locs < 7) throw new Error(`expected >=7 locations, got ${locs}`);
  if (!qs.some((q) => q.id === q1 && q.requester.toHexString() === A.hex)) throw new Error('worker cannot see A query with requester identity');
  return `locations=${locs}, queries=${qs.length}, profiles=${profiles} (incl. requester identities)`;
});
await check('worker views return NOTHING to a non-service identity', async () => {
  const c = track(await connect());
  await subscribe(c, ['svc_user_location', 'svc_query', 'svc_prompt_response', 'svc_observation', 'svc_post', 'svc_device', 'svc_answer_notification'].map((v) => `SELECT * FROM ${v}`));
  const total = ['svcUserLocation', 'svcQuery', 'svcPromptResponse', 'svcObservation', 'svcPost', 'svcDevice', 'svcAnswerNotification'].reduce((n, t) => n + rows(c, t).length, 0);
  if (total !== 0) throw new Error(`non-service identity received ${total} rows`);
  // And the same for A, who owns data in those tables:
  await subscribe(A, ['SELECT * FROM svc_query', 'SELECT * FROM svc_user_location', 'SELECT * FROM svc_answer_notification']);
  if (rows(A, 'svcQuery').length !== 0 || rows(A, 'svcUserLocation').length !== 0 || rows(A, 'svcAnswerNotification').length !== 0) throw new Error('A can read worker views');
  return '0 rows for an anonymous identity and for A (who owns rows)';
});
await check('private base tables cannot be subscribed to by clients', async () => {
  const names = ['query', 'prompt_response', 'observation', 'device', 'post', 'comment', 'user_profile', 'service_role', 'module_owner', 'user_presence', 'answer_notification'];
  for (const n of names) {
    const c = track(await connect());
    await rejects(subscribe(c, [`SELECT * FROM ${n}`]), /no such table|private/i);
  }
  return `${names.length} private tables rejected`;
});
await check('worker view is incremental: new query appears in worker subscription live', async () => {
  const seen = new Promise<void>((res) => (W.conn.db as Any).svcQuery.onInsert((_c: Any, row: Any) => row.clientRequestId === 'live-1' && res()));
  await R(A).submitQuery({ clientRequestId: 'live-1', placeId: slug, text: 'Live delta test question' });
  await Promise.race([seen, sleep(4000).then(() => { throw new Error('no live delta received'); })]);
});

// ============================================================================================
console.log('\nQuery state machine');
let q2 = 0n; // clarification path
let q3 = 0n; // refused path
await check('seed more queries (clarify path, refuse path)', async () => {
  await R(A).submitQuery({ clientRequestId: 'req-2', placeId: slug, text: 'Is it worth going there today?' });
  await R(A).submitQuery({ clientRequestId: 'req-3', placeId: slug, text: 'Where does that student live?' });
  q2 = (await eventually(() => rows(A, 'myQueries').find((x) => x.clientRequestId === 'req-2'), 3000)).id;
  q3 = (await eventually(() => rows(A, 'myQueries').find((x) => x.clientRequestId === 'req-3'), 3000)).id;
});
await check('invalid transition rejected: planning -> answered', () =>
  rejects(R(W).workerSetQueryStatus({ queryId: q1, status: 'answered' }), /Invalid query transition planning -> answered/));
await check('unknown status rejected', () => rejects(R(W).workerSetQueryStatus({ queryId: q1, status: 'banana' }), /Unknown query status/));
await check('answer_clarification rejected when not clarifying', () =>
  rejects(R(A).answerClarification({ queryId: q1, choice: 'Quiet' }), /not clarifying/));
await check('planning -> clarifying (worker), choice must be an offered option, requester only', async () => {
  await R(W).workerSetClarification({ queryId: q2, clarificationJson: JSON.stringify({ question: 'Quiet study or group work?', options: ['Quiet study', 'Group work'] }) });
  await eventually(() => rows(A, 'myQueries').find((q) => q.id === q2 && q.status === 'clarifying'), 3000, 'clarifying');
  await rejects(R(A).answerClarification({ queryId: q2, choice: 'Skydiving' }), /offered options/);
  await rejects(R(B).answerClarification({ queryId: q2, choice: 'Quiet study' }), /not found/);
  await R(A).answerClarification({ queryId: q2, choice: 'Quiet study' });
  const q = await eventually(() => rows(A, 'myQueries').find((x) => x.id === q2 && x.status === 'planning'), 3000, 'back to planning');
  if (q.clarificationChoice !== 'Quiet study') throw new Error('choice not stored');
  return 'clarifying -> planning, choice stored';
});
await check('requester cancels (planning -> cancelled); cancelling again / further transitions rejected', async () => {
  await R(A).cancelQuery({ queryId: q2 });
  await eventually(() => rows(A, 'myQueries').find((x) => x.id === q2 && x.status === 'cancelled'), 3000, 'cancelled');
  await rejects(R(A).cancelQuery({ queryId: q2 }), /Invalid query transition cancelled -> cancelled/);
  return rejects(R(W).workerSetQueryStatus({ queryId: q2, status: 'collecting' }), /Invalid query transition cancelled -> collecting/);
});
await check('planning -> refused is allowed; refused -> planning rejected', async () => {
  await R(W).workerSetAnswer({ queryId: q3, answerJson: '{"reason":"private individual"}', status: 'refused' });
  await eventually(() => rows(A, 'myQueries').find((x) => x.id === q3 && x.status === 'refused'), 3000, 'refused');
  return rejects(R(W).workerSetQueryStatus({ queryId: q3, status: 'planning' }), /Invalid query transition refused -> planning/);
});
await check('worker_set_answer rejects non-answer statuses', () =>
  rejects(R(W).workerSetAnswer({ queryId: q1, answerJson: '{}', status: 'collecting' }), /status must be/));

// ============================================================================================
console.log('\nJobs, prompt batches, recipient guardrails');
let job = 0n;
let batch1 = 0n;
const key = `job-${run}-aaaa`;
await check('worker_create_job: row found via subscription by client_key; retry with same key is a no-op', async () => {
  const args = { clientKey: key, placeId: slug, intentKey: 'quiet_study', dimensionKeysJson: '["noise_level","seating_availability"]', planJson: '{"p":1}', deadlineAtMicros: nowMicros() + 120_000_000n };
  await R(W).workerCreateJob(args);
  const j = await eventually(() => rows(W, 'svcEvidenceJob').find((x) => x.clientKey === key), 3000, 'job row');
  job = j.id;
  await R(W).workerCreateJob(args);
  await sleep(250);
  if (rows(W, 'svcEvidenceJob').filter((x) => x.clientKey === key).length !== 1) throw new Error('duplicate job created');
  return `job #${job} status=${j.status}`;
});
await check('worker_attach_query (idempotent) + status planning -> collecting', async () => {
  await R(W).workerAttachQuery({ queryId: q1, jobId: job });
  await R(W).workerAttachQuery({ queryId: q1, jobId: job });
  await R(W).workerSetQueryStatus({ queryId: q1, status: 'collecting' });
  await eventually(() => rows(A, 'myQueries').find((x) => x.id === q1 && x.status === 'collecting' && x.evidenceJobId === job), 3000, 'collecting');
});
await check('invalid transition rejected: collecting -> planning', () =>
  rejects(R(W).workerSetQueryStatus({ queryId: q1, status: 'planning' }), /Invalid query transition collecting -> planning/));

const batchArgs = (ids: Client[], extra: Any = {}) => ({
  jobId: job,
  question: 'Quick question about Guardrail Library: how loud is it?',
  controlsJson: CONTROLS,
  expiresAtMicros: nowMicros() + 120_000_000n,
  recipientIdentitiesJson: JSON.stringify(ids.map((c) => c.hex)),
  ...extra,
});
await check('requester cannot be a recipient of their own job', () =>
  rejects(R(W).workerCreatePromptBatch(batchArgs([A])), /requester/));
await check('recipient without a fresh location rejected (no location row)', () =>
  rejects(R(W).workerCreatePromptBatch(batchArgs([D])), /no location/));
await check('recipient without a profile rejected', () =>
  rejects(R(W).workerCreatePromptBatch(batchArgs([E])), /no profile|no location/));
await check('recipient who paused notifications rejected', async () => {
  await R(R6).setNotificationsPaused({ paused: true });
  const m = await rejects(R(W).workerCreatePromptBatch(batchArgs([R6])), /paused notifications/);
  await R(R6).setNotificationsPaused({ paused: false });
  return m;
});
await check('invalid controls / past expiry / duplicate in request rejected', async () => {
  await rejects(R(W).workerCreatePromptBatch(batchArgs([B], { controlsJson: '[]' })), /controls_json/);
  await rejects(R(W).workerCreatePromptBatch(batchArgs([B], { expiresAtMicros: nowMicros() - 1_000_000n })), /future/);
  return rejects(R(W).workerCreatePromptBatch(batchArgs([B, B])), /Duplicate recipient/);
});
await check('batch to B and C accepted; job.recipients_count = 2', async () => {
  await R(W).workerCreatePromptBatch(batchArgs([B, C]));
  const b = await eventually(() => rows(W, 'svcPromptBatch').find((x) => x.jobId === job), 3000, 'batch');
  batch1 = b.id;
  const j = await eventually(() => rows(W, 'svcEvidenceJob').find((x) => x.id === job && x.recipientsCount === 2), 3000, 'count');
  return `batch #${batch1}, recipients_count=${j.recipientsCount}`;
});
await check('duplicate recipient across batches of one job rejected', () =>
  rejects(R(W).workerCreatePromptBatch(batchArgs([B])), /already asked/));
await check('max 20 recipients per job: 2 + 18 ok, 21st rejected', async () => {
  const extra: Client[] = [];
  for (let i = 0; i < 15; i++) extra.push(track(await newUser(`cap${i}`)));
  await R(W).workerCreatePromptBatch(batchArgs([R3, R4, R5, ...extra]));
  await eventually(() => rows(W, 'svcEvidenceJob').find((x) => x.id === job && x.recipientsCount === 20), 5000, 'count=20');
  return rejects(R(W).workerCreatePromptBatch(batchArgs([R6])), /at most 20 recipients/);
});
await check("a recipient's own query cannot be attached to the job they were asked about", async () => {
  await eventually(() => rows(B, 'myQueries').length >= 1, 3000);
  const bq = rows(B, 'myQueries')[0].id;
  return rejects(R(W).workerAttachQuery({ queryId: bq, jobId: job }), /already a recipient/);
});

// ============================================================================================
console.log('\nPrompt responses');
await check("my_prompts: recipients see only their own prompt; requester & outsiders see none; no identity fields", async () => {
  const p = await eventually(() => rows(B, 'myPrompts')[0], 3000, 'B prompt');
  await eventually(() => rows(C, 'myPrompts').length === 1, 3000, 'C prompt');
  if (rows(A, 'myPrompts').length !== 0) throw new Error('requester sees a prompt');
  if (rows(D, 'myPrompts').length !== 0) throw new Error('outsider sees a prompt');
  const keys = Object.keys(p).sort().join(',');
  if (/requester|job|responder|owner|author/i.test(keys)) throw new Error(`prompt exposes identity-ish fields: ${keys}`);
  return `prompt fields: ${keys}`;
});
await check('non-recipient submit_response rejected (outsider and requester)', async () => {
  const m = await rejects(R(D).submitResponse({ batchId: batch1, answersJson: '{"noise_level":"quiet"}', note: '' }), /Prompt not found/);
  await rejects(R(A).submitResponse({ batchId: batch1, answersJson: '{"noise_level":"quiet"}', note: '' }), /Prompt not found/);
  return m;
});
await check('invalid answers rejected (unknown option / unknown dimension / not JSON / note too long)', async () => {
  await rejects(R(B).submitResponse({ batchId: batch1, answersJson: '{"noise_level":"deafening"}', note: '' }), /Invalid answer/);
  await rejects(R(B).submitResponse({ batchId: batch1, answersJson: '{"crowd_level":"quiet"}', note: '' }), /Unexpected answer/);
  await rejects(R(B).submitResponse({ batchId: batch1, answersJson: 'nope', note: '' }), /valid JSON/);
  return rejects(R(B).submitResponse({ batchId: batch1, answersJson: '{"noise_level":"quiet"}', note: 'x'.repeat(281) }), /note/);
});
await check('recipient responds once; second response rejected', async () => {
  await R(B).submitResponse({ batchId: batch1, answersJson: '{"noise_level":"quiet"}', note: 'Quiet corner on 2nd floor' });
  const m = await rejects(R(B).submitResponse({ batchId: batch1, answersJson: '{"noise_level":"loud"}', note: '' }), /already responded/);
  const resp = await eventually(() => rows(W, 'svcPromptResponse').filter((r) => r.batchId === batch1), 3000, 'response');
  if (resp.length !== 1) throw new Error(`expected 1 response row, got ${resp.length}`);
  const rec = rows(W, 'svcPromptRecipient').find((r) => r.batchId === batch1 && r.responder.toHexString() === B.hex);
  if (!rec?.responded) throw new Error('recipient not marked responded');
  return `${m}; worker sees 1 response (${resp[0].answersJson}) from ${resp[0].responder.toHexString().slice(0, 10)}…`;
});
await check('response after prompt expiry rejected', async () => {
  const j2key = `job2-${run}-bbbb`;
  await R(W).workerCreateJob({ clientKey: j2key, placeId: slug, intentKey: 'x', dimensionKeysJson: '["noise_level"]', planJson: '{}', deadlineAtMicros: nowMicros() + 60_000_000n });
  const j2 = (await eventually(() => rows(W, 'svcEvidenceJob').find((x) => x.clientKey === j2key), 3000)).id;
  await R(W).workerCreatePromptBatch({ jobId: j2, question: 'Short-lived question?', controlsJson: CONTROLS, expiresAtMicros: nowMicros() + 1_500_000n, recipientIdentitiesJson: JSON.stringify([R6.hex]) });
  const b2 = (await eventually(() => rows(W, 'svcPromptBatch').find((x) => x.jobId === j2), 3000)).id;
  await sleep(2000);
  return rejects(R(R6).submitResponse({ batchId: b2, answersJson: '{"noise_level":"quiet"}', note: '' }), /expired/);
});
await check('the database marks a prompt expired on its own clock', async () => {
  const key = `expiry-mark-${run}-job`;
  await R(W).workerCreateJob({
    clientKey: key, placeId: slug, intentKey: 'x', dimensionKeysJson: '["noise_level"]', planJson: '{}',
    deadlineAtMicros: nowMicros() + 120_000_000n,
  });
  const jobId = (await eventually(() => rows(W, 'svcEvidenceJob').find((x) => x.clientKey === key), 3000, 'expiry job')).id;
  await R(W).workerCreatePromptBatch({
    jobId, question: 'Will this card close itself?', controlsJson: CONTROLS,
    expiresAtMicros: nowMicros() + 2_000_000n, recipientIdentitiesJson: JSON.stringify([R6.hex]),
  });
  await eventually(
    () => rows(W, 'svcPromptBatch').find((x) => x.jobId === jobId && x.expired === true),
    12_000,
    'prompt expired',
  );
  return 'expired without an orchestrator';
});

// ============================================================================================
console.log('\nObservations, impact, answer, job lifecycle');
await check('worker_add_observation stores contributor privately; dedup makes retries idempotent; non-service blocked', async () => {
  const o = (src: string, extra: Any = {}) => ({
    placeId: slug, dimension: 'noise_level', value: 'quiet', valueLabel: 'Quiet', ordinal: 1, kind: 'objective',
    sourceType: 'response', sourceId: src, contributor: B.identity, verifiedNearby: true,
    observedAtMicros: nowMicros(), expiresAtMicros: nowMicros() + 900_000_000n, ...extra,
  });
  await R(W).workerAddObservation(o('resp-1'));
  await R(W).workerAddObservation(o('resp-1'));
  await sleep(250);
  const obs = rows(W, 'svcObservation').filter((x) => x.sourceId === 'resp-1');
  if (obs.length !== 1) throw new Error(`dedup failed: ${obs.length}`);
  await rejects(R(W).workerAddObservation(o('resp-2', { kind: 'weird' })), /kind/);
  await rejects(R(W).workerAddObservation(o('resp-3', { expiresAtMicros: nowMicros() + 999_999_000_000n })), /TTL/);
  await R(W).workerInvalidateObservation({ observationId: obs[0].id });
  await eventually(() => rows(W, 'svcObservation').find((x) => x.id === obs[0].id && x.invalidated), 3000, 'invalidated');
  return 'dedup ok, invalid kind/TTL rejected, invalidate ok';
});
await check('impact events: private per contributor (my_impact), idempotent', async () => {
  const a = { contributor: B.identity, sourceType: 'response', sourceId: 'resp-1', queryId: q1, kind: 'helped' };
  await R(W).workerRecordImpact(a);
  await R(W).workerRecordImpact(a);
  await eventually(() => rows(B, 'myImpact').length === 1, 3000, 'B impact');
  await sleep(200);
  if (rows(B, 'myImpact').length !== 1) throw new Error('dedup failed');
  if (rows(C, 'myImpact').length !== 0 || rows(A, 'myImpact').length !== 0) throw new Error('impact leaked to others');
});
await check('job: collecting -> synthesizing ok; back to collecting rejected; prompts blocked once not collecting', async () => {
  await R(W).workerSetJobStatus({ jobId: job, status: 'synthesizing', confidenceJson: '{"score":0.7,"level":"High"}' });
  await rejects(R(W).workerSetJobStatus({ jobId: job, status: 'collecting', confidenceJson: '' }), /Invalid job transition/);
  return rejects(R(W).workerCreatePromptBatch(batchArgs([R6])), /prompts can only be created while collecting/);
});
await check('answer lifecycle: collecting -> answered, answered -> answered ok, answered -> cancelled rejected', async () => {
  await R(W).workerSetAnswer({ queryId: q1, answerJson: '{"headline":"Quiet","recommendation":"go"}', status: 'answered' });
  await R(W).workerSetAnswer({ queryId: q1, answerJson: '{"headline":"Quiet (updated)","recommendation":"go"}', status: 'answered' });
  const q = await eventually(() => rows(A, 'myQueries').find((x) => x.id === q1 && x.answerJson?.includes('updated')), 3000, 'answer');
  if (q.status !== 'answered') throw new Error(q.status);
  return rejects(R(A).cancelQuery({ queryId: q1 }), /Invalid query transition answered -> cancelled/);
});

await check('requester answer payload strips responder identities while preserving readable sources', async () => {
  const secret = B.hex;
  await R(W).workerSetAnswer({ queryId: q1, status: 'answered', answerJson: JSON.stringify({
    headline: 'Quiet', confidence: { level: 'Medium' }, sourceCount: 1,
    factors: { contributorIds: [secret], observations: [{ id: 'example', dimension: 'noise_level',
      valueLabel: 'Quiet', sourceType: 'response', weight: 1, contributorId: secret }] },
    internal: { responder: secret },
  }) });
  const answer = await eventually(() => {
    const json = rows(A, 'myQueries').find(q => q.id === q1)?.answerJson;
    return json && JSON.parse(json).factors ? json : undefined;
  }, 3000, 'safe requester answer');
  if (answer.includes(secret) || /contributorId/.test(answer)) throw new Error('responder identity leaked');
  if (JSON.parse(answer).factors.observations[0].valueLabel !== 'Quiet') throw new Error('readable sources lost');
});
// ============================================================================================
console.log('\nLive Pulse: anonymity, ownership, moderation');
let pA = 0n, pB = 0n;
await check('create_post (anonymous + profile); validation + blocklist', async () => {
  await rejects(R(A).createPost({ placeId: slug, text: '', attribution: 'anonymous' }), /text/);
  await rejects(R(A).createPost({ placeId: slug, text: 'x'.repeat(281), attribution: 'anonymous' }), /text/);
  await rejects(R(A).createPost({ placeId: slug, text: 'kys loser', attribution: 'anonymous' }), /not allowed/);
  await rejects(R(A).createPost({ placeId: slug, text: 'hi', attribution: 'friends' }), /attribution/);
  await R(A).createPost({ placeId: slug, text: 'Third floor is calm right now', attribution: 'anonymous' });
  await R(B).createPost({ placeId: slug, text: 'Main floor is packed', attribution: 'profile' });
});
await check('public pulse_posts hides author identity; anonymous shows "Anonymous", profile shows username', async () => {
  const pub = (PUB = track(await connect())); // a completely separate, anonymous viewer
  await subscribe(pub, ['SELECT * FROM pulse_posts', 'SELECT * FROM pulse_comments']);
  const posts = await eventually(() => { const r = rows(pub, 'pulsePosts').filter((p) => p.placeId === slug); return r.length >= 2 && r; }, 3000, 'posts');
  const json = JSON.stringify(posts, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  for (const hex of [A.hex, B.hex]) {
    if (json.includes(hex) || json.includes(hex.slice(2)) || json.toLowerCase().includes(hex.slice(2, 14))) throw new Error('identity hex present in public rows');
  }
  const keys = Object.keys(posts[0]);
  if (keys.some((k) => /author$|authorId|identity|owner|sender/i.test(k) && k !== 'authorLabel' && k !== 'authorAvatarSeed')) throw new Error(`suspicious column: ${keys}`);
  const a = posts.find((p) => p.text.startsWith('Third floor'))!;
  const b = posts.find((p) => p.text.startsWith('Main floor'))!;
  pA = a.id; pB = b.id;
  if (a.authorLabel !== 'Anonymous' || a.authorAvatarSeed) throw new Error('anonymous post leaks profile');
  if (b.authorLabel !== B.username) throw new Error('profile post should show username');
  // A's own profile attribution default is anonymous, but A can still see nothing extra about authorship here.
  return `columns: ${keys.join(',')}; anon="${a.authorLabel}", profile="${b.authorLabel}"`;
});
await check('my_posts gives ids of own posts only (is_mine)', async () => {
  const a = await eventually(() => rows(A, 'myPosts'), 3000);
  if (a.length !== 1 || a[0].postId !== pA) throw new Error('A my_posts wrong');
  if (rows(B, 'myPosts').length !== 1 || rows(B, 'myPosts')[0].postId !== pB) throw new Error('B my_posts wrong');
  if (rows(D, 'myPosts').length !== 0) throw new Error('D should own no posts');
});
await check('worker (service) can read post author privately via svc_post', async () => {
  const p = await eventually(() => rows(W, 'svcPost').find((x) => x.id === pA), 3000, 'svc_post');
  if (p.author.toHexString() !== A.hex) throw new Error('author mismatch');
  return 'svc_post.author == A (needed for impact receipts)';
});
await check('comments: counted, public rows hide author, delete decrements', async () => {
  await R(B).createComment({ postId: pB, text: 'Confirming, no seats', attribution: 'profile' });
  await R(C).createComment({ postId: pB, text: 'Same here', attribution: 'anonymous' });
  const pub = PUB;
  await eventually(() => rows(pub, 'pulsePosts').find((p) => p.id === pB && p.commentCount === 2), 3000, 'comment_count=2');
  const cs = rows(pub, 'pulseComments').filter((c) => c.postId === pB);
  if (cs.length !== 2) throw new Error(`expected 2 comments, got ${cs.length}`);
  const json = JSON.stringify(cs, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  if (json.includes(B.hex.slice(2, 14)) || json.includes(C.hex.slice(2, 14))) throw new Error('comment leaks identity');
  const cC = cs.find((c) => c.text === 'Same here')!;
  await rejects(R(B).deleteComment({ commentId: cC.id }), /not found/); // B can't delete C's comment
  await R(C).deleteComment({ commentId: cC.id });
  await eventually(() => rows(pub, 'pulsePosts').find((p) => p.id === pB && p.commentCount === 1), 3000, 'comment_count=1');
  return 'comment_count 2 -> 1, anonymous comment author hidden';
});
await check('delete_post: only the author; deleted posts vanish from public view', async () => {
  const pub = PUB;
  await rejects(R(B).deletePost({ postId: pA }), /not found/);
  await R(W).workerAddObservation({placeId:slug, dimension:'noise_level', value:'quiet', valueLabel:'Quiet',
    kind:'objective', sourceType:'post', sourceId:`post:${pA}`, contributor:A.identity, verifiedNearby:true,
    observedAtMicros:nowMicros(), expiresAtMicros:nowMicros()+900_000_000n });
  const derived = await eventually(()=>rows(W,'svcObservation').find(o=>o.sourceId===`post:${pA}`),3000,'post evidence');
  await R(W).workerRecordImpact({contributor:A.identity, sourceType:'post', sourceId:String(derived.id), queryId:q1, kind:'helped'});
  await eventually(()=>rows(A,'myImpact').some(i=>i.sourceId===String(derived.id)),3000,'impact credited');
  await R(A).deletePost({ postId: pA });
  await eventually(()=>rows(W,'svcObservation').find(o=>o.id===derived.id)?.invalidated,3000,'post evidence invalidated');
  await eventually(()=>!rows(A,'myImpact').some(i=>i.sourceId===String(derived.id)),3000,'deleted contribution no longer credited');
  await eventually(() => !rows(pub, 'pulsePosts').some((p) => p.id === pA), 3000, 'post gone');
});
await check('report_content once per reporter; duplicate rejected', async () => {
  await R(C).reportContent({ targetType: 'post', targetId: pB, reason: 'looks wrong' });
  await rejects(R(C).reportContent({ targetType: 'post', targetId: pB, reason: 'again' }), /already reported/);
  await eventually(() => rows(W, 'svcReport').length >= 1, 3000, 'svc_report');
});
await check('admin_hide: non-admin rejected; admin (granted by worker) hides the post from the public view', async () => {
  const pub = PUB;
  await rejects(R(C).adminHide({ targetType: 'post', targetId: pB }), /Admin only/);
  await R(W).workerSetAdmin({ identity: C.identity, isAdmin: true });
  await R(C).adminHide({ targetType: 'post', targetId: pB });
  await eventually(() => !rows(pub, 'pulsePosts').some((p) => p.id === pB), 3000, 'post hidden');
  await R(W).workerSetAdmin({ identity: C.identity, isAdmin: false });
});
await check('post rate limit: 10/h, 11th rejected', async () => {
  const G = track(await newUser('g', { location: false }));
  for (let i = 0; i < 10; i++) await R(G).createPost({ placeId: slug, text: `post ${i}`, attribution: 'anonymous' });
  return rejects(R(G).createPost({ placeId: slug, text: 'one too many', attribution: 'anonymous' }), /Rate limit/);
});
await check('comment rate limit: 30/h, 31st rejected', async () => {
  const H = track(await newUser('h', { location: false }));
  await R(H).createPost({ placeId: slug, text: 'host post', attribution: 'anonymous' });
  const mine = await eventually(() => rows(H, 'myPosts')[0], 3000);
  for (let i = 0; i < 30; i++) await R(H).createComment({ postId: mine.postId, text: `c${i}`, attribution: 'anonymous' });
  return rejects(R(H).createComment({ postId: mine.postId, text: 'c-over', attribution: 'anonymous' }), /Rate limit/);
});

// ============================================================================================
console.log('\nWatches');
await check('a watch expires on the database clock, and only its owner can cancel it', async () => {
  const crid = `w-${run}`;
  await R(A).createWatch({ clientRequestId: crid, placeId: slug, text: 'Tell me when seats open up', durationS: 2n });
  const w = await eventually(() => rows(A, 'myWatches').find((x) => x.idemKey.endsWith(crid)), 3000, 'watch');
  await rejects(R(B).cancelWatch({ watchId: w.id }), /Watch not found/);
  await eventually(() => rows(A, 'myWatches').find((x) => x.id === w.id && x.status === 'expired'), 12_000, 'watch expired');
  return 'expired without an orchestrator';
});
await check('only the service can retire a watch', async () => {
  const crid = `retire-${run}`;
  await R(A).createWatch({ clientRequestId: crid, placeId: slug, text: 'Tell me when the line dies down', durationS: 0n });
  const w = await eventually(() => rows(A, 'myWatches').find((x) => x.idemKey.endsWith(crid)), 3000, 'retire watch');
  await rejects(R(B).workerRetireWatch({ watchId: w.id, reason: 'nope' }), /Only the service/);
  await R(W).workerRetireWatch({ watchId: w.id, reason: 'I can only watch for open seats or a quiet room.' });
  const done = await eventually(() => rows(A, 'myWatches').find((x) => x.id === w.id && x.status === 'expired'), 3000, 'retired');
  if (!String(done.lastValue).toLowerCase().includes('open seats')) throw new Error(done.lastValue);
  return 'owner sees the reason; someone else cannot end it';
});

console.log('\nScheduled deadline');
await check('a client cannot call the scheduled deadline reducer', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const runCall = promisify(execFile);
  try {
    await runCall('spacetime', ['call', '--server', CLI_SERVER, DB, 'job_deadline_reached', '--anonymous', '-y'], { timeout: 20_000 });
    throw new Error('scheduled reducer was client-callable');
  } catch (e) {
    const msg = `${errMessage(e)}\n${(e as { stderr?: string; stdout?: string }).stderr ?? ''}\n${(e as { stdout?: string }).stdout ?? ''}`;
    if (!/No such procedure|Private|404/i.test(msg)) throw new Error(msg.trim());
    return 'private reducer, client call rejected';
  }
});
await check('deadline fires with no orchestrator when a job has no evidence', async () => {
  const crid = `deadline-${run}`;
  await R(A).submitQuery({ clientRequestId: crid, placeId: slug, text: 'Is it quiet right now?' });
  const q = await eventually(() => rows(A, 'myQueries').find((x) => x.clientRequestId === crid), 3000, 'deadline query');
  const clientKey = `deadline-${run}-job`;
  await R(W).workerCreateJob({
    clientKey,
    placeId: slug,
    intentKey: 'noise',
    dimensionKeysJson: '["noise_level"]',
    planJson: '{"planner":"heuristic"}',
    deadlineAtMicros: nowMicros() + 2_000_000n,
  });
  const j = await eventually(() => rows(W, 'svcEvidenceJob').find((x) => x.clientKey === clientKey), 3000, 'deadline job');
  await R(W).workerAttachQuery({ queryId: q.id, jobId: j.id });
  await R(W).workerSetQueryStatus({ queryId: q.id, status: 'collecting' });
  const done = await eventually(
    () => rows(A, 'myQueries').find((x) => x.id === q.id && x.status === 'insufficient'),
    12_000,
    'deadline insufficient',
  );
  const events = rows(A, 'myQueryEvents').filter((e) => e.queryId === q.id).map((e) => e.message);
  if (!events.includes("Time's up")) throw new Error(`events=${events.join(' | ')}`);
  const answer = JSON.parse(done.answerJson);
  if (!String(answer.headline).includes('Not enough fresh evidence')) throw new Error(answer.headline);
  const jobRow = rows(W, 'svcEvidenceJob').find((x) => x.id === j.id);
  if (jobRow?.status !== 'expired') throw new Error(`job status ${jobRow?.status}`);
  const notification = await eventually(()=>rows(W,'svcAnswerNotification').find(n=>n.queryId===q.id),3000,'durable deadline notification');
  if (notification.owner.toHexString() !== A.hex || notification.state !== 'pending') throw new Error('wrong notification owner/state');
  await rejects(R(B).workerMarkAnswerNotification({key:notification.key,outcome:'sent'}),/Only the service/);
  await R(W).workerMarkAnswerNotification({key:notification.key,outcome:'retry'});
  await eventually(()=>rows(W,'svcAnswerNotification').find(n=>n.key===notification.key)?.attempts===1,3000,'retry persisted');
  await R(W).workerMarkAnswerNotification({key:notification.key,outcome:'sent'});
  await R(W).workerMarkAnswerNotification({key:notification.key,outcome:'sent'});
  const receipt=await eventually(()=>rows(W,'svcAnswerNotification').find(n=>n.key===notification.key && n.state==='sent'),3000,'delivery receipt');
  if (receipt.attempts!==2) throw new Error('sent receipt was not idempotent');
  return 'insufficient and durable notification queued with no worker polling; receipt/retry persisted';
});

// ============================================================================================
console.log('\nCleanup');
await check('a client cannot call the scheduled cleanup reducers', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const runCall = promisify(execFile);
  for (const name of ['prompt_expired', 'gc_due']) {
    try {
      await runCall('spacetime', ['call', '--server', CLI_SERVER, DB, name, '--anonymous', '-y'], { timeout: 20_000 });
      throw new Error(`${name} was client-callable`);
    } catch (e) {
      const msg = `${errMessage(e)}\n${(e as { stderr?: string }).stderr ?? ''}`;
      if (!/No such procedure|Private|404/i.test(msg)) throw new Error(msg.trim());
    }
  }
  return 'private reducers, client calls rejected';
});
await check('garbage collection keeps fresh evidence and drops what is past the late-accept window', async () => {
  const now = nowMicros();
  const obs = (sourceId: string, observedAtMicros: bigint, expiresAtMicros: bigint) => ({
    placeId: slug, dimension: 'noise_level', value: 'quiet', valueLabel: 'Quiet', ordinal: 1, kind: 'objective',
    sourceType: 'response', sourceId, contributor: B.identity, verifiedNearby: true, observedAtMicros, expiresAtMicros,
  });
  await R(W).workerAddObservation(obs(`gc-old-${run}`, now - 800_000_000n, now - 700_000_000n));
  await R(W).workerAddObservation(obs(`gc-recent-${run}`, now - 30_000_000n, now - 10_000_000n));
  await R(W).workerAddObservation(obs(`gc-fresh-${run}`, now, now + 900_000_000n));
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const runCall = promisify(execFile);
  const staleKey = `aabbcc:queries:1`;
  const sql = async (query: string) => {
    const out = await runCall('spacetime', ['sql', '--server', CLI_SERVER, '--format', 'json', '--yes', DB, query], { timeout: 20_000, encoding: 'utf8' });
    return typeof out === 'string' ? out : String((out as { stdout?: string }).stdout ?? '');
  };
  await sql(`INSERT INTO rate_bucket (key, count) VALUES ('${staleKey}', 1)`);
  await R(W).workerCollectGarbage({});
  await eventually(() => {
    const ids = rows(W, 'svcObservation').map((o) => o.sourceId);
    return ids.includes(`gc-fresh-${run}`) && ids.includes(`gc-recent-${run}`) && !ids.includes(`gc-old-${run}`);
  }, 5000, 'observation gc');
  const listed = await sql(`SELECT key FROM rate_bucket WHERE key = '${staleKey}'`);
  const jsonStart = listed.indexOf('[');
  const parsed = JSON.parse(jsonStart >= 0 ? listed.slice(jsonStart) : listed) as Array<{ rows: unknown[] }>;
  if ((parsed[0]?.rows.length ?? 1) !== 0) throw new Error(`stale rate bucket survived: ${listed.slice(0, 300)}`);
  return 'old observation and rate bucket removed; a report that expired 10s ago stayed';
});

// ============================================================================================
// Last: it wipes this test database's activity, so every check above must already have run.
console.log('\nDev wipe');
await check('non-service identity cannot worker_dev_wipe', () => rejects(R(A).workerDevWipe({}), /Only the service/));
await check('worker_dev_wipe clears activity, keeps accounts, locations and places', async () => {
  const profilesBefore = rows(W, 'svcUserProfile').length;
  const locsBefore = rows(W, 'svcUserLocation').length;
  const activity = ['svcQuery', 'svcQueryEvent', 'svcEvidenceJob', 'svcPromptBatch', 'svcPromptRecipient', 'svcPromptResponse', 'svcObservation', 'svcPost', 'svcComment', 'svcImpactEvent', 'svcReport', 'svcWatch', 'svcAnswerNotification'];
  if (activity.every((t) => rows(W, t).length === 0)) throw new Error('no activity to wipe; checks above should have created some');
  await R(W).workerDevWipe({});
  await eventually(() => activity.every((t) => rows(W, t).length === 0), 5000, 'activity wiped');
  if (rows(W, 'svcUserProfile').length !== profilesBefore) throw new Error('profiles were wiped');
  if (rows(W, 'svcUserLocation').length !== locsBefore) throw new Error('locations were wiped');
  if (!rows(A, 'place').some((p) => p.id === slug)) throw new Error('places were wiped');
  return `${activity.length} activity tables empty; ${profilesBefore} profiles and ${locsBefore} locations kept`;
});

for (const c of clients) c.close();
console.log(`\n${passed} checks passed, ${failures.length} failed${claimedNow ? ' (service role claimed on this run)' : ''}`);
if (failures.length) {
  console.log('\nFAILURES:\n - ' + failures.join('\n - '));
  process.exit(1);
}
process.exit(0);
