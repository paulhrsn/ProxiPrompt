import { Identity } from "spacetimedb";

export const MICROS_PER_MS = 1000n;

export function toMs(ts: { microsSinceUnixEpoch: bigint } | undefined | null): number {
  if (!ts) return 0;
  return Number(ts.microsSinceUnixEpoch / MICROS_PER_MS);
}

export function toMicros(ms: number): bigint {
  return BigInt(Math.max(0, Math.round(ms))) * MICROS_PER_MS;
}

export function nowMs(): number {
  return Date.now();
}

export function hexOf(id: { toHexString(): string } | undefined | null): string {
  return id ? id.toHexString() : "";
}

export function identityFromHex(hex: string): Identity {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Identity.fromString(h);
}

export function parseJson<T = unknown>(raw: string | undefined | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function envFlag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes((process.env[name] ?? "").trim().toLowerCase());
}

export function requiredEnv(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}
