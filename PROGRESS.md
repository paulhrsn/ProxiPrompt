# ProxiPrompt — Progress & Handoff Ledger

Read `SPEC.md` first (the contract). This file is the operational state. **Every agent updates this file after every substantive batch.** Never write secret values here — only env var names.

## How to resume (cold start)
1. Read `SPEC.md`, then this file top to bottom, then `NEXT_STEPS.md` (detailed specs for every upcoming work item).
2. Check "Current objective" and "Next actions".
3. Run the verification commands in "Verification" to confirm the stated state is still true before building on it.

## Current objective
**As of 2026-10-04 (session 15): all agent-doable work is done and verified on `main`.** Session 15 merged four lanes (see the orchestration log below): the browser e2e suite is isolated and green (4/4 twice), `/asi/query` has an optional shared bridge token that fails closed on a public bind, Known issues are accurate, and reciprocal priority (SPEC §7) is built. Remaining work needs Paul: SpacetimeAuth client ID, Agentverse handle, public ASI:One chat link, demo video, Devpost, and iPhone push.

State at handoff:
- Infra left running by the orchestrator: SpacetimeDB on :3000 and the agent on :8001. No live orchestrator or Vite (8080/5173); run `pnpm dev` for the full local stack.
- Tests on main: core 131, orchestrator 63, agent 148, browser e2e 4, guardrails 72 (last run session 14; no module change since).
- New env var `ORCH_BRIDGE_TOKEN` (orchestrator + agent): optional locally; required before `ORCH_HOST=0.0.0.0`. New env switch `RECIPROCAL_PRIORITY=0` turns the experiment off.

## Status by plan to-do
| to-do | status | notes |
|---|---|---|
| write-contract | done | `SPEC.md` + this ledger |
| prove-integrations | done | Spacetime subscription smoke OK; agent `/plan` `/synthesize` `/health` live; Web Push wired (VAPID keys still human) |
| build-vertical-slice | done | `services/orchestrator/scripts/e2e.ts` — 2 nearby prompted, far excluded, answer written |
| implement-intelligence | done | Places catalog, GPS/demo adapter, plan/score/route/cache/dedup/async deadlines |
| build-pulse | done | Posts, comments, AI summaries, utility ranking, attribution, impact receipts |
| harden-demo | done | Guardrails in module (61 checks), onboarding, permission copy, diagnostics, fallback catalog |
| add-stretches | done | Bluesky provider (ENABLE_BLUESKY), diagnostics drawer, confirm/changed as structured comments. Reciprocal priority built session 15 (SPEC §7) |

## Environment / toolchain
- node v24.9.0, pnpm 11.5.2, Python 3.12 (agent uv), 3.14 system, uv 0.11.19, SpacetimeDB CLI **2.10.2** at `~/.local/bin/spacetime`.
- Git remote: `git@github.com:paulhrsn/ProxiPrompt.ai.git`, branch `main`.
- Local SpacetimeDB listen: `127.0.0.1:3000`. Agent: `127.0.0.1:8001`. Orchestrator HTTP: `8080`. PWA: `5173`.

## Env vars (names only)
| name | used by | status |
|---|---|---|
| `VITE_SPACETIMEDB_URI`, `VITE_SPACETIMEDB_DB` | web | local defaults |
| `VITE_SPACETIMEAUTH_CLIENT_ID` | web | **needs human** — until set, PWA uses persisted anonymous Spacetime identity + `set_profile` |
| `VITE_GOOGLE_MAPS_API_KEY` | web | **needs human** — curated catalog works without it |
| `VITE_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | web / orchestrator | **set 2026-10-04** in git-ignored `apps/web/.env` and `services/orchestrator/.env` (orchestrator `.env` holds ONLY the VAPID lines: the example file's `ENABLE_BLUESKY=1` and empty token would override `dev.sh` defaults) |
| `SPACETIMEDB_URI`, `SPACETIMEDB_DB`, `SPACETIMEDB_TOKEN` | orchestrator | token auto-saved to `spacetimedb/.local/worker-token-<db>` |
| `AGENT_URL` | orchestrator | `http://127.0.0.1:8001` |
| `ASI_ONE_API_KEY` | agent | **set** in `services/agent/.env`; `/health` shows `llm_configured:true` |
| `AGENT_SEED`, `AGENT_MAILBOX`, `AGENT_HANDLE` | agent | **set** in `services/agent/.env` (seed is the agent's permanent identity; do not change it or the Agentverse address changes). `AGENTVERSE_API_KEY` not needed for mailbox mode |
| `AGENT_HOST`, `ORCH_HOST` | agent / orchestrator | unset = bind 127.0.0.1. Set `0.0.0.0` only on a hosted deploy (and add a bridge token first, see Known issues) |
| `ENABLE_DEV_WIPE` | orchestrator | `dev.sh` sets `1`; enables the localhost-only Wipe activity button |
| `STDB_DB` | spacetimedb scripts, e2e | e2e refuses the live `proxiprompt` DB; use `STDB_DB=proxiprompt-test` |
| `STDB_TARGET` | scripts/dev.sh | `maincloud` = use MainCloud DB `proxiprompt-mhacks` instead of local SpacetimeDB |
| `STDB_SERVER`, `STDB_URI` | spacetimedb scripts | CLI server nickname (`local`/`maincloud`) and WebSocket URI for guardrails/smoke |
| `ORCH_BRIDGE_TOKEN` | orchestrator + agent | optional locally; required before `ORCH_HOST=0.0.0.0` |
| `ORCHESTRATOR_URL` | agent chat bridge | `http://127.0.0.1:8080` |
| `DEMO_MODE` | orchestrator | `1` for judged timings |
| `ENABLE_BLUESKY` | orchestrator | default on; `scripts/dev.sh` sets `0` |

`scripts/dev.sh` sources `services/agent/.env` and `services/orchestrator/.env` before its defaults (nothing else loads them).
| `SKIP_PORT80` | scripts/dev.sh | set `1` to skip the sudo :80 forwarder (ngrok/phones only) |

## Human-gated steps (cannot be done by an agent)
- SpacetimeAuth project + magic-link client ID (optional; demo works without).
- Google Cloud billing + Maps key (optional).
- ~~VAPID keys~~ done. Still human: install PWA on iPhones (iOS ≥16.4) from the HTTPS ngrok URL via Share > Add to Home Screen, open from the icon, You tab > Enable notifications.
- ~~ASI:One API key, Agentverse mailbox~~ done 2026-10-04. Still human: register the handle `proxipromptagent` on the Agentverse profile (not yet shown publicly), make a public ASI:One shared chat link of a fully answered workflow, record the demo video. `@proxiprompt` belongs to the team's ASI:One personal AI (an unrelated chatbot persona created at ASI:One sign-up; do not delete it, its link to the account/API key is unverified).
- Agentverse profile: https://agentverse.ai/agents/details/agent1q2n246t50502rk048qful37rqmf3sv9yna6z9gsdlynr3lqrcmzhj7p3ncs/profile
- ~~`spacetime login` + MainCloud publish~~ done 2026-10-04 (`proxiprompt-mhacks`). Vercel + Railway deploys still open.
- Fetch.ai ASI Submission Agent + Devpost.

## Decisions log
- 2026-10-03: Contract as in SPEC.md.
- 2026-10-03 (correctness pass): **Prompt wording is always the plan's generated `survey.question`, never the requester's raw text.** One evidence job can serve several queries (Jaccard >= 0.5 attach, SPEC §7 step 3), so the first asker's words were reaching responders for someone else's question; quoting the asker also conflicts with SPEC §3 ("push prompts never identify the requester"). Removed the two raw-text overrides in `planner.py:_assemble_plan`. SPEC §9 updated.
- 2026-10-03 (correctness pass): **Social (Bluesky) evidence can inform a score but never satisfy sufficiency, and never counts as a nearby report.** Three scraped posts previously reached support 0.72 with ceiling 0.95 and answered a query with nobody asked, violating SPEC §1.1 in spirit. `DimensionScore.firsthandSupport` added and gated in `isSufficient`; social excluded from `contributors`/`ceilingFor`; social filed under its own `other:social_mention` dimension instead of hijacking `plan.dimensions[0]`. `ENABLE_BLUESKY` default left unchanged. SPEC §8 updated.
- 2026-10-03: Confirm/Changed P1 implemented as structured comments ("Can confirm — still true…") so they feed summarize_post / ranking without a new table. Reciprocal query priority left unimplemented.

## Session 16 orchestration log (2026-10-04 ~07:10, Paul napping ~1 h; goal: demo-ready product, Sonnet does the work, Opus orchestrates sparingly)
SpacetimeAuth client `client_034a2MZhz5kQgykZquPJIl` set in git-ignored `apps/web/.env` (`VITE_SPACETIMEAUTH_CLIENT_ID`). Redirect URIs verified accepted by SpacetimeAuth: `http://localhost:5173/callback`, `http://127.0.0.1:5173/callback`, ngrok `/callback` (a bogus URI is rejected). Plain `pnpm dev` now shows real sign-in plus "Use demo session". Magic link is SpacetimeAuth's built-in method (the Identity Providers page lists only social providers, all left disabled).

| Lane | Work | Branch | Isolation | Status |
|---|---|---|---|---|
| W3 | Simulated neighbors: bot residents that answer prompts so a solo presenter can demo | `feat/demo-neighbors` | own DB `proxiprompt-bots`, orchestrator :8085 | dispatched |
| W4 | Submission kit: DEMO.md, DEVPOST.md, Agentverse README, root README | `docs/submission-kit` | docs only | **merged** (`f89b9c7`) |
| W1 | Hands-on demo polish via browser (SPEC §14, auth screen, watch, posts) | `fix/demo-polish` | `proxiprompt-test`, ports 8081/5174 | waiting for the auth e2e run to free the ports |

Events:
- Browser e2e started with the client ID set (checks the tests survive the new sign-in screen); running long, result pending.
- W4 merged `90f2efb`+`f89b9c7`: `DEMO.md` (3-min + 60-s scripts, checklist, solo mode, failure playbook), `DEVPOST.md` (all sections + per-track evidence; placeholders left for ASI:One chat link and video), Agentverse-facing `services/agent/README.md`, root `README.md` with mermaid architecture. Orchestrator verified counts in code (22 tables, 45 reducers, 25 views + 2 anonymous views = 27), 0 dashes, filled repo URL.

## Work log addendum: MainCloud (2026-10-04, session 15, after Paul's `spacetime login`)
- Published to MainCloud: live DB **`proxiprompt-mhacks`** (dashboard https://spacetimedb.com/proxiprompt-mhacks) and test DB `proxiprompt-mhacks-test`. New names, not `proxiprompt`, because worker tokens are stored per DB name in `spacetimedb/.local/worker-token-<db>`; reusing the local name would mix local and cloud tokens.
- Service role on `proxiprompt-mhacks` claimed immediately after publish by our worker identity `c2005377d9d4...` (token in git-ignored `spacetimedb/.local/worker-token-proxiprompt-mhacks`). Do not delete that file: the claim is first-come and the DB is public.
- Guardrails against MainCloud test DB: **72/72** (`STDB_SERVER=maincloud STDB_URI=wss://maincloud.spacetimedb.com STDB_DB=proxiprompt-mhacks-test pnpm --filter @proxiprompt/spacetimedb exec tsx scripts/guardrails.ts`). First run was 69/72 because three checks shelled out with a hard-coded `--server local`; guardrails now read `STDB_SERVER` (default `local`). Smoke test on MainCloud: row delivered through subscription. Orchestrator connected to `proxiprompt-mhacks` as the claimed worker and subscribed to `svc_*` (then stopped; the team's dev stack still defaults to local).
- **Switch:** `STDB_TARGET=maincloud pnpm dev` publishes to `proxiprompt-mhacks` on MainCloud, skips local SpacetimeDB, and points orchestrator + web at it. The web app now connects directly to a configured remote `VITE_SPACETIMEDB_URI` from every host (ngrok/phones included) instead of the local `/v1` proxy.
- Security review (first-claimer-wins on a public DB): `dev.sh` maincloud mode now refuses any MainCloud DB without our worker token, so it only ever updates an already-claimed database. Creating a new MainCloud DB is a deliberate step: publish, then immediately claim with the worker identity (the session-15 claim script connects with `spacetimedb/scripts/lib.ts` `connect()` and calls `claimServiceRole`). Robust follow-up (not done): gate `claim_service_role` to the module owner recorded in an `init` reducer, then grant the worker via an owner-only reducer.
- First MainCloud run (Paul): browser showed "Failed to verify token" forever. Cause: the PWA kept one saved dev token (`pp.token`) for every database, and MainCloud rejects a token issued by the local server. Fix in `apps/web/src/spacetime.tsx`: token key is per database (`pp.token` for local `proxiprompt` so existing local/ngrok users keep their identity, `pp.token:<db>` otherwise), and a rejected saved token is dropped and the connection retried as a fresh session. Typecheck clean; browser e2e re-run blocked by the next item.
- Same run: the agent from `dev.sh` crashed with "address already in use" on :8001 because the orchestrator's session-15 agent was still running. Old agent killed and replaced with one on current code.
- **Blocker (local only):** `spacetime login` replaced the CLI identity (now `c20076e2...`, the MainCloud login). Local databases `proxiprompt` and `proxiprompt-test` were created by the previous local CLI identity, which is gone from `~/.config/spacetime/cli.toml`, so publish/reset on them now fails with 403. This breaks `pnpm e2e:browser` and plain local `pnpm dev`. MainCloud mode is unaffected. Fix needs Paul's OK because it deletes local data: stop local SpacetimeDB, delete its data directory, restart, republish both local DBs (new owner), delete `spacetimedb/.local/worker-token-proxiprompt` and `-proxiprompt-test` so the worker re-claims.
- Blocker resolved (reversibly, after Paul hit it in `pnpm dev`): moved the old local data to `~/.local/share/spacetime/data-backup-20261004-pre-login` and the two stale local worker tokens to `spacetimedb/.local/backup-pre-login/` (nothing deleted), restarted local SpacetimeDB, republished `proxiprompt` and `proxiprompt-test` under the new CLI identity. Old local questions/profiles are not in the new local DB (team re-onboards locally; MainCloud is the primary DB now). Verified: `pnpm e2e:browser` 4/4 (also confirms the per-database token change). Orchestrator left no processes running; `pnpm dev` owns ports again.
- Not yet done: run the full demo on MainCloud with the team (`STDB_TARGET=maincloud pnpm dev`); browser e2e still targets local `proxiprompt-test` by design.

## Session 15 orchestration log (2026-10-04, Opus orchestrating, Sonnet implementing)
Goal (Paul): take the 4 open items; Sonnet subagents implement, Opus orchestrates and verifies; keep this log current. Workers never edit PROGRESS.md (except L3's assigned section); the orchestrator records every dispatch, verification and merge here.

| Lane | Item | Branch / worktree | Isolation | Status |
|---|---|---|---|---|
| L1 | e2e suite isolation: canonical then watch flake on shared `proxiprompt-test` | `fix/e2e-isolation` / `../ProxiPrompt-lanes/fix-e2e-isolation` | sole owner of `proxiprompt-test`, ports 8081/5174 | **merged** (`31b6578`) |
| L2 | shared bridge token on `/asi/query` (safe hosted deploy) | `feat/asi-bridge-token` / `../ProxiPrompt-lanes/feat-asi-bridge-token` | orchestrator `asi.ts` + agent `bridge.py`; no DB | **merged** (`f33071a`) |
| L3 | PROGRESS "Known issues" cleanup (stale lines) | `docs/known-issues` / `../ProxiPrompt-lanes/docs-known-issues` | only the Known issues section | **merged** (`0e372f9`) |
| L4 | reciprocal priority (P1): people who answer get answered first | `feat/reciprocal-priority` / `../ProxiPrompt-lanes/feat-reciprocal-priority` | own DB `proxiprompt-test-recip`; no browser e2e (orchestrator runs it after merge) | **merged** (`3e325d9`); browser e2e passed on main |

Infra started by orchestrator: `spacetime start` on :3000, shared agent on :8001 (LLM on). No live orchestrator/Vite on 8080/5173.

Events:
- 2026-10-04: base `106acec` (after `git pull` of Syn's UI commits). Worktrees created; local tokens copied to L1/L4.
- L1-L4 dispatched in parallel to Sonnet workers.
- L3 done `0e372f9`: Known issues rewritten (e2e path corrected, stale VAPID line replaced with the real gap: iPhone push untested, ASI:One status line removed, env-file and human-only bullets added, reciprocal marked in progress). Orchestrator verified: diff touches only that section, 0 dashes, e2e guard claim matches `services/orchestrator/scripts/e2e.ts`. Merged to main.
- L2 reported `c7bc659`: `ORCH_BRIDGE_TOKEN` gates both `/asi/query` routes (constant-time compare, 401), fails closed with 503 on a non-loopback `ORCH_HOST` with no token; `bridge.py` sends the Bearer header. Orchestrator re-ran in the lane: orchestrator 55/55, agent 148/148, typecheck clean, 0 dashes. Sent back for one fix: orchestrator did not trim the token while the agent does (trailing space in a .env would 401 every chat).
- L2 fix `4781aa4` (test, failed first) + `f33071a` (trim). Orchestrator re-verified: orchestrator 56/56, agent 148/148, typecheck clean. Merged to main; orchestrator suite 56/56 on main after merge.
- L4 reported `3e325d9`: `reciprocityCredit` (core) = real answers in last 24 h, passes excluded, cap 5; planning queries served by credit desc then created; first wave = `FIRST_WAVE + credit` (capped), later waves unchanged; one private `boost` timeline event when credit > 0; `RECIPROCAL_PRIORITY` config key + env off-switch; SPEC §7 subsection + §13. No schema change. Orchestrator review: DB accepts any 1-40 char event kind so `boost` is valid at runtime; core 131/131, orchestrator 51/51, both typechecks clean, 0 dashes. Merged; on main after L2+L4: core 131, orchestrator 63, tsc clean. Browser e2e of the merged result runs after L1 lands (L1 owns the e2e ports).
- L1 reported `31b6578`: two separate failures. (a) Syn's UI update added a "Your location" region, so `getByLabel("Location")` matched two elements and broke canonical + watch; fixed with `{ exact: true }`. (b) Isolation: canonical leaves two fresh seating reports at Shapiro; `watchReading` uses the modal firsthand report, so the watch spec's single report was outvoted (intended product behaviour, so a test-isolation fix). New `e2e/fixtures.ts` auto-fixture calls the test orchestrator's `POST /dev/wipe` before every test; all specs import from it; `e2e-browser.sh` exports `E2E_ORCH_URL`. Worker ran full suite twice: 4/4. Orchestrator review: diff scoped to e2e files + one script line, 0 dashes, test orchestrator already has `ENABLE_DEV_WIPE=1`. Merged as `36c56b3`.
- **Final verification on main (all 4 lanes merged):** `pnpm e2e:browser` 4/4 passed twice (59.1 s, 57.4 s: canonical demo, mobile layout, signed-out welcome, watch). Core 131/131, orchestrator 63/63, agent 148/148, web typecheck clean. Reciprocal priority exercised by the canonical run (responders earn credit; the second asker's flow still reuses evidence). No module change this session, so guardrails (72) not re-run.
- Session 15 complete: all 4 items merged and verified; worktrees removed.

## Work log
- 2026-10-04 session 14: **Prompt expiry and cleanup are scheduled in the database.** `prompt_expiry_schedule` sets `prompt_batch.expired` when the card's clock hits, with no worker running (guardrails). `gc_schedule` repeats every 10 minutes and deletes observations that expired more than 600s ago plus rate buckets older than 2 hours. A report that expired 10s ago is kept, so a late answer can still use it. Guardrails 72/72.
- 2026-10-04 session 13: **Re-verified the uncommitted session-12 work and fixed two watch bugs.** Guardrails 69/69 on `proxiprompt-test` (deadline fires with no orchestrator; a watch expires on the database clock; only the service can retire a watch). `pnpm e2e:browser` canonical demo passed. The watch spec failed: the watch was armed with option id `many_open` while the answers were stored as `many_seats` / "Many open seats", so it never said "Seats opened up". `watchReading` now treats a favorable label as a match. Re-ran `pnpm e2e:browser e2e/watch.spec.ts`: passed. A question that is not about open seats or quiet is ended with a reason instead of staying on "Setting up". Published to local `proxiprompt` without deleting data. Tests: core 125, orchestrator 44, agent 145.
- 2026-10-04 session 12: **Browser e2e of SPEC §14, twice, on `proxiprompt-test`.** `pnpm e2e:browser` starts an orchestrator on :8081 and Vite on :5174 (never the live DB). Four Chromium contexts: asker, two demo-located at Shapiro, one at Michigan Union, then a second asker. Nearby prompts, far does not, High + 2 reports, second ask shows "Reusing fresh evidence". Two fixes the run found: the LLM plan for "quiet study" omitted seats, so the follow-up had nothing to reuse (`merge_detected_dimensions`, and a neighbour presence control now drops a subjective slot before an objective one); the reuse line lived only on the timeline, which unmounts when the answer arrives, so the answer screen now shows it when `cacheHit` is set. Job deadlines are a SpacetimeDB schedule (`job_deadline_reached`, private reducer). With no fresh evidence the database writes insufficient on its own (guardrails 67, no orchestrator). With evidence it sets `deadline_passed` and the worker synthesizes. ASI:One chat that is still working after 45s keeps polling and sends the answer as a follow-up (agent tests 145). **Watch a place:** "Notify me when" asks once and keeps a `watch` for up to 3 hours. `watch_expired` is scheduled in the database (guardrails: expires with no orchestrator; only the owner can cancel). The worker notifies when a firsthand report matches, matching survey labels rather than a fixed ordinal, and does not repeat the same value. Browser check `e2e/watch.spec.ts` passed. Guardrails 68.
- 2026-10-04 session 11: **Agentverse live.** Agent has a permanent `AGENT_SEED` and `AGENT_MAILBOX=1` (both in git-ignored `services/agent/.env`); address `agent1q2n246t50502rk048qful37rqmf3sv9yna6z9gsdlynr3lqrcmzhj7p3ncs`, mailbox connected via the inspector, publicly searchable on Agentverse (status active, AgentChatProtocol). Verified from ASI:One chat: messages became queries #37/#38. Handle `@proxiprompt` is taken by the team's ASI:One personal AI (unrelated persona); agent handle is `proxipromptagent` but not yet registered. Fixed: ASI:One's leading "@agent1q…" mention was saved into the question text; `bridge.handle_chat_text` now strips leading mentions. Agent tests 143.
- 2026-10-04 session 10 (security review of the dev wipe): `/dev/wipe` was reachable by anyone with the ngrok URL (Vite proxied it), from the LAN (server binds 0.0.0.0), and by any website via a simple cross-site POST (CORS `*`). Now `isLocalDevRequest` requires a loopback socket, no `Forwarded`/`X-Forwarded-*` headers (ngrok adds them; Vite's proxy does not since `xfwd` is off), the `X-ProxiPrompt-Dev: 1` header (not allowed by the CORS preflight), and a localhost or absent Origin. The button only renders on localhost. Verified live: ngrok-like, headerless, foreign-origin and LAN requests all get 403. Orchestrator tests 39.
- 2026-10-04 session 9: **"Wipe activity (dev)" button** on the You tab (Vite dev builds only, two taps). Path: web `POST /dev/wipe` -> Vite proxy -> orchestrator (only when `ENABLE_DEV_WIPE=1`, set by `scripts/dev.sh`) -> service-only reducer `worker_dev_wipe`, which empties queries, events, jobs, batches, recipients, responses, observations, posts, comments, impact, reports and rate buckets. Keeps profiles, devices, locations, places and the service role; also resets the orchestrator's in-memory loop caches. Also: VAPID keys generated into git-ignored `services/orchestrator/.env` + `apps/web/.env` (push now enabled). Tests: guardrails 65, orchestrator 34.
- 2026-10-03 session 8 (Paul: pings slow, Shiyuan never got one, coords ugly):
  1. **Test users took the real team's slots.** 61 throwaway `_mut` users from e2e/probe runs still had fresh (6h demo window) locations claimed at Duderstadt; 3 of the 5 recipients for query 33 were test users, so Shiyuan was never picked. Deleted their `user_location` rows from local `proxiprompt`; `scripts/e2e.ts` now refuses the live DB unless `STDB_DB=proxiprompt-test` (or `E2E_ALLOW_LIVE_DB=1`).
  2. **Waves too small and slow.** `FIRST_WAVE` 2 -> 10, `MAX_RECIPIENTS` / `MAX_RECIPIENTS_PER_JOB` 5 -> 20 (Paul's call). Guardrail cap check updated (63/63).
  3. **Coordinates removed** from the You-tab location label (`describeLocation` names places only).
  - Still true: no push devices registered (VAPID unset), so phones only see prompts while the app is open.
- 2026-10-03 session 7 (Paul's screenshot: responder card for "Is there anyone named shiyuen at the dude rn?"):
  1. **Person-locating question went out to responders.** The keyword guard only caught capitalised names. New `_RE_PERSON_NAMED` refuses "anyone/someone/a guy/the girl ... named/called". 7 new refusal/non-refusal cases.
  2. **Presence radio group read as a pointless question.** Routing already picks nearby people; the control only exists where GPS cannot separate neighbours (Duderstadt/Pierpont, floors). `AnswerForm` now renders it as a ghost "I'm not at {place}" skip button that submits `not_here`; the data sent is unchanged.
  3. **Freeform prompt repeated the place** ("At Duderstadt Center: ..." under a "Duderstadt Center" header). Prefix dropped.
  - Agent restarted with new code and probed live. ASI:One still off (`llm_configured:false`), so slang like "rn" is not rewritten until `ASI_ONE_API_KEY` is set.
  - Tests: agent 141, orchestrator 30, web typecheck clean.
- 2026-10-03 session 6 (security review of `293dd9f`, 3 findings; 2 reproduced and fixed, the third arrived without detail):
  1. **Keyword guard bypass via normalization.** `check_refusal` ran on raw text only, so "is ｍｙ ｅｘ there", zero-width splits, or "my https://a.example ex" passed, then normalized into "Is my ex there?" for responders. New `planner.guard_input` checks raw + normalized + V1, used by `plan`, `plan_heuristic`, and review rewrites.
  2. **ReDoS in N6.** The nested-quantifier filler regex hung on "lmk, " x 1000, and `PlanRequest.text` was unbounded. Filler now stripped one word per pass; input capped (model `max_length=1000`, normalization reads at most 1000). Worst case measured < 5 ms.
  - Tests: agent 134 (13 new, all failing before the fix).
- 2026-10-03 session 5 (post-push security review of `37fd1e8`, 2 findings, both fixed):
  1. **Freeform prompts quoted raw asker text.** Paul's call: quoting the asker is allowed, but only after input handling. New `services/agent/src/proxiprompt_agent/question_input.py` normalizes (N1-N8: NFKC + invisible chars, whitespace, punctuation runs, elongation, un-shout, filler, contact details stripped, capitalization + 200-char cap) and validates (V1: 3+ letters). With `ASI_ONE_API_KEY` set, `planner.review_question` asks ASI:One for `ok | rewrite | refuse` before planning; a rewrite is re-normalized and re-guarded, and a failed review falls back to the deterministic checks. Spec in SPEC §9.1. 40 new tests in `tests/test_question_input.py`.
  2. **ASI:One relay had no rate limit.** The service identity skipped the 10/h query cap entirely. It now has its own `SERVICE_QUERY_RATE_LIMIT_PER_HOUR = 60` (`spacetimedb/src/lib.ts`). New guardrail check confirmed failing on the old module (61 accepted), passing after publish.
  - Published to both local `proxiprompt` and `proxiprompt-test`. Tests: agent 121, orchestrator 30, guardrails 63/63.
- 2026-10-03 session 4 (Paul's screenshot: "what is the answer right now?" and broken spacing). My "no new bugs" call in session 3 was wrong — I never tested a question that matches no keyword in the vocabulary:
  1. **Freeform questions produced placeholder copy.** `detect_dimensions` fell back to the literal key `other:answer`, so the responder card read "Quick question about Duderstadt Center: what is the answer right now?" and the answer read "reports say answer is Yes." Freeform questions now get a key derived from the question itself (`other:ask_<hash>`), which also stops two unrelated freeform questions at one place from sharing an evidence job (`findAttachableJob` compares dimension sets). The survey question becomes "At {place}: {the asker's question}" — it names nobody and does not imply the asker is nearby, so SPEC §3 still holds — and synthesis phrases freeform results as "Yes — according to 1 report from {place}" instead of "answer is Yes". A test asserts the hashed key never reaches copy a human reads.
  2. **Answers mixed in evidence from other questions.** `synthesizeQuery` passed *every* live observation at the place to the agent, not just the planned dimensions — the screenshot's "reports say answer is Yes and Yes" was two unrelated questions' answers concatenated, and it disagreed with the "1 report" counter beside it. Now filtered to the question's own dimensions, which also fixes which contributors get impact credit.
  3. **The presence control repeated the place name** directly under a heading that already said it ("...Duderstadt Center" / "Are you at Duderstadt Center?"). Now "Are you there right now?" with the place on the pass option.
  4. **QueryDetail layout**: "Details" and "Ask something else" were adjacent inline text buttons with no separation, rendering as "DetailsAsk something else". Wrapped in a flex `.footer-actions` row; the answer's `supporting` and `caveats` (already generated and previously only visible inside the Details JSON blob) now render as readable lists.
  - Verified live end to end with a freeform question: card reads "At Duderstadt Center: Is the blue umbrella still in lost and found?", answer reads "Yes — according to 1 report from Duderstadt Center."
  - Tests: core 121, orchestrator 30, agent 81.
- 2026-10-03 session 3 (bug hunt to a clean pass, so the team can test and iterate). 9 more defects, found by probing paths nothing had exercised:
  1. **The whole ASI:One chat path 500'd on every question** — `/asi/query` submits with the *worker's* identity, which has no `user_profile`, so `submit_query`'s `requireProfile` rejected it ("Create a profile first"). That is the entire Fetch.ai sponsor demo (SPEC §9, §14 step 8). `submit_query` now exempts the service identity from the profile requirement and from the 10/h per-account limit, which otherwise would have made every Agentverse question share one user's budget. Verified end to end through `bridge.py`.
  2. **`ORCHESTRATOR_URL` was never exported by `scripts/dev.sh`**, so the agent's Chat Protocol silently fell back to `plan_only_reply` — it would describe what it *would* do instead of returning real evidence. Exported now.
  3. **SPEC §7 step 9 (late answers) was never implemented.** `LATE_ACCEPT_S` existed in config and was unit-tested but used nowhere. In demo mode the job deadline is 30 s while prompts stay open 600 s, so a friend answering at 35 s produced an observation the asker never saw — they sat on "Not enough fresh evidence" while the answer was in the database. Added `updateLateAnswers`: re-scores finished queries for `LATE_ACCEPT_S` past the deadline and rewrites the answer when the evidence materially changes, keyed on an evidence signature so each change fires exactly one "Updated answer". `QUERY_TRANSITIONS` gained `insufficient -> answered`. Verified live: closed insufficient at 30 s, answered late, upgraded to High/Medium with "Updated answer" in the timeline.
  4. **Push notifications could not deep-link.** Payload URLs were paths (`/respond/123`) but the PWA routes on `location.hash`, so a tap opened the app at Home with an empty hash — breaking SPEC §15's "tap deep-links to the right response sheet". Now `/#/respond/123` etc., with a test asserting the shape.
  5. **Expired prompt cards never went away.** `PromptPing` and the Questions list filtered only on `responded`, so a batch past its 600 s expiry sat on screen and could only fail on Send. Added `isAnswerable`; `Respond` now says which it is (already answered / expired) instead of showing a form that cannot work.
  6. **Live Pulse ranking was missing two of its four terms.** `verifiedNearby` was hardcoded `false` because `pulse_posts` never exposed it — SPEC §10 weights it 0.15. Added `verified_nearby` to the view (derived from the post's observations, place-level only). `recentSubstantiveComments` was using the raw comment count, so "ok" and "lol" scored the same as a real update; now the same >12-char filter the freshness note uses.
  7. **A query could be `answered` with zero supporting evidence.** The status test was `obs.length === 0`, but `obs` is every live observation at the place, including other dimensions and anonymous social posts. Now gates on `score.contributors === 0` — firsthand sources on the required dimensions only (SPEC §1.1).
  8. **A job kept interrupting people after its queries were cancelled.** `advanceCollectingJobs` only looked at live queries, so an orphaned job prompted new waves until its deadline. Now expires a job with no live query (with an age guard so a not-yet-visible attach is not killed).
  9. **Timeline copy**: "Asking 1 **people**", "N recent update**s**" for one, "N report**s**" for one, and "No one nearby is available" printed directly under "Asking 1 person" — it means no one *new*, and now says so.
  - Also wired four reducers that existed, were guardrail-tested, and had no way in from the UI: `report_content`, `delete_post`, `delete_comment` (SPEC §12 P0 "report content, delete own content") and `cancel_query`, so a stalled question is not a dead end. `deactivate_device` and `admin_hide` remain module-only by choice.
  - Guarded a clarification with no options, which would otherwise strand a query in `clarifying` forever.
  - Probed clean with no new findings: Live Pulse post/comment/summary/freshness/reactions/impact (9 checks), moderation + cancel (10 checks), the claim and adjacent-building routing, the ASI bridge, and a production `vite build`.
  - Tests: core 121, orchestrator 29, agent 79, guardrails 62, smoke OK, e2e 3/3 scenarios. Every behavioural fix was re-broken in place to confirm its test fails without it.
- 2026-10-03 session 2 (Paul's field report: Questions tab, question "erased" on back-out, wrong-building prompts):
  - **Recent Questions is now a top-level tab.** Nothing was ever deleted: `my_queries` keeps every query, but `/activity` was reachable only through one button buried on the You screen, so leaving a question made it vanish from view. Added a fourth tab (Ask / Questions / Posts / You), took `activity` out of the `pushed` set so it no longer renders a Back button, removed the now-redundant You-screen button, and rebuilt the screen to show plain-English status, place, age, answer headline, and confidence + report count. `.tabbar` was hardcoded to `repeat(3, 1fr)` and would have clipped the new tab; now 4. "New question" relabelled "Ask something else" with "This stays in Questions." underneath.
  - **Wrong-building prompts (the Duderstadt/Pierpont report).** Diagnosed from the live DB, not guesswork: all three friends were on real GPS reading 80-83 m from the Duderstadt pin and 59-78 m from Pierpont, which sits **78 m** away (Shapiro/Hatcher are 71 m apart). With `responder_radius_m` 150 the circle covers both buildings, and `DEMO_MATCH_M`'s 60 m tightening only applies to `source:"demo"`, so GPS users got the full 150. Phone GPS cannot resolve 78 m, so this is ranked and made declinable rather than hard-excluded:
    - `Candidate.atTargetBuilding` (new) orders candidates: whoever reads as inside the target is asked before whoever reads as next door. `undefined` stays neutral. Computed in `loop.ts:atTargetBuilding` from the new `nearestCatalogPlace`.
    - Every prompt about a place with a catalog neighbour inside `AMBIGUOUS_NEIGHBOR_M` (120 m) now carries an "Are you at {place}? / I'm not there" control. The not-here plumbing already existed (`ingestResponses` discards the response, `passResponseIds` expands the wave) but was only wired when the question named a floor, line, or area — "vending machine @ the dude" matched nothing, so the Pierpont friend had no way to decline and his answer would have counted as evidence about Duderstadt.
    - **Latent bug fixed in passing:** the presence control was prepended to up to 3 survey controls, and `worker_create_prompt_batch` rejects anything outside 1-3 **atomically** — so any question naming a floor plus 3 dimensions silently lost its entire wave. Controls are now capped at `MAX_PROMPT_CONTROLS`, the presence control costing one dimension slot.
  - **"Another friend didn't get it" is not a bug:** `FIRST_WAVE` is 2, so of three eligible people exactly two are asked (shiyuan lost by 1 metre at 83 m vs 82 m). The timeline already says "Asking 2 people near X". Later waves expand by 2 up to `MAX_RECIPIENTS` 5.
  - **Claimed building is now server-side and authoritative** (Paul chose this, accepting the data wipe). The "I'm in Duderstadt" claim had been `localStorage`-only (`pp.placeClaim`) and never reached the server, so routing could not use it. Added `user_location.claimed_place_id` (optional) + an optional `claimed_place_id` arg on `update_location` that rejects an unknown place id and treats an empty value as "clear". `selectResponders` excludes a claim on another building (`wrong_building`) and promotes a claim on the target; `isVerifiedNearby` honours it for posts too. Picking a demo building now counts as a claim, the You screen offers the building choice whenever the nearest place has a neighbour within 120 m (not only on a near-tie), and the web app drops a claim once you move 80 m from where you made it. `update_location`'s new arg is **optional** so existing callers (guardrails, smoke, e2e) keep working — a required arg crashed the SDK serializer with `Cannot read properties of undefined (reading 'length')`. SPEC §4 and §7 step 5 updated. Bindings regenerated; `publish:local:clear` + `publish:test:clear` run, so **everyone re-onboards** (username + demo location).
  - **Follow-up after Paul clarified the report** ("two people were asked, but one of them was at Pierpont" — the wave size was never the complaint): added the signal that was being recorded and never used. `user_location.accuracy_m` now reaches routing as `Candidate.accuracyM`, alongside `nearestOtherBuildingM` (distance to the closest catalog building that is not the target). `selectResponders` excludes someone as `wrong_building` when another building is nearer than the target by more than `max(accuracyM, GPS_CONFIDENCE_FLOOR_M = 20)` — so a fix squarely inside Pierpont is never asked about Duderstadt. Replaced the earlier boolean `atTargetBuilding` input with these two numbers; ranking now derives from them.
    - **Honest limit, documented in a test** (`routing.test.ts` "geometry alone cannot separate these three"): for Paul's measured readings the gaps were 21 m, 5 m and 17 m between buildings 78 m apart. Only jerry's 21 m clears the floor, and jerry was the one actually *inside* Duderstadt — so pure geometry is close to a coin flip here and the code does not pretend otherwise. The claim is the reliable fix; the "Are you at {place}?" control is the safety net. The floor was deliberately left at 20 m rather than tuned down to make this scenario look solved.
  - **`collecting -> collecting` fixed at the root.** The earlier tolerance only covered one call site; the second (`processPlanningQueries`) failed a whole query under subscription lag. `QUERY_TRANSITIONS` now allows the two no-op self-transitions (`collecting`, `synthesizing`), consistent with `answered -> answered` and `JOB_TRANSITIONS`' existing `collecting -> collecting`.
  - **Wave size stays at 2** (Paul's call): SPEC §1's "interrupt the fewest people who can actually see it" is the pitch, and waves expand by 2 up to 5 automatically.
  - Tests: core 108 -> 121, orchestrator 17 -> 23, guardrails 61 -> 62. Each new behavioural test was verified to fail against the pre-fix code. Live e2e now proves three scenarios: the vertical slice, cache reuse, and "a claim on Pierpont is never prompted about Duderstadt".
- 2026-10-03 correctness pass, Phase 1 (8 fixes landed, all typechecks clean):
  1. **Report count lied** — `loop.ts:synthesizeQuery` counted distinct contributors over *every* live observation at the place (any dimension, plus posts, social, and `anon:<id>` rows unique by construction) while the confidence ceiling came from `scoreEvidence`'s own restricted count. Now uses `score.contributors`; `updatedAtMs` likewise restricted to required, non-social dimensions.
  2. **Wrong question + silently rolled-back waves** — batch question and push body came from `attached[0].text`, and `requesterId` excluded only the *first* attached requester, so a later requester could be selected for their own question; `worker_create_prompt_batch` rejects that atomically, so the whole wave vanished with no event and no log. Now `survey.question`, and `SelectInput.requesterId` -> `requesterIds: string[]` in `packages/core/src/routing.ts` covering every attached requester.
  3. **Question looked unsaved** — `App.tsx:Home.ask` read `myQueries` immediately after awaiting `submitQuery`, before the view update arrived, so the asker was dropped on `/activity`. Added `waitForQueryId` (polls to a 3s cap).
  4. **Job creation not idempotent** — `clientKey` embedded `Date.now()`, defeating `worker_create_job`'s `client_key` dedup; a crash or mid-sequence throw made a second job at the same place. Now stable `job-${q.id}`.
  5. **Timeline flooded** — "Received k of N" was emitted every 2s tick with no dedup, denominator flipping between recipients asked and `plan.responder_count`. Now emitted once per distinct message (`lastReceivedEvent`), denominator always `recips.length`.
  6. **Bluesky could fabricate an answer** — see Decisions log.
  7. **Geo drift on verified-nearby** — both post paths hand-rolled `Math.hypot(dLat*111_000, dLng*85_000)` (85,000 m/deg is wrong at 42.27 deg; ~82,400) and hard-coded a 30-min location age, so 6h demo locations never earned verified-nearby. Replaced with the tested `haversineM` and `cfg.LOCATION_MAX_AGE_S` via one `isVerifiedNearby` helper; `cfg` threaded into `summarizePendingPosts`/`applyPostReactions`.
  8. **`client_key` too short** (found by the live e2e, missed by the first fake) — the bug-4 fix used `job-${q.id}`, but `worker_create_job` requires >= 8 characters, so every query with a single- or double-digit id failed outright with "client_key must be at least 8 characters". Now `job-query-${q.id}`. The fake now enforces the same minimum.
  9. **`collecting -> collecting` failed whole queries** (found by the same run) — `promptWave` re-reads `attached` before its own status write is visible through the subscription, sees `planning`, and nudges the status again; the reducer rejects that transition and the outer catch marked the query `failed`. Now re-reads the live row and tolerates losing the race. The fake can model subscription lag via `deferStatusWrites` / `flush()`.
  10. **No tests on the state machine** — fixed. `services/orchestrator/test/fake-conn.ts` mirrors the worker reducers' observable behaviour and their guardrails (autoinc ids, `client_key`/`dedup_key`/`resp_key` idempotency, recipient cap, requester exclusion, location freshness, transition validation); `loop.test.ts` carries one regression test per bug above plus two meta-tests that keep the fake honest (constants compared against `lib.ts` source, every table/reducer `loop.ts` touches must exist). Added `resetLoopState()` (the 9 module-level caches leaked between runs).
- 2026-10-03 implementer: scaffolded monorepo; `@proxiprompt/core` (92 tests); SpacetimeDB module + bindings + smoke + 61 guardrails; Python uAgent (78 tests) REST + Chat Protocol; orchestrator worker (plan/score/route/push/ASI HTTP/Bluesky); installable PWA (composer, Pulse, query timeline, responder sheet, activity, profile, demo GPS, diagnostics); e2e slice passed.

## Verification (2026-10-04 ~02:45 local)

```
pnpm --filter @proxiprompt/core test          # 125 passed
pnpm --filter @proxiprompt/orchestrator test  # 44 passed
cd services/agent && uv run pytest -q         # 145 passed
pnpm --filter @proxiprompt/spacetimedb guardrails
  72 checks passed, 0 failed
pnpm e2e:browser
  canonical demo passed (42.7s)
pnpm e2e:browser e2e/watch.spec.ts
  failed first (option id many_open vs stored many_seats), passed after the label match (24.6s)
```

## Verification (last observed 2026-10-03, after the correctness pass)

```
pnpm test
  packages/core          11 files, 121 passed   (104 before this work)
  services/orchestrator   3 files,  29 passed   (0 before this work; loop.test.ts is new)
pnpm typecheck
  core, spacetimedb, apps/web, services/orchestrator — all Done
cd services/agent && uv run pytest -q
  79 passed  (was 77; survey-question assertions updated + one new case)

# Needs local spacetime on :3000 and the agent on :8001:
spacetime publish --server local --module-path . proxiprompt-test -y && pnpm guardrails
  62 checks passed, 0 failed
ENABLE_BLUESKY=0 DEMO_MODE=1 AGENT_URL=http://127.0.0.1:8001 pnpm exec tsx scripts/e2e.ts
  E2E CLAIM OK { claimedElsewherePrompted: 0 }
  E2E OK       { status: 'answered', promptedNearby: 2, promptedFar: 0, hasAnswer: true }
  E2E CACHE OK { status: 'answered', cacheHit: true, sourceCount: 1, newPeopleInterrupted: 0,
                 timeline: [ 'Understanding your question', 'Found 3 recent updates',
                             'Reusing fresh evidence — no one interrupted', 'Answer ready' ] }
```

Each of the 9 behavioural fixes was re-broken in place and the suite re-run, confirming the
matching test fails without the fix (4 + 3 + 2 across three passes). Not a substitute for the
browser pass, which is still outstanding — see "Next actions".

## Verification (previous, 2026-10-03 pre-fix)

```
pnpm --filter @proxiprompt/core test
  Test Files  10 passed | Tests  92 passed

cd services/agent && uv run pytest -q
  78 passed

pnpm --filter @proxiprompt/orchestrator test
  Tests  3 passed (Bluesky parser)

pnpm --filter @proxiprompt/web typecheck && pnpm --filter @proxiprompt/web build
  tsc clean; vite built dist/ (453 kB JS)

# Needs local spacetime:
spacetime start --listen-addr 127.0.0.1:3000
pnpm --filter @proxiprompt/spacetimedb publish:local
pnpm --filter @proxiprompt/spacetimedb smoke
  SMOKE OK: row delivered through subscription

pnpm --filter @proxiprompt/spacetimedb publish:test
pnpm --filter @proxiprompt/spacetimedb guardrails
  62 checks passed, 0 failed

# Agent (heuristic):
uv run python -m proxiprompt_agent.agent   # :8001
curl /health -> llm_configured:false, address agent1qg4c2…
curl POST /plan (Shapiro quiet study) -> noise_level + seating_availability + worth_it, survey 1–3 controls
curl POST /synthesize empty evidence -> recommendation "insufficient"

# Vertical slice:
ENABLE_BLUESKY=0 DEMO_MODE=1 pnpm exec tsx services/orchestrator/scripts/e2e.ts
  E2E OK { status: 'answered', promptedNearby: 2, promptedFar: 0, hasAnswer: true }
```

## Known issues / blockers
- **Hosted deploy:** the agent binds 127.0.0.1 unless `AGENT_HOST` is set (needed only for `AGENT_ENDPOINT` inbound mode; mailbox mode is fine on loopback). The orchestrator binds 127.0.0.1 unless `ORCH_HOST` is set. Setting `ORCH_HOST=0.0.0.0` reopens `/asi/query` (submits as the service identity, no auth beyond the 60/h service cap); add a shared bridge token before exposing it.
- Spacetime `start` dies when the launching shell exits unless you keep that process (use a dedicated terminal).
- **One orchestrator per database.** `services/orchestrator/scripts/e2e.ts` drives `tick()` in-process, so running it while `pnpm dev`'s orchestrator is live makes the two workers race; the tells are "Invalid job transition done -> done" and "Recipient ... was already asked about this job". Stop the dev stack first, and run it with `STDB_DB=proxiprompt-test` (it refuses the live DB). SPEC §2 assumes a single worker.
- Physical iPhone Web Push is untested. VAPID keys exist and laptop push works; iOS (16.4+) needs Add to Home Screen from the HTTPS ngrok URL, then You tab > Enable notifications. e2e uses `https://push.example/...` dummy devices.
- `scripts/dev.sh` sources `services/agent/.env` and `services/orchestrator/.env`; only the VAPID lines belong in the orchestrator file (copying `.env.example` wholesale turns Bluesky on with an empty token).
- Agentverse handle `proxipromptagent`, a public ASI:One chat link, SpacetimeAuth and MainCloud login are still human-only (see Human-gated steps).
- First empty `claim_service_role` wins. After a `publish` that wipes data, delete `spacetimedb/.local/worker-token-*` or reuse that token.
- Google Places UI is catalog search only until the Maps key is set (no Maps JS wired; the You-tab mini map falls back to OpenStreetMap). The catalog covers the judged demo.
- Reciprocal priority P1: built session 15 (SPEC §7); browser e2e of it pending.

## Next actions (for the next human/agent)
Full specs are in `NEXT_STEPS.md`.

1. **SpacetimeAuth** needs a project and client ID in `VITE_SPACETIMEAUTH_CLIENT_ID`. The OIDC path in `apps/web/src/auth.tsx` is already implemented and falls back to labeled dev auth until that ID exists.
2. ~~MainCloud~~ done: `proxiprompt-mhacks` is live (guardrails 72/72). Run the team demo with `STDB_TARGET=maincloud pnpm dev`.
3. **Fetch.ai deliverables that need Paul:** register handle `proxipromptagent`, a public ASI:One chat link of a finished answer, demo video, Devpost. The late-answer follow-up chat message is implemented.
4. Later (Paul deferred): iPhone push; rehearse §14 with the team; hosted deploy (add a bridge token before `ORCH_HOST=0.0.0.0`).

## Sponsor tracks (assessment 2026-10-04)
### Fetch.ai ASI:One Agent Challenge: requirements met, deliverables outstanding
Rules (fetch.ai/events/m-hacks): agent registered on Agentverse, Chat Protocol, discoverable/usable through ASI:One, primary workflow completes without a custom frontend, ASI:One as reasoning engine, public repo. All met and verified. Outstanding: handle, shared chat URL, video.

### Best Use of SpacetimeDB: strong core, two visible gaps
Already strong (say this in the pitch):
- SpacetimeDB is the single authoritative state: tables, reducers, and views, with the safety rules in the reducers.
- All safety rules live in reducers, not the app: query/job state machine, one response per recipient, recipient cap (20), requester exclusion, location freshness, cooldowns, rate limits (incl. 60/h service relay), blocklist, admin hide, service-role authorization, dev wipe.
- Privacy by views: exact coordinates and responses are private tables; the public reads only views (`svc_*` for the worker, `my_*` per user, public Pulse/place views). Guardrails check that other users and the public cannot read private rows.
- Real-time everywhere: the PWA timeline, prompt pop-up and Pulse are live subscriptions; the orchestrator is itself a subscriber reacting to row changes.
- Clocks live in the database. A job deadline, a prompt expiry, and a 10-minute cleanup of old observations and rate buckets all run with no worker doing the work. 72 guardrail checks cover this (`pnpm --filter @proxiprompt/spacetimedb guardrails`).
Gaps, in order of judge impact:
1. **Auth is anonymous "dev auth".** `VITE_SPACETIMEAUTH_CLIENT_ID` unset, so SpacetimeAuth magic-link login is not in use. Needs a SpacetimeAuth project (human) then a short wiring check.
2. ~~Runs on local `spacetime start`, not MainCloud.~~ Done 2026-10-04: `proxiprompt-mhacks` on MainCloud, `STDB_TARGET=maincloud pnpm dev`.


## 2026-10-04 — Mobile UI overhaul

- Reworked the mobile visual system: system-font large titles, rounded grouped surfaces, muted provisional palette, safe-area-aware four-tab navigation, profile identity, and clearer post/empty states.
- Ask now has a decorative place illustration, selected destination, an expandable Change control, editable question starters, and a primary action visible above the tab bar at 390×844. Backend query/watch contracts remain intact.
- Added transform/opacity entrances, press feedback, sheet easing, touch-safe hover rules, and reduced-motion fades. Question cards are native buttons; place search uses a properly associated label and accessible suggestion buttons. Navigation resets scroll position.
- Updated DESIGN.md. Final palette remains a team decision.
- Validation: web typecheck + production build passed. Canonical browser demo passed (nearby responses and cached evidence). New mobile test passed (question starters, place changes, composer, navigation, primary-button positioning, 320/390/430/1024-width overflow checks, reduced motion, no page errors). Watch browser test passed on a fresh isolated database.
- Existing suite isolation issue: running canonical and watch sequentially against the same database left earlier evidence influencing the watch result; watch timed out in that combined run, then passed in isolation. No backend changes made for this UI task.
- Browser screenshots: test-results/mobile-home.png and test-results/mobile-posts.png (generated, ignored). Physical iPhone/Safari and Web Push were not tested.


## 2026-10-04 — Impeccable refinement

Applied Impeccable distill and polish guidance. The context engine could not initialize in its restricted cache directory, so PRODUCT.md and DESIGN.md supplied context directly. Removed the invented mark, decorative map, introductory eyebrows, and redundant reassurance copy. Product name remains plain text; the PWA icon is a text-only placeholder. All authored palette values are grayscale, including confidence badges with their explicit labels preserved. Increased small control text, standardized SVG action icons, and removed repeated screen entrance animations. Build and the mobile browser regression pass succeeded, including phone/desktop captures, question starters, place selection, navigation, overflow, reduced motion, and page-error checks.

## 2026-10-04 — Impeccable animate, delight, layout

- Applied the three requested playbooks directly; the mechanical layout detector remains unavailable because the local Impeccable engine is not installed and its cache directory is restricted.
- Added a sliding tab selection, persistent question-starter selection, disclosure feedback, and one restrained success checkmark with a polite status announcement. Reduced-motion alternatives preserve confirmation without spatial movement.
- Improved place-name wrapping with a two-column grid and made question starters wrap. Responder sheets now use consistent group spacing, actual completion counts, and sticky actions.
- Response submissions now show Sending and prevent repeated requests while pending; AnswerForm is keyed by prompt identity to prevent answers carrying into a subsequent prompt.
- Verification: web typecheck/production build passed; canonical real-time demo and mobile browser regression both passed (25.2s). Inspected phone and desktop captures. No physical-device frame-rate claim is made.

## 2026-10-04 — Impeccable detector enabled

With user authorization, installed Impeccable engine 0.1.11 through the bundled launcher's engine-probe. Both the layout-scoped detector and the broader detector completed successfully against apps/web/src/App.tsx and apps/web/src/styles.css, each returning [] (no findings). This closes the previously documented detector verification gap; it does not replace browser or physical-device testing.

## 2026-10-04 — Profile settings clarity

- Reorganized You into identity, location, notifications, developer tools, and account sections with short explanations and explicit actions. Replaced the floating “Dev on” toggle with a named demo-session control in Developer tools; the signed-out route exposes “Use demo session” only when OIDC is configured.
- Explained nearby matching and location privacy; distinguished the simulated mode from its selected place and labeled the map. Removed an unexpected notification-permission request from location selection; phone notifications now have their own explicit enable action.
- Clarified pause requests, diagnostics, and the scope of clearing shared activity. Build and Impeccable detector pass.


## 2026-10-04 — Composer and developer row follow-up

- Post composer now shows the selected place, names the attribution choice, explains anonymity/profile attribution, and says whether a place or update is needed before posting. The primary action is labeled “Post update.”
- Rebuilt developer settings rows with explicit flex layout and multiline descriptions to stop the diagnostic control and shared activity explanation from colliding.
- Build and layout detector pass.
