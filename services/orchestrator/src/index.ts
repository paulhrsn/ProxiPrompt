import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG_PLACES } from "@proxiprompt/core";
import { DbConnection } from "../../../spacetimedb/bindings/index.js";
import { agentHealth } from "./agent.js";
import { startAsiServer } from "./asi.js";
import { tick } from "./loop.js";
import { initPush } from "./push.js";

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
  "SELECT * FROM svc_impact_event",
];

let conn: DbConnection | null = null;
let busy = false;
let queued = false;

async function processOnce() {
  if (!conn) return;
  if (busy) {
    queued = true;
    return;
  }
  busy = true;
  try {
    do {
      queued = false;
      await tick(conn);
    } while (queued);
  } catch (e) {
    console.error("tick failed", e);
  } finally {
    busy = false;
  }
}

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

function connect(): Promise<DbConnection> {
  return new Promise((resolve, reject) => {
    const token = loadToken();
    const timer = setTimeout(() => reject(new Error(`timeout connecting to ${URI}/${DB}`)), 15_000);
    DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB)
      .withToken(token)
      .onConnect(async (c, identity, tok) => {
        clearTimeout(timer);
        saveToken(tok);
        console.log(`orchestrator connected as ${identity.toHexString().slice(0, 12)}…`);
        try {
          await c.reducers.claimServiceRole({});
          console.log("claimed service role");
        } catch (e) {
          console.log("claim_service_role:", (e as Error).message);
        }
        resolve(c);
      })
      .onConnectError((_ctx, err) => {
        clearTimeout(timer);
        reject(err);
      })
      .onDisconnect(() => {
        console.warn("disconnected; reconnecting in 2s");
        conn = null;
        setTimeout(() => {
          connect()
            .then((c) => attach(c))
            .catch((e) => console.error(e));
        }, 2000);
      })
      .build();
  });
}

async function attach(c: DbConnection) {
  conn = c;
  await new Promise<void>((resolve, reject) => {
    c.subscriptionBuilder()
      .onApplied(() => resolve())
      .onError((ctx) => reject(new Error(String((ctx as { event?: { message?: string } }).event?.message ?? "sub error"))))
      .subscribe(SVC_VIEWS);
  });
  console.log("subscribed to svc_* views");
  await seedPlaces(c);
  c.db.svcQuery.onInsert(() => void processOnce());
  c.db.svcQuery.onUpdate(() => void processOnce());
  c.db.svcPromptResponse.onInsert(() => void processOnce());
  c.db.svcPost.onInsert(() => void processOnce());
  c.db.svcComment.onInsert(() => void processOnce());
  setInterval(() => void processOnce(), 2000);
  void processOnce();
}

async function main() {
  initPush();
  startAsiServer(() => conn, PORT);
  const healthy = await agentHealth();
  console.log(`agent ${process.env.AGENT_URL ?? "http://127.0.0.1:8001"} ${healthy ? "up" : "DOWN"}`);
  const c = await connect();
  await attach(c);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
