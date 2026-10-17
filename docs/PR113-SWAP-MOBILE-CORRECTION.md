# PR113 — Swap pay-first mobile correction and quote lifecycle

This report supersedes the earlier receive-first visual requirement in the DEX UX audit. Scope: MPGR Swap, its quote-refresh API/cache seam, deterministic tests and read-only Preview assertions. No Agent implementation, wallet creation, contracts, shared execution engine, routing, configuration, environment or gate changes.

## Baseline, before editing

Exact inspected baseline: `8bf59aa7196a9b1fa391f1532dc647b630470055`, branch `arena/b8c82200-mpgr-hub`, existing OPEN PR113. The working files were compared against the remote SHA before implementation.

Four deterministic browser reproductions passed at 360×800 and 390×844: receive-first layout, duplicated fee display, receive selection silently reversing the pair, and short expiry needing manual recovery. Logs and four screenshots: `docs/evidence/pr113-mobile-correction/before/`. These are isolated simulated-provider/controller reproductions, not live-wallet or settlement evidence.

## Corrections

- Editable exact-input **You pay** on top, central explicit direction control, executable estimate **You receive** below. Selecting the existing pay token as receive is rejected without changing pay or its amount. An explicit reversal exchanges token identities and balances, seeds the new pay amount only from a still-fresh output, clears the old quote/output, then requotes.
- MAX belongs only beside the pay balance. Integer balances/decimals remain authoritative; native ETH retains the existing twice-estimated Base gas reserve and pre-sign gas recheck. Unavailable/disconnected balances and amounts below 400 atomic units cannot apply MAX; the existing 25bps floor and nonzero fee policy remain enforced.
- Removed the specified banners/disclaimers and duplicate confirmation/history fee displays. Exactly one fee row lives in expandable **Costs & execution details**; the underlying form disclosure is unmounted while confirmation/history is open. Amount, sell asset and collection recipient remain explicit. An expired/unsupported quote cannot claim an executable fee. Only verified settlement evidence promotes the row to collection verified; submission is unverified, and a reverted swap is not collected. Repeated approval fee prose is omitted, while contextual approval consent and other material warnings remain.
- Compact panels and normal-sized amount typography. Long decimal values use a full-width wrapping amount control instead of clipping behind a token button. The native control is recreated after modal focus restoration, retaining its exact React-controlled value; the delayed-history/edit-again regression is retained.
- One review summary, then explicit wallet confirmation. Approval and swap hashes, receipt checks, actual allowance reread, pending/unknown hash recovery, double-submit locks and receipt/event-backed success are preserved.

## Actual clocks and refresh behavior

The quote endpoint stamps `quotedAt` **before** Executor/config/quoter and price-impact RPC work. `buildTradeProposal` gives it the existing conservative 30-second application freshness budget. The unsigned AMM Executor intent normally has a separate ten-minute calldata deadline. The completed response can also come from the existing six-second deduplication cache. Network work, caching, user review and approval therefore consume—not reset—the original freshness budget. The AMM deadline is not permission to extend application/provider validity; there is no new invented provider TTL.

Swap now uses the earliest of response `expiresAt`, original creation plus the existing 30-second cap, and the actual decoded Executor deadline. Invalid/reversed clocks, materially future creation and malformed Executor calldata fail closed. No response timestamp is rewritten. Near confirmation, refresh begins within `min(5 seconds, lifetime/4)`; this also permits genuinely shorter-lived responses instead of endlessly refreshing them.

A strict Swap-only `refreshQuote: true` request bypasses a **completed** cache entry, retaining in-flight coalescing and all default/legacy cache behavior. The API requires the existing strict required-fee policy for this flag. Regressions call the real endpoint and rebuild genuinely changed-output calldata.

Swap no longer supplies the shared execution engine's automatic replacement callback. An expired/near-expiry confirmation refreshes and returns for explicit review. An approval that consumes quote validity remains confirmed, but the new output/minimum is shown and requires another explicit click before any swap signature. Wallet/Base context, amount, route, output minimum, fee configuration and live safety checks still run; a refreshed quote never silently signs. If a provider response is already expired or refreshing fails, execution remains blocked. Provider latency is not masked by extending timestamps.

## Verification

Local unit regression: **3751 passed, 24 skipped**; focused Swap/cache/API/render regression: **101 passed**; tracked TypeScript check: **PASS**; repository lint: **0 errors, 61 existing warnings**; extra final viewport evidence: **8 passed**. Local production build is blocked by the sandbox’s unavailable Google Fonts Inter fetch; no application/font/config workaround was made. Complete browser results, exact pushed SHA and hosted deployment status are recorded in the PR delivery comment after the clean-source run. Evidence is under `docs/evidence/pr113-mobile-correction/after/`.

Coverage includes pay ordering/direct entry, same-token selection, native/token balance reversal and invalidation, MAX/gas/dust, slippage and context changes, shortened expiry, post-approval refresh, changed output/minimum review, actual fresh-cache bypass, stale delayed responses, manual/debounced duplicate requests, approval rejection/revert/retry/unknown status, swap rejection/pending/revert, verified/unverified fee and output receipts, one fee row across review, long decimal clipping, mobile accessibility and a desktop viewport.

Earlier development runs are not final acceptance: one parallel unit run had an unchanged AgentKit import test exceed its existing 5-second limit; serialization preserves the original assertions/timeouts. A browser run during source edits included HMR interruptions, stale copy assertions and the multiline native-control regression; those results prompted correction, not waived assertions.

## Boundaries

All wallet/provider/transaction browser scenarios are explicitly simulated, with external network calls blocked. They do not prove authenticated deployed provider latency, physical mobile wallet behavior, a live signature, a new Base transaction, fee transfer or settlement. The existing automatically triggered read-only Preview workflow may verify deployed public layout and historical chain evidence; it cannot establish live trading acceptance. No workflow dispatch, real signing/broadcast, production write, configuration/secret change, activation or merge is performed. PR113 stays OPEN.
