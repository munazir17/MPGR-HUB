# PR #113 — Mobile acceptance audit and targeted fixes

Date: 2026-10-16. PR remains open; no merge authorized or performed.

## Scope, baseline, and limits

- Inspected remote PR HEAD **01a091af28e605965528458b887435b39d3a0640** before editing. The restored worktree's 1,193 tracked file contents exactly matched that commit; local branch/index metadata was aligned to that already-existing commit without discarding content or creating another branch.
- Work stays on `arena/b8c82200-mpgr-hub`.
- Actual React review, Framer Motion, launcher, panel, parsing/form helpers and application CSS were mounted in an **isolated headless Chromium 141 browser harness**, using Playwright 1.56.1 at **360×800** and **390×844**. These are browser-emulated mobile viewports, **not physical mobile devices or live Vercel acceptance**.
- Wallet/account/session/controller state and quote responses are deterministic test doubles. The harness has no wallet provider or signing API. Browser API requests are intercepted with an exhaustive allowlist permitting only the fixture quote request; unexpected API traffic fails the test. This harness is a Vite test entry, not a Next application route.
- Local route tests use the existing Lua-backed Redis double and existing throwaway test-key signatures. They do not contact a deployed authorization endpoint or create real permissions.
- No environment/flag values, emergency KV switch, deployment settings, contracts, executor, signing domain/witness, Permit2 semantics, routing, fees, Manual swap/approval/transaction semantics, AI vendor settings or secrets were changed. Test-process flag fixtures are not deployment changes.
- No real wallet prompt/signature, live goal authorization, live trade, broadcast, production write, workflow dispatch or merge occurred. Pushing this PR branch can trigger its existing automatic CI/Preview workflows; none was manually dispatched.

## Commits

| Commit | Purpose |
|---|---|
| `868d199fa35ce0a2c1b5d2c480910642e511aa8e` | Refuse new Mainnet spend-permission registration while production is gated; preserve all signature/nonce/binding checks. |
| `39ce2550d725f26440a81dcfe2954f173d4e9150` | Mobile review lifecycle/accessibility, latest-read-wins state, browser harness and regressions. |

The following documentation/evidence commit records results for these source commits.

## Stage 1 — Complete flow trace

1. `lib/architecture/ai/deterministic-ai-provider.ts` detects the conditional request before an execution proposal, obtains/validates reference anchoring, and builds a review-only draft through `lib/autonomy/chat-draft.ts`. The browser fixture exercises these parsing/build helpers directly, not a live Chat/model request.
2. Chat renders the draft card; `AgentChatWindow` forwards `onReviewAutonomyGoal` to `AgentExperience`, which owns `autonomy.openWithDraft`. `hooks/useAgentAutonomy.ts` stores the draft. `AgentExperience.tsx:325–328` renders the review inside Chat's existing `min-h-0 / overflow-y-auto` body, with `embedded` enabled.
3. `AgentAutonomyDraftReview` keys its dialog by draft content and initializes through `chatDraftToForm` / `autonomyDraftToForm`, using canonical Base token metadata even before runtime metadata arrives. Fixture command: **“Buy AAPLc whenever price falls 1% worth 1 USDC”**, reference **347**. Result: USDC spend → AAPLc receive, amount **1**, trigger **below 343.53**, daily cap **10**, max trades **10**, slippage **100 bps**, cooldown **3600 seconds**, TTL **30 days**. No price/amount is inferred from a fabricated live source.
4. The quote effect requires supported draft, session, valid form and loaded settings. It calls the existing `/api/trade/quote` API through `fetchWithSession`, validates the entire proposal, and binds it to pair/amount/slippage. Account changes now also refetch the wallet-bound quote. Effect cleanup rejects superseded responses.
5. `chatReviewAuthorizationError` applies the checks below. `canAuthorize` additionally refuses explicitly unsupported drafts. The button remains disabled while the controller **or local submission** is busy. Quote expiry schedules a rerender; the helper recalculates freshness.
6. The click handler reruns validation before any activation call, claims a synchronous local in-flight ref, locks the form/close controls, and reports failures without presenting them as success. No automatic sign-in is initiated by quote reads.
7. `activateDraft` in the hook requires wallet/session/token/amount/chain/floor checks and its own in-flight guard. It reserves/reconciles a policy and **DRAFT** goal, then checks only this goal's own persisted permission. A fresh goal needs its own bounded signature; another goal's permission never qualifies. Existing same-goal recovery and nonce-index history are preserved.
8. `signSlotsForPolicyGoal` checks the policy chain, server-pinned executor, wallet network and bounded input, uses the existing typed-data path, then posts the slot. This signing seam is never invoked against a real wallet in this audit.
9. `authorization/route.ts:131–179` refuses runtime/emergency restrictions and now additionally refuses **new Mainnet permissions** when production is off. Existing session/origin/rate/policy/owner/chain/token/amount/floor/deadline/actionId/policyHash/signature recovery and atomic nonce checks remain intact; persistence remains at line 295. GET/revocation code is unchanged.
10. `goals/[id]/route.ts:95–119` requires current execution readiness/emergency posture and exact-goal persisted permission before ACTIVE. `confirmGoalActivation` requires an actual ACTIVE server response before reporting success. Only then does review show **Active — awaiting trigger**, never settlement. Adapter and MCP broadcast chokepoint production gates are unchanged.

### Every button-disabled condition

Locations below refer to source commit `39ce255`.

| Condition | Location / exact failing predicate |
|---|---|
| Controller operation or this review submission in progress | `AgentAutonomyDraftReview.tsx:55–58,490`: combined `busy`; synchronous repeat calls also refused at line 168. |
| Unsupported draft | Review line 114: `draft.supported === false`; dedicated unsupported reason is shown. |
| Loading/failed/malformed settings or absent config | `chat-autonomy-review.ts:122–124`; `autonomySettingsReadError` covers loading, wallet-required, HTTP/JSON/schema/network/timeout failures. |
| Runtime disabled | Helper line 125: `!config.enabled`. |
| Emergency disabled | Helper line 126. |
| Missing/false production gate | Helper line 127: `config.productionGate !== true`. |
| Adapter/execution unavailable | Helper line 128: `config.executionAvailable !== true`. |
| Invalid form/limits | Helper lines 129–130 and `validateChatReviewForm:31–56`: unsupported identity/route, invalid configured limits, precision/positive amount, amount/daily ceilings, daily cap below a trade, trigger, slippage, trade count, expiry or cooldown bounds. |
| Disconnected or wrong-network wallet | Helper line 131; disconnected is passed as no chain, required chain is 8453. |
| Delegated capability unavailable | Helper lines 132–133: chain not 8453, signing compatibility false, or invalid/missing executor address. |
| Missing or mismapped runtime tokens | Helper lines 134–138: exact address, symbol and decimals required for both tokens. |
| Missing session | Helper line 139. Explicit sign-in button is separately unavailable when disconnected/authenticating/busy. |
| No complete matching fresh executable quote | Helper line 140 and quote validators at lines 69–108: quote key/proposal required; correct chain/network/tokens/precision/input/slippage/provider; positive atomic output/floor with floor <= output; valid timestamp/risk/warning/fee shape; matching stored floor/decimals; not expired/too old/future-dated; existing confirmation/taker-address/slippage/amount/liquidity/execution/transaction/balance/wallet revalidation; no critical risk. |

A disabled runtime/production gate is an **expected refusal**, not a defect to bypass. The helper returns the first blocker; fixing one can reveal the next. A reference price or successful quote alone never implies permission/readiness.

## Confirmed defects and red/green evidence

| ID / severity | Reproduction and root cause | Targeted fix / affected source |
|---|---|---|
| M1 — High, admission-policy gap | Offline route test with an owned Mainnet policy/goal, pinned test executor and valid test signature returned **201** with production missing/false. The production flag previously gated execution, not permission registration. This conflicts with the requested no-new-permission posture; it was not a demonstrated broadcast bypass. | `authorization/route.ts`: add Mainnet-only production admission refusal, **503 `PRODUCTION_GATE_DISABLED`**, before signature recovery/persistence. Four new route assertions cover missing/false admission and zero saves. Existing positive/executor/domain tests explicitly open only their local test-process gate so those independent checks remain exercised. Commit `868d199`. |
| M2 — Medium, asynchronous state races | Three mocked-hook regressions failed: old same-wallet config replaced newer disabled config; late old-wallet policy/slot replies replaced a new wallet view; disconnect left pending reads able to restore old config. Wallet identity alone did not order same-wallet requests, and some awaits lacked stale-response checks. | `hooks/useAgentAutonomy.ts:235–301`: version every refresh, validate version + wallet after each async boundary, invalidate pending work and clear the view on disconnect. All three added regressions pass; no writes/signatures occur. Commit `39ce255`. |
| M3 — Medium, account-switch recovery | Reproduced in Chromium at **both sizes**: after switching accounts, existing taker validation correctly disabled the button, but quote effect lacked the account dependency, so the matching replacement quote never loaded automatically. | Add `walletAddress` to quote-effect dependencies. Old pending responses remain cancelled. Account-switch browser test now observes two quote reads and a valid new-account quote before re-enabling. `AgentAutonomyDraftReview.tsx:162`; commit `39ce255`. |
| M4 — Medium, interaction re-entry / in-flight consistency | Reproduced at **both sizes**: two synchronous clicks called the mocked activation controller twice. This is component re-entry, **not proof of duplicate persisted goals/signatures/broadcasts**; the hook already had its own write guard. Source inspection also found the bottom Close and form inputs remained interactive during shared busy state. | Synchronous local ref + submitting state, `try/finally`, disabled fieldset and bottom Close, combined busy indication. Browser regression now gets one controller call and disabled Close; retry remains possible after a failure. Review lines 164–209,373,490–502; commit `39ce255`. |
| M5 — Medium, failure feedback | Reproduced at **both sizes**: an unexpected activation rejection produced no usable alert. Source also rendered returned failures in the same green/check styling as success. | Catch unexpected rejection, preserve same-draft reconciliation guidance, release local busy state, use error styling/`role=alert` for failures and status styling only after confirmed activation. Review lines 203–209,349–360; commit `39ce255`. |
| M6 — Medium, contradictory activation status | Reproduced at **both sizes**: mocked confirmed activation rendered “Active — awaiting trigger” while the unchanged header still said “Draft — inactive.” | Status header now reflects confirmed activation only, explicitly retaining fresh-runtime-check and unverified-settlement caveats. Review line 255; commit `39ce255`. |
| M7 — Medium, modal keyboard accessibility | Reproduced at **both sizes**: modal did not move focus inside; no keyboard containment/Escape/focus-return lifecycle existed. The actual embedded review is not a modal and must not trap focus. | Modal-only initial focus/body scroll lock, Tab/Shift+Tab containment, idle Escape close, opener focus restoration; embedded path unchanged. Review lines 62–101,224–227. Browser regression passes; commit `39ce255`. |
| M8 — Medium, input accessibility | A separate baseline browser regression failed at **360×800**: the trigger-price textbox had no independent accessible name because its shared label contained both a select and an input. Source applies equally at both sizes; no pre-fix 390 label run is claimed. | Add explicit **“Trigger price (USDC)”** accessible name. Named-input regression passes at **both** sizes. Review line 430; commit `39ce255`. |

### Problems checked but NOT reproduced

- No horizontal overflow, CTA clipping/unreachable scrolling, overlay interception or pointer-event defect was found at the tested sizes. Tests assert bounded Chat scroll movement, CTA-in-viewport and center-point hit testing, then actually tap it. No speculative layout rewrite was made.
- Late old-input quote responses are rejected; input edits immediately block stale quote reuse; failed refresh, expired quotes and refresh recovery remain fail-closed.
- Form values initialize correctly, remain on invalid-input/error/retry, and reopen correctly from the same parsed draft. Closing is cancellation; cross-reload durable unsaved editing is not promised.
- Manual proposal review still calls its existing handler; launcher switching and persistent Autonomy panel behavior remain covered. The audit does not claim browser-tested on-chain Manual execution.

## Stage 2/5 — Test matrix and results

### Before fixes

- Initial browser run, unchanged application source at `01a091a`: **24 passed / 10 failed** — five defect tests failed at both viewport sizes (account change, repeat handler, thrown failure feedback, activation status, modal keyboard).
- Additional independent accessible-name regression: **1 failed**, 360×800.
- Mainnet valid-signature admission regressions: **12 existing passed / 2 new failed**; both observed **201 instead of 503**. Route early-refusal regressions: **22 existing passed / 2 new failed**.
- Hook refresh regressions: **19 existing passed / 3 new failed**.
- Before/after log excerpts are committed in [evidence/pr113-mobile/red-green.txt](evidence/pr113-mobile/red-green.txt).

### After fixes

- **42/42 browser cases passed**, 21 at each viewport. The matrix includes parsed initialization/limits; loading, input-stale, late-response, expired, failed/refreshed quote; disabled runtime; missing production flag mapped to public false; execution/delegated adapter unavailability; emergency; loading settings; disconnected/wrong-network wallet; missing session and explicit mock sign-in; invalid form; isolated valid readiness; tap/working/error/retry/re-entry; focus/modal close/reopen; 500px shortened keyboard-style viewport; launcher/Manual handler; screenshot/hit-test checks.
- **219 focused tests / 11 files passed**, including review validation/behavior, parsed flow, launcher/panel, activation hook, authorization/routes, cold-start adapter status and production-gate refusal.
- Qualified offline full `npm run check`: **3,557 passed / 24 skipped**, **280 passing / 5 skipped files**, exit 0. The seven added Vitest cases are four admission regressions + three refresh races. Browser tests run separately, not counted inside Vitest.
- **TypeScript passed. Lint: 0 errors / 59 pre-existing warnings.** Both were rerun after the final browser test additions.
- **Production build attempted but blocked**, exit 1: existing `app/layout.tsx` Inter font fetch from Google Fonts is unavailable in this sandbox. No font/application-build workaround was added. This is not a successful production-build claim; new-head CI build still needs to pass.
- Full-suite qualification: external Node preload `/home/user/pr113-investigation-offline-telemetry.cjs` suppresses only unchanged AgentKit `sendAnalyticsEvent` outbound analytics. It does not replace application guards, wallet/security/signing/execution functions. Focused tests/browser tests ran without that preload. A raw unsuppressed full-suite pass is not claimed.
- Live/real-Redis/fork-dependent tests left skipped retain their normal conditions; no smoke, canary, transaction or workflow was invoked to force them green.

### Screenshots — isolated fixture browser, not Preview

Ready and gated screenshots include the fixture-only banner and are saved from the actual rendered component after scrolling to the CTA:

- [360 ready](evidence/pr113-mobile/360-review-cta.png) / [360 production-gated](evidence/pr113-mobile/360-review-gated.png)
- [390 ready](evidence/pr113-mobile/390-review-cta.png) / [390 production-gated](evidence/pr113-mobile/390-review-gated.png)

### Reproduce locally

```sh
npm ci
npx playwright install chromium
npm run test:mobile
npm run check
```

Playwright installs require a host with the browser download/system dependencies available. In this sandbox outbound access is restricted, so Chromium 141 and missing shared libraries were unpacked from an npm package **outside the repository**, then passed through the optional `MOBILE_CHROMIUM_EXECUTABLE=/tmp/chromium` and `LD_LIBRARY_PATH` overrides. No browser binaries/package payloads were committed. Vite is pinned at the version already used transitively by Vitest; Playwright is dev-only. The harness binds 0.0.0.0 and accepts the Arena preview domain; browser API calls remain relative.

Normal `npm run check` may hit the unchanged AgentKit analytics network limitation in an offline environment. The reported qualified full run used the analytics-only preload described above, not relaxed validation or ignored unhandled errors.

## Final diff/security review

- Application changes are restricted to the review component, autonomy refresh reader and authorization POST admission. Other modified files are regressions, test setup/dev dependencies and this report/evidence.
- Zero source diff from the audit baseline in `.env.example`, `vercel.json`, `.github`, `lib/autonomy/config.ts`, `lib/executor`, `lib/delegated`, `lib/trade`, `app/api/trade`, contracts or wallet-auth implementation. No execution gate removed or faked; no Manual semantic change.
- The authorization gate is Mainnet-only, POST-only; existing GET/revoke and Sepolia behavior remain unchanged. Runtime-off admission still refuses first. Watch-only policy/DRAFT metadata is distinct from a signed spend permission; the new refusal protects slot registration, not a rewrite of watch-only authoring.
- New UI locking is additive to the existing helper/hook/server checks. An enabled fixture button is not permission, transaction success or settlement.
- Existing same-goal persistence/recovery, immutable historical nonce indices, minimum-output precision, user confirmation, slippage/spend caps and exact signature/domain validation remain in place.

## Fixed versus still blocked / unverified

**Fixed:** M1–M8 above, with narrowly scoped source changes and red/green evidence. All tested isolated mobile states pass.

**Still expected to block:** disabled runtime, false/missing production gate, unavailable delegated adapter, wrong/disconnected wallet, missing session, invalid limits/form or stale/non-executable quote. These guards must remain. There is still no configuration-only way to enable the current Mainnet authorize-and-activate button while keeping production off.

The preceding investigation's exact-head October 14 Preview observation was runtime disabled / production missing→false / execution unavailable / delegated chain null. It does not establish operator intent and is **not a fresh capture of the new source head**. No deployment configuration was altered to repair that state.

**Explicitly unverified:** physical Android/iOS, Safari/WebKit, actual OS keyboard resizing, a live Vercel Chat/browser flow, current new-head Preview environment scope/readiness, real wallet connection/SIWE/session expiry/chain switching, wallet signing, real permission persistence, live activation, approvals, execution/settlement, production build after unrestricted font access, and post-push CI completion. The browser's 500px viewport is only a keyboard-style geometry simulation. No live acceptance is inferred from fixtures.

Before merge: require successful new-head CI/build, authorized GET-only new-Preview readiness capture if desired, operator confirmation of the intended inert Preview posture, and physical/mobile/wallet acceptance under a separately approved safe plan. Do not turn on execution or collect a signature merely to demonstrate this button.
