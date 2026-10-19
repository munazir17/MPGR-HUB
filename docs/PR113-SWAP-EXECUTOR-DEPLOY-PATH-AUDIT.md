# PR #113 — MPGRSwapExecutor deployment-path audit (head `38062e7`)

Audit scope: identify the exact workflow and deployment path for
`contracts/swap/MPGRSwapExecutor.sol`, distinguish it from the legacy
`deploy-executor-base-mainnet.yml` (which deploys `contracts/executor/MPGRExecutor.sol`),
and record the owner / token-allowlist / environment-protection / secrets
configuration **without exposing any secret value**. No workflow was triggered
or approved, no gate was modified, nothing was broadcast, and app routing was
not enabled during this audit.

## 1. The legacy workflow does NOT deploy the swap executor

`.github/workflows/deploy-executor-base-mainnet.yml` ("Deploy MPGR Executor
(Base Mainnet)") verifies source at `contracts/executor/MPGRExecutor.sol:MPGRExecutor`
and runs `script/DeployMPGRExecutorBaseMainnet.s.sol:DeployMPGRExecutorBaseMainnet`.
It has **zero** references to `contracts/swap`, `MPGRSwapExecutor` or
`script/DeployMPGRSwapExecutorBaseMainnet.s.sol` — as does every other file
under `.github/` (grep across `.github/` for `MPGRSwapExecutor|contracts/swap|
DeployMPGRSwapExecutor` returns nothing).

Its current state makes execution impossible and unnecessary:
- Trigger is `pull_request: types: [labeled]` with label `deploy-base-mainnet`
  from this repository only — no `workflow_dispatch`, no push trigger. PR #113
  currently carries **no labels**, so it cannot fire.
- Even if labeled, the `gates` job refuses: it requires committed
  `deploy-config.json .mainnetDeployEnabled == true` (committed value is
  `false`) **and** absence of `deployments/base-mainnet/mpgr-executor.json`
  (the legacy deployment record **exists**) → "refusing a second deployment".
- Last runs of this workflow: 2026-10-01, all skipped/cancelled. Nothing in this
  session invoked `gh workflow run` or applied any label.

Conclusion: reusing that workflow for the new contract is impossible by
construction (wrong script, wrong source path, wrong ABI gates), and re-running
it for the legacy contract is blocked by its own one-shot gates.

## 2. Exact deployment path for `contracts/swap/MPGRSwapExecutor.sol`

**There is no GitHub Actions workflow for it — by design.** The only deployment
path is an owner-controlled, out-of-CI Foundry run of
`script/DeployMPGRSwapExecutorBaseMainnet.s.sol` (`DeployMPGRSwapExecutorBaseMainnet`),
i.e. `forge script … --rpc-url <BASE_MAINNET_RPC> --broadcast --verify`.
Workflows that contain `--broadcast` today: `deploy-executor-base-mainnet.yml`,
`deploy-executor-base-sepolia.yml`, `deploy-delegated-base-mainnet.yml`,
`deploy-delegated-sepolia.yml`, `preflight-delegated-base-mainnet.yml` — none
touch `contracts/swap`. CI (`ci.yml`) only builds/tests (`forge build --force`,
full `forge test`, slither job); it never deploys.

Script gates (source lines 43–72), all currently CLOSED:
1. `block.chainid == 8453` (Base Mainnet only).
2. Env `MPGR_SWAP_EXECUTOR_DEPLOY_ENABLED` must equal `"true"` (default `"false"`).
3. Committed `deployments/base-mainnet/deploy-config.json` must contain
   `.swapExecutorDeployEnabled == true` — the key is **absent** from the
   committed config, so `vm.parseJsonBool` reverts today.
4. `deployments/base-mainnet/mpgr-swap-executor.json` must **not** exist
   (one-shot protection; it does not exist yet).
5. Env `SWAP_EXECUTOR_OWNER` (address ≠ 0) → constructor `initialOwner` (Ownable).
6. Env `SWAP_EXECUTOR_INITIAL_TOKENS` (comma-separated, non-empty) → constructor
   initial token allowlist.
7. Constructor arguments otherwise fixed in-script: canonical Base
   `WETH`/`PERMIT2` constants and exactly four hardcoded `RouterConfig`s
   (UniV3 Router02 + factory, Aerodrome Slipstream + factory, UniV2 Router02 +
   factory, Aerodrome Classic + factory).
8. Post-deploy pins inside the script: `feeBps() == 25` and
   `feeRecipient() == 0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4`.
9. Runbook: fresh dedicated deployer key with nonce 0 (a re-run cannot derive
   the same address).

Fee immutability: `feeBps` (25) and `feeRecipient` are Solidity `constant`s in
`MPGRSwapExecutor.sol` (lines 143/146) — compile-time values no owner, upgrade
or post-deploy call can change; `MAX_FEE_BPS` is also constant 25.

## 3. Owner, token allowlist, environment protection, secrets

| Item | Configuration |
| --- | --- |
| Owner (admin) | Provided at deploy time via env `SWAP_EXECUTOR_OWNER` → `Ownable(initialOwner)`. Owner decision required; the legacy executor's recorded admin (`deploy-config.json .owner`, `0xE0e0…486e`) is the natural candidate but nothing assumes it. Owner can manage the token allowlist post-deploy (`_setToken`), cannot touch fee constants. |
| Token allowlist | Env `SWAP_EXECUTOR_INITIAL_TOKENS` (comma-separated Base ERC-20 addresses), must be non-empty. Owner decision; minimal viable set = the tokens of the first enabled routes (e.g. WETH `0x4200…0006`, USDC `0x8335…2913`, plus MPGR if its pair is enabled). |
| Environment protection | GitHub environment `base-mainnet` exists with protection rule `required_reviewers`; the **legacy** deploy job uses it (`environment: base-mainnet`, line 185). The swap-executor path has **no workflow and therefore no GH environment** — its protection is the script gate stack + owner key custody + post-deploy pins + reviewed-manifest commit. Other environments (`base-sepolia`, `Preview*`, `Production*`) carry no protection rules and are unrelated to this contract. |
| Secrets / variables | The swap-executor path needs **no GitHub secrets**: the deployer key stays with the owner, outside CI. For reference, the legacy workflow *declares* (names only, values never read by this audit): secret `BASE_MAINNET_DEPLOYER_PRIVATE_KEY` (environment `base-mainnet`), optional secrets `BASE_MAINNET_RPC_URL`, `BASE_SEPOLIA_RPC_URL`, `ETHERSCAN_API_KEY`; variables `MPGR_EXECUTOR_OWNER`, `MPGR_EXECUTOR_FEE_RECIPIENT`, `MPGR_MAINNET_DEPLOY_ENABLED`. Listing repo/environment secrets via the API is not permitted for this integration token (HTTP 403), so no secret inventory beyond workflow declarations is claimed. |

## 4. Precise remaining blockers

- **B1 — no CI harness for the swap executor.** Deployment is intentionally a
  manual owner operation. If CI-parity protection (label trigger + environment
  reviewers + fork rehearsal + post-deploy checks) is wanted, a new workflow
  mirroring the legacy one must be authored and reviewed — that is a code
  change requiring your approval; it does not exist today.
- **B2 — config gate closed.** `swapExecutorDeployEnabled` absent from the
  committed `deploy-config.json` (deliberate; adding it is an approval-gated
  commit, ordered *after* the deploy decision and *before* the broadcast).
- **B3 — owner inputs missing.** `SWAP_EXECUTOR_OWNER`,
  `SWAP_EXECUTOR_INITIAL_TOKENS`, `MPGR_SWAP_EXECUTOR_DEPLOY_ENABLED=true` and
  a fresh nonce-0 deployer key exist nowhere in CI or the repo.
- **B4 — network.** Base Mainnet RPC is unreachable from this sandbox; the
  broadcast must run on an owner machine with RPC + optional Basescan key.
- **B5 — activation after deploy.** On-chain pin verification
  (`feeBps()==25`, `feeRecipient()` pin, owner, router kinds) and then commit
  the reviewed `deployments/base-mainnet/mpgr-swap-executor.json` manifest into
  `SWAP_PATH_EXECUTOR_DEPLOYMENT` (`lib/swap/swap-executor-config.ts`) — only
  then do path proposals become executable. Rollback = revert that commit.
- **B6 — legacy workflow quarantine.** `deploy-executor-base-mainnet.yml` must
  never be pointed at the new contract (wrong source/ABI/script) and cannot
  re-run for the legacy one (one-shot gates).

## 5. Exact approval needed from you (nothing else unblocks B-routes)

1. Decision to deploy `MPGRSwapExecutor` on Base Mainnet, with chosen
   `SWAP_EXECUTOR_OWNER` and initial token allowlist.
2. Approval for the two gate-opening edits, in order: commit
   `swapExecutorDeployEnabled: true` into
   `deployments/base-mainnet/deploy-config.json`, and set
   `MPGR_SWAP_EXECUTOR_DEPLOY_ENABLED=true`, `SWAP_EXECUTOR_OWNER`,
   `SWAP_EXECUTOR_INITIAL_TOKENS` plus a fresh nonce-0 deployer key **on the
   deploying machine only**.
3. Approval to run, on that machine:
   `forge script script/DeployMPGRSwapExecutorBaseMainnet.s.sol --rpc-url $BASE_RPC --broadcast --verify`
4. Approval to commit the reviewed manifest into
   `SWAP_PATH_EXECUTOR_DEPLOYMENT` (activates path proposals; revert = rollback).
5. Optional, separate approval: author a label-gated CI workflow for this
   script under environment `base-mainnet` (reviewer-protected) if you want the
   deployment rehearsed and executed through Actions like the legacy one.

Until 1–4 are granted, the repository state remains: legacy routes live,
fixed-fee swap paths fully integrated and tested but inert, all gates closed.
