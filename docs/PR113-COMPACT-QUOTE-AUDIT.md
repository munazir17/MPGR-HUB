# PR #113 — Compact quote UI and mobile authorization audit

Date: 2026-10-16. Existing branch: `arena/b8c82200-mpgr-hub`. **Do not merge.**

Baseline: `a620ecbb68a7606a5441f906a00c78cc1e5b7934` (the previous mobile audit's completed head). This report concerns **new work and new runs**, not reuse of the earlier acceptance totals.

Implementation commits:
- `0c80429` — refuse production-gated Mainnet policy and goal creation.
- `e1ac2fe` — compact quote review, context invalidation, focused/mobile regressions.
- `4840598` — clarify Manual quote-source provenance versus autonomous broadcasting, and disclose possible separate Executor approval even when the quote does not report it as required.
- `730b6ba` — honor latched quote expiry in the displayed status, authorization guard and handler.
- `7d04211` — browser-only geometry measurement: verify 44px CSS minimum/layout plus hundredth-pixel visual size, avoiding animated-translation floating-point noise.

## 1. Changes and preserved boundaries

| Files | Why |
|---|---|
| `components/features/agent/AutonomyQuoteSummary.tsx` (new) | One essential summary and three closed native disclosures: **Fee & execution details**, **Slippage & quote validity**, **Risks & network requirements**. Exact known approval/stock warnings have concise default versions and full on-demand source text. Unknown/changed warnings, unmatched warning strings and critical facts remain outside collapsed disclosures. Critical facts are never abbreviated. |
| `components/features/agent/AgentAutonomyDraftReview.tsx` | Remove repeated visible summary/paragraphs; retain original parsed values and all editable fields under **Edit trade & limits**. Keep the action and specific blocker in a sticky footer, with 44px action/refresh targets. Add native summaries to modal keyboard containment. Bind displayed/usable quote state to account, connection, chain, session-authentication state and exact quote inputs. |
| `app/api/agent/autonomy/policy/route.ts`, `goals/route.ts` | Minimal compatible admission fix: **Mainnet POST only**, fail closed with **503 `PRODUCTION_GATE_DISABLED`** before creating a policy/goal when the existing production gate is missing/false. GET, revocation, Sepolia, response shapes and successful ready flows remain unchanged. |
| `AutonomyQuoteSummary.test.ts`, `AgentAutonomyDraftReview.behavior.test.ts`, `AgentAutonomyDraft.flow.test.ts` | Fee/risk/default-detail presentation, exact amounts/trigger/reference preservation, immediate context invalidation and fresh-quote recovery. Existing text assertions now check semantic summary rows rather than the removed prose. |
| `activation-route-audit.test.ts`, `autonomy-routes-security.test.ts` | Direct concurrent gate-off no-new-record tests, runtime-off refusal and actual Mainnet route/store/signature lifecycle using offline seams. Positive write fixtures explicitly open only their local test-process gate. Independent valid-signature refusal tests create fixtures before closing that gate; their refusal/zero-slot assertions are retained. |
| `test-fixtures/chat-review-quote.ts`, `tests/mobile/main.tsx`, `tests/mobile/review.spec.ts` | Correct the fixture's B20 token kind; add an explicitly applied Executor-fee fixture, missing-executor/signing-compatibility cases, expanded compact/context/risk coverage. No fixture or harness is a production route. |

**Fee truthfulness:** the default shows the actual quote provider, not a hardcoded Executor label. The applied test quote's 25bps and `2500` atomic USDC display as **0.25% · 0.0025 USDC**. Amount display uses exact atomic units and validated sell-token decimals, not a fee estimate or rounded `displayAmount`. CDP/skipped fees say **Not charged**; absent fee data says **Not quoted**, never invented 25bps. Missing gas/protocol costs say **Not quoted**. Available gas/protocol metadata is retained as exact atomic units plus token identity on demand; its decimals are not guessed. The fee-wallet/execution explanation uses actual metadata rather than repeating the source info fact's static percentage.

**Material disclosures remain outside accordions:** Base Mainnet only; no execution before required authorization and trigger conditions; tokenized stocks are not direct shares or issuer subscriptions, with thin-liquidity/Chainlink-price caveats; actual named separate approval requirements, or possible separate Executor approval for an Executor route. Unknown restrictions cannot be suppressed merely by reusing a known risk id. Only exact repeated warning prose is deduplicated.

The editable pair, amount, trigger, daily cap and trade count remain intact; slippage, cooldown and authorization expiry remain available on demand with unchanged values/bounds. The example remains **1 USDC, below $343.53 from a $347 reference**, not the illustrative price from the request. Sell-side inverse token ratios are explicitly labelled as ratios, not falsely prefixed with a USD `$`.

**No changes** to Manual trading handlers, quote/routing/calldata generation, approval execution, amount/fee/slippage calculations, token decimals, contracts/bytecode, Executor behavior, Permit2/EIP-712 domain or witness semantics, nonce rules, model/vendor configuration, runtime/production flag definitions, emergency controls, deployment environments or secrets. No alternative executor, reusable cross-goal delegation, server-held user key or prompt-triggered broadcast was introduced.

## 2. Measured before/after mobile evidence

Real component/CSS in isolated Chromium mobile emulation, bounded 65dvh Chat, no live wallet/API. Baseline source was read-only archived from `a620ecb` outside the repository, without switching branches. Both sides used the **same canonical B20 fixture**, including the same amounts, floor, provider, applied/skipped fee and approval facts. The original unchanged fixture's first red run was smaller because it incorrectly tagged the B20 token as generic ERC20; the matched measurements below remove that confound.

| Viewport / quote | Review content before → after | Quote summary before → after |
|---|---:|---:|
| 360×800, CDP / skipped fee | 1849 → 890 px | 794 → 444 px |
| 390×844, CDP / skipped fee | 1801 → 874 px | 746 → 444 px |
| 360×800, Executor / applied fee + approval | 2337 → 933 px | 1282 → 487 px |
| 390×844, Executor / applied fee + approval | 2209 → 917 px | 1154 → 487 px |

The matched Executor review is about **59–60% shorter**. These are content heights, not viewport heights or a claim of zero scrolling. The initial view exposes pair/trigger/amount and a visible, hit-tested action; disclosures and editable/technical details remain reachable by bounded scrolling. More material risks legitimately require more space and are not hidden to meet a height target.

Screenshots (fixture banner intentionally retained):
- Executor: [360 before](evidence/pr113-compact/360-executor-before.png) / [360 after](evidence/pr113-compact/360-executor-after.png); [390 before](evidence/pr113-compact/390-executor-before.png) / [390 after](evidence/pr113-compact/390-executor-after.png).
- Actual fee + material risks after a short scroll: [360](evidence/pr113-compact/360-executor-fees-risks.png) / [390](evidence/pr113-compact/390-executor-fees-risks.png).
- Honest skipped-fee/CDP default: [360 before](evidence/pr113-compact/360-cdp-before.png) / [360 after](evidence/pr113-compact/360-cdp-after.png); [390 before](evidence/pr113-compact/390-cdp-before.png) / [390 after](evidence/pr113-compact/390-cdp-after.png).
- Specific production blocker with disabled action: [360](evidence/pr113-compact/360-production-gated.png) / [390](evidence/pr113-compact/390-production-gated.png).

## 3. Flow trace and exact blockers

`AgentAutonomyDraftReview` → read-only authenticated `/api/trade/quote` → existing `chatReviewAuthorizationError` / quote revalidation → explicit guarded button → `useAgentAutonomy.activateDraft` → authorized policy POST → DRAFT goal POST → this goal's own Permit2 slot/signature → authorization POST and persistence → goal PATCH activate → confirmed ACTIVE / awaiting trigger.

The new UI does not choose execution addresses, calldata, broadcaster or the signed floor. It forwards the same exact positive atomic-derived human floor. Activation alone is not verified settlement. Technical provider prose is labelled as the underlying **Manual quote source**, not autonomous signing/broadcast instructions: the review saves permission, while only the authorized runtime may broadcast after trigger/execution checks.

The first applicable blocker is shown, rather than claiming settings failure or generic button malfunction:

| Condition | Explanation / safe behavior |
|---|---|
| Settings loading, HTTP/JSON/schema/network/session-read failure or absent config | Specific settings diagnostic; retry cannot invent readiness. Full HTTP/runtime/production-flag diagnostics remain on demand. |
| Runtime off | “Autonomous runtime is not enabled…”; operator review is required, retry/sign-in cannot enable it. No create/sign dispatch. |
| Emergency disabled | “Autonomous goals are disabled by the operator.” |
| Production missing/false | “The production safety gate is not enabled…”; Mainnet authorization blocked. Server policy/goal/permission POST refusal is independent of the UI. |
| Execution/adapter unready | “Autonomous execution is not ready…”; separate from settings or production-gate diagnosis. |
| Invalid/unsupported asset, pair, amount/precision, daily cap, slippage, trade count, expiry, cooldown or trigger | Existing specific form validation remains authoritative; edit without losing the parsed draft. No ETH→WETH substitution. |
| Disconnected/wrong network | Connect on **Base Mainnet**; stale quote values are removed immediately and no wrong-chain quote is requested. |
| Missing executor, incompatible signing, wrong delegated chain or missing/mismatched runtime token metadata | Delegated authorization/token details unavailable; no readiness fabrication. |
| Missing authenticated session | Explicit sign-in only. Sign-in is not a spending authorization or goal activation. |
| Loading/failed/refreshed/input-mismatched/expired/future-dated quote, changed account/network/session, invalid floor/decimals/provider/transaction/balance or critical risk | Authorization disabled. Expected/minimum/provider/fee values cannot retain an apparently current presentation. Replacement must be fresh, validated and context-matching. Unknown critical risks remain visible. |
| In flight / repeated taps | Synchronous ref guard plus existing controller guard, locked inputs/Close, Working state. Failures remain visible and retryable; no false green success. |

### Current external observation versus mock readiness

The latest independently readable pre-change Preview evidence is the **successful reference check for `a620ecb`**, observed **2026-10-16T16:52:49.239Z** ([check](https://github.com/munazir17/MPGR-HUB/actions/runs/38935006157/job/117088179664), safe annotation copied into the evidence file): settings **HTTP 200**, valid/no-store; `enabled=false`, `runtimeFlag=disabled`, `productionGate=false`, `productionFlag=missing`, `executionAvailable=false`, `emergencyDisabled=false`, delegated chain null, signing support true. Tokens/goals/policy/authorization returned **404 `AUTONOMY_DISABLED`**.

That is **successful settings retrieval with disabled runtime**, plus a separate missing production gate—not a settings-fetch defect. It does not establish why an operator configured it that way, or which branch/environment override/history caused it. No configuration was changed to make the button work. Direct authenticated Preview/real-wallet verification remains outside this sandbox. New-head CI/Preview status must be read for the exact final PR SHA, not inferred from this baseline observation; final status is reported with the delivery.

## 4. Server no-persistence and ready-flow results

Baseline replay against archived `a620ecb` confirmed **policy 201 / goal 201 / permission 503**, with **one new policy, one goal, zero slots**, for both missing and false production flags. This was a persistence/admission gap, not a demonstrated execution bypass.


New direct tests make concurrent calls with the production flag missing and false. For each posture, policy POST, owned-policy goal POST and permission POST return **503 `PRODUCTION_GATE_DISABLED`**. Spies observe **zero new policy/goal/slot persistence calls**; store state retains only one policy deliberately seeded while the gate was open, **zero goals and zero slots**. Runtime-off equivalents return **404 `AUTONOMY_DISABLED`**, also zero new domain records. These are domain-record guarantees, not a claim that normal rate-limit bookkeeping cannot write.

The independent valid-test-signature gate-off tests still refuse registration and store zero slots. Their owned policy/DRAFT setup now happens **before** the gate is closed; no pre-existing records are deleted or misrepresented as newly persisted during refusal.

The ready Mainnet integration test uses real route handlers, signature validation and in-memory Lua-Redis stores, with **explicit offline session/readiness/emergency seams and a deterministic test key**, not a live wallet or real KV. It verifies:
1. Policy 201 and goal 201 → persisted **DRAFT**.
2. Activation without a goal-bound permission → **409 `AUTHORIZATION_REQUIRED`**.
3. Valid own-goal signed permission → **201**, exactly one stored goal-bound slot.
4. Activation and retry → **200 ACTIVE**, same single goal/slot, no duplicate creation.
5. Zero verified settlements and **zero broadcaster construction/calls**.

Separately rerun real-hook tests cover own-goal-only permission, rejection/registration/activation failure recovery, exact signed amount/floor, no duplicate goal on retry and no redundant signature for this same goal's saved live permission. Browser success fixtures show **Active — awaiting trigger**, never Draft — inactive or verified settlement. This is layered isolated evidence, not a single live-wallet browser-to-production end-to-end acceptance claim.

## 5. Validation and security review

A final stress rerun before `730b6ba` exposed **63 passed / 1 failed** mobile cases: after the expiry timer latched invalid, values cleared but wall-clock-only validation could still leave the action/status ready under timer/render/clock ordering. A deterministic hook-harness regression then failed with the clock deliberately still fresh. The fix makes the expiry latch fail closed in **UI and handler**, without loosening the browser assertion, quote timestamps, limits or consent gates. Final totals below are reruns after that fix, not the earlier passes.

Production logic was locked at `730b6ba`; the browser-measurement-only `7d04211` and evidence/report files follow it. TypeScript/lint were rerun after all test edits. A separate geometry-only rerun observed `43.99993896484375` for a 44px translated target; the test now checks **all three** of CSS minimum, layout size and visual size (to hundredth-pixel precision), still requiring 44px. No real undersized target, assertion threshold or production style was hidden/changed. Final results:
- **64/64 mobile cases**, 32 at each requested viewport. Includes native disclosure keyboard use, modal labels/focus trap/Escape/focus return, close/reopen, 500px keyboard-style viewport, touch/hit testing, initial sticky action, overflow, loading/refusal/error/retry/success, runtime/production/emergency gates, missing/unready adapter/executor/signing capability, quote expiry/refresh/input/account/connection/network/session transitions, repeated taps, unknown material risk visibility, exact applied fee, and existing Manual/Autonomy launcher behavior.
- **236 focused tests / 12 files**, without an analytics preload. Covers review helpers/render/effects, launcher/panel, hook activation, route authorization/admission, cold-start readiness and production refusal.
- Qualified offline full **`npm run check`: 3,574 passed / 24 skipped; 281 passing / 5 skipped files**, exit 0. Includes lint and TypeScript. Skipped live/Redis/fork prerequisites remain skipped; no live operation was used to force them green.
- **TypeScript passes; lint 0 errors / 59 existing warnings.** No warning suppression was added.
- **Local production build attempted, blocked** by existing `app/layout.tsx` Inter Google Fonts fetch in this network-restricted sandbox. No font/config workaround; no successful local production-build claim. Exact final-head hosted CI must be checked separately.
- `git diff --check` clean. Final source diff limited to the four production UI/admission files plus focused test/support files. No contract, signing, routing, approval-execution, fee-calculation, secret, workflow, deployment or gate-definition changes.

Offline qualification: an external, untracked Node preload replaces **only** `@coinbase/agentkit/dist/analytics/sendAnalyticsEvent.js`'s outbound analytics export. It does not replace application network guards, signatures, configuration, wallets or execution, and does not ignore unhandled failures. Focused/browser tests run without it. No raw unsuppressed full-suite pass is claimed. Browser binaries/libraries are external to Git (`MOBILE_CHROMIUM_EXECUTABLE`, `LD_LIBRARY_PATH` overrides); no dependency/lockfile or production setting changed.

Run excerpts, matched capture method and safe Preview annotation: [evidence/pr113-compact/results.txt](evidence/pr113-compact/results.txt).

## 6. Remaining acceptance boundary

PR remains **OPEN / unmerged**. No production activation/deployment command, environment/secret/emergency-KV change, workflow dispatch, live user signature, live goal/authorization/trade, transaction broadcast or production persistence was performed. Local test-process flag stubs and offline test-key signatures are not deployment changes or real-wallet acceptance.

Still required by an authorized reviewer: exact-head authenticated Preview inspection; physical 360/390-class mobile devices with real OS keyboard and wallet app/deep-link return; real wallet/network/session transition handling and user-consent/signing acceptance under an explicitly approved test plan. Those checks must respect the currently disabled runtime/production posture and must not be treated as authorization to enable Production or trade. This work proves mocked readiness can complete and production refusal cannot create new goals/permissions; it does **not** claim the deployed runtime is enabled, live execution is accepted, or any settlement occurred.
