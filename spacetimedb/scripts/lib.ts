// Shared helpers for smoke.ts / guardrails.ts: connect as separate identities, subscribe, call reducers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Identity } from 'spacetimedb';
import { DbConnection } from '../bindings/index.js';

export const URI = process.env.STDB_URI ?? 'ws://127.0.0.1:3000';
export const DB = process.env.STDB_DB ?? 'proxiprompt';

const here = path.dirname(fileURLToPath(import.meta.url));
export const LOCAL_DIR = path.join(here, '..', '.local');

export interface Client {
  conn: DbConnection;
  identity: Identity;
  hex: string;
  token: string;
  close(): void;
}

/** Connect (anonymous new identity unless a token is given) and wait for the connection to be established. */
export function connect(token?: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out connecting to ${URI}/${DB}`)), 10_000);
    DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB)
      .withToken(token)
      .onConnect((conn, identity, tok) => {
        clearTimeout(timer);
        resolve({ conn, identity, hex: identity.toHexString(), token: tok, close: () => conn.disconnect() });
      })
      .onConnectError((_ctx, err) => {
        clearTimeout(timer);
        reject(err);
      })
      .build();
  });
}

/** Subscribe to SQL queries and resolve when the initial rows have been applied. */
export function subscribe(c: Client, queries: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    c.conn
      .subscriptionBuilder()
      .onApplied(() => resolve())
      .onError((ctx: any) => reject(new Error(String(ctx?.event?.message ?? ctx?.event ?? 'subscription error'))))
      .subscribe(queries);
  });
}

export async function eventually<T>(fn: () => T | undefined | null | false, ms = 4000, what = 'condition'): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function readWorkerToken(): string | undefined {
  try {
    return fs.readFileSync(path.join(LOCAL_DIR, `worker-token-${DB}`), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

export function writeWorkerToken(token: string): void {
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  fs.writeFileSync(path.join(LOCAL_DIR, `worker-token-${DB}`), token + '\n', { mode: 0o600 });
}
