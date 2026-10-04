# Correctness audit fixes

Scope: all confirmed findings and additional code-review findings in the 2026-10-04 audit of `73dcf1c`. The original audit report is preserved in `/private/tmp/proxiprompt-audit.md`. This ledger tracks implementation and verification; it does not claim a completed live rollout.

| Item | Required outcome | Current evidence / remaining work |
|---|---|---|
| 1. Requester anonymity | No responder identities in stored or historical requester-visible scoring breakdowns | Implemented storage sanitization and `my_queries` sanitization; worker regression and real database guardrail pass. Cloud migration verification pending. |
| 2. Shared evidence jobs | Each attached question uses its own requirements; the job collects their union | Implemented plan union and per-query scoring/synthesis; regression passes, including no seating answer from noise-only evidence. |
| 3. Removed contributions | Deleting/hiding posts and comments invalidates derived evidence and removes related impact | Implemented transactional removal and worker repair for historical removals. Worker regression and real database deletion/impact guardrail pass. |
| 4. Browser recovery | Retry until recovered, preserve identity, cancel when signed out/unmounted, recover on network/foreground resume | Implemented backoff and stale callback cancellation. Browser recovery passes after two failed reconnect attempts, with the same username and token. |
| 5. Late evidence | Refresh materially changed modal values/conflicts/missing evidence, compare stored answer after restart, commit signature after successful write | Implemented material signatures and stored-answer comparison; same-contributor modal-change regression passes. Further restart/removal coverage pending. |
| 6. Global location / presence | GPS and simulated locations refresh throughout the app; foreground reachability separate from location age | Implemented signed-in provider and per-connection private heartbeat; browser refresh regression and connection/privacy/disconnect guardrail pass. Simulated neighbor and vertical rehearsal helpers send heartbeat. |
| 7. Push ownership | Remove old endpoint on logout/account switch; register permitted subscription for new account | Implemented browser unsubscribe + server deactivation before switch, endpoint retry tracking, permitted restoration. Browser logout guardrail passes. Account-switch regression pending. |
| 8. Worker recovery | Continuous retry, one processing timer, readiness only after authorization + subscriptions | Implemented a single retry supervisor and serialized processing; repeated startup failures, authorization readiness and stale callback regressions pass. An isolated TCP proxy rehearsal confirmed readiness becomes false during outage and recovers after multiple failed reconnects. |
| 9. Gone push endpoints | Deactivate 404/410 endpoints on every outbound notification path | Implemented common sender used by prompts, answers, impact and watches; expired prompt-device regression passes. |
| 10. Service bootstrap | Owner-gated first claim and safe provisioning of worker token/role on new or reset DB; preserve existing deployment | Implemented owner-gated provisioning, verified first-claim rejection on a fresh DB and preservation of an authorized worker. Owner-authorized SQL migration handles legacy DBs where init does not rerun; reproduced and fixed missing owner/role on the existing local proxiprompt without resetting data. |
| 11. ASI durable polling | Issued query tracking IDs recover from stored queries after worker restart | Implemented UUID tracking IDs and service-owned durable query lookup. New server-instance regression and an actual worker process restart recovered the same persisted query tracking ID. |
| 12. Demo truthfulness | Explain ASI chat queries are service-owned and demonstrate their result in chat | Corrected DEMO.md and startup instructions, including separate browser profiles for two real email accounts. |
| 13. Planning deadlines | Bound sequential agent review/planning and align worker HTTP budget/fallback policy | Implemented 20-second total LLM budget including JSON repair, 45-second total planning budget with heuristic fallback, and 50-second worker planning request. Agent health checks actual worker readiness. Regressions pass. |
| 14. Insufficient notifications | Database deadline closures and empty-evidence outcomes notify requester; persist delivery state across restarts | Implemented private durable queue, atomic database deadline enqueue, receipts, retries and restart consumption. Worker regression and real DB scheduling/receipt/privacy guardrails pass. Physical push remains deferred. |

## Verification checkpoint

- Core: 138 tests passed. Orchestrator: 97 tests passed. Agent: 190 tests passed.
- Local database: 74 guardrails passed, including new presence/privacy and answer-payload checks; deletion guardrail now checks evidence invalidation and impact removal.
- Chromium: 10 tests passed, including nearby/far routing, cache reuse, conflicts, source details, mobile screens, posts, refusal, watches, repeated connection failures, global demo-location refresh, and push logout cleanup.
- Workspace typechecks and web production build passed.
- The latest historical cleanup change has worker + database coverage; rerun the complete browser suite after remaining fixes.
- The second batch was published non-destructively to the local `proxiprompt` when fixing startup. Worker and agent health both report connected, with ASI configured. MainCloud remains unmodified by this batch.
- Demo timing now gives the first wave 30 seconds and collection 60 seconds total; a worker regression verifies 0/29/30/59/60-second boundaries. Sufficient evidence can finish earlier and late responses can update the result.
- Full Chromium suite passed 10/10 on an isolated rerun after the second batch. A concurrent guardrail run had cleared browser test activity; those runs must be sequential when using the same DB.
- User's Pierpont reproduction exposed immediate presence deletion on tab/window hiding. Keep the last heartbeat for the existing two-minute routing grace period without renewing it in the background; logout/disconnect still removes presence. Browser regression reproduces the old failure, and the canonical routing test now backgrounds one responder before the question.
- The focused canonical/recovery browser run passes 4/4 with the visibility fix, including routing to the background responder, retained presence without background renewal, reconnect, and push logout. Workspace typechecks pass after the fix.

## Remaining acceptance evidence

After all implementations: rerun core, worker, agent, database guardrails, and browser suites; rehearse on MainCloud test; non-destructively roll out and derive live readiness; commit/push main as instructed in `NEXT_STEPS.md`. Real email login → ask → sign out → sign in identity/history restoration remains unverified. Physical installed iPhone push is explicitly deferred. Human submission assets and Agentverse registration remain outside the bug-fix implementation scope.
