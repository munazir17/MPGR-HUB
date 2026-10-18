# PR #113 — Multi-venue DEX routing architecture (Base Mainnet first)

Audited head at task start: `c8b89ad`. This document describes the routing and
execution architecture delivered by commits `a94247f`, `0fdf35a`, `9c7c022`,
`117951f`, `ca514ec` on top of it.

## 1. Venue matrix (typed adapters, all factory-verified)

| Kind | Venue (Base) | Router | Factory | Quote source |
| --- | --- | --- | --- | --- |
| 2 UNISWAP_V3_ROUTER02 | Uniswap V3 | `0x2626…41e481` | `0x3312…FDfD` | quoter `quoteExactInputSingle` |
| 1 AERODROME_SLIPSTREAM | Aerodrome Slipstream | `0x698C…A92F` | `0xf8f2…61Ef` | quoter |
| 3 UNISWAP_V2_ROUTER02 | Uniswap V2 | `0x4752…aD24` | `0x8909…8eC6` | router `getAmountsOut` |
| 4 AERODROME_CLASSIC | Aerodrome Classic | `0xcF77…4E43` | `0x420D…40Da` | router `getAmountsOut(Route[])` |
| 5 PANCAKE_V3 (new) | PancakeSwap V3 | `0x1b81…eB14` | `0x0BFb…1865` | simulated typed hop (no quoter pin) |
| 6 ZEROX_SETTLER (new) | 0x aggregated liquidity | dynamic Settler (authenticated) | n/a | 0x Swap API v2 quote |

Kind values 1–4 keep their previous meanings; the enum is interface-based, so
additional venues with an identical interface (e.g. other UniV3 forks) can be
allowlisted post-deploy via `setRouter` without new code. Pancake V3 uses the
UniV3-shaped `exactInputSingle` **without** a deadline field; the trade-level
deadline bounds the transaction instead.

## 2. Permissionless token execution model (threat model)

Tokens are NOT allowlisted. Execution safety derives from invariants that hold
for any contract that behaves like a standard ERC-20:

| Threat | Mitigation (on-chain) |
| --- | --- |
| Counterfeit/malicious pool | Hop pool must equal the router's own factory lookup for the pair/fee/spacing/stable flag, and have code |
| Rogue router | Routers/factories stay allowlisted per typed kind; unknown router reverts |
| Fee-on-transfer / rebasing sell token | Exact received-amount check reverts (`UnsupportedTransferAmount`) |
| Honeypot (sell blocked) | `transferFrom` pull reverts → swap reverts; UI risk signals warn before signing |
| Token impersonating infrastructure | `TokenIsInfrastructure` / `TokenNotAContract` checks (router, factory, executor, codeless) |
| Output theft / lying router | Output measured as balance delta at the enforced recipient; `amountOutMinimum` from a fresh quote |
| Dangling approvals | Exact single-use allowance, zeroed after every leg |
| Trapped input | Post-trade input balance must equal pre-trade balance |
| Fee bypass | Atomic `floor(gross*feeBps/10000)` transfer inside the swap; delivery verified; failure reverts everything |
| Reentrancy | `nonReentrant` on every entry point |
| Aggregator calldata | See §3 |

Imported tokens are discoverable, quotable and risk-assessed wherever supported
liquidity exists; absence of a pool/quote surfaces as "No route found", never as
a promise.

## 3. Aggregator (0x) security design

- Quote source: `GET {ZEROX_API_BASE}/swap/allowance-holder/quote` (Base), header
  `0x-version: v2`, optional `0x-api-key` (env `ZEROX_API_KEY`). Without a key
  the venue reports unavailable — no silent degradation.
- Payload validation (server): `transaction.to` address, hex `data`, `value`
  must be 0, allowance spender must equal the canonical AllowanceHolder
  `0x0000…22734`, numeric `buyAmount`/`minBuyAmount`.
- On-chain authentication: `swapViaAggregator` requires
  `IERC721(ZEROX_SETTLER_DEPLOYER).ownerOf(2) == agg.target` at execution time —
  the quote's Settler must be the current taker-submitted Settler per the 0x
  deployer registry. Rotated targets revert.
- Exposure containment: zero `msg.value`; single exact `(G − fee)` approval to
  AllowanceHolder (never to the Settler, per 0x guidance); input consumption and
  output measured afterwards; min-out enforced; atomic fee unchanged.
- What we do NOT do: no Permit2 double-signature flow (a contract cannot sign),
  no raw API calldata outside the authenticated-settler call, no aggregator
  allowances beyond the single-use one.
- Evaluation notes: 0x Swap API is live on Base and aggregates 100+ sources
  including RFQ liquidity unreachable by public AMM adapters; API key + 0x terms
  apply (commercial use per 0x docs); Settler contracts are public/verified.
  Alternative considered: O1/odos-style intent APIs — rejected for this release
  because their execution models require off-chain signer custody or solver
  permissions that conflict with the taker-confirm flow. Re-evaluation is a
  follow-up, not a claim.

## 4. Route comparison and splits

- Every candidate (direct, 2-hop, 3-hop, aggregator) is quoted at the same
  pinned block; ranking uses **net output in output-token atomic units**:
  `net = quotedOut − gasUnits × gasPriceWei × nativeToOutputRate / 1e36`
  (exact integer arithmetic, `lib/swap/route-ranking.ts`).
- Split routes: up to 4 same-pair legs in ONE atomic transaction
  (`swapExactInputBatch`), per-leg fee/minimum/measurement. A split is proposed
  only when `Σ legNets − extraGas > bestSingleNet`; otherwise the single route
  wins and no split is shown.
- No fabricated liquidity: candidates without a factory-verified pool or with a
  zero/failed quote are dropped with honest statuses.

## 5. Fee governance (selected policy, on-chain)

- Initial 25 bps; hard cap `MAX_FEE_BPS = 100`; changes only via
  `proposeFeeChange` → `FEE_TIMELOCK_SECONDS = 48h` → `applyFeeChange`
  (permissionless apply after delay), `cancelFeeChange` by owner.
- No immediate setters, no fee-less entry point; pending state and all terms
  exposed via `feeGovernance()`; events `FeeChangeProposed/Applied/Cancelled`.
- Recipient pinned at construction to `0x96F7…64A4` and re-verified by the
  deploy script and deployment workflow; ownership expected to be a multisig
  (`SWAP_EXECUTOR_OWNER`), enforced at deploy verification.
- UI, quote and contract all use `floor(gross × feeBps / 10000)` with the same
  integer arithmetic; the manifest pins the verified `feeBps`.

## 6. Multichain-ready configuration

`SWAP_CHAIN_REGISTRY` maps chainId → venues/weth/permit2/manifest/explorer.
Base (8453) is the only populated entry; adding a chain = registry entry +
`deployments/<chain>/` manifest + deployment approval. No cross-chain routing is
implemented or claimed.

## 7. Security review & gas

- Slither 0.11.6 (high/medium): single remaining result is the known upstream
  OZ `Math.mulDiv` incorrect-exp false positive. New annotations document why
  `msg-value-loop` (batch reverts on nonzero `msg.value` before looping) and
  `reentrancy-balance` on `swapViaAggregator` (pre/post equality IS the
  containment check, entry nonReentrant, callee authenticated) are by design.
- Manual review points: allowance containment per leg, registry-authenticated
  aggregator target, permissionless-token checks, governance timelock path,
  no proxy/upgrade surface, renounce disabled, pause cannot trap funds.
- Gas (mock venues, `forge test --gas-report`): `swapExactInput` avg ≈ 388k
  (max ≈ 943k for 3 hops), `swapExactInputBatch` (2 legs) avg ≈ 348k,
  `swapViaAggregator` avg ≈ 91k plus real Settler calldata. Live gas varies
  with pool state; fork/live measurements accompany deployment evidence.

## 8. Honest limitations

- Fork tests skip without `BASE_MAINNET_RPC_URL`; live settlement was NOT
  performed in this sandbox (RPC blocked).
- 0x venue needs an API key and on-chain Settler authentication at trade time;
  without either it stays non-executable.
- Pancake V3 quotes use simulation reads; venues without a live pool for a pair
  are skipped, not faked.
- Fee-on-transfer and rebasing tokens remain unsupported by design (exact
  economics only); honeypots are warned, not magically made tradable.
