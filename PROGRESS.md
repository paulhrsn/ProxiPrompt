# ProxiPrompt — Progress & Handoff Ledger

Read `SPEC.md` first (the contract). This file is the operational state. **Every agent updates this file after every substantive batch.** Never write secret values here — only env var names.

## How to resume (cold start)
1. Read `SPEC.md`, then this file top to bottom.
2. Check "Current objective" and "Next actions".
3. Run the verification commands in "Verification" to confirm the stated state is still true before building on it.

## Current objective
**Correctness pass on the orchestrator — complete; ready for the team to test and iterate.** 19 defects found and fixed across three passes (8 from a code recon, 2 from the live e2e, 9 from probing unexercised paths). The last hunting pass over Live Pulse, moderation, cancel, the ASI bridge, push deep-links and the late-answer window turned up nothing new.

Previously:
**Correctness pass on the orchestrator.** A recon on 2026-10-03 found 8 real defects, 6 of them in `services/orchestrator/src/loop.ts` (690 lines, the whole query state machine, previously untested); the live e2e run then surfaced 2 more (10 total). Symptoms: prompts sent with the wrong question to the wrong people, report count disagreeing with confidence, submitted questions appearing not to save, timeline flooding with contradictory counts. All 10 fixes are landed and Phase 2 is done: `tick()` now has a fake-`DbConnection` integration harness with one regression test per bug (17 orchestrator tests). Every test was verified to FAIL against the pre-fix code before being accepted. Remaining work is the browser pass and the human-gated sponsor items below.

## Status by plan to-do
| to-do | status | notes |
|---|---|---|
| write-contract | done | `SPEC.md` + this ledger |
| prove-integrations | done | Spacetime subscription smoke OK; agent `/plan` `/synthesize` `/health` live; Web Push wired (VAPID keys still human) |
| build-vertical-slice | done | `services/orchestrator/scripts/e2e.ts` — 2 nearby prompted, far excluded, answer written |
| implement-intelligence | done | Places catalog, GPS/demo adapter, plan/score/route/cache/dedup/async deadlines |
| build-pulse | done | Posts, comments, AI summaries, utility ranking, attribution, impact receipts |
| harden-demo | done | Guardrails in module (61 checks), onboarding, permission copy, diagnostics, fallback catalog |
| add-stretches | done | Bluesky provider (ENABLE_BLUESKY), diagnostics drawer, confirm/changed as structured comments. Reciprocal priority **not** built (optional P1 experiment) |

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
| `VITE_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | web / orchestrator | **needs human** (`npx web-push generate-vapid-keys`) |
| `SPACETIMEDB_URI`, `SPACETIMEDB_DB`, `SPACETIMEDB_TOKEN` | orchestrator | token auto-saved to `spacetimedb/.local/worker-token-<db>` |
| `AGENT_URL` | orchestrator | `http://127.0.0.1:8001` |
| `ASI_ONE_API_KEY` | agent | **needs human** — heuristic planner is verified; `planner:"heuristic"` when unset |
| `AGENT_SEED`, `AGENTVERSE_API_KEY`, `AGENT_MAILBOX` | agent | **needs human** for Agentverse |
| `ORCHESTRATOR_URL` | agent chat bridge | `http://127.0.0.1:8080` |
| `DEMO_MODE` | orchestrator | `1` for judged timings |
| `ENABLE_BLUESKY` | orchestrator | default on; `scripts/dev.sh` sets `0` |
| `SKIP_PORT80` | scripts/dev.sh | set `1` to skip the sudo :80 forwarder (ngrok/phones only) |

## Human-gated steps (cannot be done by an agent)
- SpacetimeAuth project + magic-link client ID (optional; demo works without).
- Google Cloud billing + Maps key (optional).
- `npx web-push generate-vapid-keys` and install PWA on iPhones (iOS ≥16.4, Add to Home Screen).
- ASI:One API key; Agentverse account, mailbox, Evaluate Registration, handle `@proxiprompt`.
- `spacetime login` + MainCloud publish; Vercel + Railway deploys.
- Fetch.ai ASI Submission Agent + Devpost.

## Decisions log
- 2026-10-03: Contract as in SPEC.md.
- 2026-10-03 (correctness pass): **Prompt wording is always the plan's generated `survey.question`, never the requester's raw text.** One evidence job can serve several queries (Jaccard >= 0.5 attach, SPEC §7 step 3), so the first asker's words were reaching responders for someone else's question; quoting the asker also conflicts with SPEC §3 ("push prompts never identify the requester"). Removed the two raw-text overrides in `planner.py:_assemble_plan`. SPEC §9 updated.
- 2026-10-03 (correctness pass): **Social (Bluesky) evidence can inform a score but never satisfy sufficiency, and never counts as a nearby report.** Three scraped posts previously reached support 0.72 with ceiling 0.95 and answered a query with nobody asked, violating SPEC §1.1 in spirit. `DimensionScore.firsthandSupport` added and gated in `isSufficient`; social excluded from `contributors`/`ceilingFor`; social filed under its own `other:social_mention` dimension instead of hijacking `plan.dimensions[0]`. `ENABLE_BLUESKY` default left unchanged. SPEC §8 updated.
- 2026-10-03: Confirm/Changed P1 implemented as structured comments ("Can confirm — still true…") so they feed summarize_post / ranking without a new table. Reciprocal query priority left unimplemented.

## Work log
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
- Spacetime `start` dies when the launching shell exits unless you keep that process (use a dedicated terminal).
- **One orchestrator per database.** `scripts/e2e.ts` drives `tick()` in-process, so running it while `pnpm dev`'s orchestrator is live makes the two workers race; the tells are "Invalid job transition done -> done" and "Recipient … was already asked about this job". Stop the dev stack before running e2e. SPEC §2 assumes a single worker; concurrent workers are not a supported configuration.
- Physical iOS Web Push is unwired until VAPID keys exist; e2e used `https://push.example/…` dummy devices so routing still required `register_device`.
- ASI:One LLM path verified live 2026-10-03 (plan + §9.1 review: slang rewritten, ad refused). `scripts/dev.sh` now sources `services/agent/.env` and `services/orchestrator/.env`; before that nothing loaded them. Chat Protocol is implemented; Agentverse registration is not.
- First empty `claim_service_role` wins. After a `publish` that wipes data, delete `spacetimedb/.local/worker-token-*` or reuse that token.
- Google Places UI is catalog search only until the Maps key is set (no Maps JS wired yet — catalog covers the judged demo).
- Reciprocal priority P1 experiment not built.

## Next actions (for the next human/agent)
0. **Browser pass on the correctness fixes** (~10 min, not yet done): `pnpm dev`, ask about Shapiro from the asker tab and confirm it lands on `/q/<id>` rather than `/activity`; confirm the responder's card shows the neutral generated question; answer it and confirm exactly one "Received 1 of 2" line plus a report count that matches the confidence level; ask a second, differently-worded Shapiro question from a third session and confirm nobody is re-prompted.
1. Dedicated terminal: `spacetime start`, then `publish:local`, agent, orchestrator, `apps/web` `pnpm dev`.
2. Generate VAPID keys; put public key in `apps/web/.env` and both in orchestrator env; Add to Home Screen on team iPhones; enable notifications on You tab; set demo locations (Jerry/Shiyuan Shapiro, Chinmay Union).
3. Optional: `ASI_ONE_API_KEY`, Agentverse mailbox registration, evaluate, set handle; point `ORCHESTRATOR_URL` at the public orchestrator.
4. Rehearse the SPEC §14 Shapiro script.
5. Deploy (Vercel / Railway / MainCloud) when ready to leave localhost.
