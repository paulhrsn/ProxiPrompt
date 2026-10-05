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

export function parseJson<T = unknown>(raw: string | undefined | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
