# Slither suppressions: MPGRExecutorDelegated

This document records every Slither suppression added to the delegated executor, the reason for it, and the operational controls it depends on.

## 1. `reentrancy-balance` on `swapOnBehalfOfTypedModule`

**Location:** CI configuration, not Solidity source. `.github/workflows/ci.yml` (job `slither`) excludes `reentrancy-balance` from the first Slither pass with `--exclude reentrancy-balance`. The second pass, `--detect reentrancy-balance`, runs `scripts/ci/check-slither-reentrancy-balance.py`, which fails unless every finding is on `contracts/executor/MPGRExecutorDelegated.sol::swapOnBehalfOfTypedModule`.

The Solidity source carries no suppression comment. `contracts/executor/MPGRExecutorDelegated.sol` is byte-identical to commit `b32426e`. Built with solc 0.8.24, evm cancun, optimizer 200, IPFS metadata, and the six immutables patched, it reproduces the deployed runtime codehash `0xc232d9d3…085c` (verified locally with Foundry 1.7.1 and solc-js; not yet reproduced with the CI toolchain).

**Scope:** this one detector. The exclusion is global to the CI pass, so the second pass is what limits it to the reviewed function. A new `reentrancy-balance` finding anywhere else fails CI. No other detector is excluded, `--fail-high` still applies to the first pass, and no contract logic changed.

**This suppression is not a security fix.** It records a reviewed exception to a static-analysis finding. The underlying risk is described below and is **not enforced by the contract**.

### Why the finding is flagged

The function reads `tokenIn.balanceOf(module)` before and after an external call to the typed swap module, and reverts if the balance changed. Slither flags the external call between the two reads.

### Why the function is not exploitable through reentrancy

- `swapOnBehalfOfTypedModule` is `nonReentrant` and `whenNotPaused`. The two other swap entry points are also `nonReentrant` and `whenNotPaused`. The two rescue functions are `nonReentrant` and `onlyOwner`.
- The module is bound to a router by owner governance, pinned by codehash before the call (`_validate`) and after it, and must report `executor() == this` and `router() == router`.
- The module receives exactly `swapAmount` by an exact `safeTransfer`. It has no allowance from the executor.
- Output is measured by balance delta, the signer's minimum output is enforced, and the recipient is fixed to the signer.

### The residual risk (not enforced by the contract)

The consumption check and the signer minimum-output check both read `balanceOf` of allowlisted tokens. **The contract does not verify that allowlisted tokens report honest `balanceOf`.**

If an allowlisted token misreports `balanceOf`:

- **Stranded input:** while a typed module is registered, the module can keep input and the consumption check can still pass. The input is then stranded in the module. This is a protocol-side accounting loss.
- **Weakened minimum output:** the signer's minimum-output check, which also reads `balanceOf`, could pass while the signer receives less than `amountOutMinimum`.

The same assumption already governs the live Uniswap V3 and Slipstream paths (`_begin` and `_finish`). This function does not introduce it, but it relies on it.

**Current exposure on Base Mainnet:** no typed-module router is registered (router kind 3 is not in use, and no `SwapModuleUpdated` event has been emitted). The typed path is therefore inactive. This status must be re-checked on-chain, not assumed.

## 2. Operational controls (governance responsibilities, NOT contract enforcement)

The contract does not enforce any of the following. They are responsibilities of the executor owner and of whoever reviews changes to this repository.

1. **No typed-module registration without documented review.** `setRouterModule` is callable by the owner and is not blocked by the contract. Registration must be preceded by a written review of the module code, its codehash, and the tokens it will handle.
2. **Review token behavior before allowlisting non-standard tokens.** `setTokenAllowed` checks only contract existence and router/module conflicts. It does not detect rebasing, transfer hooks, transfer fees, or mutable balances. Any such token must be reviewed before it is allowlisted.
3. **Monitor these events:**
   - `RouterUpdated`: an event setting kind 3 (typed module) is a re-review trigger.
   - `SwapModuleUpdated`: any emission is a re-review trigger.
   - `TokenAllowlistUpdated`: any allowlisting of a non-standard token is a re-review trigger.

   Monitoring is not automated by this repository. Someone must own the alerts.
4. **Re-review every future edit to `swapOnBehalfOfTypedModule`.** The suppression stays in place for future edits, so Slither will not flag changes to this declaration. Any change to the function requires a fresh security review before merge.

## 3. Status of related work

- **Deploy-workflow Slither gate: unresolved and separate.** `.github/workflows/deploy-executor-base-mainnet.yml` still uses `crytic/slither-action@v0.4.1` with `fail-on: high`. That action installs an unpinned Slither in a `python:3.9` container. This suppression does not change that workflow and does not resolve it. A pinned toolchain for the deploy gate requires separate approval before any deployment.
- **No deployment or production change is covered by this document.** Merging this change does not deploy the contract and does not enable production autonomy.
