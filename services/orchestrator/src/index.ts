import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG_PLACES } from "@proxiprompt/core";
import { DbConnection } from "../../../spacetimedb/bindings/index.js";
import { agentHealth } from "./agent.js";
import { startAsiServer } from "./asi.js";
import { resetLoopState, tick } from "./loop.js";
import { initPush } from "./push.js";
import { ConnectionLoop } from "./connection-loop.js";

const URI = process.env.SPACETIMEDB_URI ?? "ws://127.0.0.1:3000";
const DB = process.env.SPACETIMEDB_DB ?? "proxiprompt";
const PORT = Number(process.env.ORCH_PORT ?? 8080);
const TOKEN_FILE = join(dirname(fileURLToPath(import.meta.url)), "../../../spacetimedb/.local", `worker-token-${DB}`);

function loadToken(): string | undefined {
  const env = process.env.SPACETIMEDB_TOKEN?.trim();
  if (env) return env;
  try {
    return readFileSync(TOKEN_FILE, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function saveToken(token: string) {
  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 });
}

const SVC_VIEWS = [
  "SELECT * FROM place",
  "SELECT * FROM svc_query",
  "SELECT * FROM svc_answer_notification",
  "SELECT * FROM svc_watch",
  "SELECT * FROM svc_query_event",
  "SELECT * FROM svc_evidence_job",
  "SELECT * FROM svc_prompt_batch",
  "SELECT * FROM svc_prompt_recipient",
  "SELECT * FROM svc_prompt_response",
  "SELECT * FROM svc_observation",
  "SELECT * FROM svc_user_location",
  "SELECT * FROM svc_user_presence",
  "SELECT * FROM svc_user_profile",
  "SELECT * FROM svc_device",
  "SELECT * FROM svc_post",
  "SELECT * FROM svc_comment",
  "SELECT * FROM svc_impact_event",
];

async function seedPlaces(c: DbConnection) {
  for (const p of CATALOG_PLACES) {
    try {
      await c.reducers.upsertPlace({
        id: p.id,
        name: p.name,
        category: p.category,
        lat: p.lat,
        lng: p.lng,
        address: p.address,
        community: p.community,
      });
    } catch (e) {
      console.warn("seed place", p.id, (e as Error).message);
    }
  }
}

function connect(signal: AbortSignal, disconnected: () => void): Promise<DbConnection> {
  return new Promise((resolve, reject) => {
    let c: DbConnection | undefined;
    let settled = false;
    const fail = (error: unknown) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(error); }
      c?.disconnect();
    };
    const timer = setTimeout(() => fail(new Error(`Timeout connecting to ${URI}/${DB}`)), 15000);
    signal.addEventListener("abort", () => fail(new Error("Connection retired")), {once:true});
    c = DbConnection.builder().withUri(URI).withDatabaseName(DB).withToken(loadToken())
      .onConnect((connection, identity, token) => {
        if (signal.aborted || settled) { connection.disconnect(); return; }
        settled = true; clearTimeout(timer); saveToken(token);
        console.log(`Worker connected as ${identity.toHexString().slice(0,12)}`);
        resolve(connection);
      })
      .onConnectError((_ctx, error) => fail(error))
      .onDisconnect(() => {
        if (!settled) fail(new Error("Disconnected before connection completed"));
        disconnected();
      }).build();
    if (signal.aborted) fail(new Error("Connection retired"));
  });
}

async function prepare(c: DbConnection, signal: AbortSignal) {
  await c.reducers.workerEnsureGc({}); // Authorization must succeed, not merely connect.
  await new Promise<void>((resolve,reject) => {
    const fail = (error: unknown) => { cleanup(); reject(error); };
    const abort = () => fail(new Error("Subscription retired"));
    const timer = setTimeout(()=>fail(new Error("Worker subscription timed out")),15000);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort",abort); };
    signal.addEventListener("abort",abort,{once:true});
    c.subscriptionBuilder().onApplied(()=>{cleanup();resolve();})
      .onError(ctx=>fail(new Error(String((ctx as {event?:unknown}).event ?? "Subscription failed"))))
      .subscribe(SVC_VIEWS);
    if (signal.aborted) abort();
  });
  if (signal.aborted) throw new Error("Connection retired");
  await seedPlaces(c);
  if (signal.aborted) throw new Error("Connection retired");
  resetLoopState();
  const process = () => { if (runtime.ready === c) void runtime.processOnce(); };
  c.db.svcQuery.onInsert(process);
  c.db.svcQuery.onUpdate(process);
  c.db.svcWatch.onInsert(process);
  c.db.svcObservation.onInsert(process);
  c.db.svcPromptResponse.onInsert(process);
  c.db.svcPost.onInsert(process);
  c.db.svcComment.onInsert(process);
}

const runtime = new ConnectionLoop({ connect, prepare, dispose:(c:DbConnection)=>c.disconnect(),
  process:tick, onReady:()=>console.log("Worker authorized and subscribed"),
  onError:(error)=>console.error("Worker recovery:",error), });

async function main() {
  initPush();
  startAsiServer(()=>runtime.ready,PORT,{onDevWipe:resetLoopState});
  const healthy=await agentHealth();
  console.log(`Agent ${healthy ? "up" : "DOWN"}`);
  runtime.start();
  for (const event of ["SIGINT","SIGTERM"] as const) process.once(event,()=>{runtime.stop();process.exit(0);});
}
void main().catch(error=>{console.error(error);process.exit(1);});
