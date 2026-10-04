# MPGR Delegated Executor — Universal Multi-Chain Architecture Decision

**Date:** 2026-10-04 · **Branch:** `arena/01a105ea-mpgr-hub` · **PR:** #78
**Status:** DECIDED — **Design A (immutable executor + governed configuration)**. No proxy.
**Deployment status:** **NOT DEPLOYED. BLOCKED.** See [§9](#9-deployment-status-blocked--exact-blockers).

This document is the pre-deployment architecture record required before any Base mainnet
deployment of a delegated executor. It evaluates the two candidate designs against the actual
source, states which was chosen and why, and records the exact blockers that prevent going
live from this environment.

---

## 1. Summary of the decision

**Chosen: Design A — an immutable, non-upgradeable executor whose *configuration* is governed
at runtime.**

The decisive reason is not preference, it is a finding from reading the contract: **the
existing `MPGRExecutorDelegated` already has a complete governed configuration surface, so
every change the requirements list as "must not require replacing the executor" already does
not require replacing it.** A proxy would add a large new attack surface to solve a problem
that does not exist.

`contracts/executor/MPGRExecutorDelegated.sol` already exposes, all `onlyOwner`:

| Function | Line | What it governs |
|---|---|---|
| `setTokenAllowed(address token, bool allowed)` | 413 | add/remove an allowed token |
| `setRouter(address router, RouterKind kind)` | 409 | add/change an allowed router **and its typed adapter** |
| `setFeeBps(uint16)` | 401 | change fee, hard-capped at `MAX_FEE_BPS = 100` |
| `setFeeRecipient(address)` | 405 | change the fee wallet |
| `pause()` / `unpause()` | 419 / 423 | emergency stop, independent of everything else |
| `rescueERC20` / `rescueNative` | 430 / 437 | recover genuinely stranded funds only |

Ownership is `Ownable2Step` (two-step transfer, so an owner key cannot be bricked by a typo)
with `renounceOwnership()` **disabled** (line 444, reverts `RenounceDisabled`) — governance can
never be accidentally abandoned, leaving allowlists frozen.

Mapping that against the stated requirement list:

| Future change | Requires redeploying the executor? |
|---|---|
| add another allowed token | **No** — `setTokenAllowed` |
| add another router | **No** — `setRouter` |
| add another supported venue (existing `RouterKind`) | **No** — `setRouter` |
| change fee recipient through governed config | **No** — `setFeeRecipient` |
| change fee within the hardcoded safety cap | **No** — `setFeeBps` |
| add another typed swap route | **No** — `setRouter` + `setTokenAllowed` |
| add a new supported **chain** deployment | New deployment **on that chain** (unavoidable — contracts are chain-local), from the *same* unaudited-change source |
| add a genuinely **new `RouterKind`** (a new typed adapter with a different router interface) | **Yes** — new code, new deployment, or an owner-governed module (see §5) |

So the executor address is **stable for a chain once deployed** for every operational change
that will realistically occur. The only thing that forces a new deployment is new *solidity
logic* — and for that case, "deploy a new immutable contract and repoint a pinned env var" is
the **safer** outcome, not the worse one (§4).

---

## 2. Why the contract is already chain-universal

Nothing in `MPGRExecutorDelegated` is chain-specific. The constructor takes every
chain-varying value as an argument:

```solidity
constructor(
    address initialOwner,
    address initialFeeRecipient,
    uint16  initialFeeBps,
    address weth,        // <- per chain
    address permit2,     // <- per chain
    RouterConfig[] memory routers,  // <- per chain
    address[] memory tokens         // <- per chain
) Ownable(initialOwner)
```

`WETH` and `PERMIT2` are **immutables set from constructor args** (lines 191/194), not
hardcoded constants, and the constructor verifies both have code (`NotAContract`). There is no
`block.chainid` constant, no baked-in address, no chain-specific branch anywhere in the file.

Consequence: **one audited implementation, deployed per chain with chain-appropriate
arguments.** That is exactly the "same architecture across chains, own address per chain"
requirement — it needs no new abstraction.

### Chain binding is already cryptographic, and Permit2 does the heavy lifting

The requirements that a Sepolia authorization must never execute on mainnet (and vice versa)
are enforced by **Permit2 itself**, not by convention:

1. Permit2's EIP-712 domain is `("Permit2", block.chainid, 0x0000…8BA3)`. A witness permit
   signed for chain 84532 produces a different `domainSeparator` on 8453, so recovery yields a
   different (essentially random) address and `SignatureTransfer` reverts. **Replaying a
   Sepolia authorization on mainnet is impossible at the Permit2 layer.**
2. Permit2 binds `spender` into the signed digest. The permit names the **executor address**,
   which differs per chain. The contract's own test `test_Signature_WrongSpenderDigest_Reverts`
   covers this.
3. The contract's own test `test_Signature_WrongChainDigest_Reverts` pins the chain binding.

The application layer adds three more independent bindings (see
[`docs/ACTIVATION-FLOW-AUDIT.md`](ACTIVATION-FLOW-AUDIT.md) §9.2): the stored slot's
`chainId`, the Permit2 domain `chainId` in the typed data the wallet signs, and `policyHash`
whose canonical tuple carries `uint256 chainId`. So a cross-chain attempt is refused at four
separate layers, the innermost of which is Permit2's own cryptography.

---

## 3. Design B evaluated — upgradeable proxy — and rejected

A `TransparentUpgradeableProxy` / UUPS variant was evaluated seriously. It is rejected because
every benefit it would provide is already provided by §1, while every cost it adds is a new
way to lose user funds.

**What a proxy would add:**

- An **upgrade authority**. This is the decisive problem. The requirements state
  *"broadcaster compromise must NOT equal implementation upgrade authority"* and *"operator
  cannot redirect user funds"*. Under Design A those are **structurally true**: there is no
  implementation to swap, so no key — broadcaster, owner, or otherwise — can change what the
  contract does. Under Design B they become **operational obligations**: correctness depends
  on the upgrade authority being a separate multisig+timelock, being configured correctly at
  deploy time, and never being pointed at the operator. A single misconfiguration converts a
  gas-only broadcaster into a key that can replace the implementation with one that drains
  every user who has an outstanding permit. That is a **custody-equivalent** power, and
  invariant 3 ("operator cannot redirect user funds") would depend on process rather than on
  code.
- **Storage-layout fragility.** Every future implementation must preserve slot ordering or
  silently corrupt `feeBps`, `feeRecipient`, `routerKind`, `isTokenAllowed` and the
  `Ownable`/`Pausable`/`ReentrancyGuard` slots. This is the classic upgradeable-contract
  failure mode and it fails *silently*.
- **Initializer surface.** The implementation must be un-initializable
  (`_disableInitializers`), the proxy must be initialized exactly once, and a `reinitializer`
  versioning discipline must be maintained forever. Miss one and an attacker can initialize the
  implementation and, in some patterns, self-destruct or hijack the proxy.
- **`delegatecall` in the trusted path.** Design A has **zero** `delegatecall` — verified by
  grep in §6. A proxy introduces it as the core mechanism.
- **Verification and audit cost.** Two contracts, an admin/proxy admin, and a timelock must all
  be deployed, verified and monitored per chain instead of one.

**What a proxy would buy:** the ability to add a genuinely new `RouterKind` (new typed adapter
logic) without a new address. That is the *only* real benefit, it applies to a rare event, and
§5 shows a safer way to get it if it is ever needed.

**Conclusion:** the requirements say *"Do not sacrifice security merely to satisfy
'upgradeable'"* and *"If modular architecture is safer: prefer it over proxy upgradeability."*
Both point to A. Design B would trade a structurally-guaranteed invariant for a
process-guaranteed one.

---

## 4. Why "deploy a new immutable contract" is the *safer* upgrade path

When new solidity logic really is needed (a new `RouterKind`), Design A's answer is: deploy a
new immutable executor and repoint `MPGR_MAINNET_DELEGATED_EXECUTOR`. This is deliberately how
the system is built, and it is safer than a proxy upgrade:

- **The change is an explicit, human-approved, publicly visible event** — a deployment
  transaction with verified source — not a silent storage swap behind a stable address.
- **Users' outstanding authorizations do not silently change meaning.** A permit binds
  `spender`. Permits signed for the old executor **cannot be redeemed by the new one**, so a
  migration can never retroactively reinterpret an authorization a user already signed. Under
  a proxy, the address stays the same while the code changes underneath every live permit —
  the user's signature now authorizes different behaviour than what they reviewed.
- **Rollback is trivial and complete:** repoint the env var. There is no storage to migrate
  back.
- **The application already fails closed on an unknown/unverifiable address.** The posture
  checks (`owner`, `feeRecipient`, `feeBps`, canonical `PERMIT2`, exact `WITNESS_TYPE_STRING`,
  `!paused`, per-token allowlist) mean a wrong or half-configured executor is refused before
  any trade, and the bounded hot-wallet gate refuses any calldata whose `to` is not the pinned
  executor for that chain.

The cost — a new address — is paid once per genuine logic change, is absorbed by a single env
var, and buys the property that **no key in the system can alter what a deployed executor
does.**

---

## 5. If modularity is ever wanted: allowlisted typed modules, not `delegatecall`

Should a future requirement make frequent logic changes necessary, the safe extension of
Design A is **explicitly allowlisted typed modules**, and it must obey these rules:

- Core authorization, Permit2 redemption, recipient binding, fee cap, pause and reentrancy
  protection stay in the **immutable** core. They are the invariants and must not be movable.
- A module registry maps `module => bool allowed`, governed exactly like `routerKind` /
  `isTokenAllowed` today (`onlyOwner`, events, no renounce).
- The core calls a module only through a **typed interface with a fixed function signature**
  (e.g. `IMPGRSwapModule.swap(SwapParams, ModuleParams)`), selected by an on-chain
  `ModuleKind` enum — the same pattern already used for `RouterKind`.
- **Forbidden, absolutely:** generic `delegatecall`; a generic `execute(target, data)`;
  arbitrary `call` with caller-supplied calldata; any module ability to move tokens to an
  address other than the recovered `witness.owner` or the `feeRecipient`; any module ability to
  read or consume a permit.

That preserves "typed router calls only" while making the venue set extensible. It is **not
built now** because nothing requires it: `RouterKind` + `setRouter` already covers both
production venues, and adding speculative attack surface to a contract that guards user funds
would itself be a security regression.

---

## 6. Attack-surface verification of the chosen design

Verified by inspection of `contracts/executor/MPGRExecutorDelegated.sol` (634 lines):

| Property | Result |
|---|---|
| `delegatecall` / `callcode` | **absent** |
| generic `execute(target, data)` | **absent** |
| arbitrary external call with caller-supplied calldata | **absent** |
| `selfdestruct` | **absent** (only mentioned in a comment about recovering force-sent ETH) |
| inline `assembly` | **absent** |
| proxy / upgrade / `initialize` / `reinitializer` / implementation slot | **absent** — the only occurrence of the word "proxy" is the comment "No proxy, no upgrade path" |
| low-level `call` | exactly one, line 589: `payable(to).call{value: amount}("")` in `_sendNative`, sending **native ETH to the recovered owner** after a WETH unwrap. Not an arbitrary-call surface. |
| `msg.value` | both entrypoints are `payable` but revert `NativeInputUnsupported()` when `msg.value != 0` (lines 320, 355). Native input is structurally impossible. |
| `receive()` | line 449, exists so WETH can return ETH on unwrap |
| upgrade authority | **none exists** — so "broadcaster compromise ⇒ implementation upgrade" is not merely prohibited, it is **not expressible** |

Existing contract test suite (`test/executor/MPGRExecutorDelegated.t.sol`, 48 tests, plus
`MPGRExecutor.t.sol` 72 and `MPGRExecutorInvariant.t.sol` 4 invariants) already covers the
required matrix — see §8.

---

## 7. FINDING: on-chain router allowlist vs the TypeScript route table disagree

While establishing what the mainnet delegated executor must allowlist, a real inconsistency
surfaced. It does not affect the *deployed v1* executor's current operation, but it **would**
affect a delegated mainnet deployment, so it is recorded here and handled in the deploy config.

- `deployments/base-mainnet/mpgr-executor.json` (the deployed v1 executor's recorded state)
  has `routerAllowlist: ["0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F"]` — **Aerodrome
  Slipstream only**.
- `script/DeployMPGRExecutorBaseMainnet.s.sol` deliberately excludes the Uniswap V3 router:
  *"Not in the production trade config: must NOT be allowlisted on mainnet"*
  (`MAINNET_UNI_ROUTER02 = 0x2626664c2603336E57B271c5C0b26F421741e481`), and
  `productionRouters()` returns Slipstream alone.
- But `lib/executor/executor-config.ts` `BASE_MAINNET_EXECUTOR_DEPLOYMENT.routes` **declares a
  `UNISWAP_V3_ROUTER02` route for USDC↔WETH** using exactly that `0x2626…e481` router, with a
  dedicated test (`uniswap-v3-mainnet-route.test.ts`) and a CREATE2-derived pool address.

Consequence for the delegated path: `mainnetDelegatedExecutorDeployment()` reuses that route
table, so an autonomous **USDC→WETH** goal on 8453 resolves to the Uniswap V3 router. If the
delegated executor is deployed mirroring v1's allowlist (Slipstream only), the contract reverts
`RouterNotAllowed` at execution time — after the user signed, after limits passed, after the
gate approved. That is a confusing, late, wasted-gas failure.

**Resolution adopted:** the delegated mainnet deploy config (`deployments/base-mainnet/
delegated-deploy-config.json`) allowlists **both** production venues — Slipstream for the B20
tokenized stocks and Uniswap V3 SwapRouter02 for USDC↔WETH — because the contract already
supports both `RouterKind`s and the TS registry declares both as production venues. Adding the
second router is exactly the governed-config change Design A exists to make cheap.

**And the inconsistency is now caught at deploy time rather than at trade time:** the deploy
script asserts, post-deployment, that every router in the TS-declared route table for chain
8453 is actually allowlisted on-chain with the expected `RouterKind`. A TS test
(`lib/executor/__tests__/delegated-architecture.test.ts`) asserts the same consistency against
the committed config, so the two can never drift silently again.

If the operator prefers to mirror v1 exactly and allowlist Slipstream only, the correct
follow-up is to **remove the USDC↔WETH Uniswap V3 route from the TS mainnet registry** so the
app never proposes a venue the contract will refuse. That is a product decision, flagged not
taken; the safe default chosen here is to make the contract accept what the app promises.

---

## 8. Test coverage against the required matrix

Contract tests exist and the relevant local suites **were executed successfully** using Foundry
1.7.1, native solc 0.8.24, OpenZeppelin v5.4.0 and forge-std v1.9.7. These tools/dependencies
were installed into ignored temporary/workspace paths; no project dependency or lockfile was
changed. The RPC-backed fork rehearsal remains unrun/skipped because Base RPC egress is blocked
(§9, B1) — local mocked/unit/fuzz/invariant coverage is not represented as fork verification.

| Executed gate | Result |
|---|---|
| `forge build` (includes the new delegated mainnet deploy script) | **success** — Solidity 0.8.24 |
| Full local `forge test` | **162 passed, 0 failed, 41 skipped** (15 suites, 203 cases) |
| `MPGRExecutorDelegated.t.sol` | **48 passed**, including two 256-run fuzz properties |
| `DeployMPGRExecutorDelegatedBaseMainnet.t.sol` | **8 passed**, no RPC/broadcast |
| Base mainnet / Base Sepolia fork suites | skipped in this sandbox-local run because their RPC env vars are unset and network egress is unavailable; remote CI fork results are separate |

A separate GitHub Actions `contracts-fork` job can exercise RPC-backed Base fork suites; its
status and annotations are recorded on PR #78, not in the local Foundry totals above. That
job's existing executor/deploy coverage must not be mistaken for a live deployment or for the
new delegated mainnet script's independently verified production posture/artifact.

Coverage mapped to the required A–Z matrix:

| Req | Covered by (`test/executor/`) |
|---|---|
| A unit | `MPGRExecutorDelegated.t.sol` (48), `MPGRExecutor.t.sol` (72) |
| B fuzz | `testFuzz_Equivalence_V1Permit2_vs_Delegated`, `testFuzz_Equivalence_FeeMath` |
| C invariant | `MPGRExecutorInvariant.t.sol` (4 invariants) |
| D Permit2 witness | `test_WitnessTypeString_IsStandardEIP712EncodeType`, `test_Signature_TamperedTypeString_Reverts`, `Permit2WitnessMock.sol` |
| E authorization | `test_SwapOnBehalfOf*`, `test_Admin_Guards` |
| F wrong chain | `test_Signature_WrongChainDigest_Reverts` |
| G wrong wallet | `test_Signature_ByNonOwner_Reverts`, `test_WrongOwner_ZeroAddress_Reverts` |
| H wrong token | `test_WrongToken_InPermit_Reverts` |
| I wrong amount | `test_WrongAmount_InPermit_Reverts` |
| J wrong minOut | `test_MinAmountOut_WitnessMismatch_Reverts`, `test_MinOut_Zero_Reverts`, `test_Slippage_RateDrop_RevertsAtomically` |
| K wrong deadline | `test_Deadline_TripleMismatch_Reverts`, `test_Deadline_AtBoundary_Succeeds`, `test_PermitExpired_Reverts` |
| L wrong actionId | `test_ActionId_MustMatch_Reverts` |
| M wrong policyHash | `test_WrongPolicyHash_Reverts` |
| N replay/nonce | `test_Replay_SamePermit_Reverts`, `test_Nonce_BurnedOnlyOnSuccess`, `test_Nonce_DifferentBitsIndependent`, `test_Revoke_InvalidateUnorderedNonces` |
| O fee | `test_FeeSplit_Exact`, `test_QuoteFee_Parity_WithV1` |
| P fee cap | `test_FeeMismatch_Reverts`, `test_FeeChangeAfterSigning_Reverts_NeverOvercharges`, `test_FeeRoundsToZero_Reverts`, `test_Admin_Guards` |
| Q pause | `test_Pause_BlocksNewSwaps_ThenUnpauses` |
| R router allowlist | `test_RouterNotAllowlisted_Reverts` |
| S token allowlist | `test_TokenNotAllowlisted_Reverts` |
| T msg.value | `test_NativeInput_Rejected`, `test_Receive_OnlyWethMaySendEth` |
| U recipient redirection | `test_Recipient_MustBeOwner_Reverts` |
| V reentrancy | `ReentrancyGuard` on both entrypoints + admin; `test_FeeOnTransferToken_Rejected`, `test_RouterReturnsInput_Reverts`, `test_RouterPullLess_Reverts`, `test_RouterRevert_NothingMoves` |
| W unauthorized governance | `test_Admin_Guards` |
| X unauthorized upgrade | **N/A — no upgrade path exists** (§6) |
| Y implementation init | **N/A — no implementation contract exists** (§6) |
| Z storage layout | **N/A — no proxy storage to preserve** (§6) |
| — non-custody proof | `test_CompromisedBroadcaster_CannotSteal_CanOnlyRedeem`, `test_CompromisedBroadcaster_BoundedBySignedMinOut`, `test_SwapOnBehalfOfUniswapV3_OwnerReceivesOutput_BroadcasterGetsNothing` |
| — output measured not trusted | `test_RouterLiesAboutOutput_BalanceDeltaRules` |
| — v1/delegated parity | `test_EventParity_V1_vs_Delegated`, `test_QuoteFee_Parity_WithV1` |

Application-layer coverage (runnable and **passing** here — 251 test files, 2603 passed and
17 skipped) additionally proves the cross-chain matrix, the bounded hot-wallet gate, canary
separation, posture fail-closed behaviour and the full mainnet stage chain. See
[`docs/ACTIVATION-FLOW-AUDIT.md`](ACTIVATION-FLOW-AUDIT.md) §9.

---

## 9. Deployment status: BLOCKED — exact blockers

**`MPGR Autonomous Mainnet is NOT LIVE`. No contract was deployed. No mainnet transaction was
sent. No canary was run.** Per the task's own deployment rule ("If ANY security invariant
cannot be proven: STOP. Do NOT deploy."), deployment was stopped rather than simulated or
faked. Nothing below was worked around, weakened or stubbed.

| # | Blocker | Evidence | Smallest safe fix |
|---|---|---|---|
| **B1** | **No network egress to any chain RPC.** Base mainnet is unreachable from this environment, so deployment, independent on-chain posture verification, and mainnet fork rehearsals / canary are impossible. | Read-only `eth_chainId` to `https://mainnet.base.org` → HTTP `000`; `BASE_MAINNET_RPC_URL` is unset. Fork suites were skipped, not counted as passes. | Run the reviewed deploy/fork workflow on an operator machine or CI runner with Base RPC egress; require the mainnet fork dry-run to pass before any real deployment. |
| **B2** | **Deployment secrets/approvals are absent.** No deployer key, owner/fee-recipient deployment vars, explicit deployment enable, production executor pin, production broadcaster key, runtime enable, or cron secret is configured in this sandbox. Secret values were never read or printed. | Presence-only environment check: all required deployment/runtime vars `UNSET`. | Operator provisions secrets via the existing secure repository/deployment environment — never chat — and separately approves the one-time deploy. Fresh deployer key must have nonce 0. |
| **B3** | **The 1-USDC canary requires the user to sign the authorization in their own wallet** and to have at most 1 USDC committed. The server/operator must never sign for them. | Invariants 1 and 6; `signDelegatedSlots` runs in the user's browser wallet. No wallet session or signed authorization was supplied. | After deploy and posture verification, the user signs exactly one bounded 1-USDC slot (short expiry, correct `policyHash`/`chainId 8453`) in the Agent UI. |
| **B4** | **The mainnet delegated executor address does not exist yet**, so `MPGR_MAINNET_DELEGATED_EXECUTOR` cannot be pinned and the adapter correctly fails closed everywhere. | `mainnetDelegatedExecutorDeployment()` returns `null` when unset; proven by tests. | Deploy after B1–B2, independently verify, then pin the actual address. |

Everything that **can** be done without those has been done: the architecture decision, the
mainnet deploy script and its eight passing local preflight tests, the reviewed deploy config,
the deployment-artifact writer, and the tests that make the configuration self-consistent and
the cross-chain matrix airtight. Local Solidity unit/fuzz/invariant tests are green; only
network-dependent fork verification and the operator/user actions remain blocked.

---

## 10. What was added to make deployment safe and repeatable

- **`script/DeployMPGRExecutorDelegatedBaseMainnet.s.sol`** — the mainnet delegated deploy
  script. It mirrors the guard pattern already proven by
  `DeployMPGRExecutorBaseMainnet.s.sol` and the constructor invocation proven by the Sepolia
  delegated script: `block.chainid == 8453`; **two independent** enable flags (env
  `MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED=true` *and* committed
  `mainnetDelegatedDeployEnabled: true`); one-time via record-exists **and** deployer nonce 0;
  deployer must differ from owner, fee recipient, the production broadcaster and the canary
  wallet; if the broadcaster key is provisioned, its derived address must also differ from
  governance, fee recipient and every denied/canary/Sepolia address; live verification that Permit2, WETH, both
  routers and all 15 tokens exist and behave on 8453; the Sepolia denylist must not appear;
  deterministic-address assertion; post-deploy assertion that **every** posture value the
  runtime will later verify already matches (owner, `pendingOwner == 0`, `feeBps`,
  `feeRecipient`, `MAX_FEE_BPS`, `PERMIT2`, exact `WITNESS_TYPE_STRING`, `!paused`, and every
  router/token allowlist entry); and §7's route-table↔allowlist consistency check. It performs
  **no swaps** — a deploy script must never touch real user funds. The canary is a separate,
  user-signed, operator-run flow.
- **`deployments/base-mainnet/delegated-deploy-config.json`** — committed, reviewed pins
  (owner, fee recipient, feeBps, maxFeeBps, both routers with kinds, all 15 tokens), shipped
  with `mainnetDelegatedDeployEnabled: false` so it cannot fire accidentally.
- **`lib/executor/__tests__/delegated-architecture.test.ts`** (27 Vitest tests) — runnable-now
  proofs: the cross-chain authorization matrix (including a third chain), the contract's zero
  proxy/`delegatecall`/generic-execute surface, the governed config surface that makes
  redeployment unnecessary, canary/broadcaster separation in config, deploy-script guard
  presence, and config↔route-table consistency.
- **`test/script/DeployMPGRExecutorDelegatedBaseMainnet.t.sol`** (8 Foundry tests) — locally
  etches mock infrastructure and proves the mainnet chain gate, both enable flags, one-time
  artifact/nonce guard, pin consistency, canary/Sepolia denylist, deployer/governance/fee/
  broadcaster separation, and a fully passing preflight. It performs no RPC or broadcast.

---

## 11. Go-live runbook (only after the RPC and deployment-approval blockers B1–B2 are resolved)

1. On an operator runner with the pinned Solidity toolchain/dependencies, run `forge build`,
   `forge test --no-match-path 'test/fork/*'`, and the RPC-backed Base mainnet fork rehearsal
   suites. The PR's existing `contracts-fork` job covers the v1 executor/deployment path; it
   does **not** validate this new delegated deployment script. Require a delegated-specific
   live preflight rehearsal to pass before deploying (B1).
2. Review and commit `deployments/base-mainnet/delegated-deploy-config.json`; set
   `mainnetDelegatedDeployEnabled: true` in the same reviewed commit.
3. From a secured operator runner, provision the reviewed owner/fee pins, the explicit env
   enable flag, a fresh dedicated deployer key (nonce 0, funded for gas), and the RPC endpoint.
   Do not paste or log keys. If the production broadcaster key is provisioned, verify it is a
   separate gas-only wallet as required by preflight.
4. **Simulate first, without `--broadcast`** against Base Mainnet:
   `forge script script/DeployMPGRExecutorDelegatedBaseMainnet.s.sol:DeployMPGRExecutorDelegatedBaseMainnet --rpc-url "$BASE_MAINNET_RPC_URL" -vv`.
   Review the full live preflight, predicted CREATE address, postflight and allowlists; stop on
   any mismatch. This dry run sends no chain transaction.
5. The script writes a predicted JSON record even during a successful no-broadcast simulation.
   Do **not** commit or treat that predicted record as deployment evidence. Since preflight
   required the artifact not to exist before the simulation, remove only that newly generated
   simulation file before the next run so the one-time artifact guard stays meaningful:
   `rm deployments/base-mainnet/mpgr-executor-delegated.json`.
6. Only after the simulation has been independently reviewed and the human has explicitly
   approved deployment, run the same script with `--broadcast --slow` from the secured runner.
   Record the actual transaction and resulting executor address; stop if the broadcast result
   is uncertain.
7. Verify source on BaseScan/Sourcify/Blockscout, then independently re-read on-chain posture
   and confirm it matches the reviewed config exactly (the script also asserts this).
8. Confirm the script's artifact describes the actual mined deployment, reconcile it with the
   transaction/receipt and on-chain reads, then commit
   `deployments/base-mainnet/mpgr-executor-delegated.json`. A simulated artifact is never
   acceptable as the production artifact.
9. Set the runtime vars — `MPGR_MAINNET_DELEGATED_EXECUTOR`,
   `MPGR_MAINNET_BROADCASTER_PRIVATE_KEY` (dedicated gas-only wallet, **not** the canary),
   `MPGR_AUTONOMOUS_EXECUTION_ADAPTER=delegated-permit2-mainnet`, `CRON_SECRET` — plus
   `MPGR_AUTONOMOUS_AGENT_ENABLED=true`.
10. Confirm `GET /api/agent/autonomy/config` reports `delegated.chainId == 8453` with the pinned
    executor and `executionAvailable == true` (posture proven, not assumed).
11. The user signs exactly one bounded 1-USDC slot in their wallet (B3).
12. Run one tick, then confirm the full lifecycle and that a duplicate tick cannot re-execute.

Until steps 1–12 have all been done and observed, mainnet autonomous execution is **not** live,
and the system is designed so that it behaves as watch-only rather than half-executable.
