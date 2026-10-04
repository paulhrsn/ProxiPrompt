import { useEffect, useMemo, useState } from "react";
import { CATALOG_PLACES, DEFAULT_COMMUNITY, describeLocation, formatAge, freshnessNote, haversineM, rankPosts, type CatalogPlace } from "@proxiprompt/core";
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
  const pushed = route.name === "query" || route.name === "respond" || route.name === "activity" || route.name === "place";
  const tab = route.name === "posts" || route.name === "place" ? "posts" : route.name === "profile" || route.name === "activity" ? "you" : "ask";

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
          <button type="button" className={tab === "ask" ? "tab on" : "tab"} onClick={() => go("/")}><Icon name="ask" />Ask</button>
          <button type="button" className={tab === "posts" ? "tab on" : "tab"} onClick={() => go("/posts")}><Icon name="posts" />Posts</button>
          <button type="button" className={tab === "you" ? "tab on" : "tab"} onClick={() => go("/profile")}><Icon name="you" />You</button>
        </nav>
      ) : null}
      <button className={`dev-toggle${dev ? " on" : ""}`} onClick={() => setDev(!dev)}>{dev ? "Dev on" : "Dev"}</button>
    </div>
  );
}

function Icon({ name }: { name: "ask" | "posts" | "you" | "back" }) {
  const props = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (name === "ask") return <svg {...props}><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" /></svg>;
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

function Home({ conn }: { conn: NonNullable<ReturnType<typeof useDb>["conn"]> }) {
  const [q, setQ] = useState("");
  const [place, setPlace] = useState<CatalogPlace | null>(CATALOG_PLACES[0]);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const suggestions = useMemo(() => {
    const t = filter.toLowerCase();
    if (!t) return CATALOG_PLACES.slice(0, 6);
    return CATALOG_PLACES.filter((p) => `${p.name} ${p.aliases.join(" ")}`.toLowerCase().includes(t)).slice(0, 8);
  }, [filter]);

  async function ask() {
    if (!place || q.trim().length < 3) return;
    setBusy(true);
    setErr("");
    try {
      await conn.reducers.upsertPlace({
        id: place.id,
        name: place.name,
        category: place.category,
        lat: place.lat,
        lng: place.lng,
        address: place.address,
        community: place.community,
      });
      const clientRequestId = crypto.randomUUID();
      await conn.reducers.submitQuery({ clientRequestId, placeId: place.id, text: q.trim() });
      const found = list(conn.db.myQueries.iter()).find((row) => row.clientRequestId === clientRequestId);
      go(found ? `/q/${found.id}` : "/activity");
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
      <label className="label">
        Place
        <input className="input" placeholder={place ? "Change place" : "Search places"} value={filter} onChange={(e) => { setFilter(e.target.value); setPlace(null); }} />
        {filter ? (
          <ul className="suggest" role="listbox">
            {suggestions.map((p) => (
              <li key={p.id} role="option" onClick={() => { setPlace(p); setFilter(""); }}>
                {p.name}<small>{p.address}</small>
              </li>
            ))}
          </ul>
        ) : null}
      </label>
      <label className="label">
        Question
        <textarea className="input" rows={3} placeholder="What’s it like there right now?" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      {err && <p className="err">{err}</p>}
      <button className="btn" type="submit" disabled={busy || !place || q.trim().length < 3}>{busy ? "Asking…" : "Ask"}</button>
    </form>
  );
}

function Posts({ conn }: { conn: NonNullable<ReturnType<typeof useDb>["conn"]> }) {
  const [sort, setSort] = useState<"useful" | "recent">("useful");
  const now = Date.now();
  const posts = useMemo(() => {
    const raw = list(conn.db.pulsePosts.iter()).filter((p) => p.community === DEFAULT_COMMUNITY);
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
      return { ...p, maxFreshness: note.maxFreshness, verifiedNearby: false, recentSubstantiveComments: Number(p.commentCount), createdAtMs: toMs(p.createdAt), id: String(p.id) };
    });
    return rankPosts(mapped, sort, now);
  }, [conn, sort, now]);

  return (
    <section>
      <div className="screen-head">
        <h1>Posts</h1>
        <div className="segment" role="tablist" aria-label="Sort posts">
          <button type="button" role="tab" aria-selected={sort === "useful"} className={sort === "useful" ? "on" : ""} onClick={() => setSort("useful")}>Useful</button>
          <button type="button" role="tab" aria-selected={sort === "recent"} className={sort === "recent" ? "on" : ""} onClick={() => setSort("recent")}>Recent</button>
        </div>
      </div>
      <ComposerPost conn={conn} />
      {posts.map((p) => (
        <article className="card" key={p.id} onClick={() => go(`/place/${p.placeId}`)}>
          <div className="meta">
            <span>{list(conn.db.place.iter()).find((x) => x.id === p.placeId)?.name ?? p.placeId}</span>
            <span>{formatAge((now - p.createdAtMs) / 1000)}</span>
          </div>
          <p className="body">{p.text}</p>
          {p.summary ? <p>{p.summary}</p> : null}
          {p.freshnessNote ? <p className={`note ${p.freshnessState}`}>{p.freshnessNote}</p> : null}
        </article>
      ))}
      {!posts.length ? (
        <div className="empty">
          <h2>No posts yet</h2>
          <p>Share what a place is like right now.</p>
        </div>
      ) : null}
    </section>
  );
}

function ComposerPost({ conn }: { conn: NonNullable<ReturnType<typeof useDb>["conn"]> }) {
  const [text, setText] = useState("");
  const [place, setPlace] = useState(CATALOG_PLACES[0]);
  const [attr, setAttr] = useState<"anonymous" | "profile">("anonymous");
  const [open, setOpen] = useState(false);
  if (!open) return <button className="btn ghost" onClick={() => setOpen(true)}>Post an update</button>;
  return (
    <div className="composer">
      <label className="label">Place
      <select className="input" value={place.id} onChange={(e) => setPlace(CATALOG_PLACES.find((p) => p.id === e.target.value) ?? place)}>
        {CATALOG_PLACES.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      </label>
      <label className="label">Update
      <textarea className="input" maxLength={280} rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Third floor is quiet." />
      </label>
      <div className="row">
        <button className="btn ghost small" onClick={() => setAttr(attr === "anonymous" ? "profile" : "anonymous")}>{attr === "anonymous" ? "Anonymous" : "Show profile"}</button>
        <button
          className="btn small"
          onClick={async () => {
            await conn.reducers.upsertPlace({ id: place.id, name: place.name, category: place.category, lat: place.lat, lng: place.lng, address: place.address, community: place.community });
            await conn.reducers.createPost({ placeId: place.id, text: text.trim(), attribution: attr });
            setText("");
            setOpen(false);
          }}
        >
          Post
        </button>
      </div>
    </div>
  );
}

function QueryDetail({ conn, id }: { conn: NonNullable<ReturnType<typeof useDb>["conn"]>; id: string }) {
  const q = list(conn.db.myQueries.iter()).find((row) => String(row.id) === id);
  const events = list(conn.db.myQueryEvents.iter()).filter((e) => String(e.queryId) === id).sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt));
  const [choice, setChoice] = useState("");
  const [diag, setDiag] = useState(false);
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
          <div className="choices">
            {clar.options.map((o) => <button key={o} className={choice === o ? "on" : ""} onClick={() => setChoice(o)}>{o}</button>)}
          </div>
          <button className="btn" disabled={!choice} onClick={() => conn.reducers.answerClarification({ queryId: q.id, choice })}>Continue</button>
        </div>
      )}
      {ans && (
        <>
          {ans.summary && ans.summary !== ans.headline ? <p className="body">{ans.summary}</p> : null}
          <p>
            <span className={`level ${ans.confidence?.level}`}>{ans.confidence?.level ?? "Low"}</span>
            {typeof ans.sourceCount === "number" ? ` · ${ans.sourceCount} reports` : ""}
            {ans.updatedAtMs ? ` · ${formatAge((Date.now() - ans.updatedAtMs) / 1000)}` : ""}
          </p>
          <button className="text" onClick={() => setDiag(!diag)}>{diag ? "Hide details" : "Details"}</button>
          {diag && <pre className="diag">{JSON.stringify({ planner: ans.planner, confidence: ans.confidence, factors: ans.factors, supporting: ans.supporting, caveats: ans.caveats }, null, 2)}</pre>}
        </>
      )}
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
  const pending = list(conn.db.myPrompts.iter()).filter((p) => !p.responded);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
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

  if (!prompt) return null;
  return (
    <div className="ping">
      <AnswerForm conn={conn} prompt={prompt} onDone={() => setHidden((prev) => new Set(prev).add(id))} />
    </div>
  );
}

function Respond({ conn, id }: { conn: NonNullable<ReturnType<typeof useDb>["conn"]>; id: string }) {
  const prompt = list(conn.db.myPrompts.iter()).find((p) => String(p.batchId) === id);
  if (!prompt) return <p>This prompt is gone or isn’t for you.</p>;
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
}: {
  conn: NonNullable<ReturnType<typeof useDb>["conn"]>;
  prompt: PromptRow;
  onDone?: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [done, setDone] = useState(false);
  const [err, setErr] = useState("");
  const controls = JSON.parse(prompt.controlsJson) as { dimension_key: string; label: string; options: { value: string; label: string }[] }[];
  if (done) return <p>Thanks — signal sent.</p>;
  return (
    <>
      <p>{prompt.placeName}</p>
      <h2>{prompt.question}</h2>
      {controls.map((c) => (
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
          disabled={prompt.responded || Object.keys(answers).length < controls.length}
          onClick={async () => {
            try {
              await conn.reducers.submitResponse({ batchId: prompt.batchId, answersJson: JSON.stringify(answers), note });
              setDone(true);
              onDone?.();
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          Send
        </button>
        {onDone ? <button className="btn ghost" onClick={onDone}>Not now</button> : null}
      </div>
    </>
  );
}

function Activity({ conn }: { conn: NonNullable<ReturnType<typeof useDb>["conn"]> }) {
  const queries = list(conn.db.myQueries.iter()).sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt));
  const prompts = list(conn.db.myPrompts.iter()).filter((p) => !p.responded);
  return (
    <section>
      <h1>Your questions</h1>
      {prompts.map((p) => (
        <div className="card" key={String(p.batchId)} onClick={() => go(`/respond/${p.batchId}`)}>
          <p className="body">{p.question}</p>
          <p>{p.placeName}</p>
        </div>
      ))}
      {queries.map((q) => (
        <div className="card" key={String(q.id)} onClick={() => go(`/q/${q.id}`)}>
          <div className="meta"><span>{q.status}</span><span>{formatAge((Date.now() - toMs(q.createdAt)) / 1000)}</span></div>
          <p className="body">{q.text}</p>
        </div>
      ))}
    </section>
  );
}

function PlacePage({ conn, id }: { conn: NonNullable<ReturnType<typeof useDb>["conn"]>; id: string }) {
  const place = list(conn.db.place.iter()).find((p) => p.id === id);
  const posts = list(conn.db.pulsePosts.iter()).filter((p) => p.placeId === id);
  const [comment, setComment] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  if (!place) return <p>Unknown place.</p>;
  return (
    <section>
      <h1>{place.name}</h1>
      <p>{place.address}</p>
      {posts.map((p) => (
        <article className="card" key={String(p.id)}>
          <p className="body">{p.text}</p>
          {p.summary && <p>{p.summary}</p>}
          {p.freshnessNote ? <p className={`note ${p.freshnessState}`}>{p.freshnessNote}</p> : null}
          <button className="text" onClick={() => setOpen(open === String(p.id) ? null : String(p.id))}>Comments</button>
          {open === String(p.id) && (
            <>
              {list(conn.db.pulseComments.iter()).filter((c) => c.postId === p.id).map((c) => (
                <p key={String(c.id)}><strong>{c.authorLabel}:</strong> {c.text}</p>
              ))}
              <label className="label">Comment
              <input className="input" value={comment} onChange={(e) => setComment(e.target.value)} />
              </label>
              <button className="btn small" onClick={async () => {
                await conn.reducers.createComment({ postId: p.id, text: comment.trim(), attribution: "anonymous" });
                setComment("");
              }}>Comment</button>
            </>
          )}
        </article>
      ))}
    </section>
  );
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
      void conn.reducers.updateLocation({ lat: p.lat, lng: p.lng, accuracyM: 15, source: "demo" });
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
        void conn.reducers.updateLocation({ lat, lng, accuracyM: accuracy, source: "gps" }).catch((err: unknown) => {
          setGpsError(err instanceof Error ? err.message : "Could not save GPS");
        });
      },
      (err) => setGpsError(err.message || "Location permission was denied"),
      { enableHighAccuracy: true, maximumAge: 0 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, [conn, demo]);

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
      {(() => {
        const picked = demo ? CATALOG_PLACES.find((p) => p.id === demo) : null;
        const gpsPoint = gpsFix ?? (loc && loc.source === "gps" ? { lat: loc.lat, lng: loc.lng } : null);
        const mapPoint = picked ? { lat: picked.lat, lng: picked.lng } : gpsPoint;
        const reading = gpsPoint && !demo ? describeLocation(gpsPoint.lat, gpsPoint.lng) : null;
        const claimNear = claim && gpsPoint && haversineM(claim.lat, claim.lng, gpsPoint.lat, gpsPoint.lng) <= 80 ? claim : null;
        const claimed = claimNear?.id ? CATALOG_PLACES.find((p) => p.id === claimNear.id) : undefined;
        const label = claimed ? `${claimed.name} (${reading?.coords})` : reading?.label;
        const showChoices = !!reading?.ambiguous && !claimed;
        return (
          <>
            <div className="status">
              <p className={gpsError && !demo && !label ? "status-readout bad" : "status-readout"}>{demo ? "Simulated location" : label ?? (gpsError || "Finding your location…")}</p>
            </div>
            {showChoices ? (
              <div className="confirm">
                {reading.places.map((place) => (
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
              <button className="text" type="button" onClick={() => savePlaceClaim(null, setClaim)}>Not this building</button>
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
        <button type="button" onClick={() => go("/activity")}>Questions</button>
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
