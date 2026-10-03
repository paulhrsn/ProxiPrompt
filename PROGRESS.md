# ProxiPrompt — Progress & Handoff Ledger

Read `SPEC.md` first (the contract). This file is the operational state. **Every agent updates this file after every substantive batch.** Never write secret values here — only env var names.

## How to resume (cold start)
1. Read `SPEC.md`, then this file top to bottom.
2. Check "Current objective" and "Next actions".
3. Run the verification commands in "Verification" to confirm the stated state is still true before building on it.

## Current objective
Judged-demo polish and human-gated sponsor registration (Agentverse, VAPID on phones, optional ASI:One key). The P0 product loop is implemented and verified locally.

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
| `ENABLE_BLUESKY` | orchestrator | default on; set `0` in tests |

## Human-gated steps (cannot be done by an agent)
- SpacetimeAuth project + magic-link client ID (optional; demo works without).
- Google Cloud billing + Maps key (optional).
- `npx web-push generate-vapid-keys` and install PWA on iPhones (iOS ≥16.4, Add to Home Screen).
- ASI:One API key; Agentverse account, mailbox, Evaluate Registration, handle `@proxiprompt`.
- `spacetime login` + MainCloud publish; Vercel + Railway deploys.
- Fetch.ai ASI Submission Agent + Devpost.

## Decisions log
- 2026-10-03: Contract as in SPEC.md.
- 2026-10-03: Confirm/Changed P1 implemented as structured comments ("Can confirm — still true…") so they feed summarize_post / ranking without a new table. Reciprocal query priority left unimplemented.

## Work log
- 2026-10-03 implementer: scaffolded monorepo; `@proxiprompt/core` (92 tests); SpacetimeDB module + bindings + smoke + 61 guardrails; Python uAgent (78 tests) REST + Chat Protocol; orchestrator worker (plan/score/route/push/ASI HTTP/Bluesky); installable PWA (composer, Pulse, query timeline, responder sheet, activity, profile, demo GPS, diagnostics); e2e slice passed.

## Verification (last observed 2026-10-03)

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
  61 checks passed, 0 failed

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
- Physical iOS Web Push is unwired until VAPID keys exist; e2e used `https://push.example/…` dummy devices so routing still required `register_device`.
- ASI:One LLM path untested live (`ASI_ONE_API_KEY` unset). Chat Protocol is implemented; Agentverse registration is not.
- First empty `claim_service_role` wins. After a `publish` that wipes data, delete `spacetimedb/.local/worker-token-*` or reuse that token.
- Google Places UI is catalog search only until the Maps key is set (no Maps JS wired yet — catalog covers the judged demo).
- Reciprocal priority P1 experiment not built.

## Next actions (for the next human/agent)
1. Dedicated terminal: `spacetime start`, then `publish:local`, agent, orchestrator, `apps/web` `pnpm dev`.
2. Generate VAPID keys; put public key in `apps/web/.env` and both in orchestrator env; Add to Home Screen on team iPhones; enable notifications on You tab; set demo locations (Jerry/Shiyuan Shapiro, Chinmay Union).
3. Optional: `ASI_ONE_API_KEY`, Agentverse mailbox registration, evaluate, set handle; point `ORCHESTRATOR_URL` at the public orchestrator.
4. Rehearse the SPEC §14 Shapiro script.
5. Deploy (Vercel / Railway / MainCloud) when ready to leave localhost.
