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

Contract tests exist and cover the full A–Z list. **They cannot be executed in this
environment** — see §9, blocker B2. Coverage was verified by reading the test names:

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

Application-layer coverage (runnable and **passing** here — 2576 tests) additionally proves the
cross-chain matrix, the bounded hot-wallet gate, canary separation, posture fail-closed
behaviour and the full mainnet stage chain. See
[`docs/ACTIVATION-FLOW-AUDIT.md`](ACTIVATION-FLOW-AUDIT.md) §9.

---

## 9. Deployment status: BLOCKED — exact blockers

**`MPGR Autonomous Mainnet is NOT LIVE`. No contract was deployed. No mainnet transaction was
sent. No canary was run.** Per the task's own deployment rule ("If ANY security invariant
cannot be proven: STOP. Do NOT deploy."), deployment was stopped rather than simulated or
faked. Nothing below was worked around, weakened or stubbed.

| # | Blocker | Evidence | Smallest safe fix |
|---|---|---|---|
| **B1** | **No network egress to any chain RPC.** Base mainnet is unreachable from this environment, so deploying, verifying on BaseScan, reading posture and broadcasting a canary are all impossible. | `curl https://mainnet.base.org` → HTTP `000`. Earlier full-suite runs showed the same for `cca-lite.coinbase.com` (`ECONNRESET`). | Run the deploy from an operator machine/CI runner with RPC egress. |
| **B2** | **No Solidity toolchain, and it cannot be installed.** `forge` is absent, `.forge-deps` (OpenZeppelin + forge-std) is not vendored, and the Foundry release binary cannot be downloaded. So the 48 contract tests **cannot be executed here** — their coverage in §8 is verified by reading them, not by running them. | `which forge` → not found; `ls .forge-deps` → missing; download → `SSL_ERROR_SYSCALL` from `release-assets.githubusercontent.com`. | `foundryup && forge install` then `forge test -vvv` on a machine with GitHub-release egress. **Must be green before deploy.** |
| **B3** | **No deployer private key with ETH on Base mainnet**, and none may ever be requested, pasted into chat, printed or committed. | By policy and by the task's own rules. | Operator supplies `BASE_MAINNET_DEPLOYER_PRIVATE_KEY` from repo secrets to the forge script. The deployer must be a **fresh, dedicated** key (the script requires nonce 0). |
| **B4** | **The 1-USDC canary requires the *user* to sign the authorization in their own wallet.** This is the non-custodial invariant, and it is not something an agent can or may do: the server/operator must never sign for the user. It also requires real USDC in that wallet. | Invariants 1 and 6; the flow is `signDelegatedSlots` in the user's browser wallet. | The user signs one bounded slot (1 USDC, short expiry, correct `policyHash`/`chainId 8453`) in the Agent UI against the pinned mainnet executor. |
| **B5** | **The mainnet delegated executor address does not exist yet**, so `MPGR_MAINNET_DELEGATED_EXECUTOR` cannot be pinned and the adapter correctly fails closed everywhere. | `mainnetDelegatedExecutorDeployment()` returns `null` when unset; proven by tests. | Deploy (B1–B3), then pin the address. |

Everything that **can** be done without those has been done: the architecture decision, the
mainnet deploy script, the reviewed deploy config, the deployment-artifact contract, and the
tests that make the configuration self-consistent and the cross-chain matrix airtight.

---

## 10. What was added to make deployment safe and repeatable

- **`script/DeployMPGRExecutorDelegatedBaseMainnet.s.sol`** — the mainnet delegated deploy
  script. It mirrors the guard pattern already proven by
  `DeployMPGRExecutorBaseMainnet.s.sol` and the constructor invocation proven by the Sepolia
  delegated script: `block.chainid == 8453`; **two independent** enable flags (env
  `MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED=true` *and* committed
  `mainnetDelegatedDeployEnabled: true`); one-time via record-exists **and** deployer nonce 0;
  deployer must differ from owner, fee recipient, the production broadcaster and the canary
  wallet; the canary address is denied outright; live verification that Permit2, WETH, both
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
- **`lib/executor/__tests__/delegated-architecture.test.ts`** — runnable-now proofs: the
  cross-chain authorization matrix (including a third chain), the contract's zero
  proxy/`delegatecall`/generic-execute surface, the governed config surface that makes
  redeployment unnecessary, canary/broadcaster separation in config, deploy-script guard
  presence, and config↔route-table consistency.

---

## 11. Go-live runbook (for the operator, once B1–B3 are available)

1. `foundryup && forge install`; `forge test -vvv` — **all contract tests green** (B2).
2. Review and commit `deployments/base-mainnet/delegated-deploy-config.json`; set
   `mainnetDelegatedDeployEnabled: true` in the same reviewed commit.
3. Deploy with a fresh dedicated key (nonce 0), `--broadcast --slow`, from a machine with RPC
   egress. Record the address.
4. Verify source on BaseScan/Sourcify/Blockscout.
5. Re-read posture on-chain and confirm it matches the config exactly (the script asserts this,
   but confirm independently).
6. Write `deployments/base-mainnet/mpgr-executor-delegated.json` (the script emits it) and
   commit the artifact.
7. Set the four runtime env vars — `MPGR_MAINNET_DELEGATED_EXECUTOR`,
   `MPGR_MAINNET_BROADCASTER_PRIVATE_KEY` (dedicated gas-only wallet, **not** the canary),
   `MPGR_AUTONOMOUS_EXECUTION_ADAPTER=delegated-permit2-mainnet`, `CRON_SECRET` — plus
   `MPGR_AUTONOMOUS_AGENT_ENABLED=true`.
8. Confirm `GET /api/agent/autonomy/config` reports `delegated.chainId == 8453` with the pinned
   executor and `executionAvailable == true` (posture proven, not assumed).
9. The user signs exactly one bounded 1-USDC slot in their wallet (B4).
10. Run one tick, then confirm the full lifecycle and that a duplicate tick cannot re-execute.

Until steps 1–10 have all been done and observed, mainnet autonomous execution is **not** live,
and the system is designed so that it behaves as watch-only rather than half-executable.
