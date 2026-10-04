import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startAsiServer } from "../src/asi";

let server: Server | null = null;

async function start(conn: unknown, onWipe = () => {}) {
  server = startAsiServer(() => conn as never, 0, { onDevWipe: onWipe });
  await new Promise((r) => server!.once("listening", r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

afterEach(() => {
  server?.close();
  server = null;
  vi.unstubAllEnvs();
});

describe("POST /dev/wipe", () => {
  it("is not exposed unless ENABLE_DEV_WIPE=1", async () => {
    const workerDevWipe = vi.fn();
    const base = await start({ reducers: { workerDevWipe } });
    const res = await fetch(`${base}/dev/wipe`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(workerDevWipe).not.toHaveBeenCalled();
  });

  it("wipes through the service identity and resets in-memory loop state", async () => {
    vi.stubEnv("ENABLE_DEV_WIPE", "1");
    const workerDevWipe = vi.fn().mockResolvedValue(undefined);
    const onWipe = vi.fn();
    const base = await start({ reducers: { workerDevWipe } }, onWipe);
    const res = await fetch(`${base}/dev/wipe`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(workerDevWipe).toHaveBeenCalledTimes(1);
    expect(onWipe).toHaveBeenCalledTimes(1);
  });

  it("rejects GET so a stray link or prefetch cannot wipe", async () => {
    vi.stubEnv("ENABLE_DEV_WIPE", "1");
    const workerDevWipe = vi.fn();
    const base = await start({ reducers: { workerDevWipe } });
    expect((await fetch(`${base}/dev/wipe`)).status).toBe(404);
    expect(workerDevWipe).not.toHaveBeenCalled();
  });

  it("reports 503 when the orchestrator is not connected", async () => {
    vi.stubEnv("ENABLE_DEV_WIPE", "1");
    const base = await start(null);
    expect((await fetch(`${base}/dev/wipe`, { method: "POST" })).status).toBe(503);
  });
});
