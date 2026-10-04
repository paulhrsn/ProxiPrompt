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
| 8. Worker recovery | Continuous retry, one processing timer, readiness only after authorization + subscriptions | Pending. |
| 9. Gone push endpoints | Deactivate 404/410 endpoints on every outbound notification path | Implemented common sender used by prompts, answers, impact and watches; expired prompt-device regression passes. |
| 10. Service bootstrap | Owner-gated first claim and safe provisioning of worker token/role on new or reset DB; preserve existing deployment | Pending. |
| 11. ASI durable polling | Issued query tracking IDs recover from stored queries after worker restart | Pending. |
| 12. Demo truthfulness | Explain ASI chat queries are service-owned and demonstrate their result in chat | Pending `DEMO.md` correction. |
| 13. Planning deadlines | Bound sequential agent review/planning and align worker HTTP budget/fallback policy | Pending. |
| 14. Insufficient notifications | Database deadline closures and empty-evidence outcomes notify requester; persist delivery state across restarts | Pending durable notification queue. Empty-evidence worker deadline now uses synthesis; database-scheduled closure still needs queue. |

## Verification checkpoint

- Orchestrator: 90 tests passed.
- Local database: 74 guardrails passed, including new presence/privacy and answer-payload checks; deletion guardrail now checks evidence invalidation and impact removal.
- Chromium: 10 tests passed, including nearby/far routing, cache reuse, conflicts, source details, mobile screens, posts, refusal, watches, repeated connection failures, global demo-location refresh, and push logout cleanup.
- Workspace typechecks and web production build passed.
- The latest historical cleanup change has worker + database coverage; rerun the complete browser suite after remaining fixes.
- All module writes in this checkpoint targeted `proxiprompt-test`; live databases were not published.

## Remaining acceptance evidence

After all implementations: rerun core, worker, agent, database guardrails, and browser suites; rehearse on MainCloud test; non-destructively roll out and derive live readiness; commit/push main as instructed in `NEXT_STEPS.md`. Real email login → ask → sign out → sign in identity/history restoration remains unverified. Physical installed iPhone push is explicitly deferred. Human submission assets and Agentverse registration remain outside the bug-fix implementation scope.
