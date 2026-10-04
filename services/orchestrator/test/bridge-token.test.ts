import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startAsiServer } from "../src/asi";

let server: Server | null = null;

function fakeConn() {
  return {
    reducers: { upsertPlace: vi.fn().mockResolvedValue(undefined), submitQuery: vi.fn().mockResolvedValue(undefined) },
    db: { svcQuery: { iter: vi.fn(() => []) }, svcQueryEvent: { iter: vi.fn(() => []) } },
  };
}

async function start(conn: unknown) {
  server = startAsiServer(() => conn as never, 0);
  await new Promise((r) => server!.once("listening", r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const submit = (base: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/asi/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ text: "Is Shapiro Library busy?", sender: "agent1abc" }),
  });

afterEach(() => {
  server?.close();
  server = null;
  vi.unstubAllEnvs();
});

describe("ORCH_BRIDGE_TOKEN", () => {
  it("leaves /asi/query open on the default loopback bind with no token", async () => {
    const conn = fakeConn();
    const base = await start(conn);
    const res = await submit(base);
    expect(res.status).toBe(200);
    expect(conn.reducers.submitQuery).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing or wrong token on POST without touching the DB", async () => {
    vi.stubEnv("ORCH_BRIDGE_TOKEN", "s3cret");
    const conn = fakeConn();
    const base = await start(conn);
    for (const headers of [{} as Record<string, string>, { Authorization: "Bearer nope" }, { Authorization: "Bearer s3cretX" }, { Authorization: "s3cret" }]) {
      const res = await submit(base, headers);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: expect.any(String) });
    }
    expect(conn.reducers.upsertPlace).not.toHaveBeenCalled();
    expect(conn.reducers.submitQuery).not.toHaveBeenCalled();
  });

  it("accepts the right token on POST and GET", async () => {
    vi.stubEnv("ORCH_BRIDGE_TOKEN", "s3cret");
    const conn = fakeConn();
    const base = await start(conn);
    const auth = { Authorization: "Bearer s3cret" };
    const created = await submit(base, auth);
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };
    expect((await fetch(`${base}/asi/query/${id}`, { headers: auth })).status).toBe(200);
  });

  it("rejects GET /asi/query/{id} without the token before reading the DB", async () => {
    vi.stubEnv("ORCH_BRIDGE_TOKEN", "s3cret");
    const conn = fakeConn();
    const base = await start(conn);
    const res = await fetch(`${base}/asi/query/asi-whatever`);
    expect(res.status).toBe(401);
    expect(conn.db.svcQuery.iter).not.toHaveBeenCalled();
  });

  it("does not gate other routes", async () => {
    vi.stubEnv("ORCH_BRIDGE_TOKEN", "s3cret");
    const base = await start(fakeConn());
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});

describe("fail closed on a non-loopback bind", () => {
  it("returns 503 on /asi/query routes when ORCH_HOST is public and no token is set", async () => {
    vi.stubEnv("ORCH_HOST", "0.0.0.0");
    const conn = fakeConn();
    const base = await start(conn);
    const res = await submit(base);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("ORCH_BRIDGE_TOKEN");
    expect((await fetch(`${base}/asi/query/asi-x`)).status).toBe(503);
    expect(conn.reducers.submitQuery).not.toHaveBeenCalled();
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("treats an empty token as unset", async () => {
    vi.stubEnv("ORCH_HOST", "0.0.0.0");
    vi.stubEnv("ORCH_BRIDGE_TOKEN", "");
    const base = await start(fakeConn());
    expect((await submit(base)).status).toBe(503);
  });

  it("serves normally on a public bind once the token is set and presented", async () => {
    vi.stubEnv("ORCH_HOST", "0.0.0.0");
    vi.stubEnv("ORCH_BRIDGE_TOKEN", "s3cret");
    const base = await start(fakeConn());
    expect((await submit(base)).status).toBe(401);
    expect((await submit(base, { Authorization: "Bearer s3cret" })).status).toBe(200);
  });

  it.each(["127.0.0.1", "::1", "localhost"])("keeps %s open with no token", async (host) => {
    vi.stubEnv("ORCH_HOST", host);
    const conn = fakeConn();
    server = startAsiServer(() => conn as never, 0);
    await new Promise((r) => server!.once("listening", r));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://${host === "::1" ? "[::1]" : host}:${port}/asi/query`, {
      method: "POST",
      body: JSON.stringify({ text: "Is Shapiro Library busy?" }),
    });
    expect(res.status).toBe(200);
  });
});
