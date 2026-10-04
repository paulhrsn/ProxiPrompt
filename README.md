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

Asker and responder are two tabs of the same app, not two programs. From the repo root:

```bash
pnpm install
pnpm dev
```

That starts SpacetimeDB (:3000), the Fetch agent (:8001), the orchestrator (:8080), and the web app (:5173). Then open:

- Asker: http://localhost:5173/
- Responder: http://127.0.0.1:5173/

Those two hosts do not share a login. Sign in with the email magic link, or press **Dev** in the corner to use a browser-only session. On the responder tab, open your name and set the demo location to the place being asked about. The question pops up on that tab. Stop everything with `pnpm stop` (ports 3000, 8001, 8080, and 5173), or Ctrl+C in the `pnpm dev` terminal.

Magic link needs a SpacetimeAuth client id in `apps/web/.env` as `VITE_SPACETIMEAUTH_CLIENT_ID`. Register both redirect URIs: `http://localhost:5173/callback` and `http://127.0.0.1:5173/callback`. Your name page can change the username and sign out. The session stays signed in across refreshes. Anonymous profiles from before this login do not carry over.

Optional: `npx web-push generate-vapid-keys`, put the public key in `apps/web/.env` as `VITE_VAPID_PUBLIC_KEY` and both keys in the orchestrator env. On iPhone: Safari → Share → Add to Home Screen, then enable notifications in the You tab.

Demo location override lives on the You tab. Only GPS acquisition is spoofed; distance, eligibility, and push use the production pipeline.

## Tests

```bash
pnpm --filter @proxiprompt/core test
pnpm --filter @proxiprompt/orchestrator test
cd services/agent && uv run pytest
pnpm --filter @proxiprompt/spacetimedb smoke          # needs local server + publish
```
