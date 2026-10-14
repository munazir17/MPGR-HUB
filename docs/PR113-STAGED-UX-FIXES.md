# PR #113 — staged Chat, authorization and compatibility fixes

Date: 2026-10-15 (Asia/Calcutta). Implementation baseline: `2dffa7a`.
Source verification head: `119c6e6`. Branch: `arena/b8c82200-mpgr-hub`.

## Changes and independently verifiable commits

| Stage | Commit | Result |
| --- | --- | --- |
| 1 | `b141483` | Keep API quote floors as canonical atomic strings with explicit decimals. Format once, exactly, at the existing human-unit signing seam; reject precision truncation. Test AAPLc 8, WETH 18, USDC 6, zero decimals, large integers and one atomic unit. |
| 2 | `0fc7e80` | Goal POST always reserves a non-runnable DRAFT. Explicit activate/resume PATCH requires execution readiness, emergency-switch approval, live policy/goal and persisted valid permission for this exact goal before CAS transition. Chat retries retain policy/goal and reconcile saved slots. |
| 3 | `af2d4dc` | Full quote review inside Chat, rather than redirecting to manual authoring: pair, spend, trigger, expected/minimum output, slippage, fees, provider, quote timestamps/expiry and risks. Exact input binding, existing confirmation validation and fresh-quote checks precede explicit authorization. Read-only quote reads do not depend on the autonomous production gate; authorization still does. |
| 4 | `b99edea` | Add canonical, already-executor-registered WETH to existing DEX reference coverage. Preserve native ETH identity and explain an explicitly requested WETH alternative. Exclude announced-not-live assets from autonomous choices, policy resolution and goal activation; reject them before stock quote preparation. No executor allowlist expansion. |
| 5 | `746ff69` | Compact Manual/Autonomy launcher after the Chat surface/dock, before page branding. Reuse existing proposal cards, confirmation handler, autonomy controller and panel. Keep the goal panel mounted across launcher close/switch; preserve edited forms. |
| Lifecycle follow-up | `119c6e6` | Used nonce indexes stay used even after consumption/revocation. Same-goal saved permission can recover activation without another signature or minimum-output re-entry. Fail closed at index exhaustion. Retry key is independent of input property order and refreshed quote floors. |

Manual means **existing immediate proposal/confirmation**, not manual autonomy goal authoring. The repository has no standalone Manual spot-entry form; none was invented. Prepare an immediate swap using existing Chat/tape handlers, then review the same proposal from Manual. Opening/closing the launcher never signs, quotes or activates anything.

## Lifecycle and failure behavior

1. Explicit confirmation reserves the policy and DRAFT goal ID needed by the existing goal-bound witness.
2. A wallet rejection or registration failure cannot make that draft ACTIVE.
3. Retry uses the same mounted controller reservation. A lost goal POST response is reconciled through goal listing; uncertain slot registration is reconciled through persisted-slot listing.
4. A live slot for another goal never covers this one. Activation rechecks policy hash, owner, chain, exact pair/amount, goal action binding, expiry, consumption and revocation against persisted records.
5. ACTIVE is shown as awaiting trigger, **not settled**. The unchanged runtime still obtains a new quote and enforces the signed floor at execution. Verified settlement is not claimed before receipt verification.
6. One slot permits one execution, not a recurring schedule. Existing five nonce indexes cannot be recycled by revocation. More executions require valid additional goal-bound permission within the existing protocol limits.

This is a staged DRAFT/registration/activation protocol, not a new atomic database transaction spanning all writes. The provisional goal must exist before witness signing. Client retry reservations are not durable across a full page reload or shared across tabs: recover an existing DRAFT from Autonomy after reload rather than re-submitting its prompt as a new goal. Global deduplication of independently initiated goals is not claimed. An uncertain activation response is not treated as success; reload/reconcile the saved goal.

## Capability verification — separate layers, not a tradeability claim

| Layer | Evidence / limit |
| --- | --- |
| Chain and identity | Base 8453, existing registry addresses. Native ETH is not WETH. No contract address is chosen by the model. |
| Advertised conditional targets | WETH plus live delegated B20 targets: AAPLc, AMZNc, GOOGLc, METAc, MSFTc, MSTRc, NVDAc, SNDKc, SPCXc, TSLAc. COINc, CRCLc, INTCc are registered but announced-not-live and are refused. Other catalog stocks are not added to the delegated allowlist. |
| Reference | Existing Chainlink equity / validated Base DEX observations; WETH uses existing DEX reference handling. Missing/stale/wrong-chain/wrong-address prices fail closed. New WETH recovery and deterministic anchoring tests use offline fixtures, not live price evidence. |
| Decimals | Delegated metadata: USDC 6, WETH 18, B20 8. Normal B20 quote preparation retains on-chain decimal verification; Chat rejects metadata inconsistent with its registry. Exact atomic/human round trips are tested without floats. |
| Quote and provider | Existing crypto routing and B20 Aerodrome Slipstream paths retained. API-shaped tests bind pair, amount, precision, slippage, provider, freshness/expiry, balance/readiness and risk review. No live quote/liquidity claim. |
| Route | Existing executor USDC routes reused, with live-target filtering. Parsing, a registry entry or reference price alone does not establish an executable route or current liquidity. |
| Approvals / authorization | Existing wallet authentication, approvals, Permit2 and goal witness semantics unchanged. Tests use mocks or offline synthetic test-key signatures; no real wallet permission was requested. |
| Fee | Existing executor 25 bps in-swap fee math and collection unchanged. Review displays quote fee details and says when gas/protocol costs were not quoted. No alternate fee transfer. |
| Settlement | Not exercised live. Existing execution/receipt-verification regressions pass offline; no actual transaction, settlement or recurring execution acceptance is claimed. |

## Verification

Environment: Node `v22.22.3`, npm `10.9.8` (repository engine permits Node >=20.11).

- Stage 1 focused tests: **79 passed / 4 files** before Stage 2 began.
- Stage 2 focused lifecycle/security run: **58 passed / 4 files**, then **37 passed / 2 files** after cross-goal/CAS cases were added.
- Stage 3 focused review/flow tests: **90 passed / 3 files**.
- Stage 4 focused compatibility/reference/security tests: **187 passed / 12 files**.
- Stage 5 launcher/panel/Chat/immediate-confirmation tests: **66 passed / 4 files** before lifecycle follow-up.
- Final lifecycle/panel focused tests: **28 passed / 2 files**.
- TypeScript: **PASS**.
- ESLint: **0 errors, 59 warnings**; no lint rules disabled or configuration changed.
- Raw final `npm run check`: **3,550 assertions passed, 24 skipped**, **280 test files passed, 5 skipped**; **not a clean test-run pass**, because unchanged AgentKit analytics emitted **two unhandled ECONNRESET rejections** to `cca-lite.coinbase.com` from `agentkit/__tests__/invoke.test.ts`.
- Explicit offline repeat: **PASS**, same **3,550 passed / 24 skipped**, **280 files passed / 5 skipped**, no unhandled errors. Only AgentKit's analytics sender was replaced with a local no-op using a Node preload outside the repository. No execution, pricing, risk, authorization, signature validation or test assertions were suppressed. This is qualified offline evidence, not a claim that the raw network-dependent run was clean.
- Skipped suites: real-Redis daily spend; live delegated execution; mainnet canary; phase-5 preflight; phase-6 fork rehearsal. No live workflow was dispatched to run them.
- `git diff --check`: PASS.
- `npm run build`: **BLOCKED** by sandbox network restrictions fetching Inter from `fonts.googleapis.com` through the unchanged `app/layout.tsx` font setup. No font, proxy, build or dependency configuration was changed to hide the failure.

Local logs outside Git: `/home/user/PR113-staged-final-check.log`, `/home/user/PR113-staged-offline-check.log`, `/home/user/PR113-staged-build.log`. Offline preload: `/home/user/pr113-offline-agentkit-telemetry.cjs`; it replaces only `@coinbase/agentkit/dist/analytics/sendAnalyticsEvent.js`'s exported sender.

## Layout verification and remaining acceptance limits

Tests verify external launcher placement, 44px wrapping controls, open/close behavior, mounted panel identity, actual edited-form preservation, inline Chat review and unchanged immediate confirmation rendering. CSS uses bounded vertical scrolling and minimum-width constraints on form controls.

No browser engine is installed in this sandbox, no authenticated Preview browser session was used, and the user's referenced screenshot is still absent. These are structural/component checks, **not** mobile/desktop pixel, touch, clipping or screenshot acceptance. No claim of production-readiness follows from these results.

## Safety boundaries unchanged

`AUTONOMOUS_PRODUCTION_ENABLED` and all other execution/emergency flags, live environment settings and signing keys were not changed. No real wallet signature/authorization, transaction, live smoke dispatch, operator deployment, merge or close was performed. Normal CI/Preview automation may run on the PR branch push; no workflow was manually dispatched.

Diff verification against the audited head confirmed no changes to `contracts/`, `lib/executor/`, `lib/delegated/`, autonomy runtime/policy engine, normal trade execution/confirmation/router/executor quote/fee collection, Permit2 helpers, wallet-auth or trade-controller hooks, `.github/`, environment files, or package/lock files. The sole normal stock preparation change is an early announced-not-live refusal; the existing live stock flow is otherwise untouched.

Rollback: review/revert the six listed commits in reverse order as a unit, rather than selectively restoring the old premature-ACTIVE behavior. Do not change any production flags as part of rollback. No store schema or contract migration is introduced.

## Exact implementation-stage file list

The 27 source/test/fixture files below differ from `2dffa7a`; this report is the additional documentation file.

```text
app/api/agent/autonomy/activation-route-audit.test.ts
app/api/agent/autonomy/authorization/route.test.ts
app/api/agent/autonomy/autonomy-routes-security.test.ts
app/api/agent/autonomy/goals/[id]/route.ts
app/api/agent/autonomy/goals/route.ts
app/api/agent/autonomy/tokens/route.ts
components/features/agent/AgentAutonomyDraft.flow.test.ts
components/features/agent/AgentAutonomyDraftReview.behavior.test.ts
components/features/agent/AgentAutonomyDraftReview.tsx
components/features/agent/AgentAutonomyPanel.behavior.test.ts
components/features/agent/AgentAutonomyPanel.tsx
components/features/agent/AgentExperience.tsx
components/features/agent/AgentTradingLauncher.behavior.test.ts
components/features/agent/AgentTradingLauncher.tsx
components/features/agent/chat-autonomy-review.test.ts
components/features/agent/chat-autonomy-review.ts
components/features/agent/test-fixtures/chat-review-quote.ts
hooks/useAgentAutonomy.activation.test.ts
hooks/useAgentAutonomy.ts
lib/architecture/ai/__tests__/deterministic-autonomy-percent.test.ts
lib/autonomy/__tests__/chat-draft.test.ts
lib/autonomy/api-helpers.ts
lib/autonomy/chat-draft.ts
lib/markets/__tests__/pair-reference.test.ts
lib/markets/base-pairs.ts
lib/trade/__tests__/tokenized-stock-fail-closed.test.ts
lib/trade/tokenized-stock-swap.ts
```
