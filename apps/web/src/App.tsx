import { useEffect, useMemo, useState } from "react";
import { CATALOG_PLACES, DEFAULT_COMMUNITY, describeLocation, formatAge, freshnessNote, haversineM, neighboringPlaces, rankPosts, type CatalogPlace } from "@proxiprompt/core";
import { CLIENT_ID, emailOf, useDevMode, useOidc } from "./auth";
import { clearLegacyToken, list, useDb } from "./spacetime";

type Route =
  | { name: "home" }
  | { name: "query"; id: string }
  | { name: "respond"; id: string }
  | { name: "posts" }
  | { name: "activity" }
  | { name: "profile" }
  | { name: "place"; id: string };

function parseHash(): Route {
  const h = location.hash.replace(/^#/, "") || "/";
  const parts = h.split("/").filter(Boolean);
  if (parts[0] === "q" && parts[1]) return { name: "query", id: parts[1] };
  if (parts[0] === "respond" && parts[1]) return { name: "respond", id: parts[1] };
  if (parts[0] === "posts") return { name: "posts" };
  if (parts[0] === "activity") return { name: "activity" };
  if (parts[0] === "profile") return { name: "profile" };
  if (parts[0] === "place" && parts[1]) return { name: "place", id: parts[1] };
  return { name: "home" };
}

function go(path: string) {
  location.hash = path;
}

const LAST_QUERY = "pp.lastQuery";

/**
 * A prompt is only worth showing while it can still be answered. submit_response rejects
 * an expired batch, so a card left up past `expiresAt` can only fail on Send.
 */
function isAnswerable(p: { responded: boolean; expiresAt: { microsSinceUnixEpoch: bigint } }): boolean {
  return !p.responded && toMs(p.expiresAt) > Date.now();
}
const OPEN_QUERY = new Set(["planning", "clarifying", "collecting", "synthesizing"]);

function askTarget(conn: Conn): string {
  const queries = list(conn.db.myQueries.iter());
  const active = queries
    .filter((q) => OPEN_QUERY.has(q.status))
    .sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt))[0];
  if (active) return `/q/${active.id}`;
  const last = sessionStorage.getItem(LAST_QUERY);
  if (last && queries.some((q) => String(q.id) === last)) return `/q/${last}`;
  return "/";
}

function toMs(ts: { microsSinceUnixEpoch: bigint } | undefined | null): number {
  if (!ts) return 0;
  return Number(ts.microsSinceUnixEpoch / 1000n);
}

const DEMO_PRESETS = CATALOG_PLACES;

export default function App() {
  const auth = useOidc();
  const { dev, setDev } = useDevMode();
  const signedIn = dev || !!auth?.isAuthenticated;
  const { conn, error, tick } = useDb();
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  const profile = conn ? list(conn.db.myProfile.iter())[0] : undefined;
  void tick;
  const showTabs = Boolean(signedIn && profile && conn && route.name !== "respond");
  const pushed = route.name === "query" || route.name === "respond" || route.name === "place";
  const tab =
    route.name === "posts" || route.name === "place" ? "posts"
    : route.name === "activity" ? "questions"
    : route.name === "profile" ? "you"
    : "ask";

  return (
    <div className={showTabs ? "app with-tabs" : "app"}>
      {pushed && signedIn ? (
        <button className="back" type="button" onClick={() => history.back()}>
          <Icon name="back" /> Back
        </button>
      ) : null}
      {error && <p className="err">{error}</p>}
      {auth?.isLoading && !dev ? <p className="ask-wait">Signing in.</p> : null}
      {!signedIn && !auth?.isLoading ? <SignedOut /> : null}
      {signedIn && !conn && !auth?.isLoading ? <p className="ask-wait">Reconnecting.</p> : null}
      {signedIn && !profile && conn ? <Onboard conn={conn} /> : null}
      {signedIn && profile && conn ? (
        route.name === "home" ? <Home conn={conn} /> :
        route.name === "query" ? <QueryDetail conn={conn} id={route.id} /> :
        route.name === "respond" ? <Respond conn={conn} id={route.id} /> :
        route.name === "posts" ? <Posts conn={conn} /> :
        route.name === "activity" ? <Activity conn={conn} /> :
        route.name === "profile" ? <Profile conn={conn} /> :
        <PlacePage conn={conn} id={route.id} />
      ) : null}
      {signedIn && profile && conn && route.name !== "respond" ? <PromptPing conn={conn} /> : null}
      {showTabs ? (
        <nav className="tabbar" aria-label="Primary">
          <button type="button" className={tab === "ask" ? "tab on" : "tab"} onClick={() => conn && go(askTarget(conn))}><Icon name="ask" />Ask</button>
          <button type="button" className={tab === "questions" ? "tab on" : "tab"} onClick={() => go("/activity")}><Icon name="questions" />Questions</button>
          <button type="button" className={tab === "posts" ? "tab on" : "tab"} onClick={() => go("/posts")}><Icon name="posts" />Posts</button>
          <button type="button" className={tab === "you" ? "tab on" : "tab"} onClick={() => go("/profile")}><Icon name="you" />You</button>
        </nav>
      ) : null}
      <button className={`dev-toggle${dev ? " on" : ""}`} onClick={() => setDev(!dev)}>{dev ? "Dev on" : "Dev"}</button>
    </div>
  );
}

function Icon({ name }: { name: "ask" | "posts" | "you" | "back" | "questions" }) {
  const props = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (name === "ask") return <svg {...props}><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" /></svg>;
  if (name === "questions") return <svg {...props}><path d="M4.5 6.5h15v9h-8l-4 3.5v-3.5h-3z" /></svg>;
  if (name === "posts") return <svg {...props}><path d="M5 7h14M5 12h14M5 17h9" /></svg>;
  if (name === "back") return <svg {...props} width={20} height={20}><path d="M14.5 6.5 9 12l5.5 5.5" /></svg>;
  return <svg {...props}><circle cx="12" cy="9" r="3" /><path d="M6.5 19c1.1-2.8 3-4.2 5.5-4.2s4.4 1.4 5.5 4.2" /></svg>;
}

function SignedOut() {
  const auth = useOidc();
  const [email, setEmail] = useState("");
  if (!CLIENT_ID) {
    return (
      <section className="ask">
        <p className="mark">ProxiPrompt</p>
        <h1>Sign in</h1>
        <p>Add VITE_SPACETIMEAUTH_CLIENT_ID, or turn on Dev.</p>
      </section>
    );
  }
  return (
    <section className="ask">
      <p className="mark">ProxiPrompt</p>
      <h1>Sign in</h1>
      <label className="label">
        Email
        <input className="input" type="email" autoComplete="email" placeholder="you@umich.edu" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      {auth?.error ? <p className="err">{auth.error.message}</p> : null}
      <button
        className="btn"
        disabled={!email.includes("@")}
        onClick={() => void auth?.signinRedirect({ extraQueryParams: { login_hint: email.trim() } })}
      >
        Sign in
      </button>
    </section>
  );
}

function Onboard({ conn }: { conn: NonNullable<ReturnType<typeof useDb>["conn"]> }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  return (
    <section>
      <h1>Your name</h1>
      <label className="label">
        Name
        <input className="input" placeholder="lowercase_name" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {err && <p className="err">{err}</p>}
      <button
        className="btn"
        onClick={async () => {
          try {
            await conn.reducers.setProfile({
              username: name.trim().toLowerCase(),
              defaultAttribution: "anonymous",
              avatarSeed: name.trim() || "seed",
            });
          } catch (e) {
            setErr((e as Error).message);
          }
        }}
      >
        Continue
      </button>
    </section>
  );
}

/** Polls my_queries for a just-submitted row. Returns its id, or null if it never lands. */
async function waitForQueryId(
  conn: NonNullable<ReturnType<typeof useDb>["conn"]>,
  clientRequestId: string,
  timeoutMs = 3000,
): Promise<bigint | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = list(conn.db.myQueries.iter()).find((row) => row.clientRequestId === clientRequestId);
    if (found) return found.id;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 80));
  }
}

function Home({ conn }: { conn: NonNullable<ReturnType<typeof useDb>["conn"]> }) {
  const [q, setQ] = useState("");
  const [place, setPlace] = useState<CatalogPlace | null>(CATALOG_PLACES[0]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function savePlace() {
    if (!place) return;
    await conn.reducers.upsertPlace({
      id: place.id,
      name: place.name,
      category: place.category,
      lat: place.lat,
      lng: place.lng,
      address: place.address,
      community: place.community,
    });
  }

  async function ask() {
    if (!place || q.trim().length < 3) return;
    setBusy(true);
    setErr("");
    try {
      await savePlace();
      const clientRequestId = crypto.randomUUID();
      await conn.reducers.submitQuery({ clientRequestId, placeId: place.id, text: q.trim() });
      // The reducer resolves before the my_queries view update arrives, so the row is not
      // there yet. Wait for it instead of bouncing the asker to /activity.
      const id = await waitForQueryId(conn, clientRequestId);
      go(id ? `/q/${id}` : "/activity");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function notify() {
    if (!place || q.trim().length < 3) return;
    setBusy(true);
    setErr("");
    try {
      await savePlace();
      const clientRequestId = crypto.randomUUID();
      // Ask once so someone nearby can look, and keep a watch so a later change still pings.
      await conn.reducers.submitQuery({ clientRequestId, placeId: place.id, text: q.trim() });
      await conn.reducers.createWatch({ clientRequestId: `watch-${clientRequestId}`, placeId: place.id, text: q.trim(), durationS: 0n });
      const id = await waitForQueryId(conn, clientRequestId);
      go(id ? `/q/${id}` : "/activity");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="ask" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
      <p className="mark">ProxiPrompt</p>
      <div className="status">
        <h1>{place?.name ?? "Where?"}</h1>
        <p>Ask someone who is there.</p>
      </div>
      <PlaceField place={place} onPlace={setPlace} />
      <label className="label">
        Question
        <textarea className="input" rows={3} placeholder="What’s it like there right now?" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      {err && <p className="err">{err}</p>}
      <div className="actions">
        <button className="btn" type="submit" disabled={busy || !place || q.trim().length < 3}>{busy ? "Asking…" : "Ask"}</button>
        <button className="btn ghost" type="button" disabled={busy || !place || q.trim().length < 3} onClick={() => void notify()}>Notify me when</button>
      </div>
    </form>
  );
}

type Conn = NonNullable<ReturnType<typeof useDb>["conn"]>;

function placeLabel(conn: Conn, id: string): string {
  return list(conn.db.place.iter()).find((p) => p.id === id)?.name ?? CATALOG_PLACES.find((p) => p.id === id)?.name ?? id;
}

function catalogPlaceFor(conn: Conn, id: string): CatalogPlace | null {
  const known = CATALOG_PLACES.find((p) => p.id === id);
  if (known) return known;
  const row = list(conn.db.place.iter()).find((p) => p.id === id);
  if (!row) return null;
  return { id: row.id, name: row.name, category: row.category, lat: row.lat, lng: row.lng, address: row.address, community: row.community, aliases: [] };
}

function PlaceField({
  place,
  onPlace,
  label = "Place",
  placeholder,
}: {
  place: CatalogPlace | null;
  onPlace: (place: CatalogPlace | null) => void;
  label?: string;
  placeholder?: string;
}) {
  const [filter, setFilter] = useState("");
  const [remote, setRemote] = useState<CatalogPlace[]>([]);
  const suggestions = useMemo(() => {
    const t = filter.trim().toLowerCase();
    const local = t
      ? CATALOG_PLACES.filter((p) => `${p.name} ${p.aliases.join(" ")} ${p.address}`.toLowerCase().includes(t)).slice(0, 6)
      : [];
    const seen = new Set(local.map((p) => p.id));
    return [...local, ...remote.filter((p) => !seen.has(p.id))].slice(0, 8);
  }, [filter, remote]);
  useEffect(() => {
    const q = filter.trim();
    if (q.length < 2) {
      setRemote([]);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
      const base = local ? ((import.meta.env.VITE_ORCH_URL as string | undefined) || "http://127.0.0.1:8080") : location.origin;
      fetch(`${base}/places?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then((res) => res.json())
        .then((data: { places?: CatalogPlace[] }) => setRemote(data.places ?? []))
        .catch(() => setRemote([]));
    }, 250);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [filter]);
  return (
    <label className="label">
      {label}
      <input
        className="input"
        placeholder={placeholder ?? (place ? "Change place" : "Search places")}
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value);
          if (e.target.value) onPlace(null);
        }}
      />
      {filter.trim().length >= 2 ? (
        <ul className="suggest" role="listbox">
          {suggestions.length ? suggestions.map((p) => (
            <li key={p.id}>
              <button type="button" role="option" onClick={() => { onPlace(p); setFilter(""); }}>
                {p.name}<small>{p.address}</small>
              </button>
            </li>
          )) : <li className="empty-suggest">No matching place</li>}
        </ul>
      ) : null}
    </label>
  );
}

function Posts({ conn }: { conn: Conn }) {
  const [sort, setSort] = useState<"useful" | "recent">("useful");
  const [feedId, setFeedId] = useState<string | null>(null);
  const now = Date.now();
  const posts = useMemo(() => {
    const raw = list(conn.db.pulsePosts.iter()).filter((p) => p.community === DEFAULT_COMMUNITY && (!feedId || p.placeId === feedId));
    const mapped = raw.map((p) => {
      const claims = (() => {
        try {
          return JSON.parse(p.claimsJson ?? "[]") as { dimension: string; volatility: "high" | "medium" | "low"; proposed_ttl_s: number; ordinal?: number | null }[];
        } catch {
          return [];
        }
      })();
      const note = freshnessNote({
        claims: claims.map((c) => ({
          dimension: c.dimension,
          volatility: c.volatility,
          ttlS: c.proposed_ttl_s,
          observedAtMs: toMs(p.createdAt),
          ordinal: c.ordinal,
        })),
        comments: list(conn.db.pulseComments.iter())
          .filter((c) => c.postId === p.id && c.text.length > 12)
          .map((c) => ({ atMs: toMs(c.createdAt) })),
        nowMs: now,
      });
      // Substantive = long enough to carry information, matching the filter used for the
      // freshness note above; the raw comment count would also score "ok" and "lol".
      const substantive = list(conn.db.pulseComments.iter()).filter(
        (c) => c.postId === p.id && c.text.trim().length > 12,
      ).length;
      return {
        ...p,
        id: String(p.id),
        postId: p.id,
        maxFreshness: note.maxFreshness,
        verifiedNearby: p.verifiedNearby,
        recentSubstantiveComments: substantive,
        createdAtMs: toMs(p.createdAt),
      };
    });
    return rankPosts(mapped, sort, now);
  }, [conn, sort, now, feedId]);
  const feedIds = useMemo(() => {
    const ids = new Set(list(conn.db.pulsePosts.iter()).filter((p) => p.community === DEFAULT_COMMUNITY).map((p) => p.placeId));
    if (feedId) ids.add(feedId);
    return [...ids].sort((a, b) => placeLabel(conn, a).localeCompare(placeLabel(conn, b)));
  }, [conn, feedId]);
  const feedPlace = feedId ? catalogPlaceFor(conn, feedId) : null;

  return (
    <section>
      <div className="screen-head">
        <h1>Posts</h1>
        <div className="segment" role="tablist" aria-label="Sort posts">
          <button type="button" role="tab" aria-selected={sort === "useful"} className={sort === "useful" ? "on" : ""} onClick={() => setSort("useful")}>Useful</button>
          <button type="button" role="tab" aria-selected={sort === "recent"} className={sort === "recent" ? "on" : ""} onClick={() => setSort("recent")}>Recent</button>
        </div>
      </div>
      {feedIds.length ? (
        <div className="chips" role="tablist" aria-label="Place feed">
          <button type="button" role="tab" aria-selected={!feedId} className={feedId ? "" : "on"} onClick={() => setFeedId(null)}>All places</button>
          {feedIds.map((id) => (
            <button type="button" role="tab" aria-selected={feedId === id} key={id} className={feedId === id ? "on" : ""} onClick={() => setFeedId(id)}>{placeLabel(conn, id)}</button>
          ))}
        </div>
      ) : null}
      <ComposerPost conn={conn} lockedPlace={feedPlace ?? undefined} onPosted={(p) => setFeedId(p.id)} />
      {posts.map((p) => (
        <PostCard key={p.id} conn={conn} post={p} placeName={placeLabel(conn, p.placeId)} showPlace={!feedId} onSelectPlace={setFeedId} />
      ))}
      {!posts.length ? (
        <div className="empty">
          <h2>{feedPlace ? `No posts at ${feedPlace.name}` : "No posts yet"}</h2>
          <p>Share what a place is like right now.</p>
        </div>
      ) : null}
    </section>
  );
}

function ComposerPost({ conn, lockedPlace, onPosted }: { conn: Conn; lockedPlace?: CatalogPlace; onPosted?: (place: CatalogPlace) => void }) {
  const [text, setText] = useState("");
  const [place, setPlace] = useState<CatalogPlace | null>(null);
  const [attr, setAttr] = useState<"anonymous" | "profile">("anonymous");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const chosen = lockedPlace ?? place;
  if (!open) return <button className="text" type="button" onClick={() => { setErr(""); setOpen(true); }}>Post an update</button>;
  return (
    <form
      className="composer"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!chosen || busy || text.trim().length < 1) return;
        setBusy(true);
        setErr("");
        try {
          await conn.reducers.upsertPlace({ id: chosen.id, name: chosen.name, category: chosen.category, lat: chosen.lat, lng: chosen.lng, address: chosen.address, community: chosen.community });
          await conn.reducers.createPost({ placeId: chosen.id, text: text.trim(), attribution: attr });
          setText("");
          setOpen(false);
          onPosted?.(chosen);
        } catch (error) {
          setErr((error as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {lockedPlace ? null : <PlaceField place={place} onPlace={setPlace} />}
      <label className="label">
        Update
        <textarea className="input" maxLength={280} rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Third floor is quiet." />
      </label>
      {err ? <p className="err">{err}</p> : null}
      <div className="row">
        <button className="control" type="button" onClick={() => setAttr(attr === "anonymous" ? "profile" : "anonymous")}>{attr === "anonymous" ? "Anonymous" : "Your name"}</button>
        <button className="text" type="button" onClick={() => { setOpen(false); setErr(""); }}>Cancel</button>
      </div>
      <button className="btn" type="submit" disabled={busy || !chosen || text.trim().length < 1}>{busy ? "Posting…" : "Post"}</button>
    </form>
  );
}

function summaryAdds(text: string, summary: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const body = norm(text);
  const note = norm(summary);
  if (!note || note === body || note.includes(body) || body.includes(note)) return false;
  return true;
}

/**
 * SPEC §12 P0 guardrails: delete your own content, report someone else's. Both reducers
 * existed and were guardrail-tested but had no way in from the UI.
 */
function ModerationRow({
  mine,
  onDelete,
  onReport,
}: {
  mine: boolean;
  onDelete: () => Promise<void>;
  onReport: (reason: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const run = async (fn: () => Promise<void>, done: string) => {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      await fn();
      setNote(done);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (note) return <p className="hint">{note}</p>;
  return (
    <div className="row">
      {mine ? (
        <button className="text" type="button" disabled={busy} onClick={() => void run(onDelete, "Deleted.")}>
          Delete
        </button>
      ) : (
        <button
          className="text"
          type="button"
          disabled={busy}
          onClick={() => void run(() => onReport("inappropriate"), "Reported. Thanks.")}
        >
          Report
        </button>
      )}
    </div>
  );
}

function PostCard({
  conn,
  post,
  placeName,
  showPlace,
  onSelectPlace,
  commentsOpen = false,
}: {
  conn: Conn;
  post: { postId: bigint; placeId: string; text: string; summary: string; freshnessNote: string; freshnessState: string; commentCount: number; attribution: string; authorLabel: string; createdAtMs: number };
  placeName: string;
  showPlace?: boolean;
  onSelectPlace?: (id: string) => void;
  commentsOpen?: boolean;
}) {
  const [open, setOpen] = useState(commentsOpen);
  const [reacting, setReacting] = useState(false);
  const [reactNote, setReactNote] = useState("");
  const count = Number(post.commentCount);
  async function react(text: "Still true" | "This changed") {
    if (reacting) return;
    setReacting(true);
    setReactNote("");
    try {
      await conn.reducers.createComment({ postId: post.postId, text, attribution: "anonymous" });
      setReactNote(text === "Still true" ? "Marked still true." : "Marked as changed.");
    } catch (error) {
      setReactNote((error as Error).message);
    } finally {
      setReacting(false);
    }
  }
  const commentLabel = count === 0 ? "Comment" : count === 1 ? "1 comment" : `${count} comments`;
  const mine = list(conn.db.myPosts.iter()).some((row) => row.postId === post.postId);
  return (
    <article className="card">
      <div className="meta">
        <span className="who">
          {showPlace && onSelectPlace ? (
            <button type="button" className="text" onClick={() => onSelectPlace(post.placeId)}>{placeName}</button>
          ) : null}
          {post.attribution === "profile" ? <span>{post.authorLabel}</span> : null}
        </span>
        <span>{formatAge((Date.now() - post.createdAtMs) / 1000)}</span>
      </div>
      <p className="body">{post.text}</p>
      {summaryAdds(post.text, post.summary) ? <p>{post.summary}</p> : null}
      {post.freshnessNote && post.freshnessState !== "fresh" && post.freshnessState !== "reinforced" ? <p className={`note ${post.freshnessState}`}>{post.freshnessNote}</p> : null}
      <button className="text" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide" : commentLabel}</button>
      {reactNote ? <p>{reactNote}</p> : null}
      {open ? (
        <>
          <div className="row">
            <button className="text" type="button" disabled={reacting} onClick={() => void react("Still true")}>Still true</button>
            <button className="text" type="button" disabled={reacting} onClick={() => void react("This changed")}>This changed</button>
          </div>
          <CommentBox conn={conn} postId={post.postId} />
          <ModerationRow
            mine={mine}
            onDelete={() => conn.reducers.deletePost({ postId: post.postId })}
            onReport={(reason) => conn.reducers.reportContent({ targetType: "post", targetId: post.postId, reason })}
          />
        </>
      ) : null}
    </article>
  );
}

function CommentBox({ conn, postId }: { conn: Conn; postId: bigint }) {
  const comments = list(conn.db.pulseComments.iter()).filter((c) => c.postId === postId).sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt));
  const [text, setText] = useState("");
  const [attr, setAttr] = useState<"anonymous" | "profile">("anonymous");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <div className="thread">
      {comments.filter((c) => !/^(still true|this changed)$/i.test(c.text.trim())).map((c) => {
        const isMine = list(conn.db.myComments.iter()).some((row) => row.commentId === c.id);
        return (
          <div key={String(c.id)}>
            <p className="comment"><span>{c.authorLabel}</span>{c.text}</p>
            <ModerationRow
              mine={isMine}
              onDelete={() => conn.reducers.deleteComment({ commentId: c.id })}
              onReport={(reason) => conn.reducers.reportContent({ targetType: "comment", targetId: c.id, reason })}
            />
          </div>
        );
      })}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy || text.trim().length < 1) return;
          setBusy(true);
          setErr("");
          try {
            await conn.reducers.createComment({ postId, text: text.trim(), attribution: attr });
            setText("");
          } catch (error) {
            setErr((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <input className="input" value={text} placeholder="Add a comment" onChange={(e) => setText(e.target.value)} />
        {err ? <p className="err">{err}</p> : null}
        <div className="row">
          <button className="control" type="button" onClick={() => setAttr(attr === "anonymous" ? "profile" : "anonymous")}>{attr === "anonymous" ? "Anonymous" : "Your name"}</button>
          <button className="btn small" type="submit" disabled={busy || text.trim().length < 1}>{busy ? "Sending…" : "Send"}</button>
        </div>
      </form>
    </div>
  );
}

function QueryDetail({ conn, id }: { conn: NonNullable<ReturnType<typeof useDb>["conn"]>; id: string }) {
  const q = list(conn.db.myQueries.iter()).find((row) => String(row.id) === id);
  const events = list(conn.db.myQueryEvents.iter()).filter((e) => String(e.queryId) === id).sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt));
  const [choice, setChoice] = useState("");
  const [diag, setDiag] = useState(false);
  useEffect(() => {
    sessionStorage.setItem(LAST_QUERY, id);
  }, [id]);
  if (!q) return <p>Query not found.</p>;
  const place = list(conn.db.place.iter()).find((p) => p.id === q.placeId);
  const clar = q.clarificationJson ? JSON.parse(q.clarificationJson) as { question: string; options: string[] } : null;
  const ans = q.answerJson ? JSON.parse(q.answerJson) as {
    headline: string; summary: string; supporting?: string[]; caveats?: string[];
    confidence?: { level?: string; score?: number; ceiling?: number };
    sourceCount?: number; updatedAtMs?: number; cacheHit?: boolean; factors?: unknown; planner?: string;
  } : null;
  return (
    <section>
      <div className="status">
        <h1>{ans?.headline || q.text}</h1>
        {place?.name ? <p>{place.name}</p> : null}
      </div>
      {!ans && (
        <ul className="timeline">
          {events.map((e) => <li key={String(e.id)} className={e === events.at(-1) ? "now" : ""}>{e.message}</li>)}
        </ul>
      )}
      {q.status === "clarifying" && clar && (
        <div className="card">
          <h2>{clar.question}</h2>
          {clar.options?.length ? (
            <div className="choices">
              {clar.options.map((o) => <button key={o} className={choice === o ? "on" : ""} onClick={() => setChoice(o)}>{o}</button>)}
            </div>
          ) : (
            // A clarification with no options would otherwise strand the query here forever.
            <label className="label">
              Your answer
              <input className="input" value={choice} placeholder="Type your answer" onChange={(e) => setChoice(e.target.value)} />
            </label>
          )}
          <button className="btn" disabled={!choice.trim()} onClick={() => conn.reducers.answerClarification({ queryId: q.id, choice: choice.trim() })}>Continue</button>
        </div>
      )}
      {!ans && OPEN_QUERY.has(q.status) ? (
        // A question that stalls (nobody nearby, agent down) would otherwise sit open forever.
        <button
          className="text"
          type="button"
          onClick={() => void conn.reducers.cancelQuery({ queryId: q.id }).catch(() => undefined)}
        >
          Cancel this question
        </button>
      ) : null}
      {ans && (
        <>
          {ans.cacheHit ? <p>Reusing fresh evidence — no one interrupted</p> : null}
          {ans.summary && ans.summary !== ans.headline ? <p className="body">{ans.summary}</p> : null}
          <p>
            <span className={`level ${ans.confidence?.level}`}>{ans.confidence?.level ?? "Low"}</span>
            {typeof ans.sourceCount === "number" ? ` · ${ans.sourceCount} report${ans.sourceCount === 1 ? "" : "s"}` : ""}
            {ans.updatedAtMs ? ` · ${formatAge((Date.now() - ans.updatedAtMs) / 1000)}` : ""}
          </p>
          {ans.supporting?.length ? (
            <ul className="sources">
              {ans.supporting.map((line) => <li key={line}>{line}</li>)}
            </ul>
          ) : null}
          {ans.caveats?.length ? (
            <ul className="caveats">
              {ans.caveats.map((line) => <li key={line}>{line}</li>)}
            </ul>
          ) : null}
          {diag && <pre className="diag">{JSON.stringify({ planner: ans.planner, confidence: ans.confidence, factors: ans.factors }, null, 2)}</pre>}
        </>
      )}
      <div className="footer-actions">
        {ans ? (
          <button className="text" type="button" onClick={() => setDiag(!diag)}>{diag ? "Hide details" : "Details"}</button>
        ) : null}
        <button className="text" type="button" onClick={() => { sessionStorage.removeItem(LAST_QUERY); go("/"); }}>
          Ask something else
        </button>
      </div>
      <p className="hint">This question stays in Questions.</p>
    </section>
  );
}

type PromptRow = {
  batchId: bigint;
  placeName: string;
  question: string;
  controlsJson: string;
  responded: boolean;
};

function PromptPing({ conn }: { conn: NonNullable<ReturnType<typeof useDb>["conn"]> }) {
  const pending = list(conn.db.myPrompts.iter()).filter(isAnswerable);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [thanks, setThanks] = useState(false);
  const prompt = pending.find((p) => !hidden.has(String(p.batchId)));
  const id = prompt ? String(prompt.batchId) : "";

  useEffect(() => {
    if (!prompt || !id) return;
    if (sessionStorage.getItem("pp.pinged") === id) return;
    sessionStorage.setItem("pp.pinged", id);
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const note = new Notification(`Quick question about ${prompt.placeName}`, {
      body: prompt.question,
      tag: `prompt-${id}`,
    });
    note.onclick = () => window.focus();
  }, [id, prompt]);

  // A new question replaces the confirmation. Keyed on id so a re-render of the same
  // prompt does not clear the thanks line in the same turn it was set.
  useEffect(() => {
    if (id) setThanks(false);
  }, [id]);
  useEffect(() => {
    if (!thanks) return;
    const timer = setTimeout(() => setThanks(false), 4000);
    return () => clearTimeout(timer);
  }, [thanks]);

  if (prompt) {
    return (
      <div className="ping">
        <AnswerForm
          conn={conn}
          prompt={prompt}
          onDone={() => setHidden((prev) => new Set(prev).add(id))}
          onSent={() => setThanks(true)}
        />
      </div>
    );
  }
  if (thanks) {
    return (
      <div className="ping">
        <p>Thanks — signal sent.</p>
      </div>
    );
  }
  return null;
}

function Respond({ conn, id }: { conn: NonNullable<ReturnType<typeof useDb>["conn"]>; id: string }) {
  const prompt = list(conn.db.myPrompts.iter()).find((p) => String(p.batchId) === id);
  if (!prompt) return <p>This prompt is gone or isn’t for you.</p>;
  // Say which it is, rather than leaving a form whose Send can only fail.
  if (prompt.responded) return <p>You already answered this one. Thanks.</p>;
  if (toMs(prompt.expiresAt) <= Date.now()) {
    return <p>This question about {prompt.placeName} expired. Someone else will have picked it up.</p>;
  }
  return (
    <section>
      <AnswerForm conn={conn} prompt={prompt} />
    </section>
  );
}

function AnswerForm({
  conn,
  prompt,
  onDone,
  onSent,
}: {
  conn: NonNullable<ReturnType<typeof useDb>["conn"]>;
  prompt: PromptRow;
  onDone?: () => void;
  /** Success path. Leaves the sheet mounted so "signal sent" can actually render. */
  onSent?: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [done, setDone] = useState(false);
  const [err, setErr] = useState("");
  const controls = JSON.parse(prompt.controlsJson) as { dimension_key: string; label: string; options: { value: string; label: string }[] }[];
  // Routing already picked people who are near the place. The presence control only exists
  // where GPS can't tell this place from a neighbour, so it is a way out, not a question.
  const presence = controls.find((c) => c.dimension_key === "other:place_part");
  const pass = presence?.options.find((o) => o.value === "not_here");
  const visible = controls.filter((c) => c.dimension_key !== "other:place_part");
  const answered = visible.filter((c) => answers[c.dimension_key]).length;
  const submit = async (payload: Record<string, string>) => {
    try {
      await conn.reducers.submitResponse({ batchId: prompt.batchId, answersJson: JSON.stringify(payload), note });
      setDone(true);
      // onSent keeps the confirmation up. onDone hides the sheet immediately, which
      // unmounts this message in the same paint, so success uses onSent when given.
      if (onSent) onSent();
      else onDone?.();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  if (done) return <p>Thanks — signal sent.</p>;
  return (
    <>
      <p>{prompt.placeName}</p>
      <h2>{prompt.question}</h2>
      {visible.map((c) => (
        <fieldset className="choice-set" key={c.dimension_key}>
          {c.label && c.dimension_key !== "other:answer" ? <legend>{c.label}</legend> : null}
          {c.options.map((o) => (
            <label className="radio" key={o.value}>
              <input type="radio" name={c.dimension_key} checked={answers[c.dimension_key] === o.value} onChange={() => setAnswers({ ...answers, [c.dimension_key]: o.value })} />
              {o.label}
            </label>
          ))}
        </fieldset>
      ))}
      <label className="label">
        Note
        <textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {err && <p className="err">{err}</p>}
      <div className="actions">
        <button
          className="btn"
          disabled={prompt.responded || answered < visible.length}
          onClick={() => submit(Object.fromEntries(visible.map((c) => [c.dimension_key, answers[c.dimension_key]])))}
        >
          Send
        </button>
        {pass ? (
          <button className="btn ghost" disabled={prompt.responded} onClick={() => submit({ "other:place_part": "not_here" })}>
            {pass.label}
          </button>
        ) : null}
        {onDone ? <button className="btn ghost" onClick={onDone}>Not now</button> : null}
      </div>
    </>
  );
}

/** What the requester sees instead of a raw status string. */
const STATUS_LABEL: Record<string, string> = {
  planning: "Working on it",
  clarifying: "Needs your answer",
  collecting: "Asking people nearby",
  synthesizing: "Writing the answer",
  answered: "Answered",
  insufficient: "Not enough evidence",
  refused: "Can't answer that",
  failed: "Something went wrong",
  cancelled: "Cancelled",
};

function Activity({ conn }: { conn: NonNullable<ReturnType<typeof useDb>["conn"]> }) {
  const queries = list(conn.db.myQueries.iter()).sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt));
  const prompts = list(conn.db.myPrompts.iter()).filter(isAnswerable);
  const watches = list(conn.db.myWatches.iter()).filter((w) => w.status !== "cancelled").sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt));
  return (
    <section>
      {watches.length ? (
        <>
          <h1>Watching</h1>
          {watches.map((w) => {
            const target = (() => {
              try {
                return JSON.parse(w.targetJson || "null") as { phrase?: string } | null;
              } catch {
                return null;
              }
            })();
            const headline = w.status === "expired"
              ? "Watch ended"
              : w.lastValue
                ? `${target?.phrase ?? "Update"} at ${placeLabel(conn, w.placeId)}`
                : `Watching ${placeLabel(conn, w.placeId)}`;
            return (
              <div className="card" key={String(w.id)}>
                <div className="meta">
                  <span>{w.status === "planning" ? "Setting up" : w.status === "expired" ? "Ended" : "Watching"}</span>
                </div>
                <p className="body">{headline}</p>
                <p>{w.text}</p>
                {w.lastValue ? <p className="body">{w.lastValue}</p> : <p>I'll tell you here when it changes.</p>}
                {w.status === "active" || w.status === "planning" ? (
                  <button className="text" type="button" onClick={() => void conn.reducers.cancelWatch({ watchId: w.id }).catch(() => undefined)}>Stop watching</button>
                ) : null}
              </div>
            );
          })}
        </>
      ) : null}
      {prompts.length ? (
        <>
          <h1>Asked of you</h1>
          {prompts.map((p) => (
            <div className="card" key={String(p.batchId)} onClick={() => go(`/respond/${p.batchId}`)}>
              <p className="body">{p.question}</p>
              <p>{p.placeName}</p>
            </div>
          ))}
        </>
      ) : null}
      <h1>Recent questions</h1>
      {queries.length === 0 ? <p>Nothing yet. Ask about a place and it will show up here.</p> : null}
      {queries.map((q) => {
        const open = OPEN_QUERY.has(q.status);
        const answer = q.answerJson
          ? (JSON.parse(q.answerJson) as { headline?: string; confidence?: { level?: string }; sourceCount?: number })
          : null;
        return (
          <div className="card" key={String(q.id)} onClick={() => go(`/q/${q.id}`)}>
            <div className="meta">
              <span>{STATUS_LABEL[q.status] ?? q.status}</span>
              <span>{formatAge((Date.now() - toMs(q.createdAt)) / 1000)}</span>
            </div>
            <p className="body">{q.text}</p>
            <p>{placeLabel(conn, q.placeId)}</p>
            {answer?.headline ? <p className="body">{answer.headline}</p> : null}
            {answer?.confidence?.level ? (
              <p>
                <span className={`level ${answer.confidence.level}`}>{answer.confidence.level}</span>
                {typeof answer.sourceCount === "number"
                  ? ` · ${answer.sourceCount} report${answer.sourceCount === 1 ? "" : "s"}`
                  : ""}
              </p>
            ) : null}
            {open ? <p>In progress</p> : null}
          </div>
        );
      })}
    </section>
  );
}

function PlacePage({ conn, id }: { conn: Conn; id: string }) {
  const place = list(conn.db.place.iter()).find((p) => p.id === id);
  const posts = list(conn.db.pulsePosts.iter()).filter((p) => p.placeId === id).sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt));
  if (!place) return <p>Unknown place.</p>;
  const catalog = catalogPlaceFor(conn, id);
  return (
    <section>
      <div className="status">
        <h1>{place.name}</h1>
        {place.address ? <p>{place.address}</p> : null}
      </div>
      {catalog ? <ComposerPost conn={conn} lockedPlace={catalog} /> : null}
      {posts.map((p) => (
        <PostCard
          key={String(p.id)}
          conn={conn}
          post={{ ...p, postId: p.id, createdAtMs: toMs(p.createdAt) }}
          placeName={place.name}
        />
      ))}
      {!posts.length ? (
        <div className="empty">
          <h2>No posts yet</h2>
          <p>Share what this place is like right now.</p>
        </div>
      ) : null}
    </section>
  );
}

function ImpactLine({ conn }: { conn: Conn }) {
  const events = list(conn.db.myImpact.iter());
  const helped = new Set(events.filter((e) => e.kind === "helped").map((e) => String(e.queryId))).size;
  const avoided = new Set(events.filter((e) => e.kind === "avoided_prompt").map((e) => String(e.queryId))).size;
  if (!helped && !avoided) return null;
  const helpedText = helped ? `Your updates helped ${helped} ${helped === 1 ? "question" : "questions"}.` : "";
  const avoidedText = avoided
    ? `${avoided} ${avoided === 1 ? "question was" : "questions were"} answered from what you shared, so nobody new was asked.`
    : "";
  return <p className="body">{`${helpedText} ${avoidedText}`.trim()}</p>;
}

function Profile({ conn }: { conn: NonNullable<ReturnType<typeof useDb>["conn"]> }) {
  const auth = useOidc();
  const { dev, setDev } = useDevMode();
  const profile = list(conn.db.myProfile.iter())[0];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [shown, setShown] = useState(profile?.username ?? "");
  const [nameErr, setNameErr] = useState("");
  const [toast, setToast] = useState("");
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (profile?.username) setShown(profile.username);
  }, [profile?.username]);
  const loc = list(conn.db.myLocation.iter())[0];
  const [paused, setPaused] = useState(profile?.notificationsPaused ?? false);
  const [demo, setDemo] = useState<string>(localStorage.getItem("pp.demoPlace") ?? "");
  const [gpsError, setGpsError] = useState("");
  const [gpsFix, setGpsFix] = useState<{ lat: number; lng: number } | null>(null);
  const [claim, setClaim] = useState<{ id: string; lat: number; lng: number } | null>(loadPlaceClaim);
  const [pushMsg, setPushMsg] = useState("");
  const [diag, setDiag] = useState(localStorage.getItem("pp.diag") === "1");

  useEffect(() => {
    if (!conn) return;
    if (demo) {
      const p = CATALOG_PLACES.find((x) => x.id === demo);
      if (!p) return;
      localStorage.setItem("pp.demoPlace", demo);
      setGpsFix(null);
      setGpsError("");
      // Picking a demo building is itself a claim: they named the building.
      void conn.reducers.updateLocation({ lat: p.lat, lng: p.lng, accuracyM: 15, source: "demo", claimedPlaceId: p.id });
      return;
    }
    localStorage.removeItem("pp.demoPlace");
    if (!navigator.geolocation) {
      setGpsError("This browser has no GPS");
      return;
    }
    setGpsError("");
    const watch = navigator.geolocation.watchPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const accuracy = Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : 50;
        setGpsFix({ lat, lng });
        // A claim only holds near where it was made; past that we are somewhere else.
        const stillHere = claim && haversineM(claim.lat, claim.lng, lat, lng) <= CLAIM_VALID_M;
        void conn.reducers
          .updateLocation({
            lat,
            lng,
            accuracyM: accuracy,
            source: "gps",
            claimedPlaceId: stillHere ? claim.id : "",
          })
          .catch((err: unknown) => {
            setGpsError(err instanceof Error ? err.message : "Could not save GPS");
          });
      },
      (err) => setGpsError(err.message || "Location permission was denied"),
      { enableHighAccuracy: true, maximumAge: 0 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, [conn, demo, claim]);

  return (
    <section>
      {emailOf(auth) ? <p>{emailOf(auth)}</p> : null}
      {editing ? (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            if (saving) return;
            const next = draft.trim().toLowerCase();
            if (!next || next === shown) {
              setDraft("");
              setEditing(false);
              return;
            }
            setSaving(true);
            setNameErr("");
            try {
              await conn.reducers.setProfile({
                username: next,
                defaultAttribution: profile?.defaultAttribution ?? "anonymous",
                avatarSeed: profile?.avatarSeed || next,
              });
              setShown(next);
              setDraft("");
              setEditing(false);
              setToast("Name saved");
            } catch (err) {
              setNameErr((err as Error).message);
            } finally {
              setSaving(false);
            }
          }}
        >
          <label className="label">
            Name
            <input className="input" value={draft} autoFocus placeholder="lowercase_name" onChange={(e) => setDraft(e.target.value)} />
          </label>
          {nameErr ? <p className="err">{nameErr}</p> : null}
          <button className="btn" type="submit" disabled={saving || draft.trim().length < 3}>{saving ? "Saving…" : "Save name"}</button>
        </form>
      ) : (
        <button className="name" onClick={() => { setDraft(""); setNameErr(""); setEditing(true); }}>{shown}</button>
      )}
      <ImpactLine conn={conn} />
      {(() => {
        const picked = demo ? CATALOG_PLACES.find((p) => p.id === demo) : null;
        const gpsPoint = gpsFix ?? (loc && loc.source === "gps" ? { lat: loc.lat, lng: loc.lng } : null);
        const mapPoint = picked ? { lat: picked.lat, lng: picked.lng } : gpsPoint;
        const reading = gpsPoint && !demo ? describeLocation(gpsPoint.lat, gpsPoint.lng) : null;
        const claimNear = claim && gpsPoint && haversineM(claim.lat, claim.lng, gpsPoint.lat, gpsPoint.lng) <= CLAIM_VALID_M ? claim : null;
        const claimed = claimNear?.id ? CATALOG_PLACES.find((p) => p.id === claimNear.id) : undefined;
        const label = claimed ? claimed.name : reading?.label;
        // Buildings 70-80 m apart are inside GPS error, so offer the choice whenever the
        // nearest one has a close neighbour — not only when the two happen to be near-tied.
        const nearbyOptions = reading?.places[0]
          ? [reading.places[0], ...neighboringPlaces(reading.places[0])].slice(0, 3)
          : [];
        const showChoices = !claimed && nearbyOptions.length > 1;
        return (
          <>
            <div className="status">
              <p
                className={gpsError && !demo && !label ? "status-readout bad" : "status-readout"}
                data-testid={loc?.source === "demo" ? "demo-location" : undefined}
              >{demo ? "Simulated location" : label ?? (gpsError || "Finding your location…")}</p>
            </div>
            {showChoices ? (
              <div className="confirm">
                {nearbyOptions.map((place) => (
                  <button
                    key={place.id}
                    className="btn ghost"
                    type="button"
                    onClick={() => savePlaceClaim({ id: place.id, lat: gpsPoint!.lat, lng: gpsPoint!.lng }, setClaim)}
                  >
                    I'm in {place.name}
                  </button>
                ))}
              </div>
            ) : null}
            {claimed ? (
              <>
                <p className="hint">Prompts for other buildings will skip you.</p>
                <button className="text" type="button" onClick={() => savePlaceClaim(null, setClaim)}>Not this building</button>
              </>
            ) : null}
            {mapPoint ? <MiniMap lat={mapPoint.lat} lng={mapPoint.lng} /> : null}
          </>
        );
      })()}
      <label className="label">
        Location
      <select className="input" value={demo} onChange={(e) => {
        const next = e.target.value;
        if (next) localStorage.setItem("pp.demoPlace", next);
        else {
          localStorage.removeItem("pp.demoPlace");
          setGpsFix(null);
        }
        setGpsError("");
        setDemo(next);
        if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
      }}>
        <option value="">Use real GPS</option>
        {DEMO_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      </label>
      {pushMsg && <p>{pushMsg}</p>}
      <div className="group">
        <button type="button" onClick={async () => {
          await conn.reducers.setNotificationsPaused({ paused: !paused });
          setPaused(!paused);
        }}>{paused ? "Resume prompts" : "Pause prompts"}</button>
        <button type="button" onClick={() => enablePush(conn).then(setPushMsg).catch((e) => setPushMsg((e as Error).message))}>Enable notifications</button>
        <label className="setting">
          <span>Developer diagnostics</span>
          <input type="checkbox" checked={diag} onChange={(e) => { setDiag(e.target.checked); localStorage.setItem("pp.diag", e.target.checked ? "1" : "0"); }} />
        </label>
        {import.meta.env.DEV ? <DevWipeButton onDone={setToast} /> : null}
        <button
          type="button"
          onClick={() => {
            clearLegacyToken();
            setDev(false);
            if (auth) void auth.signoutRedirect().catch(() => auth.removeUser());
          }}
        >
          Sign out
        </button>
      </div>
      {toast ? <p className="toast" role="status">{toast}</p> : null}
    </section>
  );
}

/**
 * Dev builds only; works from localhost. Clears questions, prompts, answers, posts and reports for everyone;
 * accounts, locations, push devices and places stay. Needs two taps.
 */
function DevWipeButton({ onDone }: { onDone: (msg: string) => void }) {
  // The orchestrator refuses the wipe from anywhere but this machine (not ngrok, not the LAN).
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      className={armed ? "danger" : undefined}
      disabled={busy || !local}
      onClick={async () => {
        if (!armed) return setArmed(true);
        setArmed(false);
        setBusy(true);
        try {
          // Relative: the Vite dev server proxies /dev to the orchestrator. The orchestrator only
          // accepts it from this machine (no ngrok), with this header.
          const res = await fetch("/dev/wipe", { method: "POST", headers: { "X-ProxiPrompt-Dev": "1" } });
          onDone(res.ok ? "All activity wiped" : `Wipe failed (${res.status}). Is ENABLE_DEV_WIPE=1 set?`);
        } catch (e) {
          onDone(`Wipe failed: ${(e as Error).message}`);
        } finally {
          setBusy(false);
        }
      }}
    >
      {!local
        ? "Wipe activity (dev): open localhost:5173 on the laptop"
        : busy ? "Wiping…" : armed ? "Tap again to wipe all activity" : "Wipe activity (dev)"}
    </button>
  );
}

async function enablePush(conn: NonNullable<ReturnType<typeof useDb>["conn"]>): Promise<string> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "This browser cannot receive Web Push.";
  const reg = await navigator.serviceWorker.register("/sw.js");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return "Notifications were not granted.";
  const key = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
  if (!key) return "VITE_VAPID_PUBLIC_KEY is not set. Generate keys and restart the web app.";
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  });
  const json = sub.toJSON();
  await conn.reducers.registerDevice({
    endpoint: json.endpoint!,
    p256Dh: json.keys!.p256dh!,
    auth: json.keys!.auth!,
    userAgent: navigator.userAgent.slice(0, 300),
  });
  return "Notifications enabled.";
}

function MiniMap({ lat, lng }: { lat: number; lng: number }) {
  const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  const pad = 0.008;
  const src = key
    ? `https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(key)}&q=${lat},${lng}&zoom=16`
    : `https://www.openstreetmap.org/export/embed.html?bbox=${lng - pad},${lat - pad},${lng + pad},${lat + pad}&layer=mapnik&marker=${lat},${lng}`;
  return <iframe className="minimap" title="Current location" src={src} loading="lazy" referrerPolicy="no-referrer-when-downgrade" />;
}

/** A claimed building only applies while you are still near where you claimed it. */
const CLAIM_VALID_M = 80;

const PLACE_CLAIM_KEY = "pp.placeClaim";

function loadPlaceClaim(): { id: string; lat: number; lng: number } | null {
  try {
    const raw = localStorage.getItem(PLACE_CLAIM_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { id?: unknown; lat?: unknown; lng?: unknown };
    if (typeof parsed.id !== "string" || typeof parsed.lat !== "number" || typeof parsed.lng !== "number") return null;
    return { id: parsed.id, lat: parsed.lat, lng: parsed.lng };
  } catch {
    return null;
  }
}

function savePlaceClaim(
  next: { id: string; lat: number; lng: number } | null,
  setClaim: (value: { id: string; lat: number; lng: number } | null) => void,
) {
  setClaim(next);
  if (!next) localStorage.removeItem(PLACE_CLAIM_KEY);
  else localStorage.setItem(PLACE_CLAIM_KEY, JSON.stringify(next));
}

function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
