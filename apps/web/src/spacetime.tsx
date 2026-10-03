import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DbConnection } from "../../../spacetimedb/bindings/index.js";

const URI = import.meta.env.VITE_SPACETIMEDB_URI || "ws://127.0.0.1:3000";
const DB = import.meta.env.VITE_SPACETIMEDB_DB || "proxiprompt";
const TOKEN_KEY = "pp.token";

const VIEWS = [
  "SELECT * FROM place",
  "SELECT * FROM pulse_posts",
  "SELECT * FROM pulse_comments",
  "SELECT * FROM my_profile",
  "SELECT * FROM my_location",
  "SELECT * FROM my_queries",
  "SELECT * FROM my_query_events",
  "SELECT * FROM my_prompts",
  "SELECT * FROM my_posts",
  "SELECT * FROM my_comments",
  "SELECT * FROM my_impact",
  "SELECT * FROM my_devices",
];

export type Conn = DbConnection;

interface Store {
  conn: Conn | null;
  identityHex: string;
  connected: boolean;
  error: string;
  tick: number;
}

const Ctx = createContext<Store>({ conn: null, identityHex: "", connected: false, error: "", tick: 0 });

export function SpacetimeProvider({ children }: { children: ReactNode }) {
  const [conn, setConn] = useState<Conn | null>(null);
  const [identityHex, setIdentityHex] = useState("");
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const bump = () => setTick((n) => n + 1);

  useEffect(() => {
    let closed = false;
    const token = localStorage.getItem(TOKEN_KEY) || undefined;
    const c = DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB)
      .withToken(token)
      .onConnect((connection, identity, tok) => {
        if (closed) return;
        localStorage.setItem(TOKEN_KEY, tok);
        setIdentityHex(identity.toHexString());
        setConnected(true);
        setError("");
        setConn(connection);
        connection
          .subscriptionBuilder()
          .onApplied(() => bump())
          .onError((ctx) => setError(String((ctx as { event?: { message?: string } | Error }).event ?? "subscription failed")))
          .subscribe(VIEWS);
      })
      .onConnectError((_ctx, err) => {
        if (!closed) setError(err instanceof Error ? err.message : "Could not reach SpacetimeDB");
      })
      .onDisconnect(() => {
        if (closed) return;
        setConnected(false);
        setConn(null);
      })
      .build();

    const ping = setInterval(bump, 2000);
    return () => {
      closed = true;
      clearInterval(ping);
      c.disconnect();
    };
  }, []);

  const value = useMemo(() => ({ conn, identityHex, connected, error, tick }), [conn, identityHex, connected, error, tick]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDb() {
  return useContext(Ctx);
}

export function list<T>(iter: Iterable<T> | undefined): T[] {
  return iter ? [...iter] : [];
}
