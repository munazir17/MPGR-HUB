# MPGR Swap — routing audit & completion scope (2026-10-19)

Audit of the repository for Phase 2 ("Jumper/Relay-style multi-DEX routing").
PR #117 (typed-path activation) was **merged 2026-10-19 09:55 UTC**
(merge `f9fd1ff`) and its Vercel **Production** deployment succeeded
(09:57 UTC). Every claim below about contract mechanics is backed by the
fork suites in `test/swap-fork/`, not by unit mocks.

## Execution paths and providers (what exists)

| # | Path | Where | Fee enforcement | Status on the strict Swap endpoint |
|---|------|-------|-----------------|-------------------------------------|
| 1 | Legacy MPGRExecutor, registered routes (USDC↔WETH UniV3, B20 stocks Slipstream) | `lib/executor/*`, `swap-route-selection.ts` | On-chain, inside the executor | Live |
| 2 | MPGRSwapExecutor typed paths — UniV2, Aerodrome Classic, UniV3, Slipstream (Pancake registered but inoperable, see #117) | `lib/swap/swap-path-*.ts` | On-chain, inside the executor | Live since #117; fork-proven vs the deployed contract |
| 3 | MPGRSwapExecutor `swapViaAggregator` — 0x Settler | contract + `lib/swap/zerox-quote.ts` + `buildAggregatorTransaction` | Designed on-chain, but **inoperable as deployed** (finding 1 below) | **Not wired — and must not be** until a new executor fixes the mechanics |
| 4 | MPGRSwapExecutor split batch (`swapExactInputBatch`) | contract + `buildSplitBatchTransaction` | On-chain per leg | Dormant builder; optimization only — left unwired, noted as future work |
| 5 | Coinbase CDP Trade API (`trade-cdp-client.ts`) | Agent/MCP + legacy trade surfaces | None (fee-skipped Agent endpoint) | **Unsupported for strict Swap**: executes outside the fee-enforcing executor |
| 6 | 0x direct AllowanceHolder (`trade-0x-client.ts`) | Agent fallback when CDP rejects a token | None through our executor | **Unsupported for strict Swap** (same reason) |
| 7 | 0x native integrator fee (`zero-ex-native-fee.ts`) | MCP/Agent path | 0x `swapFeeBps` plumbing, outside our executor | **Unsupported for strict Swap**: fee would not be collected/proven inside the reviewed executor path |
| 8 | Aerodrome Slipstream direct (`aerodrome-slipstream.ts`) | Agent B20-stock flow | Legacy executor registration | Covered by paths 1/2 |

Route selection: legacy registered candidates first, then typed path
search; inside a search, the highest **measured** quoted output wins (pool
quotes are read on-chain at a pinned block, never provider-claimed). Price
impact is computed post-selection (`estimateQuotePriceImpactBps`) and
surfaced with acknowledgement warnings ≥5% / ≥10% (`token-risk.ts`).

## Findings (in order of severity)

1. **The aggregator leg (`swapViaAggregator`) cannot settle any genuine
   0x payload as deployed.** The executor authenticates `agg.target`
   against the 0x deployer registry (`ownerOf(2)` = taker-submitted
   Settler) and calls it directly, after exact-approving `G − fee` to the
   AllowanceHolder. But a Settler can only collect the sell token inside
   an `AllowanceHolder.exec(operator, token, amount, target, data)` call —
   the holder records an *ephemeral* (transient) allowance that the
   Settler then debits via `holder.transferFrom` — or via a Permit2
   signature from the payer. In the deployed wiring nobody calls `exec`,
   the ERC-20 approval to the holder is inert, and the Permit2 branch
   would need a signature from the payer = the executor, which cannot
   sign. The API's real shape (`to` = AllowanceHolder, `data` = `exec(…)`)
   is rejected by the executor's own registry check; the executor's shape
   (`target` = Settler, `data` = `execute(…)`) authenticates and then
   reverts in the payment step. **Proven on a Base fork against the
   deployed contract**: a hand-encoded genuine payload (TRANSFER_FROM +
   UNISWAPV3 USDC→WETH@500, the 0x-settler `AllowanceHolderPairTest`
   pattern) settles through `holder.exec` (control), while both feedable
   shapes revert atomically through the executor with no funds moved
   (`testFork_Deployed_SettlerControlSettlesDirectly`,
   `testFork_Deployed_AggregatorShapesRevertKnown`, run `39235403415`).
   Consequence: **no app-side wiring can make this leg executable.** It is
   deliberately left unwired (quotes-only client, `zerox-quote.ts`), and
   the fork tripwires must flip to success assertions in the same reviewed
   change that ever deploys a fixed executor. This is also why MPGR's
   Uniswap V4 pool (finding 4) cannot be reached through the aggregator
   today, regardless of 0x's V4 support.
2. **Evidence outcomes cap (8) < candidate count (up to 10)** —
   `swapPathRoutingEvidenceValid` rejected any winner whose search
   evaluated >8 candidates, i.e. **every token↔token pair where neither
   side was WETH/USDC could never quote**. Dormant bug, shipped in #117;
   fixed here by binding the cap to `MAX_SWAP_PATH_CANDIDATES`, with
   regression tests at the unit and search level.
3. **Discovery key space too narrow** — direct candidates tried only
   UniV3 fee 3000 and Slipstream spacing 10, missing the deepest Base
   pools (UniV3 500, Slipstream 100) and Classic stable pools. Widened
   here within the existing candidate/time budgets (Slipstream
   100/10/200/50/2000/1, UniV3 500/3000/100/10000, Classic volatile+stable,
   V2; bridge legs follow the deep keys; cap 14→20). Every key is still
   factory-verified on-chain by the executor at execution — widening can
   only add real routes, never fake them.
4. **MPGR has no supported-venue pool** (from #117): launched via o1 on
   Uniswap V4 (MPGR/ETH). No UniV2/V3/Slipstream/Classic/Pancake MPGR pool
   exists at any probed tier/spacing, and the deployed executor has no V4
   adapter. Given finding 1, the aggregator cannot bridge this today.
   Deterministic options remain: seed a typed-venue pool (operator funds
   decision — not taken here), or deploy a V4/Settler-capable executor
   (plan below).
5. **Pancake V3 inoperable** (from #117): adapter ABI ≠ live router ABI.
   Never candidated; tripwire fork tests guard the state.

## What a fixed aggregator/V4 executor requires (plan only — nothing deployed)

The deployed contract is immutable; `swapViaAggregator` cannot be rescued
by governance (router re-registration does not apply — the registry check
and direct-call mechanics are code, not configuration). A successor
executor should:

- Route the aggregator leg through the holder ceremony itself: the
  executor (holding `G − fee` after slicing) calls
  `AllowanceHolder.exec(settler, tokenIn, G − fee, settler, executeData)`
  where `settler` is authenticated against the 0x deployer registry
  (`ownerOf(2)`, accepting `prev(2)` during rotations per 0x's
  `requireGenuineSettler` guidance), `executeData`'s recipient is the
  taker, and output is still enforced by measured balance deltas with the
  atomic 25 bps fee — preserving every existing safety invariant.
- Optionally add a native Uniswap V4 adapter in the same deployment
  (Permit2/Universal-Router-free direct PoolManager accounting is
  nontrivial; the Settler route already reaches V4 pools the 0x router
  indexes, which covers MPGR's o1 pool only if 0x indexes it — to be
  confirmed empirically with a configured API key before promising it).

Migration follows the PR #113/#117 playbook verbatim: reviewed source +
fork suites (the tripwires flipped to success assertions are the acceptance
test) → new sealed manifest → Safe-owned deployment via the pinned-SHA
workflow → config pointer swap in a reviewed PR → fork verification at the
new address → production smoke. The current executor keeps serving all
typed routes meanwhile; users approve the new address per trade as today.
**No deployment, funding, or governance action is requested implicitly by
this document.**

The Pancake venue, by contrast, needs no new deployment: a Safe
transaction re-registering `PANCAKE_V3` to a no-deadline-compatible router
(if one is ever identified on Base) plus fork re-verification suffices.

## Runtime configuration

No changes in this phase. `ZEROX_API_KEY` remains unused by the strict
Swap endpoint (the quotes-only client is dormant); `BASE_RPC_URL` guidance
from #117 stands. One correctness fix landed without behavior change:
`ZEROX_API_BASE` now points at the v2 host `api.0x.org` (the legacy
per-chain host is v1-only), so the dormant client is at least pointing at
the real API if a future executor ever makes it usable.
