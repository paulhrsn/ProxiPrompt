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

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}

export function startAsiServer(getConn: () => DbConnection | null, port: number) {
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
              const ans = parseJson<{ headline?: string; confidence?: { level?: string }; sourceCount?: number }>(
                q.answerJson,
                {},
              );
              rec.headline = ans.headline;
              rec.confidence = ans.confidence?.level;
              if (typeof ans.sourceCount === "number") {
                rec.sources = `${ans.sourceCount} recent nearby report${ans.sourceCount === 1 ? "" : "s"}`;
              }
            }
          }
        }
        json(res, 200, rec);
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
  server.listen(port, "0.0.0.0", () => console.log(`orchestrator http :${port}`));
  return server;
}
