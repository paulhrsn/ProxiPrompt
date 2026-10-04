/**
 * Vertical-slice proof: asker + two nearby responders + one far responder,
 * through the real orchestrator tick (heuristic agent).
 *
 * Requires: spacetime local `proxiprompt`, agent on :8001, and NO other orchestrator
 * running against the same database. This script drives `tick()` in-process, so a second
 * worker (e.g. one started by `pnpm dev`) races it and both lose: the symptoms are
 * "Invalid job transition done -> done" and "Recipient … was already asked about this job".
 * The design is a single worker (SPEC §2), so stop the dev stack first:
 *   pnpm stop && spacetime start &   # plus the agent on :8001
 * Run:  STDB_DB=proxiprompt-test AGENT_URL=http://127.0.0.1:8001 pnpm exec tsx scripts/e2e.ts
 * It refuses the live `proxiprompt` database: its throwaway users keep fresh locations at real
 * catalog places, so they were picked as responders ahead of the real team.
 */
import { CATALOG_PLACES } from "@proxiprompt/core";
import { connect, subscribe, sleep, eventually, errMessage, readWorkerToken, writeWorkerToken, URI, DB } from "../../../spacetimedb/scripts/lib.js";

if (DB === "proxiprompt" && process.env.E2E_ALLOW_LIVE_DB !== "1") {
  throw new Error("e2e writes test users into the database; run it with STDB_DB=proxiprompt-test (or E2E_ALLOW_LIVE_DB=1)");
}
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

  // Adjacent buildings: a claim on a different building must keep you out of the wave even
  // when your coordinates sit right on the target. Duderstadt and Pierpont are 78 m apart,
  // inside GPS error, so coordinates alone cannot settle this.
  const dude = CATALOG_PLACES.find((p) => p.id === "duderstadt-center")!;
  const pierpontPlace = CATALOG_PLACES.find((p) => p.id === "pierpont-commons")!;
  const dudePlace = { ...dude, id: `e2e-dude-${suffix}`, name: `E2E Duderstadt ${suffix}` };
  const claimAsker = await connect();
  const claimer = await connect();
  for (const c of [claimAsker, claimer]) {
    await subscribe(c, ["SELECT * FROM place", "SELECT * FROM my_profile", "SELECT * FROM my_queries", "SELECT * FROM my_query_events", "SELECT * FROM my_prompts"]);
  }
  await claimAsker.conn.reducers.setProfile({ username: `ca_${suffix}`.slice(0, 20), defaultAttribution: "anonymous", avatarSeed: "f" });
  await claimer.conn.reducers.setProfile({ username: `cl_${suffix}`.slice(0, 20), defaultAttribution: "anonymous", avatarSeed: "g" });
  for (const p of [dudePlace, pierpontPlace]) {
    await claimAsker.conn.reducers.upsertPlace({
      id: p.id, name: p.name, category: p.category, lat: p.lat, lng: p.lng, address: p.address, community: p.community,
    });
  }
  await claimAsker.conn.reducers.updateLocation({ lat: 42.30, lng: -83.80, accuracyM: 20, source: "demo" });
  // Standing exactly on the target, but says they are in Pierpont.
  await claimer.conn.reducers.updateLocation({
    lat: dudePlace.lat, lng: dudePlace.lng, accuracyM: 12, source: "gps", claimedPlaceId: pierpontPlace.id,
  });
  await claimer.conn.reducers.registerDevice({
    endpoint: `https://push.example/claimer-${suffix}`, p256Dh: "dGVzdA", auth: "dGVzdA", userAgent: "e2e",
  });
  await claimAsker.conn.reducers.submitQuery({
    clientRequestId: `e2e-claim-${suffix}`,
    placeId: dudePlace.id,
    text: `are there any white monsters in the vending machine at ${dudePlace.name}?`,
  });
  await tick(worker.conn);
  await sleep(700);
  await tick(worker.conn);

  const claimerPrompts = [...claimer.conn.db.myPrompts.iter()];
  if (claimerPrompts.length > 0) {
    throw new Error("someone who claimed Pierpont was prompted about Duderstadt");
  }
  console.log("E2E CLAIM OK", { claimedElsewherePrompted: claimerPrompts.length });

  // SPEC §14 step 7: a second, differently-worded question about the same place reuses the
  // evidence just collected — nobody new is interrupted, and the timeline says so.
  const asker2 = await connect();
  await subscribe(asker2, ["SELECT * FROM place", "SELECT * FROM my_profile", "SELECT * FROM my_queries", "SELECT * FROM my_query_events", "SELECT * FROM my_prompts"]);
  await asker2.conn.reducers.setProfile({ username: `ask2_${suffix}`.slice(0, 20), defaultAttribution: "anonymous", avatarSeed: "e" });

  const recipientsBefore = [...worker.conn.db.svcPromptRecipient.iter()].length;
  const crid2 = `e2e-cache-${suffix}`;
  await asker2.conn.reducers.submitQuery({
    clientRequestId: crid2,
    placeId: place.id,
    text: `Can I find a quiet seat at ${place.name} right now?`,
  });

  await tick(worker.conn);
  await sleep(600);
  await tick(worker.conn);

  const q2 = await eventually(() => {
    const row = [...asker2.conn.db.myQueries.iter()].find((r) => r.clientRequestId === crid2);
    return row && ["answered", "insufficient"].includes(row.status) ? row : undefined;
  }, 8000, "second query resolved");

  const recipientsAfter = [...worker.conn.db.svcPromptRecipient.iter()].length;
  if (recipientsAfter !== recipientsBefore) {
    throw new Error(`cache hit should interrupt nobody new (${recipientsBefore} -> ${recipientsAfter})`);
  }
  if ([...asker2.conn.db.myPrompts.iter()].length > 0) throw new Error("second asker was prompted about their own question");

  const answer2 = q2.answerJson ? JSON.parse(q2.answerJson) : null;
  const events2 = [...asker2.conn.db.myQueryEvents.iter()].filter((e) => e.queryId === q2.id).map((e) => e.message);
  if (q2.status === "answered") {
    if (!answer2?.cacheHit) throw new Error("second answer should be marked as a cache hit");
    if (!events2.some((m) => m.toLowerCase().includes("reusing"))) {
      throw new Error(`timeline should state evidence reuse, got: ${events2.join(" | ")}`);
    }
    // The report count must be the number of real people behind it, not every row at the place.
    if (typeof answer2.sourceCount !== "number" || answer2.sourceCount < 1) {
      throw new Error(`bad sourceCount ${answer2.sourceCount}`);
    }
    if (answer2.sourceCount > recipientsAfter) {
      throw new Error(`sourceCount ${answer2.sourceCount} exceeds the ${recipientsAfter} people asked`);
    }
  }

  console.log("E2E OK", { uri: URI, db: DB, status: q.status, promptedNearby: prompts1.length + prompts2.length, promptedFar: promptsFar.length, hasAnswer: !!q.answerJson });
  console.log("E2E CACHE OK", {
    status: q2.status,
    cacheHit: answer2?.cacheHit ?? null,
    sourceCount: answer2?.sourceCount ?? null,
    newPeopleInterrupted: recipientsAfter - recipientsBefore,
    timeline: events2,
  });
  for (const c of [worker, asker, asker2, near1, near2, far, claimAsker, claimer]) c.close();
}

main().catch((e) => {
  console.error("E2E FAILED", errMessage(e));
  process.exit(1);
});
