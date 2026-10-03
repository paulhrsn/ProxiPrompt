# ProxiPrompt

Ask about a place. An agent decides what evidence it needs, checks recent updates, and only then pings the fewest useful nearby people. Answers come back with confidence and provenance.

MHacks ’26 · Actually Intelligent · Fetch.ai ASI:One · SpacetimeDB

Read [`SPEC.md`](SPEC.md) (the contract) and [`PROGRESS.md`](PROGRESS.md) (handoff ledger) before changing anything.

## Repo

```
apps/web                 installable PWA
packages/core            scoring, routing, contracts (pure TS)
spacetimedb              authoritative state machine
services/orchestrator    subscription worker + Web Push + ASI HTTP
services/agent           Fetch.ai uAgent (plan / synthesize / Chat Protocol)
```

## Local demo

```bash
export PATH="$HOME/.local/bin:$PATH"
pnpm install

# 1. SpacetimeDB
spacetime start                                 # terminal A, :3000
pnpm --filter @proxiprompt/spacetimedb publish:local
pnpm --filter @proxiprompt/spacetimedb generate

# 2. Agent
cd services/agent && uv sync && uv run python -m proxiprompt_agent.agent   # :8001

# 3. Orchestrator (claims service role on first connect)
cd services/orchestrator && pnpm exec tsx src/index.ts                     # :8080

# 4. PWA
cd apps/web && pnpm dev                                                    # :5173
```

Optional: `npx web-push generate-vapid-keys`, put the public key in `apps/web/.env` as `VITE_VAPID_PUBLIC_KEY` and both keys in the orchestrator env. On iPhone: Safari → Share → Add to Home Screen, then enable notifications in the You tab.

Demo location override lives on the You tab. Only GPS acquisition is spoofed; distance, eligibility, and push use the production pipeline.

## Tests

```bash
pnpm --filter @proxiprompt/core test
pnpm --filter @proxiprompt/orchestrator test
cd services/agent && uv run pytest
pnpm --filter @proxiprompt/spacetimedb smoke          # needs local server + publish
```
