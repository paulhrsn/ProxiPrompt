# @proxiprompt/spacetimedb

Authoritative state machine + guardrails (SpacetimeDB 2.10.2, TypeScript module). Entry: `src/index.ts`.

```
src/schema.ts   tables (all private except `place`)
src/lib.ts      constants (LOCATION_MAX_AGE_S=21600, MAX_RECIPIENTS_PER_JOB=5, rate limits), transition tables, helpers
src/client.ts   client reducers
src/worker.ts   worker-only reducers (sender must be in service_role)
src/views.ts    my_* (per sender), pulse_* (public, no identities), svc_* (worker, all rows)
bindings/       generated TS client (do not edit): `pnpm generate`
scripts/        smoke.ts (subscription proof), guardrails.ts (61 re-runnable checks)
```

## Commands (spacetime CLI on PATH: `export PATH="$HOME/.local/bin:$PATH"`)

```
spacetime start                          # local server, http/ws on 127.0.0.1:3000 (blocks)
pnpm --filter @proxiprompt/spacetimedb publish:local        # publish db `proxiprompt` (add :clear to wipe data)
pnpm --filter @proxiprompt/spacetimedb generate             # regenerate bindings/
pnpm --filter @proxiprompt/spacetimedb smoke                # subscription proof against `proxiprompt`
pnpm --filter @proxiprompt/spacetimedb publish:test         # db `proxiprompt-test` (guardrails run here, so
pnpm --filter @proxiprompt/spacetimedb guardrails           #   they never consume the real service-role claim)
```

Connect from TS: `DbConnection.builder().withUri('ws://127.0.0.1:3000').withDatabaseName('proxiprompt')` where
`DbConnection` comes from `spacetimedb/bindings` (`import { DbConnection } from '../bindings/index.js'`).
Client rows/reducer args are camelCase (`createdAt`, `conn.reducers.submitQuery({ clientRequestId, placeId, text })`);
tables/columns in SQL are snake_case.

## Worker deploy step

1. Worker connects once with a persistent token (store it!) and calls `claim_service_role()`. Only works while
   `service_role` is empty. More identities: `add_service_identity(identity)` from an existing service identity.
2. Worker subscribes to the `svc_*` views (`SELECT * FROM svc_query`, …). They return ALL rows of the underlying
   private table iff the connection's identity is in `service_role`, otherwise zero rows.
   (Alternative: the database owner's token can also subscribe to private tables directly — not used.)

## Contracts the other components rely on

- **Job creation**: `worker_create_job(client_key, …)` — `client_key` is UNIQUE and stored on the row; find the new
  row in `svc_evidence_job` by `clientKey`. Same key twice = no-op (restart safe).
- **Responses → observations**: `submit_response` only stores the response. The WORKER reads `svc_prompt_response`
  and calls `worker_add_observation` (dedup key `source_type:source_id:dimension` makes retries idempotent).
- `controls_json` = JSON array (1–3) of `{dimension_key,label,options:[{value,label,ordinal}]}` (an object with a
  `controls` array is also accepted and normalised). `answers_json` = `{"<dimension_key>":"<option value>"}`.
- `worker_create_prompt_batch` is atomic and enforces: ≤5 recipients per job in total, no duplicate recipient per job,
  location captured ≤ 21600 s ago, recipient has a profile, notifications not paused, recipient is not the requester of
  any query attached to the job (and `worker_attach_query` rejects attaching a query whose requester is already a
  recipient). Any violation throws and rolls the whole batch back.
- `worker_mark_notified(recipient_id)` stamps `prompt_recipient.notified_at` after a push is sent.
- `worker_set_admin(identity, is_admin)` is the only way to grant `is_admin`.
- Query transitions: planning→clarifying|collecting|synthesizing|refused|failed|cancelled; clarifying→planning|cancelled;
  collecting→synthesizing|answered|insufficient|failed|cancelled; synthesizing→answered|insufficient|failed;
  answered→answered. Job: collecting→synthesizing|done|expired, synthesizing→done|expired.
- Deleted/hidden posts and comments are blanked (text/summary/claims cleared) and flagged `deleted`/`hidden`; the worker
  should invalidate observations derived from them (`svc_post`/`svc_comment` show the flags).
