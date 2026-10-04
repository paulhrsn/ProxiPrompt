/**
 * Scripted asker for hosted rehearsals: submits questions through the public client reducers and
 * records time to first prompt, to answered, final status, evidence count, confidence.
 *
 *   pnpm exec tsx scripts/rehearse.ts --uri wss://maincloud.spacetimedb.com --db proxiprompt-mhacks-test
 *
 * Needs an orchestrator and (for live answers) `pnpm demo:neighbors` running against the same DB.
 * Questions: --q "place-id|question text" (repeatable via ';;' separator), defaults below.
 */
import { CATALOG_PLACES } from "@proxiprompt/core";
import { DbConnection } from "../../../spacetimedb/bindings/index.js";

const argv = process.argv.slice(2);
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const URI = arg("uri", "ws://127.0.0.1:3000");
const DB = arg("db", "proxiprompt");
const TIMEOUT_MS = Number(arg("timeout", "90")) * 1000;
if (DB === "proxiprompt-mhacks") throw new Error("refusing the real demo DB");

const DEFAULTS = [
  "shapiro-undergraduate-library|Is Shapiro quiet right now, and are there open seats?",
  "duderstadt-center|How long is the line at Duderstadt Center right now?",
  "michigan-union|Is the Michigan Union busy right now?",
  "shapiro-undergraduate-library|Can I find a quiet seat at Shapiro?",
  "michigan-union|is my ex at the union",
];
const QUESTIONS = arg("q", "") ? arg("q", "").split(";;") : DEFAULTS;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FINAL = new Set(["answered", "insufficient", "refused", "failed", "expired"]);

function connect(): Promise<DbConnection> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("connect timeout")), 15000);
    DbConnection.builder().withUri(URI).withDatabaseName(DB)
      .onConnect((c) => { clearTimeout(t); resolve(c); })
      .onConnectError((_c, e) => { clearTimeout(t); reject(e); })
      .build();
  });
}

async function main() {
  const conn = await connect();
  await new Promise<void>((res, rej) =>
    conn.subscriptionBuilder().onApplied(() => res()).onError((c: any) => rej(new Error(String(c?.event?.message ?? "sub error"))))
      .subscribe(["SELECT * FROM place", "SELECT * FROM my_profile", "SELECT * FROM my_queries", "SELECT * FROM my_query_events", "SELECT * FROM my_prompts"]),
  );
  const suffix = Date.now().toString(36);
  await conn.reducers.setProfile({ username: `rehearse_${suffix}`.slice(0, 20), defaultAttribution: "anonymous", avatarSeed: "r" });
  // Far from every catalog place so the asker is never one of the responders.
  await conn.reducers.updateLocation({ lat: 42.30, lng: -83.80, accuracyM: 20, source: "demo" });
  for (const q of QUESTIONS) {
    const [placeId, text] = q.split("|");
    const p = CATALOG_PLACES.find((c) => c.id === placeId);
    if (!p) throw new Error(`unknown place ${placeId}`);
    await conn.reducers.upsertPlace({ id: p.id, name: p.name, category: p.category, lat: p.lat, lng: p.lng, address: p.address, community: p.community });
    const crid = `rehearse-${suffix}-${Math.random().toString(36).slice(2, 6)}`;
    const t0 = Date.now();
    await conn.reducers.submitQuery({ clientRequestId: crid, placeId: p.id, text });
    let tPrompt: number | null = null;
    let row: any;
    for (;;) {
      row = [...conn.db.myQueries.iter()].find((r) => r.clientRequestId === crid);
      if (row && tPrompt === null) {
        const ev = [...conn.db.myQueryEvents.iter()].filter((e) => e.queryId === row.id);
        if (ev.some((e) => /ask|prompt|nearby/i.test(e.message))) tPrompt = Date.now() - t0;
      }
      if (row && FINAL.has(row.status)) break;
      if (Date.now() - t0 > TIMEOUT_MS) break;
      await sleep(100);
    }
    const tFinal = Date.now() - t0;
    const answer = row?.answerJson ? JSON.parse(row.answerJson) : null;
    const events = [...conn.db.myQueryEvents.iter()].filter((e) => row && e.queryId === row.id).sort((a, b) => Number(a.id - b.id));
    const base = events.length ? Number(events[0].createdAt.microsSinceUnixEpoch) : 0;
    const stamped = events.map((e) => `+${((Number(e.createdAt.microsSinceUnixEpoch) - base) / 1e6).toFixed(1)}s ${e.message}`);
    console.log(JSON.stringify({
      q: text, place: placeId, status: row?.status ?? "none",
      firstPromptMs: tPrompt, finalMs: tFinal,
      evidence: answer?.sourceCount ?? null, confidence: answer?.confidence ?? null,
      cacheHit: answer?.cacheHit ?? null, reused: events.some((e) => /reusing/i.test(e.message)),
      headline: answer?.headline ?? answer?.summary ?? null, timeline: stamped,
    }));
    await sleep(500);
  }
  conn.disconnect();
}
main().catch((e) => { console.error("REHEARSE FAILED", e instanceof Error ? e.message : e); process.exit(1); });
