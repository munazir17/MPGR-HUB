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

Status: **not implemented** — changing the deployment trust design requires the
owner's explicit approval; this document is the recommendation only.

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
