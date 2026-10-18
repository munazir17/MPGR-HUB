# PR 113 — MPGRSwapExecutor activation plan (Base Mainnet)

Status: **NOT DEPLOYED, NOT APP-WIRED FOR EXECUTION.** Source, tests and the
app-side integration are complete on this branch. Every typed path route stays
non-executable until the explicit approval steps below are executed by the
operator. There is no environment variable, preview flag or runtime switch that
can activate it.

## What exists today

| Layer | Artifact | State |
|---|---|---|
| Contract | `contracts/swap/MPGRSwapExecutor.sol` | Compiled, 22 Foundry cases green; immutable 25 bps fee to `0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4`; typed 1–3 hop paths (Uni V2, Aerodrome Classic, Uni V3, Slipstream); measured outputs; no arbitrary calldata, no fee setters, no proxy |
| Contract tests | `test/swap/MPGRSwapExecutor.t.sol` | Fee-floor fuzz, mixed hops, cycle/shape guards, lying/redirecting routers, native in/out, pause/rescue, permit2, reentrancy |
| App integration | `lib/swap/swap-path-*.ts`, `swap-executor-*.ts` | Candidates, pool/quote reads, calldata builder, intent inspector, receipt settlement proof, evidence binding, policy + execution branches |
| Gate | `SWAP_PATH_EXECUTOR_DEPLOYMENT = null` in `lib/swap/swap-executor-config.ts` | Compile-time null; test-only injection hook guarded by `NODE_ENV=test` |
| Deploy script | `script/DeployMPGRSwapExecutorBaseMainnet.s.sol` | Triple-gated dry run by default |

The deployed assisted Executor (`0xD982…505A`) keeps its existing typed
single-hop V3/Slipstream routes unchanged. Its owner-mutable fee recipient
remains a known risk for those legacy routes; the release candidate removes
that risk class for Swap paths by making fee terms compile-time constants.

## Exact approval required to activate

1. **Owner decision (human):** approve deploying `MPGRSwapExecutor` on Base
   Mainnet with `owner` = operator multisig (no EOA), initial router allowlist
   (four canonical venues + factories) and an explicit initial token allowlist.
2. **Config gate:** set `"swapExecutorDeployEnabled": true` in
   `deployments/base-mainnet/deploy-config.json` (committed, reviewed) and run
   with `MPGR_SWAP_EXECUTOR_DEPLOY_ENABLED=true` and `SWAP_EXECUTOR_OWNER=<multisig>`
   plus `SWAP_EXECUTOR_INITIAL_TOKENS=<csv>` using a fresh nonce-0 deployer:
   `forge script script/DeployMPGRSwapExecutorBaseMainnet.s.sol --rpc-url $BASE_RPC --broadcast --verify`
   Without the env gate or config key the script reverts before any broadcast.
3. **On-chain verification:** confirm `feeBps()==25`,
   `feeRecipient()==0x96F7…64A4`, `routerKind/routerFactory` per venue,
   `isTokenAllowed` per token, verified source on BaseScan, and the deploy tx
   nonce/creator.
4. **App activation:** commit the reviewed manifest into
   `SWAP_PATH_EXECUTOR_DEPLOYMENT` (executor address, deployTx, deployBlock,
   venues, tokens). Only then do path quotes become available; every proposal
   still passes fee-floor, calldata-intent, evidence, freshness and
   wallet-preflight simulation checks, and settlement is verified from the
   contract's own `SwapExecuted`/`SwapPathExecuted` events.
5. **Rollback:** revert the manifest commit (or set it back to `null`); path
   routes return to discovery-only immediately. Legacy executor routes are
   unaffected in all states.

## What activation does NOT change

- No fee-less fallback ever exists; omitted or false client flags cannot weaken
  the server policy.
- MPGR Agent fee logic, Agent APIs, deployed Agent Executor ABI and Campaigns
  remain untouched.
- Discovery, import and metadata validation never authorize execution.
