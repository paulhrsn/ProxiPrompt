import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DbConnection } from "../../../spacetimedb/bindings/index.js";
import { useDevMode, useOidc } from "./auth";

function spacetimeUri(): string {
  const configured = import.meta.env.VITE_SPACETIMEDB_URI as string | undefined;
  // A hosted database (MainCloud) is reached directly from every host, phones included.
  if (configured && !/\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(configured)) return configured;
  const host = location.hostname;
  if (host === "localhost" || host === "127.0.0.1") {
    return configured || "ws://127.0.0.1:3000";
  }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}`;
}

const URI = spacetimeUri();
const DB = import.meta.env.VITE_SPACETIMEDB_DB || "proxiprompt";
// One saved identity per database: a token issued by the local server is rejected by MainCloud
// (and the reverse), and local and MainCloud databases have different names. The local
// `proxiprompt` keeps the original key so existing dev users (laptop and ngrok) stay put.
const TOKEN_KEY = DB === "proxiprompt" ? "pp.token" : `pp.token:${DB}`;

const VIEWS = [
  "SELECT * FROM place",
  "SELECT * FROM pulse_posts",
  "SELECT * FROM pulse_comments",
  "SELECT * FROM my_profile",
  "SELECT * FROM my_location",
  "SELECT * FROM my_queries",
  "SELECT * FROM my_watches",
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
  const { dev } = useDevMode();
  const auth = useOidc();
  const idToken = auth?.user?.id_token;
  const [conn, setConn] = useState<Conn | null>(null);
  const [identityHex, setIdentityHex] = useState("");
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [retry, setRetry] = useState(0);
  const bump = () => setTick((n) => n + 1);

  useEffect(() => {
    if (!dev && !idToken) {
      setConn(null);
      setConnected(false);
      setIdentityHex("");
      return;
    }

    let closed = false;
    const token = dev ? localStorage.getItem(TOKEN_KEY) || undefined : idToken;
    const c = DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB)
      .withToken(token)
      .onConnect((connection, identity, tok) => {
        if (closed) return;
        if (dev) localStorage.setItem(TOKEN_KEY, tok);
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
        if (closed) return;
        const message = err instanceof Error ? err.message : "Could not reach SpacetimeDB";
        // A saved dev token this server does not recognise: forget it and start a fresh session.
        if (dev && token && /verify token|unauthori[sz]ed|401/i.test(message)) {
          localStorage.removeItem(TOKEN_KEY);
          setRetry((n) => n + 1);
          return;
        }
        setError(message);
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
  }, [dev, idToken, retry]);

  const value = useMemo(() => ({ conn, identityHex, connected, error, tick }), [conn, identityHex, connected, error, tick]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDb() {
  return useContext(Ctx);
}

export function list<T>(iter: Iterable<T> | undefined): T[] {
  return iter ? [...iter] : [];
}

export function clearLegacyToken() {
  localStorage.removeItem(TOKEN_KEY);
}
