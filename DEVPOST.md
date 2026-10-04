# ProxiPrompt: Devpost submission

Team: Paul, Jerry, Shiyuan, Chinmay. MHacks '26.

Tracks: Actually Intelligent (main), Fetch.ai ASI:One Agent Challenge, Best Use of SpacetimeDB.

Placeholders to fill before submitting:

- Public ASI:One chat share link: `TODO_ASI_ONE_CHAT_LINK`
- Demo video URL: `TODO_VIDEO_URL`
- Public repo URL: `https://github.com/paulhrsn/ProxiPrompt.ai`

---

## Tagline

Ask about a place. Nearby people answer. You get a recommendation with confidence and provenance.

## Elevator pitch

Can't read the room? Ask it. Real-time insights from the people actually there. The community is the API.

## Inspiration

A map can tell you a library exists. It cannot tell you if there is a quiet seat right now, if the dining hall line is long, or if a treadmill is free. The only sensors that know are the people standing there. Group chats and social feeds are slow, noisy, and interrupt everyone. We wanted a way to ask the fewest useful people, only when no fresh answer already exists, and to be honest about how sure we are.

## What it does

ProxiPrompt turns nearby humans into queryable, uncertainty-aware sensors.

1. You ask about a specific place: "Is Shapiro worth going to if I need somewhere quiet to study?"
2. ASI:One reviews the question. It rewrites messy wording and refuses questions about named people, private places, surveillance, or anything not observable at a place right now.
3. The agent decides what evidence matters (noise, seating, crowd, wait time, and so on) and checks fresh evidence already in the database.
4. If that is not enough, it asks only people physically near that place, in small waves, with a short neutral micro-survey. Prompts never say who asked.
5. You watch a live timeline as answers arrive. The result shows a recommendation, High / Medium / Low confidence, "N recent nearby reports, updated Xs ago", and expandable sources.

Built-in behavior:

- **Never answers from world knowledge.** With no fresh evidence the result is explicitly "insufficient fresh evidence".
- **Cache reuse.** A second, similar question at the same place reuses fresh evidence and interrupts nobody ("Reusing fresh evidence").
- **Notify me when.** A standing watch for up to 3 hours. A matching nearby report (open seats, or quiet) sends one notification.
- **Reciprocal priority.** People who answered neighbors recently get their own questions served first and asked to more people (credit is capped at 5, zero credit is never penalized, and credit is never visible to others).
- **Live Pulse.** Proactive community posts become short-lived evidence, ranked by freshness rather than engagement.
- **Subjective vs objective.** Opinions are labeled as opinions and never turned into facts by consensus.
- **Ask from ASI:One chat.** The same workflow runs from ASI:One through our Agentverse agent, no app needed. The chat is polished: greetings and "help" get a capability intro with example questions, "list places" returns the catalog grouped by category, a message with no recognizable place gets guidance instead of a guess, and answers are formatted as a headline, a plain-sentence recommendation, confidence, and "Based on N recent nearby reports (newest X ago)". Insufficient evidence says it will not guess, and a late answer arrives as "Update on your earlier question".
- **Simulated neighbors (a demo and testing tool).** `pnpm demo:neighbors` runs bot residents so one presenter can demo alone. They are ordinary user accounts that use only normal client actions (never the worker identity), their usernames end `_sim`, and they answer prompts after a random 3 to 12 s. They are labeled as simulated everywhere we show them and are not part of the product's evidence claims.
- **Privacy.** Responders are never identified. Exact coordinates live in private tables. Public views expose place-level data only.

## How we built it

```
React PWA  <--WebSocket-->  SpacetimeDB module (tables, reducers, views, schedules)
                                   ^
                                   | subscription
                            Node orchestrator  --JSON/HTTP-->  Python uAgent (ASI:One)
                                   |                                  ^
                              Web Push                      Chat Protocol (Agentverse)
```

- **SpacetimeDB module (TypeScript).** The authoritative state and the rule engine: 22 tables, 45 reducers (20 client-facing, 25 worker or scheduled), 27 views. The query and job state machines, one response per recipient, recipient caps, requester exclusion, location freshness, cooldowns, rate limits, blocklist, and authorization are enforced in reducers, not the app. Four scheduled reducers run the clock.
- **Node orchestrator (TypeScript).** A worker that subscribes to the database, calls the agent, scores evidence, selects responders, sends Web Push, and handles waves, retries and restart recovery. It holds no authoritative state and cannot bypass reducer checks.
- **Python uAgent (Fetch.ai).** `plan`, `synthesize` and `summarize_post` endpoints using ASI:One as the LLM, plus the Chat Protocol for ASI:One chat. Every LLM output is validated and clamped (fixed dimension vocabulary, TTL bounds, radius 50 to 500 m, 1 to 5 responders). A deterministic heuristic planner exists for tests and offline use and is always labeled.
- **React PWA with Web Push.** Ask, Questions, Posts and You tabs. A responder sheet, live timeline, demo-location injection (GPS acquisition only is simulated, labeled in the UI), and service-worker push with deep links.
- **Shared core package.** Pure, unit-tested functions for scoring, routing, freshness and ranking, plus zod contracts mirrored by pydantic in the agent.

Confidence is deterministic. Each observation has weight freshness x source weight x reliability. Per dimension, support and agreement combine into a score, capped by the number of independent contributors. The LLM writes the sentence and cannot raise the score.

## Challenges

- **Nearby buildings are closer than GPS error.** Duderstadt and Pierpont are 78 m apart. We added an explicit claimed-building statement that routing trusts over coordinates, ranking by readings, and an "Are you at this place?" control on prompts for ambiguous places. We wrote down the limit rather than pretend geometry solves it.
- **Never inventing an answer.** Scraped social posts could once reach "sufficient". We split firsthand from social evidence so social can inform a score but never answer a question.
- **One evidence job serves many questions.** Prompt wording is generated from the place and dimensions so it never leaks one asker's words or identity to responders.
- **Untrusted input.** We found and fixed a normalization bypass of the keyword guard and a regular-expression slowdown, and added ASI:One review that falls back to deterministic checks.
- **Keeping the browser test honest.** The end-to-end suite runs four isolated browser contexts against a separate database and wipes state before each test.

## Accomplishments we are proud of

- The full loop works end to end: ask, plan, check evidence, ping only nearby people, answer with confidence and provenance, reuse cached evidence.
- The database runs the clock: with the worker down, a job deadline still closes the question honestly.
- Test coverage across layers: 131 core, 63 orchestrator and 148 agent tests, 72 guardrail checks against the module, and 4 browser end-to-end scenarios (last full runs recorded in `PROGRESS.md`).
- The agent is live on Agentverse, searchable, and reachable from ASI:One chat.
- Hosted on SpacetimeDB MainCloud (`proxiprompt-mhacks`), with a scripted rehearsal against the MainCloud test database (8 simulated neighbors, scripted asker, headless browser): no cloud-path bugs; live answers in 10 to 13 s, cache reuse typically 5.6 to 8.4 s (one 23 to 25 s outlier on a busy shared agent), refusals in about 0.14 s, database round trips 0.1 to 0.3 s. These are rehearsal measurements with simulated neighbors, not a user study.
- Real sign-in is live: SpacetimeAuth email magic link, with a labeled demo session for instant access.

## What we learned

- Put the rules in the database. Once reducers enforced state transitions and privacy, bugs in the app could not break safety.
- Honest uncertainty is a feature. "Insufficient fresh evidence" earns more trust than a confident guess.
- Make the LLM bounded. Validate and clamp every output, keep scoring in code, and treat model rewrites as untrusted input.
- Test the paths you did not think of. Freeform questions and cross-question evidence mixing each hid real bugs.

## What's next

- Native background geofencing (the PWA only records location while open).
- Physical iPhone push validation across devices.
- Hosted deploys of the orchestrator and agent (with a bridge token) and a Vercel PWA.
- Gating the first service-role claim to the module owner.
- More communities beyond the University of Michigan and Ann Arbor, and Google Places search.
- Confirm / Changed reactions on evidence as a first-class feature.

## Built with

SpacetimeDB (MainCloud, SpacetimeAuth), TypeScript, React, Vite, Progressive Web App, Web Push (VAPID), Node.js, Python, Fetch.ai uAgents, Agentverse, Chat Protocol, ASI:One, pnpm, uv, zod, pydantic, Vitest, pytest, Playwright.

---

## Track: Actually Intelligent (main)

ProxiPrompt is real-time local decision intelligence: it knows what it does not know. The agent works out what evidence a question needs, uses fresh existing evidence first, asks the fewest useful people near the place only if needed, and returns a recommendation with confidence and provenance. It never answers from model world-knowledge, labels subjective opinion separately from objective fact, and refuses questions about private individuals, private places and surveillance. Confidence is computed deterministically from freshness, source and agreement, and the LLM cannot raise it. Judges can verify the behavior in the demo: ask, see the timeline, get a High / Medium / Low answer with report count, and see a second question reuse cached evidence with no new interruptions.

## Track: Fetch.ai ASI:One Agent Challenge

| Official requirement | Evidence |
|---|---|
| Agent registered on Agentverse | Agent address `agent1q2n246t50502rk048qful37rqmf3sv9yna6z9gsdlynr3lqrcmzhj7p3ncs`, mailbox connected, publicly searchable. Profile: https://agentverse.ai/agents/details/agent1q2n246t50502rk048qful37rqmf3sv9yna6z9gsdlynr3lqrcmzhj7p3ncs/profile |
| Chat Protocol implemented | The uAgent includes `chat_protocol_spec`, publishes its manifest, and handles ChatMessage / ChatAcknowledgement (`services/agent/src/proxiprompt_agent/agent.py`). Status on Agentverse: active, AgentChatProtocol. |
| ASI:One as the reasoning engine | `services/agent/src/proxiprompt_agent/llm.py` and `planner.py` call the ASI:One OpenAI-compatible API (`https://api.asi1.ai/v1`) to review and rewrite questions, plan evidence needs and survey wording, write the synthesized answer, and summarize posts. |
| Usable from ASI:One chat | Verified in ASI:One chat: messages became real queries in the database. The agent resolves a campus place, submits through the orchestrator bridge, and replies with a headline, recommendation, confidence and report count with freshness, or sends a follow-up if the answer takes longer than about 45 s. |
| Primary workflow completes without a custom frontend | Ask from ASI:One chat, nearby people are prompted, the answer returns in the chat. The PWA is only needed by the responders. |
| Public repo | `https://github.com/paulhrsn/ProxiPrompt.ai` |
| Public ASI:One chat share link | `TODO_ASI_ONE_CHAT_LINK` |
| Demo video | `TODO_VIDEO_URL` |

Agent handle: `@proxipromptagent` (shown on the Agentverse profile).

## Track: Best Use of SpacetimeDB

SpacetimeDB is the single authoritative state and the rule engine, not a cache.

- **Schema.** 22 tables, 45 reducers (20 client-facing, 25 worker or scheduled) and 27 views, all in the TypeScript module (`spacetimedb/src`).
- **Private tables and views for privacy.** Exact coordinates, prompt responses and recipients live in private tables. Clients read only views: `my_*` views per user, public place-level Live Pulse views, and `svc_*` views that only the worker identity can see. Guardrail checks confirm other users and the public cannot read private rows.
- **Rules in reducers.** Query and job state machines, one response per recipient, recipient cap of 20, requester exclusion, location freshness, cooldowns, rate limits (including a separate 60/hour budget for the ASI:One relay), blocklist, admin hide, and service-role authorization.
- **Scheduled reducers run the clock.** Four schedules: `job_deadline_schedule` (with no fresh evidence the database itself writes "insufficient" and expires the job, even with the orchestrator down), `prompt_expiry_schedule` (expires a prompt card), `watch_expiry_schedule` (ends a watch after up to 3 hours), and `gc_schedule` (every 10 minutes deletes old observations and rate buckets).
- **Real-time subscriptions.** The PWA timeline, prompt pop-up and Live Pulse are live subscriptions. The orchestrator is itself a subscriber that reacts to row changes.
- **Guardrails.** 72 automated checks against the module (`pnpm --filter @proxiprompt/spacetimedb guardrails`), including deadline, watch expiry and cleanup with no worker running. Also passed against MainCloud.
- **MainCloud.** Live database `proxiprompt-mhacks` (https://spacetimedb.com/proxiprompt-mhacks), started with `STDB_TARGET=maincloud pnpm dev`.
- **SpacetimeAuth login.** Email magic-link sign-in through SpacetimeAuth (OIDC) is live in the app; the ID token authenticates the database connection. The sign-in screen also offers a labeled "Use demo session" (a browser-only dev identity) for instant access.
