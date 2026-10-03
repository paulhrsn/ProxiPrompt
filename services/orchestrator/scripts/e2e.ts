/**
 * Vertical-slice proof: asker + two nearby responders + one far responder,
 * through the real orchestrator tick (heuristic agent).
 *
 * Requires: spacetime local `proxiprompt`, agent on :8001.
 * Run:  AGENT_URL=http://127.0.0.1:8001 pnpm exec tsx scripts/e2e.ts
 */
import { CATALOG_PLACES } from "@proxiprompt/core";
import { connect, subscribe, sleep, eventually, errMessage, readWorkerToken, writeWorkerToken, URI, DB } from "../../../spacetimedb/scripts/lib.js";
import { tick } from "../src/loop.js";

const shapiro = CATALOG_PLACES.find((p) => p.id === "shapiro-undergraduate-library")!;
const union = CATALOG_PLACES.find((p) => p.id === "michigan-union")!;

const SVC = [
  "SELECT * FROM place",
  "SELECT * FROM svc_query",
  "SELECT * FROM svc_query_event",
  "SELECT * FROM svc_evidence_job",
  "SELECT * FROM svc_prompt_batch",
  "SELECT * FROM svc_prompt_recipient",
  "SELECT * FROM svc_prompt_response",
  "SELECT * FROM svc_observation",
  "SELECT * FROM svc_user_location",
  "SELECT * FROM svc_user_profile",
  "SELECT * FROM svc_device",
  "SELECT * FROM svc_post",
  "SELECT * FROM svc_comment",
];

async function main() {
  const worker = await connect(readWorkerToken());
  writeWorkerToken(worker.token);
  await subscribe(worker, SVC);
  try {
    await worker.conn.reducers.claimServiceRole({});
  } catch {
    /* already claimed */
  }

  const asker = await connect();
  const near1 = await connect();
  const near2 = await connect();
  const far = await connect();
  for (const c of [asker, near1, near2, far]) {
    await subscribe(c, ["SELECT * FROM place", "SELECT * FROM my_profile", "SELECT * FROM my_queries", "SELECT * FROM my_query_events", "SELECT * FROM my_prompts"]);
  }

  const suffix = Date.now().toString(36);
  const place = {
    ...shapiro,
    id: `e2e-shapiro-${suffix}`,
    name: `E2E Shapiro ${suffix}`,
    lat: 41.11 + Math.random() * 0.01,
    lng: -84.22 + Math.random() * 0.01,
  };
  await asker.conn.reducers.setProfile({ username: `ask_${suffix}`.slice(0, 20), defaultAttribution: "anonymous", avatarSeed: "a" });
  await near1.conn.reducers.setProfile({ username: `n1_${suffix}`.slice(0, 20), defaultAttribution: "anonymous", avatarSeed: "b" });
  await near2.conn.reducers.setProfile({ username: `n2_${suffix}`.slice(0, 20), defaultAttribution: "anonymous", avatarSeed: "c" });
  await far.conn.reducers.setProfile({ username: `far_${suffix}`.slice(0, 20), defaultAttribution: "anonymous", avatarSeed: "d" });

  await asker.conn.reducers.upsertPlace({
    id: place.id, name: place.name, category: place.category, lat: place.lat, lng: place.lng, address: place.address, community: place.community,
  });
  await asker.conn.reducers.updateLocation({ lat: 42.28, lng: -83.75, accuracyM: 20, source: "demo" });
  await near1.conn.reducers.updateLocation({ lat: place.lat + 0.0001, lng: place.lng, accuracyM: 12, source: "demo" });
  await near2.conn.reducers.updateLocation({ lat: place.lat, lng: place.lng + 0.0002, accuracyM: 12, source: "demo" });
  await far.conn.reducers.updateLocation({ lat: union.lat, lng: union.lng, accuracyM: 12, source: "demo" });

  // Fake devices so routing considers them eligible (push send will fail without VAPID, that's ok).
  for (const c of [near1, near2, far]) {
    await c.conn.reducers.registerDevice({
      endpoint: `https://push.example/${c.hex}`,
      p256Dh: "dGVzdA",
      auth: "dGVzdA",
      userAgent: "e2e",
    });
  }

  const crid = `e2e-${suffix}`;
  await asker.conn.reducers.submitQuery({
    clientRequestId: crid,
    placeId: place.id,
    text: `Is ${place.name} worth going to if I need somewhere quiet to study?`,
  });

  await tick(worker.conn);
  await sleep(800);
  await tick(worker.conn);
  await sleep(800);

  const queries = [...worker.conn.db.svcQuery.iter()];
  const locs = [...worker.conn.db.svcUserLocation.iter()];
  const devices = [...worker.conn.db.svcDevice.iter()];
  const recips = [...worker.conn.db.svcPromptRecipient.iter()];
  const jobs = [...worker.conn.db.svcEvidenceJob.iter()];
  console.log("debug", {
    queries: queries.map((q) => ({ id: String(q.id), status: q.status, place: q.placeId })),
    locCount: locs.length,
    deviceCount: devices.length,
    recipCount: recips.length,
    jobs: jobs.map((j) => ({ id: String(j.id), status: j.status, n: j.recipientsCount })),
  });

  const { prompts1, prompts2 } = await eventually(() => {
    const a = [...near1.conn.db.myPrompts.iter()];
    const b = [...near2.conn.db.myPrompts.iter()];
    return a.length + b.length > 0 ? { prompts1: a, prompts2: b } : undefined;
  }, 6000, "nearby my_prompts");
  const promptsFar = [...far.conn.db.myPrompts.iter()];
  if (promptsFar.length > 0) throw new Error("far responder should not be prompted");

  const p = prompts1[0] ?? prompts2[0];
  const controls = JSON.parse(p.controlsJson) as { dimension_key: string; options: { value: string }[] }[];
  const answers: Record<string, string> = {};
  for (const c of controls) answers[c.dimension_key] = c.options[Math.min(1, c.options.length - 1)].value;
  const responder = prompts1[0] ? near1 : near2;
  await responder.conn.reducers.submitResponse({ batchId: p.batchId, answersJson: JSON.stringify(answers), note: "pretty open, a bit chatty" });

  await tick(worker.conn);
  await sleep(400);
  await tick(worker.conn);

  const q = [...asker.conn.db.myQueries.iter()].find((row) => row.clientRequestId === crid);
  if (!q) throw new Error("query missing");
  if (!["answered", "insufficient", "collecting", "synthesizing"].includes(q.status)) {
    throw new Error(`unexpected status ${q.status}`);
  }
  console.log("E2E OK", { uri: URI, db: DB, status: q.status, promptedNearby: prompts1.length + prompts2.length, promptedFar: promptsFar.length, hasAnswer: !!q.answerJson });
  for (const c of [worker, asker, near1, near2, far]) c.close();
}

main().catch((e) => {
  console.error("E2E FAILED", errMessage(e));
  process.exit(1);
});
