# MPGR Swap Executor V2 — finalization failure and read-only recovery

Status: **runbook for the failed seal of the one existing V2 deployment.** No new
deployment, no new transaction, no routing activation.

## What happened

| Fact | Value |
| --- | --- |
| Trusted workflow run | [`39294717599`](https://github.com/munazir17/MPGR-HUB/actions/runs/39294717599) (`deploy-swap-executor-v2-trusted.yml`, dispatch from `main`) |
| Owner-pinned commit | `da73b567cdb052ff2bc05456f0a73d9e37ca8299` |
| Deploy step | **SUCCESS** — one `CREATE` broadcast |
| Create transaction | `0xb8682c025c17ab8322040dfeec58dfe1fa62a880f5ba7edf7972e84ed10bc35b` |
| Expected executor | `0x4be1154440b26145d76608D41d403a33e76b9d0A` |
| Seal step | **FAILED** — `contract 0x4be1…d0A does not have any code` |
| Chain evidence | Basescan shows the transaction succeeded and the created contract has runtime bytecode |

### Root cause

`https://mainnet.base.org` is a load-balanced endpoint. The broadcast was
confirmed by the node that accepted it, and `cast receipt` was served by a node
that knew the block, but the **first `eth_call` in the seal step was routed to a
read replica that had not yet ingested the deployment block**. `cast call`
therefore aborted with "contract … does not have any code" before any pin could
be compared. The pre-hardening seal script had **no runtime-code wait, no
retries and a single RPC**, and it also tolerated a receipt with **no**
`contractAddress` — so it could neither ride out nor diagnose replica lag.

The deployment itself is intact; only the *sealing* (the local manifest write)
failed. The staging manifest and the broadcast artifact were uploaded by the
run's `if: always()` artifact step, so the exact deployment facts are available
for a read-only replay.

## Why a recovery is safe (and what it is NOT)

* **No new transaction.** Recovery never calls `forge script`, `cast send` or
  `--broadcast`; it refuses to run if `BASE_MAINNET_DEPLOYER_PRIVATE_KEY` or
  `PRIVATE_KEY` is in scope, and the recovery workflow has no `environment`, no
  secret mapping and no write permission on repository contents.
* **No V1 change.** The active V1 executor and everything it depends on is
  asserted byte-identical (`git diff --exit-code`) by the recovery workflow.
* **No V2 activation.** `lib/swap/swap-executor-config.ts` (V1 routing) and
  `lib/swap/v2/discovery.ts` (`V2_DEPLOYMENT = null`) are asserted untouched.
  Activation remains a separate, explicit, human-reviewed change.
* **One-shot gate.** `deployments/base-mainnet/deploy-v2-config.json` is
  flipped to `consumed: true, swapExecutorV2DeployEnabled: false` only by a
  successful seal; a re-dispatch of the trusted deployment workflow refuses a
  duplicate (manifest present at the pin or on `main`).

## Recovery procedure (read-only)

### A. GitHub Actions (recommended, no local setup)

Two gated, read-only triggers exist:

* **PR label** — on a same-repository PR that contains this workflow, apply the
  label **`recover-swap-v2-finalize`**. This is the reviewer-gated pattern used
  by `swap-deploy-diagnostics.yml` and is how the recovery runs before the
  workflow exists on `main`. Fork PRs are rejected; the label path never
  receives a secret.
* **workflow_dispatch** — from `main` (or any reviewed branch) once merged,
  requiring the confirmation string below.

Both use the same expected values (dispatch inputs override the defaults):

| Value | Dispatch input | Default |
| --- | --- | --- |
| confirmation | `confirm_recovery` = `RECOVER_SEAL_ONE_MPGR_SWAP_EXECUTOR_V2` | (label path needs none) |
| source run | `source_run_id` | `39294717599` |
| create tx | `expected_tx` | `0xb8682c025c17ab8322040dfeec58dfe1fa62a880f5ba7edf7972e84ed10bc35b` |
| executor | `expected_executor` | `0x4be1154440b26145d76608D41d403a33e76b9d0A` |
| trusted pin | `trusted_pin` | `da73b567cdb052ff2bc05456f0a73d9e37ca8299` |

The job refuses to proceed unless the named run actually is the trusted V2
workflow at that pin, its **deploy step succeeded** and its **seal step
failed**. It then downloads the run's artifact, validates the recorded `CREATE`
against `expected_tx`/`expected_executor` (exact match, case-insensitive), and
seals only after every on-chain re-read below agrees on **both** `mainnet.base.org`
and an independent endpoint (defaults: `base-rpc.publicnode.com`,
`base.llamarpc.com`, `base.drpc.org` — override with the `alt_rpc` input).

On success: the sealed manifest is uploaded in the
`mpgr-swap-executor-v2-seal-recovery` artifact and posted as a PR comment; on
failure: **nothing is sealed**, the exact mismatch plus all recovered evidence
is preserved in the same artifact, and no verification is claimed.

### B. Local CLI (same script, same guarantees)

```bash
# read-only, keyless; needs gh auth with actions:read and foundry's cast
export RECOVERY_EXPECTED_PIN=da73b567cdb052ff2bc05456f0a73d9e37ca8299
bash scripts/swap-deploy-v2/recover-finalize.sh \
  39294717599 \
  0xb8682c025c17ab8322040dfeec58dfe1fa62a880f5ba7edf7972e84ed10bc35b \
  0x4be1154440b26145d76608D41d403a33e76b9d0A \
  https://mainnet.base.org https://base-rpc.publicnode.com
```

The script writes `recovery-evidence/` (gitignored): the failed run's
`source-run.json`/`source-run-jobs.json`, the downloaded staging/broadcast
artifact, the finalize failure log, and — on success — the sealed manifest and
the consumed gate. Any re-run refuses to reseal (final manifest present).

## What the seal verifies before writing anything

1. **Chain identity** — `cast chain-id` is `8453` on both endpoints.
2. **Runtime bytecode propagation** — bounded `codesize` polling (default 36 ×
   5 s) before the first `eth_call`; still zero ⇒ fail closed
   (`executor … still has NO runtime code … no manifest sealed`).
3. **Exact CREATE** — the broadcast artifact contains exactly **one** `CREATE`;
   `eth_getTransactionByHash` shows `to == null`, `from == deployer`,
   `nonce == 2`, `chainId == 0x2105`; the receipt's `transactionHash`,
   `contractAddress`, `from`, `blockNumber`, `blockHash`, `gasUsed` are the
   recovered values (a receipt **without** `contractAddress` is rejected).
4. **Derived address** — `cast compute-address <deployer> --nonce 2` equals the
   executor (offline RLP/keccak derivation, immune to replica lag).
5. **Independent second RPC** — receipt, tx, nonce, `to`, initcode, codesize,
   runtime `codeHash` (`eth_getProof`, when served), every pin and every router
   kind must be identical on both endpoints; any disagreement or empty read
   fails closed. Several endpoints may be configured: one that cannot answer a
   bounded probe is skipped, but an endpoint that answers and disagrees is a
   hard failure and no further candidate is tried.
6. **Governance pins** — `feeBps() == 25`, `MAX_FEE_BPS() == 100`,
   `FEE_TIMELOCK_SECONDS() == 172800`, `pendingEffectiveAt() == 0`,
   `feeRecipient() == 0x96F7…64A4`,
   `owner() == 0xd9aE…994B` (SafeL2 1.5.0, threshold 2), `WETH`/`PERMIT2`.
7. **Five router registrations** — `routerKind(router)` matches the manifest for
   Uniswap V3 (2), Slipstream (1), Uniswap V2 (3), Aerodrome Classic (4) and
   Uniswap V4 (7).
8. **Manifest completeness** — a real 32-byte `deployTx`, `deployBlock > 0`,
   five venues, identity fields, no `pending-record`, receipt and derived
   CREATE address equal to the executor. Only then is the final manifest
   written, the staging record removed and the V2 gate consumed.

Retry exhaustion (default 8 bounded attempts with capped linear backoff) and
every mismatch above produce `FINALIZE FAIL: …` and leave **no** final
manifest; the staging manifest stays in place as evidence.

## After a successful recovery (still no activation)

1. Review the sealed manifest (`deployments/base-mainnet/mpgr-swap-executor-v2.json`)
   and commit it together with the consumed gate
   (`deploy-v2-config.json`: `swapExecutorV2DeployEnabled: false`, `consumed: true`)
   in one reviewed PR. Nothing else changes.
2. Leave `lib/swap/swap-executor-config.ts` (active V1 routing) and
   `lib/swap/v2/discovery.ts` (`V2_DEPLOYMENT = null`) untouched.
3. Optional: verify source on Basescan for the executor (independent of this
   recovery; no transaction).
4. V2 routing activation requires a **separate explicit approval** that flips
   `V2_DEPLOYMENT` to the sealed manifest and passes the existing V2 activation
   checks. Do not combine it with the manifest commit.

## Regression coverage (offline, no RPC/key/tx)

* `scripts/swap-deploy-v2/finalize-manifest.test.sh` — 48 checks: propagation
  delay (code after 2 empty polls), missing code (bounded exhaustion), receipt
  `contractAddress`/`from`/`transactionHash` mismatch and missing
  `contractAddress`, retry exhaustion (exactly N bounded reads), second-RPC
  disagreement on pins/receipts/router kinds, wrong derived CREATE address,
  non-CREATE tx, chain drift, multiple CREATEs, optional `eth_getProof`.
* `scripts/swap-deploy-v2/recover-finalize.test.sh` — 35 checks: run identity
  (workflow/pin/conclusion/deploy-success/seal-failure), artifact tx/executor
  integrity, already-sealed staging, workspace purity, keyless guard, evidence
  preservation on failure.
* `scripts/swap-v2-finalize-recovery.test.ts` — runs both suites and asserts the
  workflow trust structure (dispatch-only, confirmation string, no environment,
  no secret mapping, least-privilege permissions, SHA-pinned actions, V1/V2
  routing guards).
