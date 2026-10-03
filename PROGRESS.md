# ProxiPrompt — Progress & Handoff Ledger

Read `SPEC.md` first (the contract). This file is the operational state. **Every agent updates this file after every substantive batch.** Never write secret values here — only env var names.

## How to resume (cold start)
1. Read `SPEC.md`, then this file top to bottom.
2. Check "Current objective" and "Next actions".
3. Run the verification commands in "Verification" to confirm the stated state is still true before building on it.

## Current objective
Milestone 1 — prove integrations (SpacetimeDB subscription, Fetch agent call, Web Push) and scaffold the monorepo.

## Status by plan to-do
| to-do | status | notes |
|---|---|---|
| write-contract | done | `SPEC.md` written; this ledger initialized |
| prove-integrations | in progress | |
| build-vertical-slice | pending | |
| implement-intelligence | pending | |
| build-pulse | pending | |
| harden-demo | pending | |
| add-stretches | pending | |

## Environment / toolchain (verified 2026-10-03)
- node v24.9.0, npm 11.13.0, pnpm 11.5.2, Python 3.14.0, uv 0.11.19.
- SpacetimeDB CLI 2.10.2 installed at `~/.local/bin/spacetime` (add `~/.local/bin` to PATH).
- No Vercel / Railway CLI installed.
- Git remote: `git@github.com:paulhrsn/ProxiPrompt.ai.git`, branch `main`.

## Env vars (names only)
| name | used by | status |
|---|---|---|
| `VITE_SPACETIMEDB_URI`, `VITE_SPACETIMEDB_DB` | web | local defaults |
| `VITE_SPACETIMEAUTH_CLIENT_ID` | web | **needs human**: create SpacetimeAuth project, enable magic link, add redirect URIs |
| `VITE_GOOGLE_MAPS_API_KEY` | web | **needs human**: billing-enabled GCP project, Places API (New) + Maps JS, referrer restriction, budget alert |
| `VITE_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | web / orchestrator | generate locally (`npx web-push generate-vapid-keys`) |
| `SPACETIMEDB_URI`, `SPACETIMEDB_DB`, `SPACETIMEDB_TOKEN` | orchestrator | token from worker identity |
| `AGENT_URL` | orchestrator | local `http://127.0.0.1:8001` |
| `ASI_ONE_API_KEY` | agent | **needs human**: asi1.ai dashboard |
| `AGENT_SEED`, `AGENTVERSE_API_KEY` | agent | **needs human** for Agentverse registration |
| `DEMO_MODE` | orchestrator, web | `1` for judged demo timings |

## Human-gated steps (cannot be done by an agent)
- Create SpacetimeAuth project + client ID.
- Google Cloud billing + Maps key.
- ASI:One API key; Agentverse account, registration, Evaluate Registration.
- `spacetime login` for MainCloud publish.
- Vercel + Railway accounts/deploys.
- Install PWA on physical iPhones (iOS ≥16.4, Add to Home Screen), grant notifications.
- Fetch.ai submission via the ASI Submission Agent; Devpost.

## Decisions log
- 2026-10-03: Contract written from planning session. Key decisions: PWA (not native), real geolocation pipeline with labeled demo-coordinate injection, SpacetimeDB authoritative + small TS orchestrator worker (SpacetimeDB has no official Python client; reducers can't do network I/O; procedures are beta), Python Fetch uAgent with ASI:One LLM, Google Places + curated fallback, magic-link auth, anonymous-by-default attribution, prompt answers private, Live Pulse as evidence stream with utility ranking, Bluesky as P1.

## Work log
(append newest at top: date/time, agent, what changed, files, verification evidence)

## Verification
(commands that prove current state, with last observed result)

## Known issues / blockers

## Next actions
1. Scaffold pnpm monorepo + `packages/core` contracts and scoring (TDD).
2. SpacetimeDB module schema + reducers; local `spacetime start` + publish; React subscription proof.
3. Python uAgent with `/plan` `/synthesize` `/summarize_post` (heuristic + ASI:One), Chat Protocol.
4. Web Push proof: VAPID keys, service worker, worker send.
