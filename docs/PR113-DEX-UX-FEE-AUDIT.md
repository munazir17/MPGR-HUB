# PR113 — Swap UX, execution and fee audit

Date: 2026-10-17 (IST). Baseline inspected before edits: **`4aa22fd3c354c7242dcd01b193e7a4e4c0c87237`**, clean working tree, PR #113 open. Scope: Swap, opt-in quote/execution safety seams and test/evidence infrastructure. Agent product code, provider implementations, contracts, Executor ABI/config/intent/fee maths, authorization and production settings remain unchanged.

This is an engineering implementation/verification report, **not a claim of unrestricted production readiness**. Simulated wallet transport, historical recorded logs, fresh read-only RPC evidence and authenticated end-to-end trading are different evidence classes.

## 1. Reproduction and root causes — all eleven requested areas

Before editing production source, ran the existing real-controller mobile cases for the successful approval→swap path and declined wallet request at both requested sizes: **4 passed**. Passing here reproduces the old behavior, not the requested new UX. Captures and exact baseline run are in [before evidence](evidence/pr113-dex/before/). The declined-wallet capture shows the old terminal error/disabled action. Source audit below establishes absent UX controls. The user's specific historical failed/missing-fee transaction was not supplied; we do not claim to reproduce that unidentified transaction.

| # | Baseline reproduction / root cause | Implementation / recovery |
| --- | --- | --- |
| 1. Direction | `SwapForm` placed sell and buy selects side-by-side, no reversal, and one sell amount; visual order did not match receive-first requirement. | Receive panel first, pay second. Output is read-only/estimated; only pay input supplies `fromAmount`. Reversal exchanges exact addresses and uses the previous **fresh output**, with that output token's decimals, as the new pay amount. Without a fresh output the pay amount is cleared. Every edit invalidates the old quote. |
| 2. DEX layout | Static selects, permanent address paragraphs, large Base/chain heading and raw bps field occupied the main form; no balance/activity controls. | Compact Base indicator, glyph/monogram token chips, large amount fields, exchange rate, actual provider and available impact, material minimum/fee/risk summary, expandable costs/addresses. Native modal dialogs provide focus containment, Escape handling, scroll containment and accessible labels. No issuer logo or USD valuation is invented. |
| 3. Slippage | Permanent number input exposed bps without a settings interaction. | Presets 0.1/0.5/1%, custom 0.01–5%, integer-bps validation, high-slippage warning above 1%, documented existing 1% default, browser-session preference. Applying settings invalidates and requotes; minimum is the actual server/encoded minimum, never locally rewritten calldata. |
| 4. Confirmation | Prepare → intermediate quote/details → Review → confirmation dialog. | A debounced executable quote and concise in-panel summary, then **Confirm Swap** opens actual transaction review. Its explicit **Confirm & Swap** starts the existing execution engine. No intermediate Review screen. No wallet writes from input, search, settings, automatic quoting or import. |
| 5. Fee inconsistency | Main form's MPGR `agentFee.status=skipped` and old modal's generic “Swap fee” describe **different fees**: the latter is `fees.protocolFee`. CDP/0x/direct Aerodrome browser proposals can omit MPGR collection. An amount displayed or provider fee is not evidence of MPGR payment. | Swap explicitly separates **Provider fee**, estimated network fee and **MPGR fee**. Swap requests `requireMPGRFee:true`; server and client independently refuse non-compliant quotes. Existing Executor 25bps collection is preserved. No new provider fee implementation, recipient replacement or transfer is introduced. Agent's backward-compatible quotes stay unchanged. |
| 6. Approval dead end | Old modal only allowed `executionState=IDLE`; rejection/failure moved to ERROR with no retry path. Execution waited for approval status but did not re-read allowance afterward, and could use a quote that expired while approval mined. | Explicit approval cancelled/reverted/receipt-unknown states; exact-amount approval; successful receipt bound to wallet/token and actual mined hash; actual allowance reread. Revalidate before swap; expired quotes require a fresh explicit review while retaining allowance. Retry reads allowance and skips duplicate approval. Unknown approval receipt blocks a second approval until status check. Submitted swaps cannot be resubmitted from the dialog. |
| 7. Collection evidence | Old browser execution treated a success receipt as SUCCESS without using the already-existing Executor event verifier; its comment assumed fees had been taken even for fee-less routes. The expected environment fee wallet can also be confused with the Executor's separate authoritative recipient. | Swap success requires exact `SwapExecuted` receipt verification through `verifyExecutorReceipt`; output, fee, recipient and route must match. Quoted/submitted/verified/reverted states are distinct. Independent read-only historical audit additionally checks ERC-20 fee Transfer logs. See fee ledger below; no retroactive recovery or fresh live trade was performed. |
| 8. Token selector | Isolated search box filtered native selects and an “import as buy” button, rather than a coherent selector. | Searchable selector by symbol/name or exact address; full contract identity per result; selected check; known glyph or safe monogram; no-results/invalid/loading/error states. Pasted contracts are offered only after the existing authenticated Base metadata validation, including already-cataloged contract addresses. Duplicate symbols never collapse identities. Metadata is escaped and control/bidi characters stripped from displayed names. Import is not endorsement/liquidity. |
| 9. Balances/MAX | No wallet token balances or maximum control in the form. | Read ERC-20 balance + decimals for the exact selected contract/account on Base; native ETH uses native balance, never WETH. Wallet/network/selection/revision keys reject late responses from another context. Refresh after approval/swap outcomes and periodically. ERC-20 MAX uses exact live units; native MAX obtains a real candidate quote and Base L1+operator+L2 gas estimate, reserves **2×** that estimate and requotes the new amount. Gas/read failure never invents a maximum. |
| 10. History | No Swap activity component or trustworthy history source integration. | Compact session activity dialog records only actual submitted wallet hashes. Approval and swap have separate hashes/status/links; recorded local submission time is labelled. Actual output/collected fee appears only with matching receipt proof. Status refresh binds the exact submitted hash/wallet/target/input/value and reads receipts; failures stay pending/unverified, not failed. This is **not an external wallet index**: up to 20 session entries, cleared by page close, and scoped to the current wallet/Base. Honest empty/error states; no invented history or browser-storage confirmation authority. |
| 11. Providers/quotes | Existing provider priority and eligible Executor/Uniswap/Aerodrome/B20 paths are genuine; importing alone never made all contracts routable. Existing hooks already had important stale/balance/wallet controls, but no strict Swap fee-consumer policy. | Reuse the same API, router, Executor builders, calldata, approvals and explicit wallet execution. Preserve Executor-first proven pairs and the existing CDP→0x→Aerodrome provider priority elsewhere. Swap blocks a fallback that cannot safely collect its required fee instead of silently waiving it. No comparison/best-route claim. Live balances/allowance, wallet/network, fee config, actual encoded token direction/recipient/minimum, gas and freshness are checked before relevant signatures. |

## 2. Fee lifecycle and authoritative recipient

### Mechanism (not changed)

`G = fromAmount` in the **pay token's atomic units**; `F = floor(G × 25 / 10,000)`; `N = G − F`. BUY/SELL UI terminology never changes the fee basis. Dust below 400 atomic units cannot produce a nonzero 25bps fee and must not execute as a waived-fee swap.

1. Existing quote builder reads the Executor's **live `feeBps()` and `feeRecipient()`**. It quotes the pool for **N**, not G.
2. For ERC-20 input, the wallet approves the existing Executor for **G**, only if actual allowance is short. Approval is not payment or a swap.
3. The one swap transaction targets the **existing Executor**, commits `expectedFeeAmount=F`, gross input, route, output minimum, recipient and deadline. Native input attaches value G; native output preserves WETH as the internal leg with unwrap flags.
4. The unchanged Executor transfers F to its own fee recipient and swaps N atomically. A failed fee transfer or later swap failure reverts the whole swap and its fee. Network gas can still be spent.
5. `_finish` measures actual output by balance delta, checks minimum, performs native unwrap/send if needed, then emits `SwapExecuted`. Swap uses the existing verifier to check receipt status/from/to, exact event emitter/intent/taker/router/tokens/gross/fee/bps/fee recipient/native flags, `fee + net = gross`, and output ≥ reviewed minimum. Only then are output and MPGR collection labelled verified.

**There is no separate MPGR fee transaction, no post-swap transfer, no server signing key and no changed Executor bytecode.**

### Recipient sources

- Executor: **`0xD982726e28275661F8aB64054E6b17a70a63505A`** (Base 8453).
- Recorded fee recipient: **`0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4`** in `deployments/base-mainnet/mpgr-executor.json` and `lib/executor/executor-config.ts`. This is public deployment metadata, **not proof of today's on-chain state**.
- Swap's authoritative recipient is the **on-chain Executor getter**, read at quote time and checked again before signing. The UI shows that quoted recipient in advanced details and the verified receipt's recipient in activity.
- `MPGR_AGENT_FEE_RECIPIENT` / `NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT` serve the **existing MCP 0x-native integrator-fee fallback**, not this browser Executor path. They must not override the Executor recipient. Tests deliberately set a different public env address and prove it is not substituted. These are test stubs, not deployment configuration edits.
- No deployment environment secret/value was requested, invented or changed. The deployed public env's actual value is not claimed verified or relevant to the Swap recipient.
- `scripts/read-swap-fee-audit.mjs`, called by the existing automatic Preview check, reads chain ID, code and current recipient/bps/paused at a pinned block, and the two historical receipts/transactions/transfers below. It writes safe public evidence to the Preview artifact/annotation. If RPC reads fail, the result is **unverified**, never a fallback “live” recipient. No workflow dispatch or live transaction is used.

### Route/status ledger

| Route | Calculated / included in transaction | Submitted / confirmed collected |
| --- | --- | --- |
| Executor USDC↔WETH, Uniswap V3 | Exact gross-pay-token fee; net pool quote; fee committed inside existing calldata. Covered by real API/builder tests. | New task executions: **simulated only**. Two older captured mainnet events below verify fees for those specific transactions; read-only workflow evidence separately determines whether current RPC/Transfer checks succeeded. |
| Native ETH↔USDC through registered WETH leg | Same gross fee, paid as native ETH on native input, USDC on opposite direction; correct value/unwrap identity. | New task: simulated receipt proofs only. No fresh native-fee settlement claim. |
| Executor USDC↔eligible live B20, Aerodrome Slipstream | Exact fee in **pay asset**, e.g. USDC for BUY, AAPLc at its actual decimals for SELL; original adapter/allowlist preserved. | New task: simulated only. No live B20 fee receipt claimed. |
| Direct CDP / 0x / Aerodrome browser fallback without provable MPGR collection | Existing legacy `agentFee=skipped` is **not** an MPGR charge; provider protocol fees are not substituted. | **Blocked on Swap**, 422 and pre-signature policy refusal. No fee transfer/waiver. Agent/MCP behavior is not reconfigured. |
| Dust / unsupported pair / missing or changed fee configuration | Fail closed; no safe 25bps commitment. | No signature or swap submitted by this path. |

### Historical evidence available before this task

The repository already contains raw calldata and the final Executor event transcribed from BaseScan on 2026-09-26 in `lib/mcp/__tests__/base-mainnet-live-fixtures.ts`. These are **historical recorded facts**, not newly generated trades, current prices or fresh receipt requests. The new Swap verifier replays both literal captured events successfully; the separate workflow audit requires matching fresh ERC-20 Transfer evidence before claiming a fresh re-verification.

| Historical transaction | Gross input | Captured fee / asset | Captured recipient |
| --- | --- | --- | --- |
| [0x935607…75ab3](https://basescan.org/tx/0x935607b73388e7d53263577d1b6856708b01cecf1911f991fe2c78850fd75ab3), block 51804466, USDC→WETH | 1 USDC | 2,500 units = **0.0025 USDC** | `0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4` |
| [0xd7d3a9…d55c6](https://basescan.org/tx/0xd7d3a9098ec3615e9dee82a710531f345c96b52c746aef1d65402614a66d55c6), block 51804590, WETH→USDC | 0.0001 WETH | 250,000,000,000 units = **0.00000025 WETH**, not native ETH | same |

These do not explain an unidentified user's transaction or prove all expected fees were received. Possible distinct cases must not be conflated: a fee-skipping direct route, provider protocol fee mistaken for MPGR, a different expected wallet, an approval with no submitted swap, a reverted swap, WETH/ERC-20 fees not visible in a native-ETH balance, or unavailable verification. No missing-fee reimbursement/recovery is attempted.

## 3. Approval versus swap evidence and recovery

- Production execution engine remains `lib/trade/trade-execution.ts`. Swap supplies opt-in safety callbacks; Agent's controller is not replaced. Fixed the existing malformed global in-flight key to actual `wallet:proposalId`.
- Allowance is read for the exact pay token/wallet/Executor; approval calldata is `approve(Executor, G)`, never unlimited. A submitted hash is exposed while awaiting receipt.
- Verify approval receipt wallet/token/status, track a repriced receipt's actual hash, then re-read allowance. Receipt success with insufficient/unreadable allowance cannot reach swap signing.
- Before swap: recheck live account/network, quote deadline/freshness, token decimals/balance, allowance, known route/calldata/recipient/minimum/fees, live fee configuration and Base total gas budget. Failed reads fail closed. Wallet/network changes after approval stop the next prompt.
- Expiry while approving yields an explicit refresh/review step, not expired calldata. A successful standing allowance is reused on retry. Authentication expiry during recovery requires explicit SIWE retry, not an invisible signing request.
- Approval rejection: **Approval cancelled**, no hash/payment claim, retry allowed. Approval revert: receipt failure, no swap. Swap rejection: **Swap cancelled**, not on-chain failure; confirmed approval retained. Swap revert: fee rolled back; gas may be spent.
- Approval receipt unknown: **check status** before another approval. Swap submitted but receipt/proof unavailable: keep swap hash, show unverified, offer status check, **not resubmit**. Receipt success without correct fee event is not Swap success.
- Local tests exercise double clicks, rejection/revert/retry, allowance still zero, receipt RPC failure, wrong approval wallet, post-approval expiry, auth expiry and wallet/network changes. Transport fixture uses **different approval and swap hashes**, applies allowance only after successful receipt, and changes simulated balances from simulated receipts exactly once.

## 4. Validation / evidence

Final local verification of this implementation:

| Check | Result |
| --- | --- |
| Full Vitest | **3,737 passed / 24 intentionally skipped**, 289 passing files, zero unhandled errors, exit 0. Includes Agent/authorization/Executor regressions. |
| Full mobile | **142 passed**, 71 at each size, 6.3 minutes: 64 Swap + 8 Autonomy + 70 existing review cases. Real controllers with isolated transport, not live wallet acceptance. |
| TypeScript | **PASS**, including freshly generated official Next route types (`next typegen`), no ignored build/type errors or source workaround. |
| ESLint | **0 errors / 61 warnings**: 59 existing plus two Swap effects (hydrated session preference and confirmed-swap reset). Warnings are not suppressed. Test-wallet render mutation warning was corrected with a layout effect. |
| Policy / engine / audit / quote API focused run | **81 passed**; incorporated into full suite above. |
| JavaScript syntax + whitespace | Both verification scripts `node --check` and `git diff --check` **PASS**. |
| Local production bundle | **BLOCKED by sandbox network**, `next/font` cannot fetch Inter from `fonts.googleapis.com`. No font/app config change or mocked-font production build. After the failed Webpack attempt, stale generated Webpack route-type scaffolding was cleared and the official `next typegen` route validator passed. Hosted exact-head build must be judged separately. |

Summaries, eight final-state PNGs, 72 isolated controller API traces and the history-race negative control are in [evidence](evidence/pr113-dex/README.md). Exact-head hosted CI/Preview results belong to the delivery PR check/comment and their immutable run/artifact URLs, not the previous PR113 acceptance counts.

- New pure policy tests: integer slippage/limits, fee applicability, BUY/SELL/native asset identity, encoded minimum, recipient/route/value manipulation, matched/mismatched/missing/duplicate event, archived literal mainnet events, safe MAX.
- New real-controller tests: existing `executeTrade` plus Swap's safety callbacks, actual intent/fee/receipt verifiers, mocked wallet/RPC boundary only. No live key/signature.
- Real quote API tests cover strict fee opt-in, all three fee-less provider branches, malformed opt-in, public env non-substitution, and policy isolation across the existing cache; existing Agent parser→tool→API→Executor tests retained.
- Mobile uses actual Swap/auth/execution/Autonomy components and controllers at **360×800 and 390×844**; only HTTP responses, gas/RPC/wallet transport and receipts are isolated fixtures. Existing 70 review/layout cases and Autonomy lifecycle regressions remain. No assertions are relaxed to permit a transaction, missing proof or gate bypass. A late historical receipt is bound to its originating review session and current snapshot, so it cannot promote a newly opened review. The isolated negative-control test reproduced false success with that guard removed; the restored implementation passed both sizes. See `history-race-negative-control.txt`.
- Existing automatic deployed probe verifies anonymous current Swap receive/pay entry, compact settings invalid value, honest empty session history, no Agent Manual controls and production-gated goal review; unauthenticated quote/import POSTs must reach **401**, not providers. It additionally records the independent read-only Base fee audit. This is not authenticated trading acceptance.

## 5. Remaining limits / unsupported combinations

- Arbitrary Base contracts can be validated and selected; that never guarantees a fee-compliant executable route. Non-Executor fallback routes are blocked on Swap until an approved collection-compatible path exists. No provider replacement or unapproved protocol is implemented.
- Only existing registered pairs/adapters are eligible; ETH↔WETH wrapping and arbitrary multi-hop/token combinations are not invented as new 25bps routes. Unissued/non-live B20s remain unavailable. Missing liquidity, unsupported contracts, dust and RPC/provider failures remain real blockers.
- Limit orders remain explicitly unavailable, not disguised drafts/alerts.
- Gas reserve is an estimate with a 2× buffer, not a guarantee under future gas volatility. Native MAX requires an executable candidate quote and working Base total-fee estimator; otherwise it is refused.
- Activity is a bounded browser-session view, not a full indexed wallet history, and does not survive page close. No unavailable remote history is fabricated.
- Execution proof uses the existing **direct Executor receipt** verifier. Wallets whose account-abstraction/batched outer receipts do not match its from/to expectations remain unverified rather than successful; live wallet/connector-specific receipt acceptance has not been performed. No signature/route validation is relaxed to accept an unknown wrapper.
- Contract fee amount is committed in calldata, but the unchanged contract does not bind a future fee-recipient rotation in calldata. Pre-signature live checks detect observed changes; a concurrent owner change can still cause post-receipt recipient mismatch. Such a receipt is unverified in the UI, never reported as paid to the quoted recipient. Eliminating that race would need separately approved contract semantics, not a client fiction.
- Authenticated Preview quote/provider health, real wallet approvals/signatures, fresh trades, native/B20 fee transfers and physical-device acceptance are **not performed**. Fresh read-only historical evidence, if available, applies only to its exact hashes and observation block.

## 6. Files / rollback / operational safety

The exact changed-file manifest is retained in `docs/evidence/pr113-dex/changed-files.txt`. Source groups: `components/features/swap/*`, `hooks/useSwap{Balances,Execution}.ts`, `lib/swap/*`, the optional strict quote-policy section in `app/api/trade/quote/route.ts`, compatible execution safety seams in `lib/trade/trade-execution.ts`, isolated browser/quote tests, and read-only verification scripts. No Agent product file, contract/deployment/config, provider implementation, signing/Permit2 domain, reward feature, package dependency or autonomous authorization server is edited. One existing AgentKit test has a narrowly scoped telemetry-HTTP fixture: its real SDK/action/allowlist assertions are preserved, unexpected network still fails, and globals are restored after each test. This fixes the three unhandled background analytics errors exposed by the restricted offline environment, not Agent behavior.

No `MPGR_AUTONOMOUS_AGENT_ENABLED`, `AUTONOMOUS_PRODUCTION_ENABLED`, emergency KV, production environment, secret, signing key or deployment setting was changed. No real wallet signature, live approval, swap, fee transfer, transaction broadcast, goal authorization or workflow dispatch was initiated. Automatic PR CI/Preview checks are allowed; PR remains open/unmerged. Rollback is the Swap-scoped patch relative to the recorded baseline; no on-chain rollback or environment toggle is required.
