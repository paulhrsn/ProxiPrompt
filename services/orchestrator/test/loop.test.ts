/**
 * Regression tests for the orchestrator tick, one per defect found in the
 * 2026-10-03 correctness pass. Runs against the in-memory fake connection in
 * `fake-conn.ts`; the agent, push, and Bluesky edges are mocked.
 */
import { CATALOG_PLACES } from "@proxiprompt/core";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent.js", () => ({
  callPlan: vi.fn(),
  callSynthesize: vi.fn(),
  callSummarize: vi.fn(),
  agentHealth: vi.fn(async () => true),
}));
vi.mock("../src/push.js", () => ({
  pushEnabled: vi.fn(() => false),
  sendPush: vi.fn(async () => "ok"),
  initPush: vi.fn(),
}));
vi.mock("../src/bluesky.js", () => ({
  searchBluesky: vi.fn(async () => []),
  blueskyQueryForPlace: vi.fn((name: string) => name),
  parseSearchPosts: vi.fn(() => []),
}));

import { callPlan, callSummarize, callSynthesize } from "../src/agent.js";
import { pushEnabled, sendPush } from "../src/push.js";
import { resetLoopState, tick } from "../src/loop.js";
import {
  addPlace,
  addQuery,
  addUser,
  hexFor,
  identityFor,
  makeFakeConn,
  metersNorth,
  ts,
  tsMicros,
  type FakeConn,
  JOB_TRANSITIONS,
  LOCATION_MAX_AGE_S,
  MAX_RECIPIENTS_PER_JOB,
  QUERY_TRANSITIONS,
} from "./fake-conn.js";

type Conn = Parameters<typeof tick>[0];
const asConn = (c: FakeConn) => c as unknown as Conn;

// tick() reads the wall clock (`nowMs()`), so fixtures must be anchored to it or every
// location and observation reads as stale. All offsets below are relative to NOW.
const NOW = Date.now();
const MIN = 60_000;

const dim = (key: string, kind = "objective", ttl = 900) => ({
  key,
  label: key.replace(/_/g, " "),
  kind,
  volatility: "high",
  proposed_ttl_s: ttl,
});

const control = (key: string) => ({
  dimension_key: key,
  label: key.replace(/_/g, " "),
  options: [
    { value: "low", label: "Low", ordinal: 0 },
    { value: "mid", label: "Moderate", ordinal: 1 },
    { value: "high", label: "High", ordinal: 2 },
  ],
});

const NEUTRAL_QUESTION =
  "Quick question about Shapiro Undergraduate Library: what is the noise level right now?";

function plan(keys: string[], question = NEUTRAL_QUESTION) {
  return {
    canonical_intent: `Current conditions at Shapiro`,
    intent_key: `shapiro-undergraduate-library:${[...keys].sort().join("+")}`,
    decision: "Whether to go now",
    dimensions: keys.map((k) => dim(k)),
    needs_clarification: false,
    clarification: null,
    survey: { question, controls: keys.map(control), allow_note: true },
    responder_radius_m: 150,
    responder_count: 2,
    refusal: null,
    planner: "heuristic" as const,
  };
}

const SYNTH = {
  headline: "Fairly quiet right now.",
  recommendation: "go" as const,
  summary: "Two people report moderate noise.",
  supporting: [],
  caveats: [],
  planner: "heuristic" as const,
};

/** A live firsthand observation, as ingestResponses would write it. */
function addObservation(
  conn: FakeConn,
  over: {
    dimension: string;
    contributor?: ReturnType<typeof identityFor>;
    sourceType?: string;
    value?: string;
    valueLabel?: string;
    ordinal?: number;
    ageMs?: number;
    ttlS?: number;
    placeId?: string;
    verifiedNearby?: boolean;
  },
) {
  const observedAt = NOW - (over.ageMs ?? 0);
  const id = BigInt(conn.rows.svcObservation.length + 1);
  conn.rows.svcObservation.push({
    id,
    placeId: over.placeId ?? "shapiro-undergraduate-library",
    dimension: over.dimension,
    value: over.value ?? "mid",
    valueLabel: over.valueLabel ?? "Moderate",
    ordinal: over.ordinal ?? 1,
    kind: "objective",
    sourceType: over.sourceType ?? "response",
    sourceId: `src-${id}`,
    contributor: over.contributor,
    verifiedNearby: over.verifiedNearby ?? true,
    observedAt: ts(observedAt),
    expiresAt: ts(observedAt + (over.ttlS ?? 900) * 1000),
    invalidated: false,
    dedupKey: `${over.sourceType ?? "response"}:src-${id}:${over.dimension}`,
    svc: 0,
  });
}

beforeEach(() => {
  resetLoopState();
  vi.mocked(callPlan).mockReset();
  vi.mocked(callSynthesize).mockReset();
  vi.mocked(callSummarize).mockReset();
  vi.mocked(callSynthesize).mockResolvedValue(SYNTH as never);
  process.env.DEMO_MODE = "1";
});

describe("bug 1: report count agrees with the confidence it sits next to", () => {
  it("counts distinct firsthand contributors on required dimensions, not every observation at the place", async () => {
    const conn = makeFakeConn(NOW);
    const place = addPlace(conn);
    const asker = addUser(conn, "asker", { lat: 42.30, lng: -83.70 });
    const u1 = addUser(conn, "u1", { lat: place.lat, lng: place.lng });
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);

    // One response on the required dimension…
    addObservation(conn, { dimension: "noise_level", contributor: u1 });
    // …plus unrelated noise at the same place: another dimension, and an anonymous
    // social post. Neither is a nearby report for THIS question.
    addObservation(conn, { dimension: "crowd_level", contributor: identityFor("u2"), sourceType: "post" });
    addObservation(conn, { dimension: "other:social_mention", sourceType: "social", contributor: undefined });

    const q = addQuery(conn, asker, place.id, "How loud is Shapiro?");
    await tick(asConn(conn));

    const answer = JSON.parse(conn.rows.svcQuery.find((r) => r.id === q.id)!.answerJson!);
    expect(answer.sourceCount).toBe(1);
    // The ceiling is derived from the same count, so the two can no longer disagree.
    expect(answer.confidence.ceiling).toBe(0.6);
  });
});

describe("bug 2: the prompt a responder sees", () => {
  it("asks the plan's neutral question, not either asker's words, when a job is shared", async () => {
    const conn = makeFakeConn(NOW);
    const place = addPlace(conn);
    const asker1 = addUser(conn, "asker1", { lat: 42.30, lng: -83.70 });
    const asker2 = addUser(conn, "asker2", { lat: 42.31, lng: -83.71 });
    addUser(conn, "n1", { lat: metersNorth(place.lat, 20), lng: place.lng });
    addUser(conn, "n2", { lat: metersNorth(place.lat, 45), lng: place.lng });
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);

    addQuery(conn, asker1, place.id, "Is Shapiro quiet enough to study?");
    await tick(asConn(conn));
    addQuery(conn, asker2, place.id, "how loud is the ugli rn lol");
    await tick(asConn(conn));

    // Both queries share one job (Jaccard 1.0), so one batch serves both.
    expect(conn.rows.svcEvidenceJob).toHaveLength(1);
    expect(conn.rows.svcPromptBatch).toHaveLength(1);
    const batch = conn.rows.svcPromptBatch[0]!;
    expect(batch.question).toBe(NEUTRAL_QUESTION);
    expect(batch.question).not.toContain("study");
    expect(batch.question).not.toContain("lol");
  });

  it("excludes every attached requester, so the wave is not rolled back wholesale", async () => {
    const conn = makeFakeConn(NOW);
    const place = addPlace(conn);
    const asker1 = addUser(conn, "asker1", { lat: 42.30, lng: -83.70 });
    addUser(conn, "n1", { lat: metersNorth(place.lat, 20), lng: place.lng });
    // asker2 and n2 have no location yet, so the first wave cannot reach them.
    const asker2 = addUser(conn, "asker2");
    const n2 = addUser(conn, "n2");
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);

    addQuery(conn, asker1, place.id, "Is it quiet?");
    await tick(asConn(conn));
    const job = conn.rows.svcEvidenceJob[0]!;

    // Now asker2 walks into the place and asks their own question. By proximity they are
    // the best candidate for the next wave, but the module rejects a batch containing a
    // requester on this job — and it rejects the whole batch, not just that recipient.
    for (const [identity, meters] of [[asker2, 10], [n2, 40]] as const) {
      conn.rows.svcUserLocation.push({
        identity, lat: metersNorth(place.lat, meters), lng: place.lng, accuracyM: 12,
        source: "demo", capturedAt: ts(NOW - MIN), svc: 0,
      });
    }

    // Second query attaches to the same job and is already collecting.
    const q2 = addQuery(conn, asker2, place.id, "any seats?");
    q2.status = "collecting";
    q2.evidenceJobId = job.id;

    // Drop the first wave back in time so the next tick expands. jobLastWaveAt is
    // in-memory and also gates expansion, so clear it the way a restart would.
    for (const r of conn.rows.svcPromptRecipient) r.notifiedAt = ts(NOW - 31_000);
    resetLoopState();
    const batchesBefore = conn.rows.svcPromptBatch.length;
    await tick(asConn(conn));

    const recipientHexes = conn.rows.svcPromptRecipient.map((r) => r.responder.toHexString());
    expect(recipientHexes).not.toContain(hexFor("asker2"));
    // A new batch really was created — the old code lost the whole wave to a rollback.
    expect(conn.rows.svcPromptBatch.length).toBeGreaterThan(batchesBefore);
    expect(recipientHexes).toContain(hexFor("n2"));
  });
});

describe("bug 4: job creation is idempotent across a worker restart", () => {
  it("re-planning the same query creates no second job", async () => {
    const conn = makeFakeConn(NOW);
    const place = addPlace(conn);
    const asker = addUser(conn, "asker", { lat: 42.30, lng: -83.70 });
    addUser(conn, "n1", { lat: metersNorth(place.lat, 20), lng: place.lng });
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);
    const q = addQuery(conn, asker, place.id, "Is it quiet?");

    await tick(asConn(conn));
    expect(conn.rows.svcEvidenceJob).toHaveLength(1);

    // The worker dies and restarts: in-memory locks are gone and the query is replanned.
    // The existing job is no longer attachable (not `collecting`), so the create path runs
    // again — and must be a no-op, because client_key is stable per query. The old
    // timestamped key inserted a second job at the same place here, splitting the evidence.
    conn.rows.svcEvidenceJob[0]!.status = "synthesizing";
    q.status = "planning";
    q.evidenceJobId = undefined;
    q.planJson = undefined;
    resetLoopState();

    await tick(asConn(conn));
    expect(conn.calls.filter((c) => c.name === "workerCreateJob")).toHaveLength(2);
    expect(conn.rows.svcEvidenceJob).toHaveLength(1);
    expect(conn.rows.svcEvidenceJob[0]!.clientKey).toBe(`job-query-${q.id}`);
  });
});

describe("bugs 8 and 9: found by the live e2e run, not by the first fake", () => {
  it("builds a client_key the reducer accepts even for a single-digit query id", async () => {
    const conn = makeFakeConn(NOW);
    const place = addPlace(conn);
    const asker = addUser(conn, "asker", { lat: 42.30, lng: -83.70 });
    addUser(conn, "n1", { lat: metersNorth(place.lat, 20), lng: place.lng });
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);
    const q = addQuery(conn, asker, place.id, "Is it quiet?");
    expect(q.id).toBe(1n); // the case that broke: `job-1` is under the 8-char minimum

    await tick(asConn(conn));

    expect(conn.rows.svcQuery.find((r) => r.id === q.id)!.status).not.toBe("failed");
    expect(conn.rows.svcEvidenceJob).toHaveLength(1);
    expect(conn.rows.svcEvidenceJob[0]!.clientKey.length).toBeGreaterThanOrEqual(8);
  });

  it("survives seeing its own status write late (collecting -> collecting)", async () => {
    const conn = makeFakeConn(NOW);
    const place = addPlace(conn);
    const asker = addUser(conn, "asker", { lat: 42.30, lng: -83.70 });
    addUser(conn, "n1", { lat: metersNorth(place.lat, 20), lng: place.lng });
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);
    const q = addQuery(conn, asker, place.id, "Is it quiet?");

    // The status write is accepted but not visible yet, so promptWave re-reads "planning"
    // and would nudge the status a second time. The reducer rejects that transition, which
    // used to fail the whole query.
    conn.deferStatusWrites = true;
    await tick(asConn(conn));
    conn.flush();

    const row = conn.rows.svcQuery.find((r) => r.id === q.id)!;
    expect(row.status).toBe("collecting");
    expect(row.answerJson).toBeUndefined();
    expect(conn.rows.svcPromptBatch).toHaveLength(1);
  });
});

describe("adjacent buildings (the Duderstadt/Pierpont report)", () => {
  // Real data from the 2026-10-03 session: three friends on GPS near North Campus, all
  // reading 80-83 m from the Duderstadt pin and 59-78 m from Pierpont, which sits 78 m
  // away. A 150 m radius covers both buildings, so the Pierpont friend was asked about
  // Duderstadt with no way to decline.
  const dude = CATALOG_PLACES.find((p) => p.id === "duderstadt-center")!;
  const pierpont = CATALOG_PLACES.find((p) => p.id === "pierpont-commons")!;

  const DUDE_QUESTION = "Quick question about Duderstadt Center: what is the equipment availability right now?";

  function arrange(conn: FakeConn) {
    addPlace(conn, { id: dude.id, name: dude.name, category: dude.category, lat: dude.lat, lng: dude.lng, address: dude.address });
    vi.mocked(callPlan).mockResolvedValue(plan(["equipment_availability"], DUDE_QUESTION) as never);
  }

  it("offers a way out when a neighbouring building is within GPS error", async () => {
    const conn = makeFakeConn(NOW);
    arrange(conn);
    const asker = addUser(conn, "asker", { lat: 42.30, lng: -83.80 });
    addUser(conn, "jerry", { lat: dude.lat, lng: dude.lng, source: "gps" });
    addQuery(conn, asker, dude.id, "any white monsters in the vending machine @ the dude?");

    await tick(asConn(conn));

    const controls = JSON.parse(conn.rows.svcPromptBatch[0]!.controlsJson) as {
      dimension_key: string;
      label: string;
      options: { value: string; label: string }[];
    }[];
    const presence = controls.find((c) => c.dimension_key === "other:place_part");
    expect(presence, "a prompt about Duderstadt must let the responder say they are elsewhere").toBeTruthy();
    // The question above already names the place; the pass option carries it instead.
    expect(presence!.label).toBe("Are you there right now?");
    expect(presence!.options.find((o) => o.value === "not_here")!.label).toContain("Duderstadt");
    expect(presence!.options.map((o) => o.value)).toContain("not_here");
    // The reducer takes 1-3 controls; the presence control must not push the batch over.
    expect(controls.length).toBeLessThanOrEqual(3);
  });

  it("asks whoever reads as inside Duderstadt before whoever reads as inside Pierpont", async () => {
    const conn = makeFakeConn(NOW);
    arrange(conn);
    const asker = addUser(conn, "asker", { lat: 42.30, lng: -83.80 });
    // chin is physically in Pierpont but only 82 m from the Duderstadt pin, so the old
    // distance-only ranking asked him; jerry is inside Duderstadt but further from its pin.
    addUser(conn, "chin", { lat: pierpont.lat, lng: pierpont.lng, source: "gps" });
    addUser(conn, "jerry", { lat: metersNorth(dude.lat, 40), lng: dude.lng, source: "gps" });
    addQuery(conn, asker, dude.id, "any white monsters in the vending machine @ the dude?");

    await tick(asConn(conn));

    const asked = conn.rows.svcPromptRecipient.map((r) => r.responder.toHexString());
    expect(asked).toContain(hexFor("jerry"));
    expect(asked[0]).toBe(hexFor("jerry"));
  });

  it("discards a 'not there' answer and asks someone else instead", async () => {
    const conn = makeFakeConn(NOW);
    arrange(conn);
    const asker = addUser(conn, "asker", { lat: 42.30, lng: -83.80 });
    // Between the two buildings: 56 m from Duderstadt, 42 m from Pierpont. That 14 m gap is
    // inside GPS error, so chin stays eligible and the prompt has to ask him to confirm.
    const chin = addUser(conn, "chin", { lat: metersNorth(dude.lat, 56), lng: dude.lng, source: "gps" });
    // shiyuan has no location during the first wave, so chin is the only one asked.
    const shiyuan = addUser(conn, "shiyuan");
    addQuery(conn, asker, dude.id, "any white monsters in the vending machine @ the dude?");
    await tick(asConn(conn));

    const batch = conn.rows.svcPromptBatch[0]!;
    const recipient = conn.rows.svcPromptRecipient.find((r) => r.responder.isEqual(chin));
    expect(recipient, "chin should be the only one asked in the first wave").toBeTruthy();
    conn.rows.svcUserLocation.push({
      identity: shiyuan, lat: metersNorth(dude.lat, 30), lng: dude.lng, accuracyM: 12,
      source: "gps", capturedAt: ts(NOW - MIN), svc: 0,
    });
    conn.rows.svcPromptResponse.push({
      id: 1n, batchId: batch.id, responder: chin,
      answersJson: JSON.stringify({ "other:place_part": "not_here" }), note: "",
      createdAt: ts(NOW), respKey: `${batch.id}:${chin.toHexString()}`, svc: 0,
    });
    recipient!.responded = true;

    await tick(asConn(conn));

    // Nothing from Pierpont is recorded as evidence about Duderstadt.
    expect(conn.rows.svcObservation.filter((o) => o.sourceType === "response")).toHaveLength(0);
    // And the pass triggers a fresh wave to someone who is actually there.
    expect(conn.rows.svcPromptBatch.length).toBeGreaterThan(1);
    expect(conn.rows.svcPromptRecipient.map((r) => r.responder.toHexString())).toContain(hexFor("shiyuan"));
  });

  it("leaves someone standing in Pierpont out of a Duderstadt wave", async () => {
    // The clean case: a fix squarely on the Pierpont pin is 78 m from the target with 0 m of
    // doubt, so it is excluded outright. Note this geometry would also be handled by plain
    // distance ranking; the strict regression test for the reported near-tie is the claim
    // test below, because at 80 m vs 82 m geometry genuinely cannot tell the two apart.
    const conn = makeFakeConn(NOW);
    arrange(conn);
    const asker = addUser(conn, "asker", { lat: 42.30, lng: -83.80 });
    addUser(conn, "chin", { lat: pierpont.lat, lng: pierpont.lng, source: "gps" });
    addUser(conn, "jerry", { lat: dude.lat, lng: dude.lng, source: "gps" });
    addUser(conn, "shiyuan", { lat: metersNorth(dude.lat, 15), lng: dude.lng, source: "gps" });
    addQuery(conn, asker, dude.id, "any white monsters in the vending machine @ the dude?");

    await tick(asConn(conn));

    const asked = conn.rows.svcPromptRecipient.map((r) => r.responder.toHexString());
    expect(asked).toHaveLength(2);
    expect(asked).not.toContain(hexFor("chin"));
    expect(asked.sort()).toEqual([hexFor("jerry"), hexFor("shiyuan")].sort());
  });

  it("never prompts someone who claimed Pierpont about Duderstadt", async () => {
    const conn = makeFakeConn(NOW);
    arrange(conn);
    addPlace(conn, { id: pierpont.id, name: pierpont.name, category: pierpont.category, lat: pierpont.lat, lng: pierpont.lng, address: pierpont.address });
    const asker = addUser(conn, "asker", { lat: 42.30, lng: -83.80 });
    // chin is sitting ON the Duderstadt pin by GPS, but he told the app he is in Pierpont.
    addUser(conn, "chin", { lat: dude.lat, lng: dude.lng, source: "gps", claimedPlaceId: pierpont.id });
    addUser(conn, "jerry", { lat: metersNorth(dude.lat, 70), lng: dude.lng, source: "gps", claimedPlaceId: dude.id });
    addQuery(conn, asker, dude.id, "any white monsters in the vending machine @ the dude?");

    await tick(asConn(conn));

    const asked = conn.rows.svcPromptRecipient.map((r) => r.responder.toHexString());
    expect(asked).not.toContain(hexFor("chin"));
    expect(asked).toContain(hexFor("jerry"));
  });

  it("keeps seats and noise when Shapiro's neighbour takes a survey slot", async () => {
    const conn = makeFakeConn(NOW);
    const shapiro = CATALOG_PLACES.find((p) => p.id === "shapiro-undergraduate-library")!;
    addPlace(conn, { id: shapiro.id, name: shapiro.name, category: shapiro.category, lat: shapiro.lat, lng: shapiro.lng, address: shapiro.address });
    const asked = plan(
      ["noise_level", "worth_it", "seating_availability"],
      "How quiet is Shapiro Undergraduate Library for studying right now?",
    );
    asked.dimensions = [
      dim("noise_level", "objective"),
      dim("worth_it", "subjective", 5400),
      dim("seating_availability", "objective"),
    ];
    vi.mocked(callPlan).mockResolvedValue(asked as never);
    const asker = addUser(conn, "asker", { lat: 42.30, lng: -83.80 });
    addUser(conn, "near", { lat: shapiro.lat, lng: shapiro.lng, source: "demo", claimedPlaceId: shapiro.id });
    addQuery(conn, asker, shapiro.id, "Is Shapiro worth going to if I need somewhere quiet to study?");

    await tick(asConn(conn));

    const controls = JSON.parse(conn.rows.svcPromptBatch[0]!.controlsJson) as { dimension_key: string }[];
    const keys = controls.map((c) => c.dimension_key);
    expect(keys).toContain("other:place_part");
    expect(keys).toContain("noise_level");
    expect(keys).toContain("seating_availability");
    expect(keys).not.toContain("worth_it");
    expect(keys.length).toBeLessThanOrEqual(3);
    const jobKeys = JSON.parse(conn.rows.svcEvidenceJob[0]!.dimensionKeysJson) as string[];
    expect(jobKeys).toEqual(expect.arrayContaining(["noise_level", "seating_availability"]));
    expect(jobKeys).not.toContain("worth_it");
  });

  it("does not add a presence control for a place with no close neighbour", async () => {
    const conn = makeFakeConn(NOW);
    const stadium = CATALOG_PLACES.find((p) => p.id === "michigan-stadium")!;
    addPlace(conn, { id: stadium.id, name: stadium.name, category: stadium.category, lat: stadium.lat, lng: stadium.lng, address: stadium.address });
    vi.mocked(callPlan).mockResolvedValue(plan(["crowd_level"], "Quick question about Michigan Stadium: how busy is it right now?") as never);
    const asker = addUser(conn, "asker", { lat: 42.30, lng: -83.80 });
    addUser(conn, "fan", { lat: stadium.lat, lng: stadium.lng, source: "gps" });
    addQuery(conn, asker, stadium.id, "is the big house packed?");

    await tick(asConn(conn));

    const controls = JSON.parse(conn.rows.svcPromptBatch[0]!.controlsJson) as { dimension_key: string }[];
    expect(controls.map((c) => c.dimension_key)).toEqual(["crowd_level"]);
  });
});

describe("bug 5: the requester's timeline", () => {
  it("writes one 'Received' event per distinct count, not one per tick", async () => {
    const conn = makeFakeConn(NOW);
    const place = addPlace(conn);
    const asker = addUser(conn, "asker", { lat: 42.30, lng: -83.70 });
    const n1 = addUser(conn, "n1", { lat: metersNorth(place.lat, 20), lng: place.lng });
    addUser(conn, "n2", { lat: metersNorth(place.lat, 45), lng: place.lng });
    // Two required dimensions, one answered: enough to report progress, not enough to finish.
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level", "seating_availability"]) as never);

    const q = addQuery(conn, asker, place.id, "Quiet seat free?");
    await tick(asConn(conn));

    const batch = conn.rows.svcPromptBatch[0]!;
    conn.rows.svcPromptResponse.push({
      id: 1n, batchId: batch.id, responder: n1,
      answersJson: JSON.stringify({ noise_level: "mid" }), note: "",
      createdAt: ts(NOW), respKey: `${batch.id}:${n1.toHexString()}`, svc: 0,
    });
    conn.rows.svcPromptRecipient.find((r) => r.responder.isEqual(n1))!.responded = true;

    await tick(asConn(conn));
    await tick(asConn(conn));
    await tick(asConn(conn));

    const received = conn.rows.svcQueryEvent.filter((e) => e.queryId === q.id && e.kind === "received");
    expect(received).toHaveLength(1);
    // Denominator is the number of people actually asked, not the plan's request.
    expect(received[0]!.message).toBe("Received 1 of 2");
  });
});

describe("bug 6: social evidence cannot answer a query by itself", () => {
  it("still prompts people when only scraped posts exist, and claims no contributors", async () => {
    const conn = makeFakeConn(NOW);
    const place = addPlace(conn);
    const asker = addUser(conn, "asker", { lat: 42.30, lng: -83.70 });
    addUser(conn, "n1", { lat: metersNorth(place.lat, 20), lng: place.lng });
    addUser(conn, "n2", { lat: metersNorth(place.lat, 45), lng: place.lng });
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);

    // Three agreeing social posts: support ~0.72 under the old gate, which answered
    // the query outright with nobody asked.
    for (let i = 0; i < 3; i++) {
      addObservation(conn, { dimension: "noise_level", sourceType: "social", contributor: undefined, ordinal: undefined });
    }

    const q = addQuery(conn, asker, place.id, "Is it quiet?");
    await tick(asConn(conn));

    const row = conn.rows.svcQuery.find((r) => r.id === q.id)!;
    expect(row.status).toBe("collecting");
    expect(row.answerJson).toBeUndefined();
    expect(conn.rows.svcPromptRecipient).toHaveLength(2);
  });
});

describe("bug 7: verified-nearby on a post", () => {
  it("honours the demo location window and real distance", async () => {
    const conn = makeFakeConn(NOW);
    const place = addPlace(conn);
    // 2h-old demo location 40 m away: inside the 6h demo window, inside 150 m.
    const author = addUser(conn, "poster", {
      lat: metersNorth(place.lat, 40), lng: place.lng, source: "demo", ageMs: 2 * 60 * MIN,
    });
    conn.rows.svcPost.push({
      id: 1n, author, attribution: "anonymous", placeId: place.id, community: place.community,
      text: "Second floor is dead quiet", createdAt: ts(NOW - MIN), deleted: false, hidden: false,
      summary: "", freshnessState: "pending", freshnessNote: "", commentCount: 0, svc: 0,
    });
    vi.mocked(callSummarize).mockResolvedValue({
      summary: "Quiet on the second floor.",
      claims: [{ dimension: "noise_level", value_label: "Quiet", kind: "objective", volatility: "high", proposed_ttl_s: 900, ordinal: 0 }],
      planner: "heuristic",
    } as never);

    await tick(asConn(conn));

    const obs = conn.rows.svcObservation.filter((o) => o.sourceType === "post");
    expect(obs).toHaveLength(1);
    expect(obs[0]!.verifiedNearby).toBe(true);
  });

  it("rejects an author who is too far away", async () => {
    const conn = makeFakeConn(NOW);
    const place = addPlace(conn);
    const author = addUser(conn, "poster", {
      lat: metersNorth(place.lat, 400), lng: place.lng, source: "demo", ageMs: 2 * 60 * MIN,
    });
    conn.rows.svcPost.push({
      id: 1n, author, attribution: "anonymous", placeId: place.id, community: place.community,
      text: "heard it is quiet", createdAt: ts(NOW - MIN), deleted: false, hidden: false,
      summary: "", freshnessState: "pending", freshnessNote: "", commentCount: 0, svc: 0,
    });
    vi.mocked(callSummarize).mockResolvedValue({
      summary: "Quiet.",
      claims: [{ dimension: "noise_level", value_label: "Quiet", kind: "objective", volatility: "high", proposed_ttl_s: 900, ordinal: 0 }],
      planner: "heuristic",
    } as never);

    await tick(asConn(conn));

    expect(conn.rows.svcObservation.filter((o) => o.sourceType === "post")[0]!.verifiedNearby).toBe(false);
  });
});

describe("the database owns the deadline clock", () => {
  it("closes a collecting job when the database flags the deadline, before the clock", async () => {
    const conn = makeFakeConn(NOW);
    const place = addPlace(conn);
    const asker = addUser(conn, "asker", { lat: 42.30, lng: -83.70 });
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);
    const q = addQuery(conn, asker, place.id, "How loud is it?");
    await tick(asConn(conn));
    const job = conn.rows.svcEvidenceJob[0]!;
    expect(Number(job.deadlineAt.microsSinceUnixEpoch / 1000n)).toBeGreaterThan(NOW);
    expect(conn.rows.svcQuery.find((r) => r.id === q.id)!.status).toBe("collecting");
    await tick(asConn(conn));
    expect(conn.rows.svcQuery.find((r) => r.id === q.id)!.status).toBe("collecting");
    job.deadlinePassed = true;
    await tick(asConn(conn));
    expect(conn.rows.svcQuery.find((r) => r.id === q.id)!.status).toBe("insufficient");
  });
});

describe("a watch fires when the place changes", () => {
  it("notes the open seats once, then stays quiet while they stay open", async () => {
    const conn = makeFakeConn(NOW);
    const place = addPlace(conn);
    conn.rows.svcWatch.push({
      id: 1n,
      owner: identityFor("watcher"),
      placeId: place.id,
      text: "Tell me when seats open up",
      status: "active",
      dimensionKeysJson: '["seating_availability"]',
      targetJson: JSON.stringify({ dimension: "seating_availability", phrase: "Seats opened up", metValues: ["mid"] }),
      lastValue: "",
      expiresAt: ts(NOW + 60_000),
      svc: 0,
    });
    addObservation(conn, { dimension: "seating_availability", ordinal: 3, placeId: place.id, contributor: identityFor("u1") });
    await tick(asConn(conn));
    await tick(asConn(conn));
    const notes = conn.calls.filter((c) => c.name === "workerNoteWatch");
    expect(notes).toHaveLength(1);
    expect(conn.rows.svcWatch[0]!.lastValue).toBe("Moderate");
  });

  it("ends a watch it cannot turn into open seats or quiet", async () => {
    const conn = makeFakeConn(NOW);
    const place = addPlace(conn);
    conn.rows.svcWatch.push({
      id: 2n,
      owner: identityFor("watcher"),
      placeId: place.id,
      text: "Tell me when the vending machine is restocked",
      status: "planning",
      dimensionKeysJson: "[]",
      targetJson: "",
      lastValue: "",
      expiresAt: ts(NOW + 60_000),
      svc: 0,
    });
    vi.mocked(callPlan).mockResolvedValue(plan(["other:ask_vending"]) as never);

    await tick(asConn(conn));

    expect(conn.rows.svcWatch[0]!.status).toBe("expired");
    expect(conn.rows.svcWatch[0]!.lastValue.toLowerCase()).toContain("open seats");
  });
});

describe("an answer always has something behind it", () => {
  it("stays insufficient when the only evidence is on a dimension nobody asked about", async () => {
    const conn = makeFakeConn(NOW);
    const place = addPlace(conn);
    const asker = addUser(conn, "asker", { lat: 42.30, lng: -83.70 });
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);
    // Plenty of fresh evidence at this place — all of it about something else.
    addObservation(conn, { dimension: "parking_availability", contributor: identityFor("u1") });
    addObservation(conn, { dimension: "cleanliness", contributor: identityFor("u2"), sourceType: "post" });
    // The agent is willing to answer; the deterministic score must still veto it.
    vi.mocked(callSynthesize).mockResolvedValue({ ...SYNTH, recommendation: "go" } as never);

    const q = addQuery(conn, asker, place.id, "How loud is it?");
    await tick(asConn(conn));
    const job = conn.rows.svcEvidenceJob[0]!;
    job.deadlineAt = ts(NOW - 1000);
    await tick(asConn(conn));

    const row = conn.rows.svcQuery.find((r) => r.id === q.id)!;
    expect(row.status).toBe("insufficient");
    const answer = JSON.parse(row.answerJson!);
    expect(answer.sourceCount ?? 0).toBe(0);
  });
});

describe("an answer only uses evidence for the question that was asked", () => {
  it("ignores live observations on other dimensions at the same place", async () => {
    const conn = makeFakeConn(NOW);
    const place = addPlace(conn);
    const asker = addUser(conn, "asker", { lat: 42.30, lng: -83.70 });
    const u1 = addUser(conn, "u1", { lat: place.lat, lng: place.lng });
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);

    // Evidence for this question…
    addObservation(conn, { dimension: "noise_level", contributor: u1 });
    // …and a different question's answer, still live at the same place. The symptom was a
    // headline reading "answer is Yes and Yes" — one value per unrelated question.
    addObservation(conn, { dimension: "other:ask_deadbeef", contributor: identityFor("u2") });

    addQuery(conn, asker, place.id, "How loud is it?");
    await tick(asConn(conn));

    const sent = vi.mocked(callSynthesize).mock.calls.at(-1)![0] as {
      evidence: { dimension: string }[];
    };
    expect(sent.evidence.map((e) => e.dimension)).toEqual(["noise_level"]);
  });
});

describe("a job nobody is waiting on", () => {
  it("stops prompting once its only query is cancelled", async () => {
    const conn = makeFakeConn(NOW);
    const place = addPlace(conn);
    const asker = addUser(conn, "asker", { lat: 42.30, lng: -83.70 });
    addUser(conn, "n1", { lat: metersNorth(place.lat, 20), lng: place.lng });
    addUser(conn, "n2", { lat: metersNorth(place.lat, 45), lng: place.lng });
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);

    const q = addQuery(conn, asker, place.id, "Is it quiet?");
    await tick(asConn(conn));
    const batchesWhileLive = conn.rows.svcPromptBatch.length;
    expect(batchesWhileLive).toBe(1);

    // The asker gives up. Nobody should be interrupted for this question again.
    q.status = "cancelled";
    conn.rows.svcEvidenceJob[0]!.createdAt = ts(NOW - 60_000);
    for (const r of conn.rows.svcPromptRecipient) r.notifiedAt = ts(NOW - 60_000);
    resetLoopState();

    await tick(asConn(conn));
    await tick(asConn(conn));

    expect(conn.rows.svcPromptBatch).toHaveLength(batchesWhileLive);
    expect(conn.rows.svcEvidenceJob[0]!.status).toBe("expired");
  });
});

describe("push notifications deep-link into the app", () => {
  it("uses hash routes, because a path URL lands on Home instead of the prompt", async () => {
    // SPEC §15: "tap deep-links to the right response sheet". App.tsx routes on
    // location.hash, so `/respond/123` would open the app with an empty hash.
    vi.mocked(pushEnabled).mockReturnValue(true);
    vi.mocked(sendPush).mockClear();
    const conn = makeFakeConn(NOW);
    const place = addPlace(conn);
    const asker = addUser(conn, "asker", { lat: 42.30, lng: -83.70 });
    addUser(conn, "n1", { lat: metersNorth(place.lat, 20), lng: place.lng });
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);
    addQuery(conn, asker, place.id, "Is it quiet?");

    await tick(asConn(conn));

    const urls = vi.mocked(sendPush).mock.calls.map((c) => (c[1] as { url: string }).url);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url.startsWith("/#/")).toBe(true);
    expect(urls.some((u) => /^\/#\/respond\/\d+$/.test(u))).toBe(true);
    vi.mocked(pushEnabled).mockReturnValue(false);
  });
});

describe("late answers (SPEC §7 step 9)", () => {
  it("upgrades an insufficient query when a response lands after the deadline", async () => {
    const conn = makeFakeConn(NOW);
    const place = addPlace(conn);
    const asker = addUser(conn, "asker", { lat: 42.30, lng: -83.70 });
    const n1 = addUser(conn, "n1", { lat: metersNorth(place.lat, 20), lng: place.lng });
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);

    const q = addQuery(conn, asker, place.id, "Is it quiet?");
    await tick(asConn(conn));
    const batch = conn.rows.svcPromptBatch[0]!;

    // Nobody answers before the 60 s demo deadline, so the query closes as insufficient.
    const job = conn.rows.svcEvidenceJob[0]!;
    job.deadlineAt = ts(NOW - 1000);
    await tick(asConn(conn));
    expect(conn.rows.svcQuery.find((r) => r.id === q.id)!.status).toBe("insufficient");

    // n1 answers 40 s late. The prompt is still open (600 s), so this is a real response.
    conn.rows.svcPromptResponse.push({
      id: 1n, batchId: batch.id, responder: n1,
      answersJson: JSON.stringify({ noise_level: "low" }), note: "very quiet up here",
      createdAt: ts(NOW), respKey: `${batch.id}:${n1.toHexString()}`, svc: 0,
    });
    conn.rows.svcPromptRecipient.find((r) => r.responder.isEqual(n1))!.responded = true;

    await tick(asConn(conn));

    const row = conn.rows.svcQuery.find((r) => r.id === q.id)!;
    expect(row.status).toBe("answered");
    const answer = JSON.parse(row.answerJson!);
    expect(answer.sourceCount).toBe(1);
    const messages = conn.rows.svcQueryEvent.filter((e) => e.queryId === q.id).map((e) => e.message);
    expect(messages).toContain("Updated answer");
  });

  it("updates once per change, not once per tick", async () => {
    const conn = makeFakeConn(NOW);
    const place = addPlace(conn);
    const asker = addUser(conn, "asker", { lat: 42.30, lng: -83.70 });
    const n1 = addUser(conn, "n1", { lat: metersNorth(place.lat, 20), lng: place.lng });
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);

    const q = addQuery(conn, asker, place.id, "Is it quiet?");
    await tick(asConn(conn));
    const batch = conn.rows.svcPromptBatch[0]!;
    conn.rows.svcEvidenceJob[0]!.deadlineAt = ts(NOW - 1000);
    await tick(asConn(conn));

    conn.rows.svcPromptResponse.push({
      id: 1n, batchId: batch.id, responder: n1,
      answersJson: JSON.stringify({ noise_level: "low" }), note: "",
      createdAt: ts(NOW), respKey: `${batch.id}:${n1.toHexString()}`, svc: 0,
    });
    conn.rows.svcPromptRecipient.find((r) => r.responder.isEqual(n1))!.responded = true;

    await tick(asConn(conn));
    await tick(asConn(conn));
    await tick(asConn(conn));

    const updates = conn.rows.svcQueryEvent.filter((e) => e.queryId === q.id && e.message === "Updated answer");
    expect(updates).toHaveLength(1);
  });

  it("stops looking once LATE_ACCEPT_S has passed", async () => {
    const conn = makeFakeConn(NOW);
    const place = addPlace(conn);
    const asker = addUser(conn, "asker", { lat: 42.30, lng: -83.70 });
    const n1 = addUser(conn, "n1", { lat: metersNorth(place.lat, 20), lng: place.lng });
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);

    const q = addQuery(conn, asker, place.id, "Is it quiet?");
    await tick(asConn(conn));
    const batch = conn.rows.svcPromptBatch[0]!;
    // Deadline well past the 120 s demo late-accept window.
    conn.rows.svcEvidenceJob[0]!.deadlineAt = ts(NOW - 10 * MIN);
    await tick(asConn(conn));
    resetLoopState();

    conn.rows.svcPromptResponse.push({
      id: 1n, batchId: batch.id, responder: n1,
      answersJson: JSON.stringify({ noise_level: "low" }), note: "",
      createdAt: ts(NOW), respKey: `${batch.id}:${n1.toHexString()}`, svc: 0,
    });
    conn.rows.svcPromptRecipient.find((r) => r.responder.isEqual(n1))!.responded = true;

    await tick(asConn(conn));

    expect(conn.rows.svcQuery.find((r) => r.id === q.id)!.status).toBe("insufficient");
  });
});

/** Gives `who` n prompt responses (real answers, or "not_here" passes) from `ageMs` ago. */
function addResponses(
  conn: FakeConn,
  who: ReturnType<typeof identityFor>,
  n: number,
  over: { pass?: boolean; ageMs?: number } = {},
) {
  for (let i = 0; i < n; i++) {
    const id = BigInt(conn.rows.svcPromptResponse.length + 100);
    conn.rows.svcPromptResponse.push({
      id, batchId: 999n, responder: who,
      answersJson: JSON.stringify({ noise_level: over.pass ? "not_here" : "mid" }), note: "",
      createdAt: ts(NOW - (over.ageMs ?? MIN)), respKey: `999:${who.toHexString()}:${id}`, svc: 0,
    });
  }
}

/** `n` neighbors standing 1..n metres from the place, so a wave is limited only by its size. */
function addNeighbors(conn: FakeConn, place: { lat: number; lng: number }, n: number) {
  for (let i = 0; i < n; i++) {
    addUser(conn, `nb${i}`, { lat: metersNorth(place.lat, 1 + i), lng: place.lng });
  }
}

const boostEvents = (conn: FakeConn, queryId: bigint) =>
  conn.rows.svcQueryEvent.filter((e) => e.queryId === queryId && e.message.startsWith("Priority boost"));

describe("demo collection timing", () => {
  it("allows 30 seconds for each wave before an insufficient result at 60 seconds", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      const conn = makeFakeConn(NOW);
      const place = addPlace(conn);
      const asker = addUser(conn, "timing-asker", {lat:42.30, lng:-83.70});
      addNeighbors(conn, place, 20);
      vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);
      const q = addQuery(conn, asker, place.id, "Is Shapiro quiet?");
      await tick(asConn(conn));
      const job = conn.rows.svcEvidenceJob[0]!;
      expect(Number(job.deadlineAt.microsSinceUnixEpoch / 1000n)).toBe(NOW + 60_000);
      expect(conn.rows.svcPromptRecipient).toHaveLength(10);
      clock.mockReturnValue(NOW + 29_000);
      await tick(asConn(conn));
      expect(conn.rows.svcPromptRecipient).toHaveLength(10);
      clock.mockReturnValue(NOW + 30_000);
      await tick(asConn(conn));
      expect(conn.rows.svcPromptRecipient).toHaveLength(20);
      clock.mockReturnValue(NOW + 59_000);
      await tick(asConn(conn));
      expect(q.status).toBe("collecting");
      clock.mockReturnValue(NOW + 60_000);
      await tick(asConn(conn));
      expect(q.status).toBe("insufficient");
    } finally { clock.mockRestore(); }
  });
});

describe("reciprocal priority (SPEC §7)", () => {
  beforeEach(() => {
    delete process.env.RECIPROCAL_PRIORITY;
  });

  it("serves the requester who answered neighbors first, even when they asked second", async () => {
    const conn = makeFakeConn(NOW);
    const shapiro = addPlace(conn);
    const hatcher = addPlace(conn, { id: "hatcher-graduate-library", name: "Hatcher Graduate Library", lat: 42.2767, lng: -83.7382 });
    const lowAsker = addUser(conn, "low-asker");
    const highAsker = addUser(conn, "high-asker");
    addUser(conn, "near-shapiro", { lat: metersNorth(shapiro.lat, 10), lng: shapiro.lng });
    addUser(conn, "near-hatcher", { lat: metersNorth(hatcher.lat, 10), lng: hatcher.lng });
    addResponses(conn, highAsker, 2);
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);

    addQuery(conn, lowAsker, shapiro.id, "Is Shapiro quiet?");
    addQuery(conn, highAsker, hatcher.id, "Is Hatcher quiet?");
    await tick(asConn(conn));

    expect(conn.rows.svcPromptBatch[0]!.placeId).toBe(hatcher.id);
    expect(conn.rows.svcPromptBatch[1]!.placeId).toBe(shapiro.id);
  });

  it("keeps created order between requesters with equal credit", async () => {
    const conn = makeFakeConn(NOW);
    const shapiro = addPlace(conn);
    const hatcher = addPlace(conn, { id: "hatcher-graduate-library", name: "Hatcher Graduate Library", lat: 42.2767, lng: -83.7382 });
    const a = addUser(conn, "asker-a");
    const b = addUser(conn, "asker-b");
    addUser(conn, "near-shapiro", { lat: metersNorth(shapiro.lat, 10), lng: shapiro.lng });
    addUser(conn, "near-hatcher", { lat: metersNorth(hatcher.lat, 10), lng: hatcher.lng });
    addResponses(conn, a, 2);
    addResponses(conn, b, 2);
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);

    addQuery(conn, a, shapiro.id, "Is Shapiro quiet?");
    addQuery(conn, b, hatcher.id, "Is Hatcher quiet?");
    await tick(asConn(conn));

    expect(conn.rows.svcPromptBatch[0]!.placeId).toBe(shapiro.id);
  });

  it("widens the first wave by the requester's credit", async () => {
    const conn = makeFakeConn(NOW);
    const place = addPlace(conn);
    const asker = addUser(conn, "asker");
    addNeighbors(conn, place, 25);
    addResponses(conn, asker, 3);
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);

    addQuery(conn, asker, place.id, "Is it quiet?");
    await tick(asConn(conn));

    expect(conn.rows.svcPromptRecipient).toHaveLength(13);
  });

  it("caps the extra reach at 5, so the first wave is at most 15", async () => {
    const conn = makeFakeConn(NOW);
    const place = addPlace(conn);
    const asker = addUser(conn, "asker");
    addNeighbors(conn, place, 25);
    addResponses(conn, asker, 9);
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);

    addQuery(conn, asker, place.id, "Is it quiet?");
    await tick(asConn(conn));

    expect(conn.rows.svcPromptRecipient).toHaveLength(15);
  });

  it("does not penalize a requester with no credit, and passes or old answers earn none", async () => {
    const conn = makeFakeConn(NOW);
    const place = addPlace(conn);
    const asker = addUser(conn, "asker");
    addNeighbors(conn, place, 25);
    addResponses(conn, asker, 4, { pass: true });
    addResponses(conn, asker, 4, { ageMs: 25 * 60 * MIN });
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);

    const q = addQuery(conn, asker, place.id, "Is it quiet?");
    await tick(asConn(conn));

    expect(conn.rows.svcPromptRecipient).toHaveLength(10);
    expect(boostEvents(conn, q.id)).toHaveLength(0);
  });

  it("tells the requester about the boost once, and only when there is credit", async () => {
    const conn = makeFakeConn(NOW);
    const place = addPlace(conn);
    const asker = addUser(conn, "asker");
    const stranger = addUser(conn, "stranger");
    addNeighbors(conn, place, 12);
    addResponses(conn, asker, 3);
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);

    const q = addQuery(conn, asker, place.id, "Is it quiet?");
    const q0 = addQuery(conn, stranger, place.id, "Seats free?");
    await tick(asConn(conn));
    await tick(asConn(conn));
    await tick(asConn(conn));

    const events = boostEvents(conn, q.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.message).toBe("Priority boost: you answered 3 neighbors today");
    expect(boostEvents(conn, q0.id)).toHaveLength(0);
  });

  it("with RECIPROCAL_PRIORITY off, behaves exactly as before", async () => {
    process.env.RECIPROCAL_PRIORITY = "0";
    const conn = makeFakeConn(NOW);
    const shapiro = addPlace(conn);
    const hatcher = addPlace(conn, { id: "hatcher-graduate-library", name: "Hatcher Graduate Library", lat: 42.2767, lng: -83.7382 });
    const lowAsker = addUser(conn, "low-asker");
    const highAsker = addUser(conn, "high-asker");
    addNeighbors(conn, hatcher, 25);
    addResponses(conn, highAsker, 3);
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);

    addQuery(conn, lowAsker, shapiro.id, "Is Shapiro quiet?");
    const hq = addQuery(conn, highAsker, hatcher.id, "Is Hatcher quiet?");
    await tick(asConn(conn));

    expect(conn.rows.svcPromptBatch.map((b) => b.placeId)).toEqual([hatcher.id]);
    expect(conn.rows.svcPromptRecipient).toHaveLength(10);
    expect(boostEvents(conn, hq.id)).toHaveLength(0);
  });
});

describe("the fake connection still matches the real module", () => {
  it("mirrors the guardrail constants in spacetimedb/src/lib.ts", () => {
    const libPath = join(dirname(fileURLToPath(import.meta.url)), "../../../spacetimedb/src/lib.ts");
    const src = readFileSync(libPath, "utf8");
    const num = (name: string) => {
      const m = src.match(new RegExp(`export const ${name} = (\\d+)`));
      if (!m) throw new Error(`${name} not found in lib.ts`);
      return Number(m[1]);
    };
    expect(num("MAX_RECIPIENTS_PER_JOB")).toBe(MAX_RECIPIENTS_PER_JOB);
    expect(num("LOCATION_MAX_AGE_S")).toBe(LOCATION_MAX_AGE_S);

    // Transition tables are compared structurally; a reordering is fine, a changed edge is not.
    for (const [table, name] of [
      [QUERY_TRANSITIONS, "QUERY_TRANSITIONS"],
      [JOB_TRANSITIONS, "JOB_TRANSITIONS"],
    ] as const) {
      const block = src.slice(src.indexOf(`export const ${name}`));
      for (const [from, tos] of Object.entries(table)) {
        const line = block.slice(0, block.indexOf("};")).split("\n").find((l) => l.trim().startsWith(`${from}:`));
        expect(line, `${name}.${from} missing from lib.ts`).toBeTruthy();
        for (const to of tos) expect(line).toContain(`'${to}'`);
      }
    }
  });

  it("exposes every table and reducer loop.ts touches", () => {
    const conn = makeFakeConn(NOW);
    const loopPath = join(dirname(fileURLToPath(import.meta.url)), "../src/loop.ts");
    const src = readFileSync(loopPath, "utf8");
    for (const m of src.matchAll(/conn\.db\.(\w+)\.iter\(\)/g)) {
      expect(conn.db, `db.${m[1]} missing from the fake`).toHaveProperty(m[1]!);
    }
    for (const m of src.matchAll(/conn\.reducers\.(\w+)\(/g)) {
      expect(conn.reducers, `reducer ${m[1]} missing from the fake`).toHaveProperty(m[1]!);
    }
  });
});

// Kept to show the unused import is intentional: tsMicros is part of the fake's public surface.
void tsMicros;

describe("an answer admits when its own sources disagree", () => {
  it("caps confidence, adds a 'Reports disagree' caveat, and keeps the conflict in the answer", async () => {
    const conn = makeFakeConn(NOW);
    const place = addPlace(conn);
    const asker = addUser(conn, "asker", { lat: 42.30, lng: -83.70 });
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);
    for (const u of ["u1", "u2", "u3"]) {
      addObservation(conn, { dimension: "noise_level", contributor: identityFor(u), value: "high", valueLabel: "High", ordinal: 2 });
    }
    addObservation(conn, { dimension: "noise_level", contributor: identityFor("u4"), value: "low", valueLabel: "Low", ordinal: 0 });

    const q = addQuery(conn, asker, place.id, "How loud is Shapiro?");
    await tick(asConn(conn));

    const sent = vi.mocked(callSynthesize).mock.calls.at(-1)![0] as { confidence: { level: string } };
    expect(sent.confidence.level).toBe("Medium");
    const answer = JSON.parse(conn.rows.svcQuery.find((r) => r.id === q.id)!.answerJson!);
    expect(answer.confidence.level).toBe("Medium");
    expect(answer.conflicts).toEqual([{ dimension: "noise_level", severity: "moderate", labels: ["Low", "High"] }]);
    expect(answer.caveats.some((c: string) => c.startsWith("Reports disagree"))).toBe(true);
  });
});

describe("a late conflicting report on an answered question", () => {
  it("rewrites the answer even when the agent now calls it insufficient", async () => {
    const conn = makeFakeConn(NOW);
    const place = addPlace(conn);
    const asker = addUser(conn, "asker", { lat: 42.30, lng: -83.70 });
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);
    addObservation(conn, { dimension: "noise_level", contributor: identityFor("u1"), value: "high", valueLabel: "High", ordinal: 3 });

    const q = addQuery(conn, asker, place.id, "How loud is Shapiro?");
    await tick(asConn(conn));
    expect(conn.rows.svcQuery.find((r) => r.id === q.id)!.status).toBe("answered");

    // answered -> insufficient is not a legal transition, so the update must stay "answered".
    vi.mocked(callSynthesize).mockResolvedValue({ ...SYNTH, recommendation: "insufficient" } as never);
    addObservation(conn, { dimension: "noise_level", contributor: identityFor("u2"), value: "low", valueLabel: "Low", ordinal: 0 });
    await tick(asConn(conn));
    await tick(asConn(conn));

    const row = conn.rows.svcQuery.find((r) => r.id === q.id)!;
    expect(row.status).toBe("answered");
    const answer = JSON.parse(row.answerJson!);
    expect(answer.confidence.level).toBe("Low");
    expect(answer.caveats[0]).toMatch(/^Reports disagree/);
  });
});

describe("audit reproductions", () => {
  it("does not put contributor identities into requester answers", async () => {
    const c = makeFakeConn(NOW); const p = addPlace(c);
    const a = addUser(c, "privacy_asker", {lat:42.30,lng:-83.70});
    const contributor = identityFor("private_responder");
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);
    addObservation(c, {dimension:"noise_level", contributor});
    const q = addQuery(c, a, p.id, "Is Shapiro quiet?");
    await tick(asConn(c));
    const answer = c.rows.svcQuery.find(row=>row.id===q.id)!.answerJson!;
    expect(answer).not.toContain(contributor.toHexString());
    expect(JSON.parse(answer).factors).not.toHaveProperty("contributorIds");
  });
  it("deactivates an expired push device", async () => {
    const c = makeFakeConn(NOW); const p = addPlace(c);
    const a = addUser(c, "push_asker", {lat:42.30,lng:-83.70});
    const r = addUser(c, "expired_device", {lat:p.lat,lng:p.lng});
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);
    vi.mocked(pushEnabled).mockReturnValue(true);
    vi.mocked(sendPush).mockResolvedValue("gone");
    addQuery(c,a,p.id,"Is Shapiro quiet?");
    try {
      await tick(asConn(c));
      expect(c.rows.svcDevice.find(d=>d.owner.isEqual(r))!.active).toBe(false);
    } finally {vi.mocked(pushEnabled).mockReturnValue(false);}
  });
  it("scores each attached query using its own required dimensions", async () => {
    const c = makeFakeConn(NOW); const p = addPlace(c);
    const a = addUser(c, "audit_a", {lat:42.30,lng:-83.70});
    const b = addUser(c, "audit_b", {lat:42.30,lng:-83.70});
    addUser(c,"audit_r",{lat:p.lat,lng:p.lng});
    vi.mocked(callPlan).mockResolvedValueOnce(plan(["noise_level"]) as never)
      .mockResolvedValueOnce(plan(["noise_level","seating_availability"]) as never);
    addQuery(c,a,p.id,"Is Shapiro quiet?");
    const q2=addQuery(c,b,p.id,"Are there quiet seats at Shapiro?");
    await tick(asConn(c));
    addObservation(c,{dimension:"noise_level",contributor:identityFor("reporter1")});
    await tick(asConn(c));
    const stored=c.rows.svcQuery.find(q=>q.id===q2.id)!;

    expect(stored.status).toBe("collecting");
    expect(JSON.parse(c.rows.svcEvidenceJob[0].dimensionKeysJson)).toContain("seating_availability");
    addObservation(c,{dimension:"seating_availability",contributor:identityFor("reporter2")});
    await tick(asConn(c));
    const final=JSON.parse(c.rows.svcQuery.find(q=>q.id===q2.id)!.answerJson!);
    expect(final.dimensions.map((d: {key:string})=>d.key)).toContain("seating_availability");
  });
  it("refreshes an answer when the modal value changes with unchanged count and confidence level", async()=>{
    const c=makeFakeConn(NOW); const p=addPlace(c);
    const a=addUser(c,"audit_a",{lat:42.30,lng:-83.70});
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);
    addObservation(c,{dimension:"noise_level",contributor:identityFor("reporter1"),value:"low",valueLabel:"Quiet",ordinal:0,ageMs:1000});
    const q=addQuery(c,a,p.id,"Is Shapiro quiet?"); await tick(asConn(c));
    const before=vi.mocked(callSynthesize).mock.calls.length;
    addObservation(c,{dimension:"noise_level",contributor:identityFor("reporter1"),value:"high",valueLabel:"Loud",ordinal:2});
    await tick(asConn(c));
    expect(vi.mocked(callSynthesize).mock.calls.length).toBeGreaterThan(before);
  });
  it("does not reuse an observation from a deleted post",async()=>{
    const c=makeFakeConn(NOW);const p=addPlace(c);
    const a=addUser(c,"audit_a",{lat:42.30,lng:-83.70});
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);
    addObservation(c,{dimension:"noise_level",contributor:identityFor("deleted_author"),sourceType:"post"});
    c.rows.svcObservation[0].sourceId="post:99";
    c.rows.svcPost.push({id:99n,placeId:p.id,author:identityFor("deleted_author"),text:"Quiet",attribution:"anonymous",createdAt:ts(NOW),deleted:true,hidden:false,commentCount:0,summary:"Quiet",freshnessNote:"Fresh",freshnessState:"fresh",svc:0} as never);
    const q=addQuery(c,a,p.id,"Is Shapiro quiet?");await tick(asConn(c));
    const result=c.rows.svcQuery.find(x=>x.id===q.id)!;
    expect(result.status).not.toBe("answered");
    expect(c.rows.svcObservation[0].invalidated).toBe(true);
  });
  it("compares a late change against the persisted answer after a worker restart", async()=>{
    const c=makeFakeConn(NOW), p=addPlace(c);
    const a=addUser(c,"restart_asker",{lat:42.30,lng:-83.70});
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);
    addObservation(c,{dimension:"noise_level",contributor:identityFor("reporter1"),value:"low",ordinal:0,ageMs:1000});
    const q=addQuery(c,a,p.id,"Is Shapiro quiet?"); await tick(asConn(c));
    const before=vi.mocked(callSynthesize).mock.calls.length;
    resetLoopState(); await tick(asConn(c));
    expect(callSynthesize).toHaveBeenCalledTimes(before);
    addObservation(c,{dimension:"noise_level",contributor:identityFor("reporter1"),value:"high",ordinal:2});
    resetLoopState(); await tick(asConn(c));
    expect(callSynthesize).toHaveBeenCalledTimes(before+1);
    expect(JSON.parse(q.answerJson!).dimensions[0].modalValue).toBe("high");
    resetLoopState(); await tick(asConn(c));
    expect(callSynthesize).toHaveBeenCalledTimes(before+1);
  });
  it("refreshes a finished answer when its last contribution is removed",async()=>{
    const c=makeFakeConn(NOW), p=addPlace(c);
    const a=addUser(c,"removal_asker",{lat:42.30,lng:-83.70});
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);
    addObservation(c,{dimension:"noise_level",contributor:identityFor("reporter1")});
    const q=addQuery(c,a,p.id,"Is Shapiro quiet?"); await tick(asConn(c));
    c.rows.svcObservation[0].invalidated=true;
    vi.mocked(callSynthesize).mockResolvedValue({...SYNTH,recommendation:"insufficient",headline:"No fresh evidence remains"} as never);
    resetLoopState(); await tick(asConn(c));
    const answer=JSON.parse(q.answerJson!);
    expect(answer.sourceCount).toBe(0);
    expect(answer.dimensions[0].count).toBe(0);
    expect(answer.recommendation).toBe("insufficient");
    expect(answer.headline).toBe("No fresh evidence remains");
  });
  it("retries a late answer after its first replacement write fails",async()=>{
    const c=makeFakeConn(NOW),p=addPlace(c);
    const a=addUser(c,"write_asker",{lat:42.30,lng:-83.70});
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);
    addObservation(c,{dimension:"noise_level",contributor:identityFor("reporter1"),value:"low",ordinal:0,ageMs:1000});
    const q=addQuery(c,a,p.id,"Is Shapiro quiet?"); await tick(asConn(c));
    addObservation(c,{dimension:"noise_level",contributor:identityFor("reporter1"),value:"high",ordinal:2});
    const write=vi.spyOn(c.reducers,"workerSetAnswer").mockRejectedValueOnce(new Error("write interrupted"));
    try {
      await expect(tick(asConn(c))).rejects.toThrow("write interrupted");
      expect(JSON.parse(q.answerJson!).dimensions[0].modalValue).toBe("low");
      await tick(asConn(c));
      expect(JSON.parse(q.answerJson!).dimensions[0].modalValue).toBe("high");
      expect(write).toHaveBeenCalledTimes(2);
    } finally {write.mockRestore();}
  });
});


describe("foreground reachability", () => {
  it("routes to an open foreground session with an old but valid location and no push device", async () => {
    const c = makeFakeConn(NOW); const place = addPlace(c);
    const asker = addUser(c, "presence_asker", {lat:42.30,lng:-83.70});
    const responder = addUser(c, "foreground", {lat:place.lat,lng:place.lng, device:false, ageMs:3600000});
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);
    addQuery(c, asker, place.id, "Is Shapiro quiet?");
    await tick(asConn(c));
    expect(c.rows.svcPromptRecipient.some(r=>r.responder.isEqual(responder))).toBe(true);
  });
  it("does not infer foreground reachability from a recent location", async () => {
    const c = makeFakeConn(NOW); const place = addPlace(c);
    const asker = addUser(c, "presence_asker", {lat:42.30,lng:-83.70});
    const responder = addUser(c, "background", {lat:place.lat,lng:place.lng, device:false, foreground:false, ageMs:1000});
    vi.mocked(callPlan).mockResolvedValue(plan(["noise_level"]) as never);
    addQuery(c, asker, place.id, "Is Shapiro quiet?");
    await tick(asConn(c));
    expect(c.rows.svcPromptRecipient.some(r=>r.responder.isEqual(responder))).toBe(false);
  });
});


it("delivers a persisted insufficient-answer notification after a worker restart without duplicate pushes", async () => {
  const c=makeFakeConn(NOW), place=addPlace(c), asker=addUser(c,"queue_asker",{lat:42.3,lng:-83.7});
  const q=addQuery(c,asker,place.id,"Is it quiet?");
  q.status="insufficient"; q.answerJson=JSON.stringify({headline:"Not enough fresh evidence",sourceCount:0});
  c.rows.svcAnswerNotification.push({key:`${q.id}:deadline`,queryId:q.id,owner:asker,title:"Not enough fresh reports",
    body:"Nobody answered in time",url:`/#/q/${q.id}`,tag:`answer-${q.id}`,state:"pending",attempts:0,
    nextAttemptAt:ts(NOW),createdAt:ts(NOW),svc:0});
  vi.mocked(pushEnabled).mockReturnValue(true); vi.mocked(sendPush).mockClear().mockResolvedValue("sent");
  try {
    resetLoopState(); await tick(asConn(c));
    expect(sendPush).toHaveBeenCalledTimes(1);
    expect(c.rows.svcAnswerNotification[0].state).toBe("sent");
    resetLoopState(); await tick(asConn(c));
    expect(sendPush).toHaveBeenCalledTimes(1);
  } finally {vi.mocked(pushEnabled).mockReturnValue(false);}
});
