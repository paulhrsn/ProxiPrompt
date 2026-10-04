# ProxiPrompt — Product & Architecture Contract

This file is the canonical contract. It changes only when an agreed decision changes; record the reason in `PROGRESS.md` when it does. Operational state (what is built, what is next) lives in `PROGRESS.md`.

## 1. Product

**One line:** ProxiPrompt turns nearby humans into queryable, uncertainty-aware sensors. You ask about a place; an agent figures out what you actually need to know, checks fresh evidence, asks the fewest useful people near that place only if needed, and returns a recommendation with confidence and provenance.

**Hackathon:** MHacks '26, 24 hours, team of four (Paul, Jerry, Shiyuan, Chinmay). Built agentically on one laptop at a time; agents hand off via `PROGRESS.md`.

**Tracks:** Main — Actually Intelligent (AI). Sponsor — Fetch.ai ASI:One Agent Challenge, Best Use of Spacetime.

**Positioning:** Real-time local decision intelligence. Demonstrated through campus availability (seats, noise, crowds, lines, equipment) but applicable to any place: libraries, dining halls, gyms, stores, transit, events, parks, parking. Not a nightlife app — never tailor copy or examples to bars.

### 1.1 Answerability contract
- Accept questions about a specific place's current, locally observable conditions, plus subjective conditions (atmosphere, "is it worth it").
- Subjective evidence is labeled separately from objective evidence and never turned into an objective fact by consensus.
- Refuse: questions targeting named private individuals, sensitive private locations (homes, dorm rooms, medical facilities' patients), surveillance of people, or anything not tied to a place.
- Never answer from model world-knowledge. With no fresh evidence the result is explicitly "insufficient fresh evidence".
- The requester's own location is irrelevant. Only responder proximity to the *target place* matters.

### 1.2 Out of scope (do not build)
X/Instagram/YikYak scraping, general web scraping, autonomous API discovery, follower graphs, DMs, likes/reposts, public leaderboards, spendable currency, native iOS app.

## 2. Architecture

```
apps/web (React PWA)  ──typed WS──▶  spacetimedb (module: state machine + guardrails)
                                          ▲  typed WS subscription
                                          │
                              services/orchestrator (Node/TS worker)
                                 │ JSON/HTTP            │ Web Push (VAPID)
                                 ▼                      ▼
                     services/agent (Python Fetch uAgent)   iPhones (installed PWA)
                        │ ASI:One LLM API
                        └ Chat Protocol ◀── Agentverse / ASI:One users
```

| Component | Owns | Never does |
|---|---|---|
| `apps/web` | Login, place search, ask composer, GPS + labeled demo-location injection, push subscription, service worker, query timeline/result, responder sheet, Live Pulse, posts/comments, activity, profile, diagnostics | Choose responders, compute confidence, see others' identities/coordinates |
| `spacetimedb` | Authoritative state, reducers, authorization, one-response constraint, anonymity, idempotency, lifecycle transitions, dedup records, cooldowns, recipient caps, expiry, rate limits, real-time subscriptions | Network I/O (reducers are deterministic) |
| `services/orchestrator` | Subscribes to queued work, calls agent, validates plans, scores evidence, selects responders, sends Web Push, deadlines/expansion, retries, restart recovery | Hold authoritative state; bypass reducer checks |
| `services/agent` | Fetch uAgent: `plan`, `synthesize`, `summarize_post` REST endpoints using ASI:One LLM; Chat Protocol for ASI:One discovery that triggers the same workflow | See responder identities or coordinates; send notifications; write DB |

Monorepo layout (pnpm workspaces + uv for Python):
```
apps/web/                 Vite + React + TS PWA
spacetimedb/              SpacetimeDB TypeScript module
services/orchestrator/    Node/TS worker (vitest)
services/agent/           Python uAgent (uv, pytest)
packages/core/            Shared TS: contracts (zod), dimension vocabulary, scoring, routing, freshness, ranking — pure functions, unit tested
SPEC.md  PROGRESS.md
```

Deployment target: PWA → Vercel; module → SpacetimeDB MainCloud; orchestrator and agent → separate Railway services. Orchestrator needs no inbound port and can run from a laptop as fallback. Agent needs a public HTTPS endpoint for Agentverse.

## 3. Identity, privacy, attribution
- Login: SpacetimeAuth (OIDC) email magic link for every account; the OIDC ID token authenticates the SpacetimeDB connection. If `VITE_SPACETIMEAUTH_CLIENT_ID` is unset, the web app falls back to a SpacetimeDB-issued anonymous identity + username onboarding, visibly labeled "dev auth".
- There are no asker/responder account types. Every account can ask, respond, post, comment.
- Public attribution is per contribution: `anonymous` (default; shown as "Anonymous") or `profile` (username + avatar). Changing profile settings never retroactively reveals anonymous contributions.
- Prompt responses are never public and carry no identification to anyone but the system.
- Exact coordinates live only in private tables, readable by the worker. Public views expose place-level data only; "verified nearby" is a boolean.
- Push prompts never identify the requester and never imply the requester is nearby. Copy: "Quick question about {place}" / "Someone wants a current update: {question}".
- Worker authorization: a `service_role` table. The first identity to call `claim_service_role` (when none exists) becomes the worker; documented as a deploy step. Worker-only reducers check membership.

## 4. Location
- PWA requests foreground geolocation when opened and on an interval while open; writes `{lat,lng,accuracy_m,source,captured_at}` via reducer.
- `source` is `gps` or `demo`. Demo mode substitutes coordinates at acquisition only; every downstream step (distance, eligibility, routing, notifications) is the real pipeline. Demo-sourced locations are labeled in the UI and diagnostics.
- Location freshness for routing: `LOCATION_MAX_AGE_S` (normal 1800, demo 21600).
- Production would use native background geofencing; the PWA records last-known location while opened. This limitation is stated honestly in the pitch.

## 5. Places
- Google Places (New) autocomplete via the Maps JS API, key restricted by referrer and API, with budget alert. Stable `place_id` keys caching.
- Curated Ann Arbor fallback catalog (approximate coordinates) used when the key is missing or Places fails: Shapiro Undergraduate Library, Hatcher Graduate Library, Michigan Union, Duderstadt Center, Pierpont Commons, Ross School of Business, Central Campus Recreation Building, Intramural Sports Building, North Campus Recreation Building, South Quad Dining, Mosher-Jordan Dining, East Quad Dining, The Diag, Zingerman's Delicatessen, Blake Transit Center, Michigan Stadium.
- Place record: `id, name, category, lat, lng, address, community`. Community default `umich-annarbor`.

## 6. Dimension vocabulary
Controlled keys so caching and dedup converge. Agent must choose from this list (or `other:<slug>` sparingly):

| key | kind | default volatility |
|---|---|---|
| seating_availability | objective | high |
| crowd_level | objective | high |
| wait_time | objective | high |
| line_length | objective | high |
| noise_level | objective | high |
| equipment_availability | objective | high |
| parking_availability | objective | high |
| food_availability | objective | medium |
| open_status | objective | low |
| event_status | objective | medium |
| cleanliness | objective | medium |
| temperature | objective | medium |
| atmosphere | subjective | medium |
| worth_it | subjective | medium |

TTL bounds by volatility (agent proposes; code clamps): high 300–1800 s (default 900), medium 1800–14400 s (default 5400), low 14400–172800 s (default 43200).

## 7. Query lifecycle

Entities:
- **Query** — one requester's question, preferences, status, final answer. Private to requester + worker.
- **Evidence job** — canonical place + dimension set; shared by equivalent queries.
- **Observation** — one reusable fact (dimension, value, kind, source, observed_at, expires_at, verified_nearby).
- **Prompt batch** — one adaptive micro-survey sent to selected responders.
- **Answer snapshot** — synthesis for one query, referencing the observations used.

Query states: `planning → (clarifying →) collecting | synthesizing → answered | insufficient | refused | failed | cancelled`. Job states: `collecting → synthesizing → done | expired`.

Flow:
1. `submit_query` reducer validates (auth, rate limit, text length, place) and inserts `planning` + timeline event.
2. Worker sees it, calls agent `plan`. Refusal → `refused`. Clarification (rare; only when two plausible interpretations need materially different evidence) → `clarifying`; `answer_clarification` reducer returns to `planning`.
3. Worker clamps TTL/radius/count, then looks for an active job at the same place whose dimension set overlaps (Jaccard ≥ 0.5) → attach query. Otherwise create a job.
4. Worker scores fresh observations for the place. Sufficient → `synthesizing`. Else create a prompt batch and select responders.
5. Responder selection: location fresh, within radius (clamped 50–500 m, default 150), not the requester, has active push device, not notifications-blocked, not in cooldown, not already a recipient for this job. Rank by distance then reliability. First wave is 2. If that group has not produced a sufficient answer after `EXPAND_AFTER_S`, or everyone in it has already responded, ask a new group of 2 who have not been asked. Repeat until the answer is sufficient, nobody new is nearby, or the job reaches 5 recipients.
6. `submit_response` reducer: only selected recipients, once per batch (unique), within expiry. Each answer becomes observations (`verified_nearby` = recipient selection was proximity-based on a fresh location).
7. Worker re-scores on each response. Stops when sufficient, when no further wave is available, or at `JOB_DEADLINE_S`.
8. Worker calls agent `synthesize` per attached query with explicit evidence bundle and deterministic confidence. Writes answer → `answered`, or `insufficient` if no usable evidence. Notifies requester via push.
9. Late responses still become observations; if they materially change an answered query, the worker writes an updated answer and notifies "Updated answer".

Timing config (`DEMO_MODE` env toggles):

| setting | normal | demo |
|---|---|---|
| FIRST_WAVE | 2 | 2 |
| MAX_RECIPIENTS | 5 | 5 |
| EXPAND_AFTER_S | 30 | 10 |
| JOB_DEADLINE_S | 120 | 30 (answer accepted until 120) |
| RESPONDER_COOLDOWN_S | 600 | 60 |
| PROMPT_EXPIRY_S | 600 | 600 |

Timeline events shown to requester (compact, no chain-of-thought): "Understanding your question", "Checking recent updates", "Found N recent updates (X fresh)", "Asking N people near {place}", "Received k of N", "Enough evidence", "Answer ready" / "Not enough fresh evidence".

## 8. Scoring (deterministic, `packages/core`)

Per observation weight:
`w = freshness × source_weight × reliability`
- `freshness = clamp(1 − (age/ttl)², 0, 1)`; 0 if past `expires_at` or invalidated.
- `source_weight`: response verified 1.0; response unverified 0.7; post verified 0.8; post unverified 0.55; comment 0.5; social (Bluesky) 0.35.
- `reliability` default 1.0 (range 0.5–1.2, P1).

Per dimension: `support = 1 − Π(1 − wᵢ)`; `agreement` = weight share of the modal value (ordinal values within one step count as half agreement); `dim_conf = support × agreement`.

Overall: weighted mean of `dim_conf` over required dimensions (objective weight 1.0, subjective 0.5). Ceiling by independent contributors: 1 → 0.6, 2 → 0.8, ≥3 → 0.95. Level: ≥0.70 High, ≥0.45 Medium, else Low. Sufficient when overall ≥ `SUFFICIENT_SCORE` (0.6) and every objective required dimension has support ≥ 0.5.

Contradiction: a newer observation on the same dimension with a value ≥2 ordinal steps away halves older observations' freshness for that dimension.

Users see High/Medium/Low + "N recent nearby reports · updated Xs ago". Numeric score and factor breakdown are exposed only in the diagnostics drawer (P1 UI; P0 stores the factors).

## 9. Agent contract (JSON over HTTP; mirrored by zod in `packages/core` and pydantic in `services/agent`)

`POST /plan` → `{ canonical_intent, intent_key, decision, dimensions:[{key,label,kind,volatility,proposed_ttl_s}], needs_clarification, clarification:{question,options[]}|null, survey:{question, controls:[{dimension_key,label,options:[{value,label,ordinal}]}] (1–3), allow_note:true}, responder_radius_m, responder_count, refusal:{reason}|null, planner:"llm"|"heuristic" }`
Request: `{ query_id, text, place:{id,name,category,lat,lng}, now_iso, recent_evidence:[{dimension,value_label,kind,source_type,age_s,verified_nearby}] }`.

`POST /synthesize` → `{ headline, recommendation:"go"|"maybe"|"avoid"|"insufficient", summary, supporting[], caveats[], planner }`
Request: `{ query_id, text, canonical_intent, place, dimensions, evidence:[{id,dimension,value_label,kind,source_type,age_s,verified_nearby,note}], confidence:{score,level,ceiling}, missing_dimensions[] }`. The agent may not invent evidence or raise confidence.

`POST /summarize_post` → `{ summary (one sentence), claims:[{dimension,value_label,kind,volatility,proposed_ttl_s,ordinal}], planner }`
Request: `{ post_id, place, text, comments:[{text,age_s}], now_iso }`.

LLM: ASI:One OpenAI-compatible API (`ASI_ONE_API_KEY`). When the key is absent the agent uses a deterministic heuristic planner and reports `planner:"heuristic"`; diagnostics surface this. The heuristic path exists for tests and offline dev, never presented as the AI.

Chat Protocol: the uAgent implements `chat_protocol_spec`, publishes its manifest, uses a mailbox, and is registered on Agentverse with a README and keywords. An ASI:One chat like "Is Shapiro Library busy right now?" resolves the place against the curated catalog, submits a real query into SpacetimeDB through the orchestrator, and replies with the result when ready (or a progress message + follow-up).

## 10. Live Pulse (proactive evidence stream)
- Home screen: ask composer first; Live Pulse below. Not marketed as social media.
- Scope: editable community selector (default UM / Ann Arbor), independent of requester GPS.
- Post: place, text (≤280), attribution choice. Comments: text (≤280), attribution choice. No likes/reposts.
- Agent `summarize_post` on create and when comments change: one-sentence summary + claims → observations (posts verified-nearby if author location fresh and within 150 m).
- Freshness note computed deterministically from claim age vs TTL (no LLM per scroll): "Fresh · 3 min ago", "Aging · changes fast", "Context only · 4 h ago", "Mixed reports", "Recently reinforced".
- Ranking (default "Most useful"): `score = 0.55·max_claim_freshness + 0.15·verified + 0.15·recent_substantive_comments + 0.15·recency`; strict "Recent" sort available. Freshness dominates engagement.
- Evidence reactions "Can confirm / Situation changed" are P1 (deferred; revisit after P0).

## 11. Impact loop
- Immediate receipt on submit: "Signal sent".
- `impact_event` recorded whenever an observation from a contribution is used in an answered query; contributor gets a push "Your update about {place} helped someone" (rate-limited) and private totals: people helped, notifications avoided (cache hits).
- Anonymous contributions earn private impact. Contradicted/removed contributions earn nothing. No public leaderboard in P0.

## 12. Safety (P0 core guardrails)
Rate limits (queries 10/h, posts 10/h, comments 30/h per account), text length limits, simple blocklist filter, report content, delete own content, mute prompts ("pause notifications"), admin-only hide via `is_admin` profile flag, sensitive-query refusal by agent + keyword guard, no public coordinates.

## 13. Priorities
- **P0 (non-negotiable, in order):** query → plan → evidence check → push to nearby → one-time response → live synthesis → caching/dedup → async result notification; then Live Pulse posts/comments/summaries/ranking; impact receipts; guardrails; onboarding/permission/error states.
- **P1:** Bluesky public `app.bsky.feed.searchPosts` provider (normalized `source_type:"social"`, never claimed verified); diagnostics drawer UI; Confirm/Changed reactions; reciprocal priority experiment; richer contributor recognition.

## 14. Canonical demo (acceptance scenario)
1. Four signed-in installed PWAs. Paul = requester (laptop or phone). Jerry and Shiyuan have demo locations at Shapiro (~20 m, ~45 m). Chinmay demo-located at Michigan Union (~600 m). One device shows real GPS to prove acquisition.
2. Ask: "Is Shapiro worth going to if I need somewhere quiet to study?"
3. Timeline: understands → checks updates → finds a 25-min-old post (rejected as stale for noise/seats) → asks 2 people near Shapiro.
4. Jerry and Shiyuan get real iOS notifications; Chinmay does not.
5. They answer in seconds via adaptive quick choices.
6. Requester sees responses arrive live; answer: recommendation, High/Medium/Low, "2 nearby reports · updated 12 s ago", expandable sources.
7. A second user asks "Can I find a quiet seat at Shapiro right now?" → cached evidence reused, no notifications sent, timeline says so.
8. Optional: show the Agentverse profile and ask the agent in ASI:One.

## 15. Acceptance criteria
- Real `navigator.geolocation` works; demo injection uses the identical pipeline and is labeled.
- Physical iPhone receives push while PWA backgrounded; tap deep-links to the right response sheet; requester updates live.
- Reducers reject: unauthorized transitions, non-recipient answers, duplicate answers, excess recipients, stale-location selection, identity exposure in public views.
- Verified: cache hit, active-job dedup, TTL expiry, contradiction handling, cooldown, deadline/insufficient result, worker restart recovery.
- Agentverse profile live; ASI:One chat triggers the same workflow.
- Unit tests for scoring/routing/state logic; integration tests across worker ↔ agent ↔ database contracts; one browser-driven end-to-end scenario. Results recorded in `PROGRESS.md`.
