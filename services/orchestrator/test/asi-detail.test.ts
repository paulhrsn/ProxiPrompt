import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startAsiServer } from "../src/asi";

let server: Server | null = null;

afterEach(() => {
  server?.close();
  server = null;
  vi.useRealTimers();
});

type Row = { id: bigint; clientRequestId: string; status: string; answerJson?: string };

function fakeConn(queryRow: (id: string) => Row | null) {
  let current: Row | null = null;
  return {
    reducers: {
      upsertPlace: vi.fn().mockResolvedValue(undefined),
      submitQuery: vi.fn(async ({ clientRequestId }: { clientRequestId: string }) => {
        current = queryRow(clientRequestId);
      }),
    },
    db: {
      svcQuery: { iter: vi.fn(() => (current ? [current] : [])) },
      svcQueryEvent: { iter: vi.fn(() => []) },
    },
  };
}

async function start(conn: unknown) {
  server = startAsiServer(() => conn as never, 0);
  await new Promise((r) => server!.once("listening", r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

async function submitAndPoll(base: string) {
  const created = await fetch(`${base}/asi/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Is Shapiro Library busy?", sender: "agent1abc" }),
  });
  const { id } = (await created.json()) as { id: string };
  return (await fetch(`${base}/asi/query/${id}`)).json() as Promise<Record<string, unknown>>;
}

describe("GET /asi/query/{id} detail", () => {
  it("returns recommendation and freshest_age_s from the stored answer", async () => {
    const now = Date.now();
    const conn = fakeConn((id) => ({
      id: 7n,
      clientRequestId: id,
      status: "answered",
      answerJson: JSON.stringify({
        headline: "Shapiro is moderately busy.",
        recommendation: "go",
        confidence: { level: "High" },
        sourceCount: 2,
        updatedAtMs: now - 240_000,
      }),
    }));
    const body = await submitAndPoll(await start(conn));
    expect(body.recommendation).toBe("go");
    expect(body.freshest_age_s).toBeGreaterThanOrEqual(240);
    expect(body.freshest_age_s).toBeLessThan(250);
    expect(body.headline).toBe("Shapiro is moderately busy.");
    expect(body.sources).toBe("2 recent nearby reports");
  });

  it("omits the new fields when the answer lacks them", async () => {
    const conn = fakeConn((id) => ({
      id: 8n,
      clientRequestId: id,
      status: "answered",
      answerJson: JSON.stringify({ headline: "Quiet.", confidence: { level: "Low" } }),
    }));
    const body = await submitAndPoll(await start(conn));
    expect(body).not.toHaveProperty("recommendation");
    expect(body).not.toHaveProperty("freshest_age_s");
  });
});
