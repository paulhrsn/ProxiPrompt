# Orchestrator

The worker that subscribes to SpacetimeDB, calls the agent, routes prompts to nearby people and writes answers. See `SPEC.md` section 2 and `NEXT_STEPS.md` section 0 for how it fits in.

## Simulated neighbors

`scripts/demo-neighbors.ts` runs a handful of bot users so one presenter can run the whole demo alone and a question never ends with "No one nearby is available".

Each bot is an ordinary user (public client reducers only, never the worker identity). It onboards with a clearly simulated username (`maya_sim`, `dev_sim`, ...), registers a placeholder push device so routing treats it as reachable, claims a catalog place with a demo location (and refreshes it every 4 minutes so it stays fresh), then answers every prompt it receives after a random 3 to 12 second delay. Answers follow plausible time-of-day priors (quiet libraries late, busy dining at meal times), sometimes include a short note, and rarely pass with "I'm not at X". The answer logic is a pure function in `src/neighbors.ts` (tests in `test/neighbors.test.ts`).

Default spread for `--count 8`: three at Shapiro, two at Duderstadt, one each at Michigan Union, CCRB and East Quad Dining.

```
# local stack (database name defaults to proxiprompt)
pnpm demo:neighbors -- --db proxiprompt --count 8 --seed-posts

# MainCloud, solo demo
pnpm demo:neighbors -- --uri wss://maincloud.spacetimedb.com --db proxiprompt-mhacks --count 8 --seed-posts
```

Flags: `--uri` (default `ws://127.0.0.1:3000`, or `STDB_URI`), `--db` (default `proxiprompt`, or `STDB_DB`), `--count` (default 8, max 40), `--seed-posts` (create up to 4 Live Pulse posts at different places; a bot that posted in the last hour is skipped), `--min-delay` / `--max-delay` (answer delay in seconds, default 3 and 12). Set `NEIGHBOR_DEBUG=1` to log each scheduled answer delay.

Notes:
- Tokens are saved in `spacetimedb/.local/neighbor-tokens-<db>.json` (git-ignored), so restarting reuses the same accounts. Delete the file for fresh bots.
- The orchestrator for that database must be running; the bots only answer prompts the orchestrator sends them.
- The bots count as real nearby people, so do not run them against a database where real users are being demoed unless that is the point. Stop with Ctrl+C.
- Bots answer from their claimed place, so the prompt's place must be one they sit at. Their own answers feed the same evidence cache, so a repeat question may be answered from cache with no prompt ("Reusing fresh evidence").
