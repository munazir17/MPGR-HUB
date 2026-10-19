# MPGR Swap V2 — undeployed candidate, not a release

## Deployment status

**No Base transaction has been sent. No V2 address, deployment transaction,
block or sealed manifest exists. App routing is unchanged.** The V1 executor,
its manifest and its consumed deployment gate are unchanged.

PR #119 is already an ancestor of this work; its permissionless picker changes
have not been reverted.

## Implemented candidate

- Separate `MPGRSwapExecutorV2.sol`, not an upgrade of the deployed executor.
- Constructor enforces the deployed governance Safe address
  `0xd9aE570767C5a15780DD5cdAdd0b1b732D98994B`, code present, not deployer.
- Initial 25 bps, hard cap 100 bps, nonzero fees only. Recipient permanently
  pinned to `0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4`.
- Only owner proposes/applies after 48h. No immediate setter or renunciation;
  ownership cannot be transferred back to the deployment origin.
- Approval, ERC-2612 and Permit2 input authorization; measured exact pulls,
  output minima, deadlines, reentrancy protection, pause/rescue.
- Typed v2/v3/Slipstream/Classic adapters. V3 no longer restricts fee tiers
  to a hardcoded four-tier list; canonical factory resolution decides.
- Typed v4 PoolKey and authenticated unlock/swap/settle/take callback,
  including native currency normalization through WETH. No v3 lookup for v4.
- One-to-three-hop paths and up to four split paths. One input pull and
  one gross-input fee per transaction, including split routes; measured legs,
  cleared allowances, no per-leg fee rounding.
- Pancake and 0x kinds cannot be enabled. No aggregator/Settler call entry.
- Separate deployment script, closed V2 gate, preflight, manifest finalizer and
  trusted pinned-SHA workflow. Existing deployment key mapping is retained.
  A reviewed observed nonce (not nonce zero) prevents retrying the same CREATE
  after an incomplete receipt/finalization step. Preflight checks deployer
  identity, genuine Safe, chain, gas balance and venue/factory code/identity.

## Local evidence

- Solidity 0.8.24 compile succeeds; candidate runtime bytecode below EIP-170 limit.
- `forge test --match-path 'test/swap/*'`: **58 passed**, including 20 V2 tests
  and 256 fuzz cases for gross-fee split rounding.
- V4 tests are explicitly **mock ABI/lifecycle fixtures**, not real Base pools.
- `npm run typecheck`: passed.
- `npx vitest run lib/swap`: **26 files / 477 tests passed**. These verify the
  existing app, not new V2 address wiring.
- Shell syntax checks passed. Closed V2 preflight rejects before reading keys.
- Proof-result guard checked against success, absent suite, missing coverage and
  skipped outcomes. Synthetic guard checks are not fork evidence.

## Still required; release must not be activated

1. Implement and run the complete real-Base V2 fork suite, including actual MPGR
   v4 PoolKey/hooks discovery, direct non-major pairs, Aerodrome, and a real
   no-direct-pool multi-hop example. **No venue has fork-passed for V2 yet.**
2. Confirm every deployment address against chain and official deployment
   sources. The v4 constant is the expected address, not a completed verification.
3. Implement V2 quote/transaction ABI integration and liquidity-derived discovery
   of tiers, spacings, v4 keys and intermediates. Existing app search still has
   fixed WETH/USDC bridge candidates; this change does not claim to fix that.
4. Prove direct-first routing, executor simulation, net-output split optimization,
   and `LIQUIDITY_UNAVAILABLE` without sending for arbitrary imported pairs.
5. Complete deployment-pipeline rehearsal and tests, including finalizer failure
   paths and source-verification constructor arguments.
6. After code review, pin on main, obtain environment approval, verify gas,
   broadcast exactly once, seal receipt and pins, persist the consumed V2 gate
   and manifest, then activate the app against independently verified chain data.

The trusted V2 workflow intentionally requires
`test/swap-fork/MPGRSwapExecutorV2BaseFork.t.sol`, which does not yet exist.
Missing tests or skipped tests cannot qualify a deployment. The gate is closed
and the reviewed deployer nonce is unset. Do not manufacture a manifest or
open this gate to bypass missing proofs.

Base RPC access from this sandbox failed with an SSL connection error. No gas
balance or deployed venue was read successfully here. This is a partial
implementation suitable for a draft PR, **not the requested completed launch**.
