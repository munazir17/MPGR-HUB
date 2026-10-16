# PR #113 — P0 Manual / Autonomy flow repair

Date: 2026-10-17 (IST). Original deployed baseline: `e15c3b126e5fe481bc5d4198aa966ae32b160943`.
Product fix: **`d086b4145d1503014b16691540101086751cfaed`**, existing branch `arena/b8c82200-mpgr-hub`.

## Acceptance status — distinguish the evidence

**Restored and deployed:** discoverable Manual token/amount preparation, and local Autonomy draft → existing review while gates remain closed. These entry paths were checked in the actual protected Preview browser at both requested sizes, not merely rendered in unit tests.

**Passed in simulated browser end-to-end tests:** authenticated quote preparation/refresh, wallet/network validation, the existing Manual confirmation/execution controller, and the existing goal-bound Autonomy activation controller under an isolated ready configuration. Network APIs and wallet transports in these tests are doubles, not live service acceptance.

**Still unverified:** an authenticated user's actual Preview quote/provider, balance, approval/signature, execution or settlement. Anonymous deployed quote probes return 401 before providers run. No live signatures were permitted, and authentication was not bypassed. Thus this report does **not** claim that both live trading flows have passed user acceptance. Mainnet Autonomy authorization remains intentionally unavailable in Preview.

## 1. Deployed failure reproduction and request trace

[Authorized baseline/current browser + API check](https://github.com/munazir17/MPGR-HUB/actions/runs/38951335568/job/117143163961), observed starting **2026-10-16T19:00:05.666Z**. The baseline URL was resolved from GitHub's deployment record for exactly `e15c3b1`, not the moving branch alias. The fixed URL was resolved for exactly `d086b41`. Both were READY Preview deployments.

The automated probe used **anonymous browsers at 360×800 and 390×844**, no wallet connection or auth cookies. Browser requests were restricted to same-Preview GETs; external hosts and all browser POSTs (including analytics) were aborted. Separate, explicitly allowlisted sessionless quote POSTs were required to refuse authentication. No goal/permission/activation requests were submitted to the deployment.

| Observation / request | Original Preview `e15c3b1` | Fixed Preview `d086b41` |
|---|---|---|
| Manual button → token/amount form | **Absent**, both viewports; only chat/tape instructions and existing proposals | **Present**, both viewports; token selectors, sell amount and wallet-required preparation action verified |
| Autonomy button → local draft/review | **Absent**, both viewports | **Present**; entered 1 USDC / trigger 200, opened existing review, exact values preserved, authorization disabled |
| `GET /api/auth/session` | 200, `authenticated=false` | Same |
| `POST /api/trade/quote`, `{fromToken:"USDC",toToken:"WETH",amount:"1",slippageBps:100}` | **401 `AUTH_REQUIRED`** | Same, expected without SIWE |
| `POST /api/trade/stocks/quote`, `{symbol:"AAPLc",side:"BUY",amount:"1"}` | **401 `AUTH_REQUIRED`** | Same, expected without SIWE |
| `GET /api/agent/autonomy/config` | 200; Preview, runtime/production/execution false | Same |
| `GET /api/agent/autonomy/tokens?chainId=8453` | **404 `AUTONOMY_DISABLED`** | Same |
| `GET /api/agent/autonomy/goals` | **404 `AUTONOMY_DISABLED`** | Same |

Neither quote endpoint returned an origin rejection or origin-not-configured error in these probes. **401 is the verified session refusal, not proof of a provider outage or provider health.** The probe does not impersonate the user's connected-wallet session. Full sanitized results: [deployed-results.json](evidence/pr113-p0/deployed-results.json).

### Exact Manual root causes

- `AgentTradingLauncher.tsx` exposed no preparation controls or preparation callback. A user with no proposal reached explanatory prose only. **There was no preparation request to trace from that missing control.** This is a functional entry-point failure, independent of provider health.
- The tape shortcut in `AgentExperience.tsx` called `fetchInstantSwapProposal()` → existing session-bound quote endpoints, then silently returned on `!result.ok`. This source trace explains why service/session errors could disappear. The anonymous endpoint probes above verify the 401 refusal; they are **not** a captured authenticated tape interaction.
- An additional deterministic integration regression exposed expired-session recovery: a quote can return 401 while `WalletAuthProvider` still caches this wallet as authenticated. Calling the old cached `authenticate()` would return true without renewing SIWE. This was reproduced with an HTTP double and the real auth provider, not asserted as the original user's observed session state.

### Exact Autonomy root causes

- `AgentAutonomyPanel.tsx` renders its runtime-backed creation form only when `config.enabled && !config.emergencyDisabled`.
- `useAgentAutonomy.refresh()` fetches its token list only when `config.enabled`. The deployed token API also correctly returns 404 while runtime-off.
- The launcher had no runtime-independent local draft path. Consequently its management UI could not author/review a draft in this posture. **The runtime refusal is correct and was not repaired by enabling it.**

## 2. Functional repairs and preserved execution paths

### Manual

`AgentManualSwapForm.tsx` provides Sell / Buy token selection from the existing canonical live catalog, human sell amount, slippage in bps, Prepare, Refresh and Review. Exact token addresses/network are visible. Native ETH and WETH remain distinct. No chat command or model is needed.

`lib/trade/manual-swap.ts` sends human `amount`, exact token addresses and requested slippage to **the existing `/api/trade/quote`** with session credentials and no-store. The server's existing parser resolves decimals (including fail-closed live B20 verification), prioritizes Executor routes and performs existing routing/fee checks. No address, calldata, output, price or fee is constructed by the new form. Returned proposals must match wallet, tokens, amount, slippage and expiry before Review is available.

Edits and wallet/network switches invalidate the form's proposal and abort/discard old requests. Quote expiry disables Review; refresh clears the previous quote. Wrong network/disconnection stop preparation. HTTP/code failures remain visible, rather than being interpreted as success. A 401 offers **explicit** “Sign in and retry quote”; the user action re-enters the **same server-verified SIWE flow**, bypassing only the stale *client cache*, never authentication.

Review calls the existing `tradeQuote.openProposal` owned by `AgentExperience` → `useTradeConfirmation` / existing confirmation modal → explicit Confirm → `useTradeExecution` / `executeTrade`. Existing approvals, Permit2, re-quote/consent checks and signing/broadcast implementations are unchanged. The tape still uses its original fast path, now with visible failure feedback.

### Autonomy

`AgentAutonomyDraftComposer.tsx` creates an **in-memory-only** conditional buy draft: supported target, explicit USDC amount and absolute user-entered trigger. It calls existing `buildGoalDraft()` → `autonomy.openWithDraft()` → `AgentAutonomyDraftReview`. It requires no chat, wallet signature, runtime tokens API, policy or goal persistence. It never invents a reference price; the threshold is explicitly user-entered.

The existing review retains daily cap, max trades, expiry, cooldown, slippage, live-quote validation and one-execution consent. With gates closed, authorization stays disabled. Existing runtime management remains mounted, preserving its handlers and state. No simulation button, fake-ready flag or alternate execution path was added to the product.

When actually eligible, the existing activation controller still performs:

1. Deterministic review/policy validation and authenticated policy POST.
2. Goal POST/reconciliation, initially **DRAFT**.
3. Exactly bounded permission signed for **that goal's own actionId** and exact amount/minimum/expiry.
4. Permission persistence, then explicit activation PATCH.
5. **ACTIVE / awaiting trigger**, not settlement success. Another goal's permission is never reused.

## 3. End-to-end simulated browser results

**94/94 cases passed**, 47 each at **360×800 and 390×844**. This comprises all 70 previous compact-review cases plus **24 new integrated flow cases**. The new entry uses the real `WalletAuthProvider`, `useAgentAutonomy`, `useTradeQuote`, `useTradeConfirmation`, `useTradeExecution`, launcher, review and confirmation components. Unlike the older review harness, the new harness does **not** replace these controllers. API responses and wallet transports are explicitly simulated; every unexpected API route fails the test and external network is blocked.

| New integrated browser case (each viewport) | Result |
|---|---|
| Manual select AAPLc, 1 USDC → quote 200 → refresh 200 → existing review → explicit Confirm → exact approval + Executor swap through real engine | PASS; **two simulated sends**, no separate fee transfer; 25 bps / 0.0025 USDC shown from a consistent unsigned fixture |
| Quote expires; Review disabled; edit clears old quote; wrong network stops new request | PASS |
| Quote 429 and 503 | PASS; actual status shown, no Review/signing/execution |
| Quote 401 with cached auth → no automatic retry → explicit retry → existing SIWE nonce/verify flow → quote 200 | PASS; exactly one **simulated** SIWE signature, no swap |
| Wallet switches network or account after opening review | PASS; real execution controller refuses before transaction submission |
| Disconnected wallet | PASS; form editable, no quote or execution |
| Preview runtime-off → local draft → review | PASS; exact 1 USDC / 200 trigger, disabled authorization, zero autonomy POST/PATCH calls or signatures |
| Isolated mocked-ready → policy 201 → goal 201 → own-goal permission 201 → activation PATCH 200 | PASS; real UI reaches **Active — awaiting trigger**, one own-goal permission, one simulated delegated signature, no swap/broadcast |
| Policy refusal 503 | PASS; no goal/permission/signature/activation |
| Permission persistence fails 503 | PASS; stays DRAFT; retry reuses same policy/goal, persists own permission before ACTIVE |

The actual unsigned Executor builder/encoder generates the simulated quote, including exact fee and minimum. Wallet action stubs have **no connector, provider, private key or RPC transport**. A simulated successful receipt is **not** evidence of on-chain settlement. All API request/status traces for these cases are saved in [simulated-api-traces.json](evidence/pr113-p0/simulated-api-traces.json); representative screenshots are under `evidence/pr113-p0/simulated/` and must be read as **simulation only**.

Additional validation:

- **688 focused tests / 53 files passed**, covering existing quote APIs, parsers/decimals, crypto/B20 routing, Executor/25-bps invariants, slippage, approvals/Permit2, funds safety, quote confirmation/execution, API admission guards and own-goal permission lifecycle.
- TypeScript passed; lint **0 errors / 59 existing warnings**; diff check clean.
- Runtime missing/false and production missing/false admission tests independently assert **zero new policies/goals/permissions**, zero store mutation calls and no broadcast, not just a disabled UI.
- Product commit `d086b41`: hosted build, full quality job and all other required checks passed (**10 pass / 2 opt-in skipped**). This supports, but does not substitute for, the browser evidence above.

### Actual deployed screenshots

[GitHub artifact — 8 before/after mobile PNGs + results JSON](https://github.com/munazir17/MPGR-HUB/actions/runs/38951335568/artifacts/12067883549). The safe JSON annotation is mirrored in this repository. Sandbox artifact download was blocked at the external blob-storage redirect, so those PNGs are retained in GitHub rather than falsely presented as locally inspected files. Artifact retention is 7 days; the checked-in sanitized JSON persists.

## 4. Remaining acceptance blockers — not reported as success

1. **Authenticated Preview provider health remains unknown.** A real user-session executable quote was not obtained. Both anonymous probes stop at 401, before CDP/0x/Aerodrome/Executor quote services. The next authorized human acceptance step is to connect/sign in through the existing flow, prepare a small quote without confirming a swap, and capture its actual response/status. No readiness assumption or new credential/vendor was introduced.
2. **Live Manual signing, execution and settlement were not tested**, by instruction. The browser test substitutes every wallet/receipt operation; no live approval, signature or transaction was requested.
3. **Preview Mainnet Autonomy activation is intentionally blocked.** Only local draft/review is deployable under the required posture. The ready lifecycle is tested in isolated fixtures, not by enabling Preview. Vercel runtime-row provenance/operator intent remains unverified as documented in the preceding diagnosis.
4. Mobile evidence is Chromium browser emulation, not physical-device or embedded-wallet acceptance. The actual deployed browser test is disconnected/anonymous; connected authenticated full flows are simulated separately.

## Changed files / safety boundary

Product: new `AgentManualSwapForm.tsx`, `AgentAutonomyDraftComposer.tsx`, `lib/trade/manual-swap.ts`; launcher wiring; tape error feedback in `AgentExperience.tsx`; optional explicit forced SIWE retry in `hooks/useWalletAuth.tsx` (all old no-argument calls retain their behavior).

Tests/evidence: `manual-swap.test.ts`, launcher structural expectation, isolated `tests/mobile/flows*` entry/spec/fixtures, wallet transport doubles/Vite aliases, existing harness callback, `scripts/verify-preview-user-flows.mjs`, and the existing PR113 reference workflow's anonymous browser/refusal probe + artifact upload. No workflow dispatch; it ran automatically on this PR branch push.

**Unchanged:** production settings/scopes/secrets, autonomy flag values/definitions, emergency KV switch, contracts/bytecode, existing Manual execution APIs/controllers, Executor behavior, fee arithmetic and collection semantics, slippage/approval/Permit2 signing domains/witness/routing, and AI vendors/defaults. No live wallet signatures, goal authorization, transactions, broadcasts, production writes, production deployment or merge. The PR remains open.
