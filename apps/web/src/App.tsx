import { useEffect, useMemo, useState } from "react";
import { CATALOG_PLACES, DEFAULT_COMMUNITY, formatAge, freshnessNote, rankPosts, type CatalogPlace } from "@proxiprompt/core";
import { list, useDb } from "./spacetime";

type Route =
  | { name: "home" }
  | { name: "query"; id: string }
  | { name: "respond"; id: string }
  | { name: "activity" }
  | { name: "profile" }
  | { name: "place"; id: string };

function parseHash(): Route {
  const h = location.hash.replace(/^#/, "") || "/";
  const parts = h.split("/").filter(Boolean);
  if (parts[0] === "q" && parts[1]) return { name: "query", id: parts[1] };
  if (parts[0] === "respond" && parts[1]) return { name: "respond", id: parts[1] };
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
  const { conn, connected, error, tick } = useDb();
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  const profile = conn ? list(conn.db.myProfile.iter())[0] : undefined;
  void tick;

  return (
    <div className="app">
      <header className="top">
        <div className="brand" onClick={() => go("/")} role="button">ProxiPrompt</div>
        <div className="chip">{connected ? (profile ? `@${profile.username}` : "needs profile") : "connecting…"}</div>
      </header>
      {error && <p className="err">{error}</p>}
      {!profile && conn ? <Onboard conn={conn} /> : null}
      {profile && conn ? (
        route.name === "home" ? <Home conn={conn} /> :
        route.name === "query" ? <QueryDetail conn={conn} id={route.id} /> :
        route.name === "respond" ? <Respond conn={conn} id={route.id} /> :
        route.name === "activity" ? <Activity conn={conn} /> :
        route.name === "profile" ? <Profile conn={conn} /> :
        <PlacePage conn={conn} id={route.id} />
      ) : null}
      {profile && conn && route.name !== "respond" ? <PromptPing conn={conn} /> : null}
      {profile && (
        <nav className="nav">
          <button className={route.name === "home" ? "on" : ""} onClick={() => go("/")}>Ask</button>
          <button className={route.name === "activity" ? "on" : ""} onClick={() => go("/activity")}>Activity</button>
          <button className={route.name === "profile" ? "on" : ""} onClick={() => go("/profile")}>You</button>
        </nav>
      )}
    </div>
  );
}

function Onboard({ conn }: { conn: NonNullable<ReturnType<typeof useDb>["conn"]> }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  return (
    <section>
      <h1>Pick a handle.</h1>
      <p>Every account can ask, answer, and post. Public posts default to anonymous.</p>
      <input className="field" placeholder="lowercase_letters" value={name} onChange={(e) => setName(e.target.value)} />
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
  const [community] = useState(DEFAULT_COMMUNITY);
  const [sort, setSort] = useState<"useful" | "recent">("useful");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const now = Date.now();

  const suggestions = useMemo(() => {
    const t = filter.toLowerCase();
    if (!t) return CATALOG_PLACES.slice(0, 6);
    return CATALOG_PLACES.filter((p) => `${p.name} ${p.aliases.join(" ")}`.toLowerCase().includes(t)).slice(0, 8);
  }, [filter]);

  const posts = useMemo(() => {
    const raw = list(conn.db.pulsePosts.iter()).filter((p) => p.community === community);
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
  }, [conn, community, sort, now]);

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
    <>
      <h1>What’s it like there right now?</h1>
      <div className="composer">
        <input className="place" placeholder="Search a place" value={filter || place?.name || ""} onChange={(e) => { setFilter(e.target.value); setPlace(null); }} />
        {filter && (
          <ul className="suggest">
            {suggestions.map((p) => (
              <li key={p.id} onClick={() => { setPlace(p); setFilter(""); }}>
                {p.name}<small>{p.category} · {p.address}</small>
              </li>
            ))}
          </ul>
        )}
        <textarea placeholder="Is Shapiro worth going to if I need somewhere quiet to study?" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="row">
          <span className="chip">{place ? place.name : "Pick a place"}</span>
          <button className="btn" disabled={busy || !place} onClick={ask}>{busy ? "Asking…" : "Ask"}</button>
        </div>
        {err && <p className="err">{err}</p>}
      </div>

      <div className="row" style={{ marginTop: 22 }}>
        <h2 className="grow">Live Pulse · UM / Ann Arbor</h2>
        <button className="btn ghost small" onClick={() => setSort(sort === "useful" ? "recent" : "useful")}>{sort === "useful" ? "Most useful" : "Recent"}</button>
      </div>
      <ComposerPost conn={conn} />
      {posts.map((p) => (
        <article className="card" key={p.id} onClick={() => go(`/place/${p.placeId}`)}>
          <div className="meta">
            <span>{list(conn.db.place.iter()).find((x) => x.id === p.placeId)?.name ?? p.placeId}</span>
            <span>{formatAge((now - p.createdAtMs) / 1000)}</span>
          </div>
          <p style={{ color: "var(--ink)", margin: "8px 0 0" }}>{p.text}</p>
          {p.summary && <p>{p.summary}</p>}
          <div className="meta">
            <span>{p.authorLabel}</span>
            <span>{p.commentCount} comments</span>
          </div>
          {p.freshnessNote && <span className={`note ${p.freshnessState}`}>{p.freshnessNote}</span>}
        </article>
      ))}
      {!posts.length && <p>No live updates yet. Ask a question or post what you see.</p>}
    </>
  );
}

function ComposerPost({ conn }: { conn: NonNullable<ReturnType<typeof useDb>["conn"]> }) {
  const [text, setText] = useState("");
  const [place, setPlace] = useState(CATALOG_PLACES[0]);
  const [attr, setAttr] = useState<"anonymous" | "profile">("anonymous");
  const [open, setOpen] = useState(false);
  if (!open) return <button className="btn ghost" onClick={() => setOpen(true)}>Post an update</button>;
  return (
    <div className="card">
      <select className="field" value={place.id} onChange={(e) => setPlace(CATALOG_PLACES.find((p) => p.id === e.target.value) ?? place)}>
        {CATALOG_PLACES.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <textarea className="field" maxLength={280} value={text} onChange={(e) => setText(e.target.value)} placeholder="Third floor is packed but the basement is quiet." />
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
          Signal sent
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
      <p className="chip">{place?.name}</p>
      <h1>{q.text}</h1>
      <p>Status: {q.status}{ans?.cacheHit ? " · reused evidence" : ""}</p>
      <ul className="timeline">
        {events.map((e) => <li key={String(e.id)} className={e === events.at(-1) ? "now" : ""}>{e.message}</li>)}
      </ul>
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
        <div className="card">
          <div className="answer">{ans.headline}</div>
          <p>{ans.summary}</p>
          <p>
            <span className={`level ${ans.confidence?.level}`}>{ans.confidence?.level ?? "Low"}</span>
            {" · "}
            {ans.sourceCount ?? 0} recent nearby reports
            {ans.updatedAtMs ? ` · ${formatAge((Date.now() - ans.updatedAtMs) / 1000)}` : ""}
          </p>
          {ans.supporting?.map((s) => <p key={s}>· {s}</p>)}
          {ans.caveats?.map((s) => <p key={s}>{s}</p>)}
          <button className="btn ghost small" onClick={() => setDiag(!diag)}>{diag ? "Hide diagnostics" : "Developer diagnostics"}</button>
          {diag && <pre className="diag">{JSON.stringify({ planner: ans.planner, confidence: ans.confidence, factors: ans.factors }, null, 2)}</pre>}
        </div>
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
  const [hidden, setHidden] = useState("");
  const prompt = pending.find((p) => String(p.batchId) !== hidden);
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
      <AnswerForm conn={conn} prompt={prompt} onDone={() => setHidden(id)} />
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
      <p className="chip">{prompt.placeName}</p>
      <h2>{prompt.question}</h2>
      <p>Someone wants a current update. They are not necessarily nearby.</p>
      {controls.map((c) => (
        <div key={c.dimension_key}>
          <h2>{c.label}</h2>
          <div className="choices">
            {c.options.map((o) => (
              <button key={o.value} className={answers[c.dimension_key] === o.value ? "on" : ""} onClick={() => setAnswers({ ...answers, [c.dimension_key]: o.value })}>{o.label}</button>
            ))}
          </div>
        </div>
      ))}
      <textarea className="field" placeholder="Optional note" value={note} onChange={(e) => setNote(e.target.value)} />
      {err && <p className="err">{err}</p>}
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
    </>
  );
}

function Activity({ conn }: { conn: NonNullable<ReturnType<typeof useDb>["conn"]> }) {
  const queries = list(conn.db.myQueries.iter()).sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt));
  const prompts = list(conn.db.myPrompts.iter()).filter((p) => !p.responded);
  const impact = list(conn.db.myImpact.iter());
  return (
    <section>
      <h1>Activity</h1>
      <p>{impact.length} contributions helped someone.</p>
      {prompts.length > 0 && <h2>Waiting for you</h2>}
      {prompts.map((p) => (
        <div className="card" key={String(p.batchId)} onClick={() => go(`/respond/${p.batchId}`)}>
          <strong>{p.placeName}</strong>
          <p>{p.question}</p>
        </div>
      ))}
      <h2>Your questions</h2>
      {queries.map((q) => (
        <div className="card" key={String(q.id)} onClick={() => go(`/q/${q.id}`)}>
          <div className="meta"><span>{q.status}</span><span>{formatAge((Date.now() - toMs(q.createdAt)) / 1000)}</span></div>
          <p style={{ color: "var(--ink)" }}>{q.text}</p>
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
          <p style={{ color: "var(--ink)" }}>{p.text}</p>
          {p.summary && <p>{p.summary}</p>}
          <span className={`note ${p.freshnessState}`}>{p.freshnessNote || p.authorLabel}</span>
          <div className="row">
            <button className="btn ghost small" onClick={() => conn.reducers.createComment({ postId: p.id, text: "Can confirm — still true from here.", attribution: "anonymous" })}>Can confirm</button>
            <button className="btn ghost small" onClick={() => conn.reducers.createComment({ postId: p.id, text: "Situation changed — this no longer matches what I see.", attribution: "anonymous" })}>Situation changed</button>
            <button className="btn ghost small" onClick={() => setOpen(open === String(p.id) ? null : String(p.id))}>Comments</button>
          </div>
          {open === String(p.id) && (
            <>
              {list(conn.db.pulseComments.iter()).filter((c) => c.postId === p.id).map((c) => (
                <p key={String(c.id)}><strong>{c.authorLabel}:</strong> {c.text}</p>
              ))}
              <input className="field" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment" />
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
  const profile = list(conn.db.myProfile.iter())[0];
  const loc = list(conn.db.myLocation.iter())[0];
  const [paused, setPaused] = useState(profile?.notificationsPaused ?? false);
  const [demo, setDemo] = useState<string>(localStorage.getItem("pp.demoPlace") ?? "");
  const [pushMsg, setPushMsg] = useState("");
  const [diag, setDiag] = useState(localStorage.getItem("pp.diag") === "1");

  useEffect(() => {
    if (!conn) return;
    if (demo) {
      const p = CATALOG_PLACES.find((x) => x.id === demo);
      if (p) {
        localStorage.setItem("pp.demoPlace", demo);
        void conn.reducers.updateLocation({ lat: p.lat, lng: p.lng, accuracyM: 15, source: "demo" });
      }
    } else if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          void conn.reducers.updateLocation({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracyM: pos.coords.accuracy,
            source: "gps",
          });
        },
        () => undefined,
        { enableHighAccuracy: true, maximumAge: 15_000 },
      );
    }
  }, [conn, demo]);

  return (
    <section>
      <h1>@{profile?.username}</h1>
      {loc?.source === "demo" && <div className="demo-banner">Simulated location on — routing still uses the real distance pipeline.</div>}
      <p>Location source: {loc?.source ?? "none"} {loc ? `(${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)})` : ""}</p>
      <h2>Demo location override</h2>
      <select className="field" value={demo} onChange={(e) => {
        setDemo(e.target.value);
        if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
      }}>
        <option value="">Use real GPS</option>
        {DEMO_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <div className="row">
        <button className="btn ghost" onClick={async () => {
          await conn.reducers.setNotificationsPaused({ paused: !paused });
          setPaused(!paused);
        }}>{paused ? "Resume prompts" : "Pause prompts"}</button>
        <button className="btn ghost" onClick={() => enablePush(conn).then(setPushMsg).catch((e) => setPushMsg((e as Error).message))}>Enable notifications</button>
      </div>
      {pushMsg && <p>{pushMsg}</p>}
      <label className="chip">
        <input type="checkbox" checked={diag} onChange={(e) => { setDiag(e.target.checked); localStorage.setItem("pp.diag", e.target.checked ? "1" : "0"); }} /> Developer diagnostics
      </label>
      <p>Add this site to your Home Screen on iOS (Share → Add to Home Screen) so Web Push can reach you while the app is closed.</p>
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

function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
