# PR 113 — MPGRSwapExecutor activation plan (Base Mainnet)

Status: **NOT DEPLOYED, NOT APP-WIRED FOR EXECUTION.** Source, tests and the
app-side integration are complete on this branch. Every typed path route stays
non-executable until the explicit approval steps below are executed by the
operator. There is no environment variable, preview flag or runtime switch that
can activate it.

## What exists today

| Layer | Artifact | State |
|---|---|---|
| Contract | `contracts/swap/MPGRSwapExecutor.sol` | Compiled, 37 Foundry swap cases green (24 executor + 5 venue + 8 deploy-preflight); immutable 25 bps fee to `0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4` (100 bps hard cap, 48 h timelock, Safe-governed); typed 1–3 hop paths (Uni V3, Slipstream, Uni V2, Aerodrome Classic, Pancake V3); measured outputs; no arbitrary calldata, no proxy |
| Contract tests | `test/swap/MPGRSwapExecutor.t.sol` | Fee-floor fuzz, mixed hops, cycle/shape guards, lying/redirecting routers, native in/out, pause/rescue, permit2, reentrancy |
| App integration | `lib/swap/swap-path-*.ts`, `swap-executor-*.ts` | Candidates, pool/quote reads, calldata builder, intent inspector, receipt settlement proof, evidence binding, policy + execution branches |
| Gate | `SWAP_PATH_EXECUTOR_DEPLOYMENT = null` in `lib/swap/swap-executor-config.ts` | Compile-time null; test-only injection hook guarded by `NODE_ENV=test` |
| Deploy script | `script/DeployMPGRSwapExecutorBaseMainnet.s.sol` | Triple-gated dry run by default; deployed only via the dispatch-only trusted workflow against an owner-pinned main-ancestor SHA |

The deployed assisted Executor (`0xD982…505A`) keeps its existing typed
single-hop V3/Slipstream routes unchanged. Its owner-mutable fee recipient
remains a known risk for those legacy routes; the release candidate removes
that risk class for Swap paths by making fee terms compile-time constants.

## Exact approval required to activate

### Phase 1 — deployment (trusted workflow; exactly one broadcast)

1. **Owner decision (human):** review this PR — `.github/CODEOWNERS` puts every
   deploy-critical path under `@munazir17` — and merge it to `main`. Merging
   alone deploys nothing: both committed gates stay `false`.
2. **Gate-open commit:** a separate, reviewed commit on `main` sets
   `"swapExecutorDeployEnabled": true` in
   `deployments/base-mainnet/deploy-config.json`. This commit is the explicit
   owner authorization for one deployment attempt; it is also the pin the
   trusted workflow requires (gate must be open **at the pinned SHA**).
3. **Owner pins code + governance (outside the repo):**
   - repo **variable** `SWAP_DEPLOY_REF` = exact 40-hex SHA of the gate-open
     commit on `main` (only the owner can change it);
   - `base-mainnet` **environment variable** `SWAP_EXECUTOR_OWNER` = the
     governance Safe address (never an EOA, never the deployer);
   - `base-mainnet` **environment secret** `SWAP_BASE_MAINNET_DEPLOYER_PRIVATE_KEY`
     = a fresh nonce-0 dedicated deployer key (value never printed anywhere;
     the key is only in scope inside the `deploy` job, after the pin check).
4. **Dispatch + environment approval:** run the workflow
   `deploy-swap-executor-trusted.yml` from `main` with
   `confirm_deployment = DEPLOY_ONE_MPGR_SWAP_EXECUTOR`; a required reviewer
   approves the `base-mainnet` deployment. `resolve-pin` (secret-free) validates
   the pin: 40-hex, exists, ancestor of `origin/main`, gate open at pin, all
   deploy files present at pin, no final manifest at pin. The `deploy` job
   checks out exactly the pin and its **first step verifies `HEAD == pin` with a
   clean tree before any secret is in scope**.
5. **Fail-closed preflight (`scripts/swap-deploy/preflight.sh`):** chain id
   8453; deployer nonce exactly 0; deployer ≠ owner; committed gate open; no
   existing final/staging manifest; and a **genuine-Safe check**
   (`scripts/swap-deploy/safe-check.sh`) of `SWAP_EXECUTOR_OWNER` — proxy code
   present, a canonical Safe singleton in storage slot 0
   (1.3.0/1.4.1/1.5.0, standard or L2 variant) whose runtime bytecode hashes to
   the code hash published for Base Mainnet in `safe-global/safe-deployments`,
   and working
   `getThreshold()`/`getOwners()`/`VERSION()`. Bytecode alone is explicitly not
   accepted. Any failure aborts before signing.
6. **Exactly one broadcast**, then `finalize-manifest.sh` seals
   `deployments/base-mainnet/mpgr-swap-executor.json` only from the real
   broadcast receipt (placeholder/stale/mismatched records are rejected). The
   workflow independently re-reads every pin on-chain — `feeBps()==25`,
   `MAX_FEE_BPS()==100`, `FEE_TIMELOCK_SECONDS()==172800`, `pendingEffectiveAt()==0`,
   `feeRecipient()==0x96F7…64A4`, `owner()==<Safe>`, `WETH()`, `PERMIT2()`, all
   five router/factory pairs — re-runs the Safe check, verifies source on
   Basescan, comments the evidence on the PR, and uploads artifacts
   (tx hash, block, address, deployer, constructor args, receipt).
7. **Manifest review:** the sealed manifest is committed back via a normal
   reviewed PR; it is the audited source of truth for Phase 2.

### Phase 2 — routing activation (separate review, separate approval)

8. **App activation — the exact and only diff:** flip the single constant in
   `lib/swap/swap-executor-config.ts`. Every `<manifest.*>` placeholder is
   copied verbatim from the sealed, independently reviewed
   `deployments/base-mainnet/mpgr-swap-executor.json`; the compiler
   (`satisfies SwapPathExecutorDeployment`) rejects malformed literals:

```diff
--- a/lib/swap/swap-executor-config.ts
+++ b/lib/swap/swap-executor-config.ts
@@
-/** NOT DEPLOYED. Fill only from a reviewed, on-chain-verified manifest after
- * explicit owner approval; until then every path route stays non-executable. */
+/** DEPLOYED on Base Mainnet — every field copied verbatim from the sealed,
+ * on-chain-verified deployments/base-mainnet/mpgr-swap-executor.json. */
@@
-export const SWAP_PATH_EXECUTOR_DEPLOYMENT: SwapPathExecutorDeployment | null = null;
+export const SWAP_PATH_EXECUTOR_DEPLOYMENT: SwapPathExecutorDeployment | null = {
+  chainId: 8453,
+  executor: "<manifest.executor>",
+  owner: "<manifest.owner>", // governance Safe — never the deployer EOA
+  weth: "0x4200000000000000000000000000000000000006",
+  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
+  deployTx: "<manifest.deployTx>",
+  deployBlock: <manifest.deployBlock>,
+  explorerUrl: "https://basescan.org",
+  venues: [
+    { kind: SwapRouterKind.UNISWAP_V3_ROUTER02, router: "0x2626664c2603336E57B271c5C0b26F421741e481", factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" },
+    { kind: SwapRouterKind.AERODROME_SLIPSTREAM, router: "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F", factory: "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef", quoter: "0x514c8B5f54112481E28028F1166Bd78501089259" },
+    { kind: SwapRouterKind.UNISWAP_V2_ROUTER02, router: "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24", factory: "0x8909dc15e40173ff4699343b6eb8132c65e18ec6", quoter: null },
+    { kind: SwapRouterKind.AERODROME_CLASSIC, router: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43", factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da", quoter: null },
+    { kind: SwapRouterKind.PANCAKE_V3, router: "0x1b81D678ffb9C0263b24A97847620C99d213eB14", factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865", quoter: null },
+  ],
+  feeBps: 25,
+  maxFeeBps: 100,
+  feeTimelockSeconds: 172800,
+  feeRecipient: "0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4",
+};
```

   Tokens stay permissionless on-chain (no token allowlist exists in the
   manifest or the constant). Only after this commit do path quotes become
   available; every proposal still passes fee-floor, calldata-intent, evidence,
   freshness and wallet-preflight simulation checks, and settlement is verified
   from the contract's own `SwapExecuted`/`SwapPathExecuted` events.
9. **Tests required green on the activation diff before it merges:** the full
   swap-path suite (routing/quoting/candidates, calldata-intent inspector,
   approval + Permit2 flows, slippage and fee-floor policy, evidence binding,
   receipt settlement), repo-wide `npm run typecheck`, the complete `vitest`
   run, and all forge suites. Legacy executor route tests must pass unchanged —
   the legacy routes are not touched by activation.
10. **Rollback:** revert the activation commit (constant back to `null`); path
    routes return to discovery-only immediately. Legacy executor routes are
    unaffected in all states. The on-chain contract is immutable, pausable and
    Safe-owned; halting routing never requires on-chain action.

## What activation does NOT change

- No fee-less fallback ever exists; omitted or false client flags cannot weaken
  the server policy.
- MPGR Agent fee logic, Agent APIs, deployed Agent Executor ABI and Campaigns
  remain untouched.
- Discovery, import and metadata validation never authorize execution.
