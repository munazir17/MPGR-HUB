# PR #113 — dedicated MPGR Swap and command-first Agent

Date: 2026-10-17. Scope baseline: `bb70ec86cf394f7412b2d053df3f1b4d33475d10`. Work stays on `arena/b8c82200-mpgr-hub`; PR remains open and unmerged.

## Delivered scope

- **`/swap`** is the dedicated manual trading surface, linked from desktop navigation and the mobile menu. It reuses the existing manual quote form/controller and the existing confirmation modal, `useTradeQuote`, wallet authentication and execution hooks. It does not introduce an executor or transaction builder.
- **Agent has no Manual tab or duplicate manual swap form.** Command-generated proposals remain reviewable through the same handler. Chat, market intelligence, status handling and Autonomy remain; the Autonomy panel keeps its mounted state when closed.
- Swap supports local catalog name/symbol/address search and explicit **exact Base contract import**. Import uses the existing resolver behind a new read-only `POST /api/trade/token` boundary: trusted origin, registered session, separate wallet/IP 30-per-minute limits, 1KiB JSON limit, exact address and numeric chain 8453 validation, no-store/request IDs. Unknown contracts must pass the existing bytecode/ERC-20/metadata reads. Imported metadata stays local to that wallet/network-mounted form.
- Import selects the explicitly labeled buy token; it is not endorsement, a security audit, liquidity evidence or trading permission. Unverified choices are labeled with an address suffix, and full sell/buy addresses remain visible. ETH and WETH remain distinct choices. Quotes independently resolve contracts again; browser-imported decimals, symbols and verification flags are **not** sent as authoritative quote input.
- **Sized swap quotes and route requests use executable prepare-for-review proposals**, not a reference-price answer. Unsized price questions retain the read-only path, now labeled “Reference quote (not executable).” No quote or chat command authorizes a signature or broadcast.
- Known applied MPGR fees, minimum received, slippage and route information are disclosed; missing network/protocol cost estimates are explicitly not assumed zero. Swap has on-demand quote details and uses exact atomic formatting so a small positive output/minimum is not presented as zero.
- Executable **limit orders are explicitly unavailable**. No signing, storage, submission, cancellation or settlement integration was added. [The separate protocol comparison and approval proposal](BASE-LIMIT-ORDER-PROPOSAL.md) explains the compatibility blockers.

## Audit before implementation

The clean baseline was inspected before source edits. The relevant paths were the existing launcher/manual form, token resolver/discovery/request parsing, quote/price guards, routing and Executor/fee precedence, deterministic provider and routed AI preflight, confirmation/execution hooks and mobile fixtures. Important findings and resulting decisions:

| Finding | Small compatible change / preserved behavior |
| --- | --- |
| Arbitrary Base contract validation already existed in `resolveSwapToken`. Discovery was not validation or liquidity proof. | Reused it behind a guarded read-only import endpoint; no new registry/provider or browser-trusted metadata. |
| Manual form lived inside Agent, but already had abort/version, edit, expiry and wallet/network invalidation plus explicit 401 retry. | Moved/reused it on Swap; retained those controls and shared confirmation/execution. Removed the old Agent Manual surface rather than maintaining two forms. |
| Default routed AI already sent clear orders through deterministic prepare-only tools before the model. Conditional parsing preceded spot orders. | Extended the existing preflight for route/sized-quote requests. Added deterministic input refusals to the routed provider, fallback and shared tool-loop entrance, without changing AI provider configuration. |
| “Show me the best available route…” was not reliably recognized, and generic quote-only handling could return reference data. | Narrow leading-verb normalization preserves the original operands/amount. Sized quotes prepare for review. Replies explicitly state that executable alternatives were not compared. |
| Existing quote API gives registered MPGR Executor pairs authority; falling back on an Executor failure would silently drop its fee. | Quote API and Executor routing remain unchanged, including fail-closed behavior. |
| Direct crypto router is CDP → conditional 0x fallback; eligible B20 routing uses existing Aerodrome support, bypassing known CDP/0x rejection. | Router unchanged. No all-provider comparison, generic Aerodrome fallback, new route or “best route” claim. |
| Protocol limit orders use different signed-order/settlement mechanisms. | Research only; an Agent trigger is never relabeled as a protocol order. |

## Commands and safety boundaries

| Input | Expected behavior and evidence |
| --- | --- |
| `Buy $10 of ETH on Base` | Existing USDC-budget prepare flow. Offline integrated test traverses the real parser, tool runtime, quote API and Executor builder; native ETH remains the proposed output, with the existing internal WETH/unwrap semantics, not a WETH substitution. |
| `Swap 20 USDC to WETH` | Exact 20 USDC sell amount and WETH output. Same offline integrated path verifies one existing Executor transaction and 25bps fee math. |
| `Buy AAPLc if its price falls below $200` | Review-only draft retaining AAPLc, the $200 trigger and missing spend amount (`null`). It is not activated, signed or converted to a spot swap. Existing goal-bound permission and server activation gates remain mandatory. |
| `Show me the best available route for 100 USDC to ETH` | Current executable priority-route quote for review, not a claim that alternatives were compared. Integrated offline test verifies exact 100 USDC, ETH identity/unwrap and atomic fee fields. |
| `Quote 20 USDC to ETH` | Executable quote proposal for review, still requiring explicit confirmation. An unsized market-price question remains reference-only. |
| Explicit non-Base `on …` / `chain …` request | Specific Base-8453 clarification before model/tool preparation. Base Sepolia is not Base Mainnet. |
| Alternative/multiple assets or multiple orders | Clarification/refusal rather than selecting a first alternative or preparing multiple orders. Ambiguous `Buy 2 ETH` is not silently treated as a 2-USDC budget; B20's existing share/dollar parsing is preserved. |
| Executable limit-order request | Explicit “not integrated” refusal, not an autonomy goal or local executable-looking draft. |
| Import succeeds but quote fails | Token may be selected with an unverified warning, but no reviewable/executable proposal or success is manufactured. |

The model still does not select a router, calldata, minOut, broadcaster or signing key. A quote is not authorization. Existing freshness, quote refresh/change checks, wallet/network binding, balance/allowance checks, approval/Permit2 handling, explicit confirmation and receipt-status handling remain in their original controllers. Unavailable gas/cost estimates are not fabricated. Provider availability, gas funding and settlement are not guaranteed by a metadata import or by a quote.

## Fees and routing: what is and is not claimed

- Existing registered Executor routes retain the **25bps fee on the gross sell amount**, including sell-token decimals, floor rounding and same-transaction collection. The Executor remains authoritative; a failed quote does not escape to a non-fee route.
- Existing MCP/provider-native fee behavior remains unchanged. No native fee parameters, calldata, signing domain, Permit2 witness or fee recipient were changed.
- Existing direct browser CDP/0x/Aerodrome proposals can have `agentFee.status = skipped`. This PR does **not** invent collection for those routes; it makes “MPGR fee: not applied on this quoted route” visible. It does not claim that every imported token/route now collects 25bps.
- No separate fee transaction, duplicate fee or new execution path was introduced. Protocol/provider costs are shown only when quoted; missing values are not presented as zero.
- B20's established Aerodrome compatibility is preserved. This is not a promise of liquidity for every B20 token or arbitrary imported asset, nor a universal CDP→0x→Aerodrome retry chain. Missing credentials, paused/unissued tokens, absent pools and rejected routes remain real blockers.

## Validation record

| Verification | Result |
| --- | --- |
| Complete offline Vitest suite | **3,668 passed**, 24 opt-in skipped; 286 passed files, 5 skipped; exit 0, no unhandled errors |
| Mobile Playwright | **108 passed**: 54 cases each at 360×800 and 390×844; 38 real-controller/simulated HTTP-wallet cases plus 70 review/layout cases |
| TypeScript | `npx tsc --noEmit` passed |
| Lint | 0 errors; 59 existing warnings |
| Diff check / Preview probe syntax | Passed |

[Validation summary](evidence/pr113-swap-agent/validation.txt) and [38 safe simulated API traces](evidence/pr113-swap-agent/simulated-api-traces.json) are retained. **These are offline/simulated outcomes, not authenticated Preview/provider acceptance or real-wallet signing/settlement.**

Representative screenshots (simulated data/transport, actual production components):

| Size | Swap / verified simulated receipt | Imported contract, unavailable route | Preview-gated local goal review |
| --- | --- | --- | --- |
| 360×800 | [Swap confirmation](evidence/pr113-swap-agent/simulated/360-swap-simulated-confirmation.png) | [Import refusal](evidence/pr113-swap-agent/simulated/360-import-no-route.png) | [Authorization disabled](evidence/pr113-swap-agent/simulated/360-autonomy-preview-blocked.png) |
| 390×844 | [Swap confirmation](evidence/pr113-swap-agent/simulated/390-swap-simulated-confirmation.png) | [Import refusal](evidence/pr113-swap-agent/simulated/390-import-no-route.png) | [Authorization disabled](evidence/pr113-swap-agent/simulated/390-autonomy-preview-blocked.png) |

The historical **before** images at [360](evidence/pr113-p0/simulated/360-manual-simulated-confirmation.png) and [390](evidence/pr113-p0/simulated/390-manual-simulated-confirmation.png) are bb70-era isolated-controller evidence of the old Agent Manual placement, not fresh live deployed evidence. Current images show the dedicated Swap component and no Manual launcher. Native viewport screenshots/PNG captures are browser emulations, not physical-device acceptance.

### Coverage added or reused

- `app/api/trade/token/route.test.ts`: real origin/body checks with mocked auth/rate/resolver boundaries; anonymous refusal before RPC; separate wallet/IP limits; numeric Base chain enforcement; exact-address/metadata errors; no liquidity/permission/proposal fabrication.
- `lib/trade/__tests__/token-import.test.ts`: malformed/wrong-chain/address-mismatched import responses fail; imported UI selection never supplies trusted metadata to the quote API; no route means no proposal.
- `lib/architecture/ai/__tests__/command-first-swap.test.ts`: requested commands, sized quote, no model loop for clear orders, exact ETH/WETH/amount identity, non-Base/ambiguous/limit-order refusals, actual prepare errors and no success claims.
- `app/api/trade/quote/executor-fee-route.test.ts`: **real parser → tool runtime → existing quote API → real unsigned Executor builder** for the three spot/route examples, with mocked session/RPC/pool results; decodes gross amount, 25bps fee and native unwrap fields. Existing opposite-direction, B20 and approval/fee tests retained.
- Existing trade resolver, routing, quote/cache, confirmation, execution, fee-both-directions, wallet rejection, stale/change, insufficient balance, approvals/Permit2, receipt failure and autonomy server/security suites remain applicable; no assertions or gates in these engines were relaxed.
- Mobile fixtures now render the **actual `SwapExperience`**, auth/quote/confirmation/execution controllers and actual Autonomy controls. Only wallet/connector transport, HTTP data/persistence and receipts are simulated. Sizes: **360×800 and 390×844**. Added import/search/unavailable-route cases, wallet invalidation and insufficient/rejected/reverted execution; retained goal-bound activation/refusal/retry cases and review-layout coverage.

### Test changes explained

Removal of the Manual tab is the new requirement, so tests now assert its absence and retain command-proposal review. Route disclosure now permits the **0x venue name**, while still rejecting raw contract dumps, calldata and implementation/debug text. Skipped fees are now disclosed instead of omitted. Mobile assertions target the Swap dialog/controller rather than the old Agent controller and check the existing wallet refusal wording (“declined”), disabled action, no broadcast and no success.

The broad local suite exposed the SDK's fire-and-forget analytics request in `invoke.test.ts`, producing unrelated unhandled TLS rejections against a blocked host. Its test now uses the **same exact telemetry-only mock already present in `prepare-only-wallet.test.ts`**, keeping the real SDK, policy action and signing-denial assertions; unexpected network requests still fail. No production telemetry, environment setting or failure assertion was changed, and unhandled errors were not ignored.

## Preview/provider evidence is separate

The existing automatic PR Preview probe was updated to compare **bb70 baseline Agent Manual → current command-first Agent plus mobile-menu `/swap`**, alongside local goal review with authorization disabled. It uses anonymous browser GETs, blocks browser writes/external hosts, and expects unauthenticated quote/import POSTs to refuse before RPC/providers. It does not connect a wallet or obtain signatures. It is not an authenticated provider-health test.

Commit-specific hosted/deployed status, anonymous screenshots and safe refusal annotations are available from [PR #113 checks](https://github.com/munazir17/MPGR-HUB/pull/113/checks). The workflow remains automatic; no dispatch, environment/secrets edit or production deployment was performed. Artifact download may be blocked in this sandbox by external storage redirects; a linked artifact is not claimed as locally inspected imagery.

**Unverified / not performed:** authenticated Preview quotes and arbitrary-token reads against live RPC; live CDP/0x/Aerodrome health, route availability and fee settlement; physical mobile/wallet acceptance; real approval/Permit2/goal authorization signatures, order signatures, trades, broadcasts or decoded live fills. Anonymous 401 is session-gate evidence, not evidence that a provider works. Limit-order service access, fee equivalence and unchanged-Executor compatibility remain blocked as detailed in the research proposal.

## Unchanged production/security surfaces

Relative to bb70, no contract, deployment, Executor, fee-math/collection, existing quote API, routing implementation, signing/Permit2 domain/witness, confirmation/execution hook, autonomy server/persistence/permission gate, provider configuration or reward-system source was changed. No `experimental_fallback` was introduced. No production switch, emergency KV value, deployment environment, secret or signing key was edited. Production execution remains disabled; simulated ready fixtures do not create real authorizations. No merge was performed.
