# ProxiPrompt: Next Steps (work specs)

Written 2026-10-04 at handoff. Read `SPEC.md` (contract) and `PROGRESS.md` (state) first; this file specifies the work that comes next, in priority order. Update the status line on each item as you go, and move finished items into `PROGRESS.md`'s work log.

Paul's working preferences that apply to all of this:
- TDD: write the failing test first, confirm it fails, then implement (see `~/.claude/CLAUDE.md`).
- Browser mock first. Paul wants every feature working in the laptop browser (asker tab `http://localhost:5173`, responder tab `http://127.0.0.1:5173`) before any iPhone testing. iPhone push is explicitly deferred.
- Short answers, no em dashes in anything he reads, do the next step instead of offering it.
- Commit and push to `main` after each verified fix (this repo works directly on `main`).

---

## 0. How the system fits together (read this if you are new)

| Piece | Where | Port | Role |
|---|---|---|---|
| SpacetimeDB module | `spacetimedb/src/*.ts` | 3000 | The database AND the rule engine. 22 tables, 45 reducers (20 client, 25 worker or scheduled), 27 views. Holds all state, enforces every safety rule, and pushes live updates to every subscriber. Reducers cannot do network I/O. |
| Orchestrator | `services/orchestrator/src` | 8080 | The dispatcher. Subscribes to the database, calls the agent, picks who to ping, sends Web Push, decides when to synthesize. Runs `tick()` every 2 s (`src/index.ts:141`). Also serves `/places`, `/asi/query`, `/dev/wipe`, `/vapidPublicKey`. |
| Agent | `services/agent/src/proxiprompt_agent` | 8001 | The brain. Python uAgent. `/plan`, `/synthesize`, `/summarize_post` use ASI:One as the LLM. Also implements the Fetch.ai Chat Protocol (ASI:One chat users reach it through the Agentverse mailbox). |
| PWA | `apps/web/src/App.tsx` | 5173 | React app. Asker composer, live timeline, responder prompt sheet, Posts, You tab. |

Run everything: `pnpm dev` (`scripts/dev.sh`, which sources the git-ignored `.env` files). Both HTTP services bind 127.0.0.1 only; phones reach the app through ngrok to Vite, and Vite proxies `/v1`, `/places`, `/dev`.

Databases: `proxiprompt` is the live local DB the team uses. `proxiprompt-test` is for guardrails and e2e. Never run test scripts against `proxiprompt` (throwaway users with fresh locations steal real people's prompt slots; it happened on 2026-10-03).

Test commands (all green at handoff):
```
pnpm --filter @proxiprompt/core test            # 121
pnpm --filter @proxiprompt/orchestrator test    # 40
cd services/agent && uv run pytest -q           # 143
pnpm --filter @proxiprompt/web typecheck
pnpm --filter @proxiprompt/spacetimedb publish:test && pnpm --filter @proxiprompt/spacetimedb guardrails   # 65
```

---

## 1. Playwright browser end-to-end test of the canonical demo

**Status:** done 2026-10-04. Re-checked this session: the canonical spec passed against `proxiprompt-test`. **Needs Paul:** nothing.

**Why:** SPEC §15 requires "one browser-driven end-to-end scenario", the only unmet acceptance criterion. It is also the fastest way to make "everything works in the browser mock" provable with one command after every change, instead of Paul clicking through it.

**Scope:** automate SPEC §14 steps 1-7 in real Chromium pages against real services.

**Isolation (must do, do not skip):**
- Run against `proxiprompt-test`, never `proxiprompt`.
- Start a second orchestrator: `SPACETIMEDB_DB=proxiprompt-test ORCH_PORT=8081 DEMO_MODE=1 ENABLE_BLUESKY=0`, worker token from `spacetimedb/.local/worker-token-proxiprompt-test` (guardrails created it). Only one orchestrator may serve a DB (see PROGRESS Known issues).
- Start a second Vite on another port (e.g. 5174) with `VITE_SPACETIMEDB_DB=proxiprompt-test`. `apps/web/vite.config.ts` hard-codes proxy targets to 8080; make the orchestrator target configurable via an env var (e.g. `ORCH_PROXY_TARGET`), default unchanged.
- Reuse the shared agent on 8001 (stateless).
- Best: a script (`scripts/e2e-browser.sh` or a Playwright `globalSetup`) that starts and stops the test orchestrator + Vite.

**Install:** add `@playwright/test` as a root dev dependency. Chromium builds are already cached in `~/Library/Caches/ms-playwright`; run `pnpm exec playwright install chromium` if the version differs.

**Scenario (one test, four browser contexts so identities are separate):**
1. Context A (asker), B and C (responders), D (far responder). In each: complete onboarding (username), then on the You tab pick a demo location: B and C = Shapiro Undergraduate Library, D = Michigan Union. A needs no location.
2. A asks "Is Shapiro worth going to if I need somewhere quiet to study?".
3. Assert on A's `/q/<id>` timeline, in order: "Understanding your question", "Checking recent updates", an "Asking N people near Shapiro" line.
4. Assert B and C each see the prompt pop-up/sheet within ~10 s; D never does (wait the full window).
5. B and C pick answers and Send. Assert the "Signal sent"/thanks state.
6. Assert A's page shows the answer: a recommendation, a High/Medium/Low confidence, and a report count matching the confidence level (a past bug had them disagree).
7. A second asker (new context E, or reuse D) asks "Can I find a quiet seat at Shapiro right now?". Assert the timeline says "Reusing fresh evidence, no one interrupted" (exact copy in `loop.ts:803` uses an em dash; match a substring) and that B/C get no new prompt.
8. Teardown: call the test orchestrator's `/dev/wipe` (it is localhost-only; send header `X-ProxiPrompt-Dev: 1`) or `publish:test:clear`.

**Selectors:** prefer visible text and roles. Add `data-testid` only where text is ambiguous; keep it minimal.

**Done when:** `pnpm e2e:browser` (or similar) passes twice in a row from a clean `proxiprompt-test`, and the command plus result is recorded in PROGRESS "Verification".

---

## 2. Fix whatever item 1 finds

**Status:** done 2026-10-04. The run found two product bugs, both pinned and fixed: the planner now keeps vocabulary dimensions the question names (seats on "quiet study"), and a neighbour presence control drops a subjective survey slot before an objective one. The cache-hit line stays on the answer screen. See PROGRESS session 12.

---

## 3. SpacetimeDB track upgrades ("Best Use of SpacetimeDB")

Current strengths and the full gap list are in PROGRESS "Sponsor tracks". These are the three gaps, highest judge impact first.

### 3a. Scheduled reducers: let the database run the clock

**Status:** done 2026-10-04. Job deadlines, prompt expiry, and garbage collection all run on the database clock. **Needs Paul:** nothing.

**Problem today:** every time-based rule is enforced by the orchestrator polling every 2 s:
- Job deadline: `loop.ts:656` computes `pastDeadline = now >= job.deadlineAt`, then (`loop.ts:696-721`) writes an `insufficient` answer when there is no evidence, or synthesizes, then sets the job `expired`.
- Prompt expiry: stored as `prompt_batch.expires_at`; `submit_response` already rejects late answers lazily (`client.ts:264`), but nothing marks prompts expired, so they only disappear client-side via `isAnswerable`.
- Observation TTL: `observation.expires_at`; filtered at read time in `loop.ts:78`, never cleaned up.
- Rate buckets: hourly rows in `rate_bucket` accumulate forever.
If the orchestrator is down, deadlines silently stop happening and queries hang in `collecting`.

**Design:** SpacetimeDB schedule tables (a table whose rows carry a `ScheduleAt`; the module runs the bound reducer at that time). Verify the exact TypeScript syntax against the installed `spacetimedb` package docs before writing code; the SDK in `spacetimedb/node_modules/spacetimedb` exposes `ScheduleAt`.
1. `job_deadline_schedule` table `{ scheduled_id (pk autoinc), scheduled_at: ScheduleAt, job_id: u64 }` bound to reducer `job_deadline_reached`. Insert a row in `worker_create_job` at `deadline_at`.
2. `job_deadline_reached` (callable only by the scheduler: check `ctx.sender` is the module identity per the SDK docs):
   - If the job is no longer `collecting`/`synthesizing`, do nothing.
   - Add a `query_event` "Time's up" to each attached query.
   - Deterministic part in the DB: if the job has zero non-expired, non-invalidated observations for its dimensions, write the `insufficient` answer for each attached query (copy the exact answer JSON from `loop.ts:699-711`) and set the job `expired`.
   - Otherwise set a new flag/status (e.g. `deadline_passed: true`, or a new job status `closing` added to the transition table in `lib.ts:52-53`) so the orchestrator, which reacts to the subscription instead of the clock, runs synthesis (it needs the agent, which a reducer cannot call).
3. Orchestrator: replace the `pastDeadline` clock check with "job flagged by the database". Keep a fallback so a job is not stuck if the scheduler row is missing.
4. Optional, same pattern: `prompt_expiry_schedule` marks batches expired; a periodic `gc` schedule (every 10 min) deletes expired observations past the late-accept window and rate buckets older than 2 h.

**Tests (write first):**
- Guardrails (`spacetimedb/scripts/guardrails.ts`): create a job with a deadline ~2 s out and no evidence; assert attached query becomes `insufficient` with no orchestrator running (the guardrails script has no orchestrator, which proves the point). Assert a non-scheduler identity cannot call `job_deadline_reached`.
- Orchestrator (`services/orchestrator/test/fake-conn.ts` + `loop.test.ts`): the fake must model the new flag/status; existing deadline tests must still pass; add one where the orchestrator synthesizes only after the DB flags the deadline.
- Re-run the full e2e from item 1.

**Also update:** SPEC §2 (who owns deadlines), SPEC §7 lifecycle, the `JOB_STATUSES` transitions if a status is added, and regenerate bindings (`pnpm --filter @proxiprompt/spacetimedb generate`), then `publish:local` and `publish:test`.

**Pitch line:** "Deadlines, expiry and cleanup are scheduled inside SpacetimeDB, so the database enforces time even if every worker is down."

### 3b. SpacetimeAuth login

**Status:** not started. **Needs Paul:** create a SpacetimeAuth project and an OIDC client with email magic link, then put the client ID in `apps/web/.env` as `VITE_SPACETIMEAUTH_CLIENT_ID` (a public identifier, not a secret). Redirect URIs: `http://localhost:5173`, `http://127.0.0.1:5173`, and the ngrok URL.
**Code:** `apps/web/src/auth.tsx` already implements the OIDC path (SPEC §3); today it falls back to anonymous "dev auth" because the ID is unset. Work is verification: sign in on both tabs, confirm the identity persists across reloads and that `set_profile` onboarding still runs once.
**Watch out:** existing anonymous identities become different users after switching; use the dev wipe or re-onboard.

### 3c. Host on MainCloud

**Status:** done 2026-10-04. Live DB `proxiprompt-mhacks` (test DB `proxiprompt-mhacks-test`, guardrails 72/72 there). Service role claimed by our worker; token in `spacetimedb/.local/worker-token-proxiprompt-mhacks` (keep it). Use `STDB_TARGET=maincloud pnpm dev`. Remaining: one full team demo run on MainCloud.

---

## 4. "Watch a place" extension (proposed, NOT yet approved by Paul)

**Status:** done 2026-10-04. "Notify me when" asks once and keeps a watch for up to 3 hours. The database expires it. A later report that matches (open seats, or quiet) shows on Questions and sends a push. The match uses the report's label as well as its option id, because the watch and the question are planned separately and the model picks different ids for the same choice. A question that is not seats or quiet ends with a reason instead of staying on "Setting up". Verified in Chromium against `proxiprompt-test` (`e2e/watch.spec.ts`, passed after that fix).

**Idea:** a standing question. "Tell me when seats open up at Shapiro." The agent keeps watching new evidence and pushes when the answer changes, instead of answering once. Fits the "Actually Intelligent" track: the agent acts on the user's behalf over time.

**Sketch:** `watch` table `{ id, owner, place_id, dimension_keys, target (e.g. seating_availability >= "some"), created_at, expires_at (max 3 h), last_value, status }`. Created from the composer ("Notify me when..."), planned by the agent (`/plan` already yields dimensions; add a target condition). The orchestrator re-evaluates watches when new observations arrive at that place (it already subscribes to `observation`) and pushes "Seats opened up at Shapiro (2 reports, 1 min ago)". Optional: if a watch is stale, run a low-priority prompt wave, respecting cooldowns. Expiry via a SpacetimeDB schedule (reuses 3a). Never re-ping the same responders just to serve a watch more than once per 15 min.

**Estimate:** 3-4 h including tests.

---

## 5. Fetch.ai ASI:One Agent Challenge deliverables

**Status:** technical requirements met and verified 2026-10-04 (agent `agent1q2n246t50502rk048qful37rqmf3sv9yna6z9gsdlynr3lqrcmzhj7p3ncs`, mailbox, AgentChatProtocol, publicly searchable, ASI:One chat created real queries #37/#38).

Remaining (mostly Paul):
1. Register the handle `proxipromptagent` on the Agentverse profile (`@proxiprompt` is taken by the team's ASI:One personal AI, an unrelated chatbot persona; do not delete it).
2. Produce a public ASI:One shared chat URL showing a fully answered workflow: have a teammate's tab demo-located at the place, ask from ASI:One, answer in the tab within the 30 s demo window.
3. Demo video, Devpost entry with the Agentverse profile URL: https://agentverse.ai/agents/details/agent1q2n246t50502rk048qful37rqmf3sv9yna6z9gsdlynr3lqrcmzhj7p3ncs/profile

Follow-up: if the answer is not ready after 45s, the chat says it will send the answer, then `poll_until_done` keeps watching for 3 minutes and posts the result (`bridge.py`, `agent.py`). Verified with `tests/test_chat_bridge.py`.

---

## 6. Deferred by Paul (do later)

- iPhone push: open the HTTPS ngrok URL in Safari, Share > Add to Home Screen, open from the icon, You tab > Enable notifications. The manifest fix for ngrok (`crossorigin="use-credentials"`) is untested on iOS Safari.
- Rehearse SPEC §14 with the team.
- Hosted deploy of web/orchestrator/agent. The shared bridge token now exists: set the same `ORCH_BRIDGE_TOKEN` on the orchestrator and the agent (the agent sends it as `Authorization: Bearer`). The orchestrator returns 503 on `/asi/query` if `ORCH_HOST` is non-loopback and the token is unset.

---

## 7. Known quirks to keep in mind

- Restarting: the agent and orchestrator do not hot-reload; Vite does. After code changes to either service, restart it (or `pnpm dev`).
- The free ngrok tier serves its warning page to cookie-less browser requests (fixed for the manifest; any new fetch without credentials through ngrok can hit it).
- `services/orchestrator/.env` must contain only the VAPID lines; copying `.env.example` wholesale turns Bluesky on and sets an empty token.
- The dev "Wipe activity" button only works from `localhost`/`127.0.0.1` on the laptop, by design (security review 2026-10-04).

---

## 8. Session 15 (done 2026-10-04)

All merged and verified on `main` (details in PROGRESS "Session 15 orchestration log"):
- Browser e2e isolation: every spec wipes activity first (`e2e/fixtures.ts`); `pnpm e2e:browser` 4/4 twice.
- `/asi/query` bridge token: set the same `ORCH_BRIDGE_TOKEN` on orchestrator and agent before any public bind; a public `ORCH_HOST` without it returns 503 on those routes.
- PROGRESS Known issues refreshed.
- Reciprocal priority (SPEC §7): requesters who answered neighbors in the last 24 h are planned first and get a first wave of `FIRST_WAVE + credit` (credit capped at 5), with a private "Priority boost" timeline line. Off switch: `RECIPROCAL_PRIORITY=0`.

What remains is human-gated: sections 3b, 3c, 5 and 6.
