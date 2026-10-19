# PR #113 — Deployment trust review: PR-controlled code vs. production secrets

Scope: `.github/workflows/deploy-swap-executor-base-mainnet.yml`,
`scripts/swap-deploy/*`, `script/DeployMPGRSwapExecutorBaseMainnet.s.sol`.
Read-only review; no protection, gate or workflow behaviour was changed by it.

## 1. Current protections (verified)

| Layer | Status |
| --- | --- |
| Trigger | Label `deploy-swap-base-mainnet` only; same-repo PRs only (fork PRs rejected by the job `if`); no push/dispatch trigger |
| Environment | Only the `deploy` job declares `environment: base-mainnet`; `can_admins_bypass=false`; `prevent_self_review=true`; required reviewer `munazir17` — verified via API and asserted by `scripts/swap-executor-deployment-workflow.test.ts` + the diagnostics workflow |
| Secrets | `SWAP_BASE_MAINNET_DEPLOYER_PRIVATE_KEY` appears in exactly one workflow, only in the protected `deploy` job; the `gates` job (which runs untrusted-adjacent rehearsal code) has NO production secrets; secret/variable values are not listable by `GITHUB_TOKEN` (403 by design) |
| Order of execution | Preflight (fail closed: committed gate, chain id, nonce 0, multisig owner ≠ deployer, no existing manifest) runs strictly before the single broadcast; manifest sealing strictly after, from the real receipt |
| Gates | `swapExecutorDeployEnabled=false` and `mainnetDeployEnabled=false` committed; `SWAP_PATH_EXECUTOR_DEPLOYMENT=null`; while closed, broadcast is impossible even with approval + valid secrets (empirically demonstrated: run 39153806768 preflight exit 1, broadcast step skipped) |
| Key hygiene | Key only via environment secret → step env → `--private-key` / `vm.envUint`+`vm.addr`; never printed; rehearsal uses generated test-only keys; local evidence stored outside the repo |

## 2. Residual risk: PR-head code executes with the production secret

The `deploy` job checks out `github.event.pull_request.head.sha`. After a human
approves the environment, the following PR-controlled files execute **inside the
job that has `SWAP_BASE_MAINNET_DEPLOYER_PRIVATE_KEY` in its env**:

- the workflow steps themselves (`run:` blocks come from the checked-out ref),
- `scripts/swap-deploy/preflight.sh` / `finalize-manifest.sh`,
- `script/DeployMPGRSwapExecutorBaseMainnet.s.sol` and `contracts/swap/*`.

A head commit that modified any of these could exfiltrate the deployer key or
broadcast different bytecode **after** approval. Mitigations today: same-repo
requirement (write access implied), the reviewer sees the exact head SHA and can
inspect the diff, and gates rehearse the same head before approval. But a
reviewer cannot realistically audit every line of each run, so this remains the
single largest structural risk in the pipeline.

**RESOLVED (this PR):** the risk above no longer exists in the pipeline. The
PR-head workflow was rewritten to gates-only (no environment, no production
secret, no broadcast step — it structurally cannot deploy anything), and a
separate dispatch-only trusted workflow deploys exclusively from
owner-pinned, main-ancestor code (see §3 status below).

## 3. Recommended safer design: deploy only trusted (protected-ref) code

**Recommendation A (target state): deploy from the protected branch, not the PR head.**
- Merge reviewed code to `main` first (PR #113 review serves this).
- The `deploy` job checks out `main` — or better, an exact owner-pinned SHA held
  in a repo **variable** (e.g. `SWAP_DEPLOY_REF`) that only the owner can change.
- The label-on-PR trigger stays as the control plane (identity of the run,
  reviewer approval, PR-comment evidence), but *the code executing with secrets
  is always the protected-branch code*.
- Add `CODEOWNERS` (or branch-protection path rules) requiring owner review for
  `.github/workflows/**`, `scripts/swap-deploy/**`, `contracts/swap/**`,
  `script/Deploy*`, `deployments/**`.

**Interim hardening (usable before merge): pipeline hash pinning.**
- Owner-reviewed `deployments/base-mainnet/trusted-pipeline-hashes.json` pins
  SHA-256 of the workflow, the three scripts, the deploy script and
  `contracts/swap/MPGRSwapExecutor.sol`.
- The `deploy` job verifies every hash **before** any step that can see the
  secret; mismatch = fail closed. The pinned file itself is only changeable via
  reviewed PR to the protected branch.

**Alternatives considered:** immutable signed release tags checked out by SHA
(equivalent to A with stronger provenance); reusable workflow called from a
main-only workflow with secrets (adds indirection, same trust root). Weaker
options rejected: relying on reviewer diff-reading alone; moving secrets to
repo-level (broader exposure); `workflow_dispatch` without environment.

**Trade-off to accept with A:** deployment can only happen after merge — which
matches the intended sequence anyway (code review → deploy config → deployment →
routing activation are separate approvals).

Status: **IMPLEMENTED in this PR** (pending merge + owner pin). Recommendation A
was chosen and built; the interim hash-pinning option is superseded (pinning to
a main-ancestor SHA subsumes it). What now exists in this branch:

1. **PR-side workflow — gates only** (`.github/workflows/deploy-swap-executor-base-mainnet.yml`):
   label-triggered, same-repo-only. Runs lint/type/tests, the committed-gate
   report, all forge swap suites, and the full fork/seeded rehearsal
   (`SWAP_REHEARSAL_OVERRIDE_GATE=true`, test-only keys, local anvil). It has
   **no `environment:`, no access to `SWAP_BASE_MAINNET_DEPLOYER_PRIVATE_KEY`,
   and no `--broadcast` to any public RPC** — approving or compromising this
   workflow cannot produce a mainnet deployment.
2. **Trusted deployment workflow** (`.github/workflows/deploy-swap-executor-trusted.yml`):
   `workflow_dispatch` only, only from `refs/heads/main`, only with the literal
   confirmation input `DEPLOY_ONE_MPGR_SWAP_EXECUTOR`.
   - `resolve-pin` job (no environment, no secrets): validates the repo
     **variable `SWAP_DEPLOY_REF`** — 40-hex, exists, is an ancestor of
     `origin/main`, has `swapExecutorDeployEnabled=true` committed at the pin,
     contains all required deploy files at the pin, and has no existing final
     manifest at the pin.
   - `deploy` job (`environment: base-mainnet`, `needs: resolve-pin`): checks
     out exactly the pinned SHA, then **step 1 verifies `HEAD == pin` and a
     clean tree before any step that can see the deployer secret**. Then:
     fail-closed `preflight.sh` (fresh nonce-0 deployer, deployer ≠ owner,
     committed gate open, no duplicate manifest, chain 8453, and a genuine-Safe
     check of `SWAP_EXECUTOR_OWNER` via `safe-check.sh` — proxy code present,
     canonical Safe singleton in storage slot 0, working
     `getThreshold`/`getOwners`/`VERSION`), one `--broadcast`, `finalize-manifest.sh`
     sealing only a real broadcast receipt, an independent on-chain re-verification
     (pins + safe-check re-run), Basescan source verification, a PR-comment
     evidence summary, and uploaded artifacts.
3. **`.github/CODEOWNERS`**: `@munazir17` required for `.github/workflows/**`,
   `scripts/swap-deploy/**`, `contracts/**`, `script/**`, `deployments/**`,
   activation-relevant config and `foundry.toml`. (Enforcement requires the
   owner to enable "Require review from Code Owners" in branch protection.)
4. **All actions SHA-pinned** in both swap workflows and the diagnostics
   workflow; `zizmor --offline` reports zero unsuppressed findings on all three.
5. **Automated regression proof**: `scripts/swap-executor-deployment-workflow.test.ts`
   (22 tests) asserts gates closed, fee-pin consistency, PR-side secret-free,
   trusted-workflow step ordering / pin validation / environment scope,
   SHA-pinned actions, CODEOWNERS coverage, and offline fail-closed behaviour of
   `preflight.sh`, `safe-check.sh`, `rehearse.sh` and `finalize-manifest.sh`.
   Diagnostics step 8 machine-checks the same trust structure on every run.

Remaining owner-only steps (cannot be done from this branch): merge to `main`,
enable CODEOWNERS enforcement, set the `base-mainnet` environment variable
`SWAP_EXECUTOR_OWNER` (the governance Safe) and repo variable `SWAP_DEPLOY_REF`
(the merged SHA to deploy), resolve the `prevent_self_review` deadlock (second
required reviewer, or have someone other than the approver trigger), and
dispatch. Until then every gate stays closed and no deployment can occur.

## 4. Owner multisig verification standard

`preflight.sh` requires `codesize > 0` for `SWAP_EXECUTOR_OWNER`, which proves a
contract but NOT a genuine, correctly configured Safe. The read-only
`swap-deploy-diagnostics.yml` workflow closes that gap when re-run with the
public `owner_address` input:

1. bytecode present on Base;
2. storage slot 0 (SafeProxy singleton) equals a canonical Safe implementation
   on Base (GnosisSafe 1.3.0 `0xd9Db…9552`, GnosisSafeL2 1.3.0 `0x3E5c…D36E`,
   Safe 1.4.1 `0x4167…461a`, SafeL2 1.4.1 `0x29fc…C762`);
3. `getThreshold()` / `getOwners()` / `VERSION()` respond correctly;
4. threshold ≥ 1 to pass, advisory notice recommending ≥ 2 signers; owners list
   printed (public data) for human review against the intended governance set.

Anything failing 1–3 is rejected: an EOA, a proxy to a non-Safe implementation,
or a malformed multisig cannot pass. The variable's VALUE is not readable by
`GITHUB_TOKEN` or the Arena token (403), so the address must be supplied by the
owner as dispatch input (it is public information, not a secret).

## 5. Diagnostics boundary

`swap-deploy-diagnostics.yml` is deliberately capability-limited: no
`environment:` on any job, no reference to the deployer secret, no broadcast
verbs, no writes to `deployments/` (asserted by a post-run `git diff --exit-code`
check), read-only RPC calls only. It can be run at any time, including while the
protected deploy run sits waiting for approval, without touching any gate.
