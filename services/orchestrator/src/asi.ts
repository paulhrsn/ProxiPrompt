import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CATALOG_PLACES, resolveCatalogPlace } from "@proxiprompt/core";
import { searchPlaces } from "./places.js";
import type { DbConnection } from "../../../spacetimedb/bindings/index.js";
import { parseJson, toMs } from "./util.js";

export interface AsiRecord {
  id: string;
  queryId?: string;
  status: string;
  headline?: string;
  confidence?: string;
  sources?: string;
  recommendation?: string;
  freshest_age_s?: number;
  message?: string;
  progress?: string;
}

const records = new Map<string, AsiRecord>();

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const LOCAL_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;

/**
 * The dev wipe must come from the developer's own browser on this machine:
 * - a loopback socket (not the LAN; this server listens on 0.0.0.0);
 * - no proxy forwarding headers (ngrok adds X-Forwarded-For, and Vite passes it on);
 * - the custom X-ProxiPrompt-Dev header, which a cross-site page cannot send without a CORS
 *   preflight, and the preflight below does not allow it;
 * - no Origin, or a localhost one.
 */
export function isLocalDevRequest(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(addr)) return false;
  if (Object.keys(req.headers).some((h) => h === "forwarded" || h.startsWith("x-forwarded-"))) return false;
  if (req.headers["x-proxiprompt-dev"] !== "1") return false;
  const origin = req.headers.origin;
  return !origin || LOCAL_ORIGIN.test(origin);
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}

const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"];

/**
 * Gate for the /asi/query routes, which submit as the service identity. With ORCH_BRIDGE_TOKEN
 * set, callers must send `Authorization: Bearer <token>`. A non-loopback ORCH_HOST with no token
 * fails closed (503); the default loopback bind with no token stays open for local dev.
 * Returns true when it has already answered the request.
 */
function rejectBridge(req: IncomingMessage, res: ServerResponse): boolean {
  const token = process.env.ORCH_BRIDGE_TOKEN?.trim() ?? "";
  if (!token) {
    const host = process.env.ORCH_HOST?.trim() || "127.0.0.1";
    if (LOOPBACK_HOSTS.includes(host)) return false;
    json(res, 503, { error: "ORCH_BRIDGE_TOKEN is required when ORCH_HOST is not a loopback address" });
    return true;
  }
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const want = Buffer.from(token);
  if (given.length === want.length && timingSafeEqual(given, want)) return false;
  json(res, 401, { error: "missing or invalid bridge token" });
  return true;
}

export function startAsiServer(
  getConn: () => DbConnection | null,
  port: number,
  hooks: { onDevWipe?: () => void } = {},
) {
  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://local");
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, { ok: true, connected: !!getConn() });
        return;
      }
      if (req.method === "GET" && url.pathname === "/places") {
        const places = await searchPlaces(url.searchParams.get("q") ?? "");
        json(res, 200, { places });
        return;
      }
      if (req.method === "GET" && url.pathname === "/vapidPublicKey") {
        json(res, 200, { publicKey: process.env.VITE_VAPID_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY || "" });
        return;
      }
      if (req.method === "POST" && url.pathname === "/asi/query") {
        if (rejectBridge(req, res)) return;
        const body = JSON.parse((await readBody(req)) || "{}") as { text?: string; sender?: string };
        const text = (body.text ?? "").trim();
        const id = `asi-${Date.now().toString(36)}`;
        const place = resolveCatalogPlace(text);
        if (!place) {
          const rec: AsiRecord = {
            id,
            status: "refused",
            message: "Name a place I know (try Shapiro Library, the Union, Duderstadt, CCRB).",
          };
          records.set(id, rec);
          json(res, 200, rec);
          return;
        }
        const conn = getConn();
        if (!conn) {
          const rec: AsiRecord = { id, status: "failed", message: "ProxiPrompt network is offline." };
          records.set(id, rec);
          json(res, 200, rec);
          return;
        }
        await conn.reducers.upsertPlace({
          id: place.id,
          name: place.name,
          category: place.category,
          lat: place.lat,
          lng: place.lng,
          address: place.address,
          community: place.community,
        });
        const clientRequestId = id;
        await conn.reducers.submitQuery({ clientRequestId, placeId: place.id, text: text.slice(0, 300) });
        const rec: AsiRecord = { id, status: "pending", progress: `Checking ${place.name}` };
        records.set(id, rec);
        json(res, 200, rec);
        return;
      }
      const poll = url.pathname.match(/^\/asi\/query\/([^/]+)$/);
      if (req.method === "GET" && poll) {
        if (rejectBridge(req, res)) return;
        const id = decodeURIComponent(poll[1]);
        const rec = records.get(id);
        if (!rec) {
          json(res, 404, { error: "unknown id" });
          return;
        }
        const conn = getConn();
        if (conn) {
          const q = [...conn.db.svcQuery.iter()].find((row) => row.clientRequestId === id);
          if (q) {
            rec.queryId = String(q.id);
            rec.status = q.status;
            rec.progress = [...conn.db.svcQueryEvent.iter()]
              .filter((e) => e.queryId === q.id)
              .sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt))[0]?.message;
            if (q.answerJson) {
              const ans = parseJson<{
                headline?: string;
                recommendation?: string;
                confidence?: { level?: string };
                sourceCount?: number;
                updatedAtMs?: number;
              }>(q.answerJson, {});
              rec.headline = ans.headline;
              rec.confidence = ans.confidence?.level;
              if (ans.recommendation) rec.recommendation = ans.recommendation;
              // updatedAtMs is the newest firsthand observation the answer used.
              if (typeof ans.updatedAtMs === "number") {
                rec.freshest_age_s = Math.max(0, Math.round((Date.now() - ans.updatedAtMs) / 1000));
              }
              if (typeof ans.sourceCount === "number") {
                rec.sources = `${ans.sourceCount} recent nearby report${ans.sourceCount === 1 ? "" : "s"}`;
              }
            }
          }
        }
        json(res, 200, rec);
        return;
      }
      // Dev only: the web app's "Wipe activity" button. Opt-in so a deployed orchestrator
      // never exposes it; POST so a link or prefetch cannot trigger it; local-only (above).
      if (req.method === "POST" && url.pathname === "/dev/wipe" && process.env.ENABLE_DEV_WIPE === "1") {
        if (!isLocalDevRequest(req)) {
          json(res, 403, { error: "dev wipe is only available from the local web app on this machine" });
          return;
        }
        const conn = getConn();
        if (!conn) {
          json(res, 503, { error: "orchestrator is not connected to SpacetimeDB" });
          return;
        }
        await conn.reducers.workerDevWipe({});
        hooks.onDevWipe?.();
        records.clear();
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && url.pathname === "/catalog") {
        json(res, 200, CATALOG_PLACES);
        return;
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });
  // Loopback by default: /asi/query submits as the service identity, so on 0.0.0.0 anyone who
  // can reach this machine could ask questions without an account. Phones reach /places and
  // /dev through the Vite proxy, which runs here. A hosted deploy sets ORCH_HOST=0.0.0.0.
  const host = process.env.ORCH_HOST?.trim() || "127.0.0.1";
  server.listen(port, host, () => console.log(`orchestrator http ${host}:${port}`));
  return server;
}
