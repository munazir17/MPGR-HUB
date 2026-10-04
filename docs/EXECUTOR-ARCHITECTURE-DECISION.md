# MPGR Delegated Executor — Architecture Decision

**Date:** 2026-10-05 · **Branch:** `arena/01a105ea-mpgr-hub` · **PR:** #78
**Decision:** immutable core with owner-governed configuration and fixed-selector typed modules. **No proxy.**
**Deployment:** **NOT DEPLOYED.** Mainnet deployment, activation, and canary remain blocked; this record is not a “LIVE” claim.

This is the architecture record for the delegated executor. It compares an immutable core plus configurable typed modules with a strictly governed proxy, records the selected trust boundary, and states what remains unproven before any Mainnet action.

## 1. Decision and rationale

Choose an **immutable, non-upgradeable core with governed configuration and explicitly registered typed modules**. Do not add a proxy.

The core already owns the security-critical operations: witness recovery, Permit2 redemption, authorization binding, fee calculation, pause/reentrancy checks, output measurement, and delivery to the recovered owner. Adding proxy upgrade authority would place those invariants behind mutable implementation code without providing a necessary operational capability. Configurable tokens, the existing router kinds, and reviewed venue modules can be added without changing the executor address where the module is safely bound to that executor.

This is not “no governance”: the immutable contract has an `Ownable2Step` owner for bounded settings and module registration. That owner can configure the venue set but cannot replace the contract logic. The configured owner’s real-world governance posture still has to be independently checked before deployment or activation; a pinned address alone is not proof of its signers or threshold.

### Considered alternative: a strictly governed proxy

A proxy could keep an address stable while changing core authorization logic. It would also add an implementation-upgrade capability, initializer and storage-layout risks, and a new key that could change the meaning of outstanding authorizations. To be acceptable, that authority would need to be separate from the broadcaster and proven to be strict governance, with initializer, storage-layout, and unauthorized-upgrade safeguards independently verified. None of that is needed for the required token, router, or venue configuration, so the proxy is rejected.

## 2. Immutable authorization and funds boundary

`contracts/executor/MPGRExecutorDelegated.sol` retains the following responsibilities in immutable code:

- The user’s Permit2 witness is recovered on-chain; the recovered `owner` is the fund source and the only output recipient.
- The one-use Permit2 authorization binds the chain/domain, executor/spender, token-in and gross amount; the witness binds owner, token-out, minimum output, deadline, `actionId`, and `policyHash`. The swap parameters, Permit2 permit, and witness must agree exactly.
- Gross amount, fee, and net swap amount are derived on-chain. The fee is taken from the sell token, fee mismatches revert, and the hard fee cap remains 100 bps.
- Pause, reentrancy protection, deadline, slippage/minimum output, token allowlisting, zero-`msg.value`, and no-native-input checks remain in the core.
- The broadcaster has no user-token custody or general transaction authority. The fixed-selector gate checks the exact calldata against the user authorization before signing; uncertain broadcast outcomes remain fail-closed and require receipt verification.

The core has no generic `delegatecall`, `execute(target,data)`, caller-supplied arbitrary call, or upgrade entrypoint. The only native-value call is the fixed WETH unwrap delivery to the recovered owner.

## 3. Typed-module boundary

The delegated executor has three fixed swap entrypoints: the existing Uniswap V3 and Aerodrome Slipstream adapters, plus `swapOnBehalfOfTypedModule`. The module path is an ordinary external call through `IMPGRExecutorSwapModule`; it is **not** `delegatecall`.

A module must expose fixed typed methods, including:

- `quoteExactInput(tokenIn, tokenOut, amountIn)`, used only for read-only simulation; and
- `swapExactInput(tokenIn, tokenOut, amountIn, amountOutMinimum, deadline, recipient)`, where the recipient is the executor supplied by core.

The core verifies the module’s executor/router bindings and pinned runtime bytecode hash, sends exactly the post-fee input amount without granting an allowance, checks that the module consumed that exact input, measures output at the executor, enforces the signed minimum output, and delivers the measured output to the recovered owner. The module return value is not trusted as output evidence. The runtime code hash is checked during validation and after the module call.

Governance registers a module for one router using `setRouterModule(router,module)`. Registration is explicit, one-router/one-module, executor-bound and code-hash-pinned; it is not a general target/data registry. Removing or replacing a module does not replace the executor. Each chain still needs its own executor-bound module and policy/chain binding.

A typed module is nevertheless **trusted venue code**. A malicious or defective module can cause a trade to lose value up to the user’s signed bounds; the immutable core enforces authorization and minimum output, not the economics or safety of arbitrary module logic. Every production module therefore needs independent code review, venue/pool verification, exact bytecode pinning, tests, and governance approval before registration.

**Current production state:** `typedModules` is empty in the committed Mainnet deployment config; no production venue module has been deployed or registered. MCP quote simulation requires agreement between the configured module, live executor registration, pinned hash, and fetched runtime bytecode. Delegated calldata construction and Mainnet autonomy posture checks perform corresponding checks. The old v1 assisted path explicitly refuses module routes.

## 4. Chain-local deployment model

There is one executor address per chain. Constructor-bound `WETH` and Permit2, the EIP-712 chain domain, executor/spender binding, chain-specific policy hash, and chain-specific authorization storage keep Mainnet and Sepolia authorizations separate. The application must not infer a chain from an adapter name or reuse the v1 assisted executor for delegated autonomy.

Tokens and existing built-in router kinds are owner-configurable. A new venue can retain the executor address only when it has a reviewed typed module that is bound to that executor and router. A core authorization change requires a newly reviewed immutable executor and a new per-chain pin.

## 5. Mainnet configuration reviewed in this branch

`deployments/base-mainnet/delegated-deploy-config.json` currently records:

- `chainId`: 8453; `mainnetDelegatedDeployEnabled`: **false** (safe, disabled value; not changed for this task).
- Fee: 25 bps; on-chain maximum: 100 bps.
- Canonical Base Permit2 and WETH.
- Aerodrome Slipstream (kind 1) and Uniswap V3 SwapRouter02 (kind 2).
- The 15 configured production tokens: USDC, WETH, and the 13 listed B20 assets.
- Canary wallet, v1 Mainnet executor, and Sepolia contracts/addresses in the denylist.
- `moduleRegistrySchemaVersion: 1` and `typedModules: []`.

The config’s address lists and kinds are asserted by the architecture test and the deployment/recording scripts. The enable flag must not be changed just to make a simulation pass; any change requires an explicitly reviewed decision. The current script’s preflight intentionally refuses while either independent enable flag is false.

## 6. Deployment and artifact sequencing

- `script/DeployMPGRExecutorDelegatedBaseMainnet.s.sol` is Base-Mainnet-only and performs preflight plus simulated constructor/postflight checks. It does not perform swaps. It checks the one-time artifact guard and fresh deployer nonce, role separation and live infrastructure, then validates owner, pending owner, fee posture, immutable dependencies, witness type, router kinds, token allowlist, and zero initial balances. The module registry is empty for the initial deployment.
- Forge creates and mines the broadcast transaction **after** `run()` has completed. Therefore the deploy script does not invent or write a mined transaction hash during transaction collection.
- `script/RecordMPGRExecutorDelegatedBaseMainnet.s.sol` is a separate read-only post-broadcast recorder. It requires a successful mined creation summary and a successful receipt, checks deterministic address binding and live posture, then writes the machine-readable record including actual transaction hash, mined block, and runtime code hash. It marks source verification `PENDING_EXTERNAL_VERIFICATION`; it cannot claim verification merely because a deployment succeeded.
- A no-broadcast simulation is not a deployment artifact. The recorder must not run for a dry run. Do not fabricate or commit a predicted executor as production evidence.

## 7. Validation status and blockers

The current reviewed code was validated by GitHub Actions CI run `37226740107` at commit `127424c7f22cc207259f26140f6d850e9e5e8ab3`. The `contracts`, `contracts-fork`, `quality`, `build`, `slither`, and `secret-scan` jobs all succeeded. The `contracts` job executed `forge test -vvv`; the fork job passed its v1 Mainnet/Sepolia suites, but is not a delegated deployment preflight and uses an optional RPC secret with a public-RPC fallback. The workflow exposed the exact released toolchain in a check annotation: Foundry `1.8.4` (`50af4efe189dc64bad2b75ed6990b835de66c4ae`, build timestamp `2026-10-01T14:08:28Z`) and Solidity `0.8.24+commit.e11b9ed9.Linux.g++`; OpenZeppelin `v5.4.0` and forge-std `v1.9.7` were installed at pinned tags. The current CI result validates the committed typed-module and recorder code; it does **not** prove a live deployment or the secure-runner Mainnet preflight. Manual workflow dispatch remains denied with HTTP 403 (`Resource not accessible by integration`), and raw Actions log download returns EOF; the toolchain versions are available via the successful contracts check annotation.

Local application diagnostics on the current worktree passed: `npm test` reported 248 files passed / 4 skipped and 2,609 tests passed / 17 skipped; `npm run typecheck` was clean; `npm run lint` reported 0 errors (59 warnings); and `npm run audit:high` passed with no unexpected high/critical findings. These are local application checks, not GitHub Actions or Solidity release validation. The Mainnet RPC and secret-presence gates are **unverified** here. `BASE_MAINNET_RPC_URL` is not available in this workspace; GitHub Environment secret/variable enumeration is denied by the current integration permissions. No private-key values were requested, printed, or read. The configured deployment flag remains false. Consequently there is no verified runner `eth_chainId`, no deployer address/nonce result, no fresh production script simulation, no predicted production address, no deployment receipt, and no source-verified artifact.

**State:** no Mainnet deployment, activation, transaction, canary, or “LIVE” claim. Stop before broadcast unless every required runner, RPC, config, governance, signing-separation, contract-test, simulation, and on-chain verification gate has a real observed result. An uncertain broadcast must never be retried blindly.

## 8. Remaining go-live gates (not performed)

1. On the authorized secure Mainnet runner, require the real `BASE_MAINNET_RPC_URL` secret without printing it; make a read-only `eth_chainId` call and require 8453. The PR CI fork job above is not a substitute and does not establish whether that secret or its public fallback was used.
2. Check only the presence of `BASE_MAINNET_DEPLOYER_PRIVATE_KEY`, `MPGR_EXECUTOR_OWNER`, `MPGR_EXECUTOR_FEE_RECIPIENT`, and `MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED`; derive the deployer address without printing its key and verify nonce zero by RPC. The integration cannot currently enumerate the `base-mainnet` environment secrets/variables.
3. Review—not rewrite—the committed Mainnet config. If any pin or flag is unexpected, stop. The false deploy enable currently blocks the deployment script’s full preflight; do not change it implicitly.
4. Only if every gate passes and the required flags have been explicitly reviewed, run the exact no-broadcast `forge script ... -vv`. Capture the full result. It is still only a simulation; this was not run and no predicted executor is available.
5. Stop for explicit human approval. No broadcast, deployment, runtime activation, or canary is authorized by this record.
6. After a later approved broadcast only: verify the real receipt and independent chain posture, verify source, run the recorder, pin the actual executor, and complete the bounded user-signed canary process. The user signs in their wallet; the server never signs for them.
