/**
 * Simulated neighbors: N bot users who sit at catalog places, keep a fresh demo location, and answer
 * every prompt they are sent, so one presenter can run the whole demo alone.
 *
 * Bots are ordinary users: public client reducers only (set_profile, upsert_place, update_location,
 * register_device, submit_response, create_post). They never touch the worker/service identity.
 *
 *   pnpm demo:neighbors -- --db proxiprompt --uri ws://127.0.0.1:3000 --count 8 --seed-posts
 *   pnpm demo:neighbors -- --uri wss://maincloud.spacetimedb.com --db proxiprompt-mhacks
 *
 * Tokens persist in spacetimedb/.local/neighbor-tokens-<db>.json so a restart reuses the same accounts.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG_PLACES, type CatalogPlace } from "@proxiprompt/core";
import { DbConnection } from "../../../spacetimedb/bindings/index.js";
import { PERSONAS, chooseAnswer, seedPostText, type Control, type Persona } from "../src/neighbors.js";

// ---------- args ----------
function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--" || !a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const URI = String(args.uri ?? process.env.STDB_URI ?? "ws://127.0.0.1:3000");
const DB = String(args.db ?? process.env.STDB_DB ?? "proxiprompt");
const COUNT = Math.max(1, Math.min(40, Number(args.count ?? 8) || 8));
const SEED_POSTS = args["seed-posts"] === true || args["seed-posts"] === "true";
const MIN_DELAY_MS = Number(args["min-delay"] ?? 3) * 1000;
const MAX_DELAY_MS = Number(args["max-delay"] ?? 12) * 1000;
const LOCATION_REFRESH_MS = 4 * 60 * 1000;
const POST_COOLDOWN_MS = 60 * 60 * 1000;

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(here, "..", "..", "..", "spacetimedb", ".local", `neighbor-tokens-${DB}.json`);

// ---------- token store ----------
interface BotRecord {
  token: string;
  username?: string;
  lastPostAt?: number;
}
type Store = Record<string, BotRecord>;
function loadStore(): Store {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")) as Store;
  } catch {
    return {};
  }
}
function saveStore(store: Store) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
}
const store = loadStore();

// ---------- helpers ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const stamp = () => new Date().toLocaleTimeString("en-US", { hour12: false });
const log = (msg: string) => console.log(`${stamp()} ${msg}`);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const tsMs = (t: { microsSinceUnixEpoch: bigint }) => Number(t.microsSinceUnixEpoch / 1000n);

function personaFor(i: number): Persona {
  if (i < PERSONAS.length) return PERSONAS[i];
  // Past the named list: simple extra neighbors spread over the catalog.
  const place = CATALOG_PLACES[i % CATALOG_PLACES.length];
  return { username: `neighbor${i + 1}_sim`, placeId: place.id };
}

const SHEET_KEYS = [
  "SELECT * FROM place",
  "SELECT * FROM my_profile",
  "SELECT * FROM my_prompts",
];

class Bot {
  private conn: DbConnection | null = null;
  private answered = new Set<string>();
  private scheduled = new Set<string>();
  private timers = new Set<NodeJS.Timeout>();
  private stopped = false;
  readonly place: CatalogPlace;
  username: string;

  constructor(
    private readonly key: string,
    persona: Persona,
  ) {
    this.username = store[key]?.username ?? persona.username;
    this.place = CATALOG_PLACES.find((p) => p.id === persona.placeId) ?? CATALOG_PLACES[0];
  }

  private tag() {
    return `[${this.username} @ ${this.place.name}]`;
  }

  private connect(): Promise<DbConnection> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out connecting to ${URI}/${DB}`)), 15_000);
      DbConnection.builder()
        .withUri(URI)
        .withDatabaseName(DB)
        .withToken(store[this.key]?.token)
        .onConnect((conn, _identity, token) => {
          clearTimeout(timer);
          store[this.key] = { ...store[this.key], token, username: this.username };
          saveStore(store);
          resolve(conn);
        })
        .onConnectError((_ctx, err) => {
          clearTimeout(timer);
          reject(err);
        })
        .onDisconnect(() => {
          if (this.stopped) return;
          log(`${this.tag()} disconnected, reconnecting in 3s`);
          this.conn = null;
          this.clearTimers();
          setTimeout(() => void this.start().catch((e) => log(`${this.tag()} reconnect failed: ${errText(e)}`)), 3000);
        })
        .build();
    });
  }

  private subscribe(conn: DbConnection): Promise<void> {
    return new Promise((resolve, reject) => {
      conn
        .subscriptionBuilder()
        .onApplied(() => resolve())
        .onError((ctx: any) => reject(new Error(String(ctx?.event?.message ?? ctx?.event ?? "subscription error"))))
        .subscribe(SHEET_KEYS);
    });
  }

  async start() {
    this.conn = await this.connect();
    const conn = this.conn;
    await this.subscribe(conn);
    await this.onboard(conn);
    await this.setLocation(conn);
    this.every(LOCATION_REFRESH_MS, () => void this.setLocation(conn).catch((e) => log(`${this.tag()} location refresh failed: ${errText(e)}`)));
    this.every(1500, () => this.sweep(conn));
    this.sweep(conn);
  }

  private async onboard(conn: DbConnection) {
    const mine = [...conn.db.myProfile.iter()][0];
    if (mine) {
      this.username = mine.username;
    } else {
      const base = this.username;
      for (let n = 1; n <= 5; n++) {
        const name = n === 1 ? base : `${base.slice(0, 18)}${n}`;
        try {
          await conn.reducers.setProfile({ username: name, defaultAttribution: "profile", avatarSeed: name });
          this.username = name;
          break;
        } catch (e) {
          if (!/taken/i.test(errText(e)) || n === 5) throw e;
        }
      }
      store[this.key] = { ...store[this.key], username: this.username };
      saveStore(store);
    }
    // A registered (fake) device is what makes routing consider this user reachable; the push itself goes nowhere.
    await conn.reducers.registerDevice({
      endpoint: `https://push.example.invalid/sim/${DB}/${this.username}`,
      p256Dh: "dGVzdA",
      auth: "dGVzdA",
      userAgent: "proxiprompt-simulated-neighbor",
    });
    // Make sure the claimed place exists; upsert_place never overwrites an existing place for a normal user.
    const known = [...conn.db.place.iter()].some((p) => p.id === this.place.id);
    if (!known) {
      const p = this.place;
      await conn.reducers.upsertPlace({ id: p.id, name: p.name, category: p.category, lat: p.lat, lng: p.lng, address: p.address, community: p.community });
    }
  }

  private async setLocation(conn: DbConnection) {
    // About 10 m of wobble, well inside the 60 m demo match radius.
    const p = this.place;
    await conn.reducers.updateLocation({
      lat: p.lat + rand(-0.00009, 0.00009),
      lng: p.lng + rand(-0.00012, 0.00012),
      accuracyM: 15,
      source: "demo",
      claimedPlaceId: p.id,
    });
  }

  /** Schedule an answer for every prompt that is open and not yet handled. */
  private sweep(conn: DbConnection) {
    const now = Date.now();
    for (const prompt of conn.db.myPrompts.iter()) {
      const id = String(prompt.batchId);
      if (prompt.responded || prompt.expired || this.answered.has(id) || this.scheduled.has(id)) continue;
      if (tsMs(prompt.expiresAt) <= now) continue;
      this.scheduled.add(id);
      const delay = Math.min(rand(MIN_DELAY_MS, MAX_DELAY_MS), Math.max(0, tsMs(prompt.expiresAt) - now - 2000));
      if (process.env.NEIGHBOR_DEBUG) log(`${this.tag()} batch ${id} will answer in ${(delay / 1000).toFixed(1)}s`);
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        void this.answer(conn, id);
      }, delay);
      this.timers.add(timer);
    }
  }

  private async answer(conn: DbConnection, id: string) {
    const prompt = [...conn.db.myPrompts.iter()].find((p) => String(p.batchId) === id);
    this.scheduled.delete(id);
    if (!prompt || prompt.responded || prompt.expired || this.answered.has(id) || tsMs(prompt.expiresAt) <= Date.now()) return;
    let controls: Control[];
    try {
      controls = JSON.parse(prompt.controlsJson) as Control[];
    } catch {
      return;
    }
    this.answered.add(id);
    const choice = chooseAnswer({ controls, placeCategory: prompt.placeCategory, hour: new Date().getHours(), rng: Math.random });
    try {
      await conn.reducers.submitResponse({ batchId: prompt.batchId, answersJson: JSON.stringify(choice.answers), note: choice.note });
      const summary = choice.pass ? "passed (not_here)" : Object.entries(choice.answers).map(([k, v]) => `${k}=${v}`).join(" ");
      log(`${this.tag()} answered batch ${id} "${prompt.question}": ${summary}${choice.note ? ` | "${choice.note}"` : ""}`);
    } catch (e) {
      log(`${this.tag()} answer for batch ${id} failed: ${errText(e)}`);
    }
  }

  async seedPost(): Promise<boolean> {
    const conn = this.conn;
    if (!conn) return false;
    const last = store[this.key]?.lastPostAt ?? 0;
    if (Date.now() - last < POST_COOLDOWN_MS) {
      log(`${this.tag()} posted recently, skipping seed post`);
      return false;
    }
    const text = seedPostText(this.place.category, new Date().getHours(), Math.random);
    await conn.reducers.createPost({ placeId: this.place.id, text, attribution: "profile" });
    store[this.key] = { ...store[this.key], lastPostAt: Date.now() };
    saveStore(store);
    log(`${this.tag()} posted: "${text}"`);
    return true;
  }

  private every(ms: number, fn: () => void) {
    const t = setInterval(fn, ms);
    this.timers.add(t as unknown as NodeJS.Timeout);
  }

  private clearTimers() {
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers.clear();
    this.scheduled.clear();
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    this.conn?.disconnect();
  }
}

async function main() {
  log(`simulated neighbors: ${COUNT} bots -> ${URI}/${DB} (tokens: ${path.relative(process.cwd(), TOKEN_FILE)})`);
  const bots: Bot[] = [];
  for (let i = 0; i < COUNT; i++) {
    const persona = personaFor(i);
    const bot = new Bot(`bot${i + 1}`, persona);
    try {
      await bot.start();
      bots.push(bot);
      log(`[${bot.username}] online at ${bot.place.name}`);
    } catch (e) {
      log(`[${persona.username}] failed to start: ${errText(e)}`);
    }
  }
  if (bots.length === 0) throw new Error("no bots could start");

  if (SEED_POSTS) {
    // A handful of posts at different places: the first bot of each distinct place, up to 4.
    const seen = new Set<string>();
    let n = 0;
    for (const bot of bots) {
      if (seen.has(bot.place.id) || n >= 4) continue;
      seen.add(bot.place.id);
      try {
        if (await bot.seedPost()) n++;
      } catch (e) {
        log(`[${bot.username}] seed post failed: ${errText(e)}`);
      }
      await sleep(300);
    }
    log(`seeded ${n} Live Pulse post(s)`);
  }

  log(`${bots.length} neighbors ready, answering prompts after ${MIN_DELAY_MS / 1000}-${MAX_DELAY_MS / 1000}s. Ctrl+C to stop.`);
  const shutdown = () => {
    log("stopping neighbors");
    for (const b of bots) b.stop();
    setTimeout(() => process.exit(0), 200);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("demo-neighbors failed:", errText(e));
  process.exit(1);
});
