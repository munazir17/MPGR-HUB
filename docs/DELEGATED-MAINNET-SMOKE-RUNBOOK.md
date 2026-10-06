# DELEGATED MAINNET SMOKE RUNBOOK — PREPARED, NOT EXECUTED

**Status: READY (awaiting explicit operator approval). No Base Mainnet transaction has been sent by this work.**

This runbook covers the **dedicated** smoke/canary test for the deployed
**`MPGRExecutorDelegated`** on Base Mainnet. It is a separate test from the v1
assisted-executor smoke test (`script/smoke-executor-base-mainnet.mjs` +
`.github/workflows/smoke-executor-base-mainnet.yml`), which remains **unchanged
and is not reused, imported or modified** by anything described here. Nothing in
this work deploys or reconfigures a contract, and no product code path was weakened.

Canary trade: **BUY 0.50 USDC → WETH through the real deployed delegated path**
(user-signed Permit2 **witness permit** → `swapOnBehalfOfUniswapV3` → the 25 bps
MPGR fee taken atomically inside the same swap → WETH to the signer). Maximum
total exposure: **0.50 USDC + one transaction's gas**. Exactly **ONE** mainnet
transaction is ever sent per wallet.

---

## 1. What is exercised (and what is deliberately NOT)

| Aspect | Value | Source of truth |
|---|---|---|
| Contract under test | `MPGRExecutorDelegated` `0x39B1C6Ea88A01e70cbF4899BF3cEfB2c43cD32Bb` | latest deployment report of `.github/workflows/deploy-delegated-base-mainnet.yml` (run `37472605485`), whose predicted CREATE address is pinned in `scripts/delegated-mainnet-deployment-guard.mjs` (`EXPECTED_EXECUTOR`) and was confirmed by the mined receipt; re-verified live at runtime |
| Deployment tx / block | `0xef46dc42e5513bb7aab3b79b55d79efc2fdca0c77e3db47220186801a094511b` @ `52252520`, deployer `0x954BFdf0b3A262D537c825a40F7ba960830be88A` | same guard script + Blockscout |
| Chain | Base Mainnet `8453` (no other chain is in scope; `buildPermitTypedData` refuses to even build a foreign-chain payload) | `deployments/base-mainnet/delegated-deploy-config.json` |
| Entrypoint | `swapOnBehalfOfUniswapV3(SwapParams,uint24,Permit2Authorization)` — selector `0x9d5fea22` | the deployed runtime dispatch table (verified against the creation bytecode) |
| Authorization | **Permit2 `permitWitnessTransferFrom` with the executor's `ActionWitness`** — one user signature per trade. **The executor is never approved** (a non-zero `allowance(wallet → executor)` is a gate failure), and there is **no standing Permit2 `AllowanceTransfer` approval** (`PERMIT2.allowance(wallet, USDC, executor)` must be 0). The ONE allowance that must exist is the canonical **one-time ERC-20 approval of the Permit2 contract** (`allowance(wallet → Permit2) ≥ 500000`): Permit2's `SignatureTransfer` pulls by calling `USDC.transferFrom(owner, executor, gross)` **from inside Permit2**, so without it the delegated `eth_call` reverts `Error("TRANSFER_FROM_FAILED")` before any executor logic runs. The canary wants **exactly the gross** (least privilege); more is accepted with a non-fatal note | `contracts/executor/MPGRExecutorDelegated.sol` (`_begin` → `_pullFromOwner`); Uniswap `permit2/src/SignatureTransfer.sol::_permitTransferFrom` |
| Route | USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` → WETH `0x4200000000000000000000000000000000000006`, Uniswap V3 SwapRouter02 `0x2626664c2603336E57B271c5C0b26F421741e481`, pool `0x6c561B446416E1A00E8E93E221854d6eA4171372`, fee tier `3000`, QuoterV2 `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` | reviewed config `routers[kind=2]` + `lib/executor/executor-config.ts` (8453 entry) |
| Permit2 | canonical `0x000000000022D473030F116dDEE9F6B43aC78BA3` | contract `PERMIT2()` read live |
| Amount | gross `500000` raw (0.50 USDC) → fee `1250` (25 bps) → swap `498750`; `unwrapNativeOut = false`; recipient = the signer | see §2 |
| Slippage / validity | `amountOutMinimum = quote × 9900/10000` (100 bps); `deadline = latest.timestamp + 300s` and it must still have ≥ 90 s of margin at the moment of broadcast | campaign constants in `scripts/delegated-smoke-gates.mjs` |
| NOT exercised | the Slipstream venue (kind 1), the typed swap-module path (kind 3), `unwrapNativeOut`, native input, any `pause`/fee/router/token setter, the v1 `MPGRExecutor` (`0xD982726e28275661F8aB64054E6b17a70a63505A`, denylisted), and any deployment | by design |

## 2. Why 0.50 USDC is the smallest *safe* amount

`MPGRExecutorDelegated` takes the fee inside the swap and **reverts
`FeeRoundsToZero`** when `feeBps != 0` and `floor(gross × 25 / 10000) == 0`, so the
gross must be ≥ **400** raw units (0.0004 USDC) for the fee path to exist at all.
The canary deliberately uses **0.50 USDC** because it must also satisfy:

1. the fee is exact and *observable* — `1250` raw (0.00125 USDC), comfortably
   verifiable from `Transfer` logs and balance deltas at block precision;
2. the output stays far above dust (≈ 1.5e14 wei of WETH, i.e. ~6 orders of
   magnitude above a 1 wei rounding floor), so the `minOut` floor is meaningful;
3. total loss exposure stays at or below ~$0.50 of value plus one transaction of
   gas — a fifth smaller than the v1 smoke test's 1.00 USDC;
4. gas stays a small fraction of the traded value, so even a reverted canary is a
   cheap signal rather than a loss.

The amount is a **constant, not a knob**: an operator-tunable size is a size that
gets tuned. A different size means a different campaign, reviewed as such.

## 3. Operator-side requirements (nothing here is provisioned by the repo)

| Requirement | Value | Notes |
|---|---|---|
| Dedicated smoke key | NEW GitHub **secret** `BASE_MAINNET_DELEGATED_SMOKE_PRIVATE_KEY` | Generated **offline** by the operator (`cast wallet new`). Used ONLY by the `live` job. **Never** the v1 smoke wallet `0xB54900f2c355CB0A61c62f8220191D3aAA6f4455`, never the Phase-5/6 canary `0xBF6c574b9543967f0D528ae49603b0A7574a280b`, never the deployer, owner, fee recipient, executor, venue or token address — all of those are refuse-by-denylist in `evaluateSignerIdentity`. Never committed, never in a Vercel env, never in a log. |
| Its address | NEW GitHub/environment **variable** `SMOKE_DELEGATED_WALLET_ADDRESS` (non-secret) | The `live` and `preflight` steps refuse to start when it is unset, and the script aborts if the key's derived address is not exactly this value. |
| Funding | `≥ 0.50 USDC` (500 000 raw) **and** `≥ 0.0002 ETH` | Sent by the operator to the smoke address. The canary can only ever move its own funds; USDC it already holds is what it spends. |
| One-time Permit2 approval | `USDC.approve(0x000000000022D473030F116dDEE9F6B43aC78BA3, 500000)` — **exactly the gross**, sent once by the smoke wallet itself before the run | **Required.** Permit2's `SignatureTransfer` moves the tokens with `transferFrom` executed *by the Permit2 contract*, so a wallet that never approved Permit2 cannot redeem any witness permit — the gate refuses, and the simulation would revert `Error("TRANSFER_FROM_FAILED")`. This grants Permit2 **no** unilateral power: it can only move the allowance against a live, single-use, witness-bound signature whose spender is this executor and whose output recipient is the signer. A larger (e.g. unlimited) approval still passes but is reported as a non-fatal note; the exact-gross approval is fully consumed by the one canary trade. This repository never creates it — `preflight` tells you if it is missing. |
| No approval to the executor | deliberately **zero** `allowance(wallet → executor)` **and** zero standing Permit2 `AllowanceTransfer` approval | The delegated path never relies on an executor approval. A non-zero value in either is a **gate failure**, not a convenience. Do not "help" by approving the executor. |
| Optional private RPC | existing secret `BASE_MAINNET_RPC_URL` | Used by all three jobs; the script also has public Base fallbacks with sticky-endpoint retry/backoff/failover and a "never read behind the observed head" rule. |
| Code-hash pin (optional, recommended) | variable `SMOKE_DELEGATED_EXPECTED_CODE_HASH` | If set, the executor's runtime `keccak256(code)` must equal it. The verified deployed runtime hash (`runtimeCodeHash` in `deployments/base-mainnet/mpgr-executor-delegated.json`): `0xc232d9d36cabcefd5f97029d2b4c1f2d60a1b0cd54d020f12d0b517eb3cf085c` — re-read it yourself before pinning. |
| Kill switch | `MPGR_AUTONOMOUS_EMERGENCY_DISABLE=true` | When set, every mode refuses to start, before any network call. |
| Second confirmation | the literal phrase `smoke-delegated-base-mainnet` | Needed twice, independently: as the `workflow_dispatch` `confirm` input (job condition) **and** as `SMOKE_DELEGATED_CONFIRM` inside the script (its own gate). A wrong/absent phrase aborts before the key is used. |

## 4. Running it

### 4.1 Rehearsal — local Base Mainnet fork (default, no key, nothing broadcast)

```bash
anvil --fork-url https://mainnet.base.org --host 127.0.0.1 --port 8545 &
SMOKE_DELEGATED_MODE=rehearsal \
SMOKE_DELEGATED_RPC_URL=http://127.0.0.1:8545 \
node script/smoke-delegated-executor-base-mainnet.mjs
```

* The RPC **must** be `127.0.0.1`/`localhost` and there must be exactly one endpoint; the
  env key is refused in this mode (the gate checks its *presence*, so run it in a clean shell).
* The principals are **fork-only accounts derived from public labels** (`keccak256("mpgr-delegated-smoke-rehearsal:<label>")`)
  so no key literal ever exists in the repository. The signer and the broadcaster are
  **two different accounts**: this is the only mode that proves the delegated property
  that *anyone* may relay a user-signed permit while the output still lands on the signer.
* The rehearsal funds its principals on the **fork only** (a located-slot
  `anvil_setStorageAt` USDC top-up plus `anvil_setBalance` for ETH) and records that as an
  explicit non-mainnet annotation in the report.
* It also writes the **canonical one-time `USDC → Permit2` approval** into fork state
  (same located-slot technique, for **exactly the 500000 raw gross** — never unlimited,
  never the executor). A real user grants this once, off-band, before signing anything;
  a freshly derived fork principal never has it, and Permit2's `SignatureTransfer` pull
  (`USDC.transferFrom(owner, executor, gross)` executed *by Permit2*) would otherwise
  revert `Error("TRANSFER_FROM_FAILED")` before any executor logic runs. No approval
  transaction is broadcast anywhere — only local anvil state is touched, and the report
  annotates it. `preflight`/`live` never write it: there the operator must have granted
  it, and the gate refuses until they have.
* If the signed `eth_call` reverts, the report prints the **decoded revert**
  (`Error(string)`, `Panic`, or any `MPGRExecutorDelegated`/Permit2/ERC-20 custom error,
  with the raw 4-byte selector) together with the exact non-secret call frame: `from`/`to`/
  `value`, the calldata selector and size, tokens, gross/fee/minOut, recipient, deadline vs
  block timestamp, Permit2 nonce, witness hash, and the balance/allowance state it ran
  against.
* Log queries are **fork-bounded**: the historical `SwapExecuted` scan covers only the last
  10 blocks of the fork (`REHEARSAL_LOG_WINDOW`) instead of the deployment block onwards.
  Anvil proxies pre-fork `eth_getLogs` to the upstream, which caps the range a single call
  may span (as low as 10 blocks on public Base endpoints), so an unbounded scan fails
  there; and the fork-derived principals cannot have real history. `preflight` and `live`
  are unchanged — they scan from the deployment block for the pinned wallet. The report's
  "One-shot scan" line states which window was used.

### 4.2 Preflight — strictly read-only against real mainnet

```bash
SMOKE_DELEGATED_MODE=preflight \
SMOKE_DELEGATED_WALLET_ADDRESS=0x<fresh-smoke-wallet> \
node script/smoke-delegated-executor-base-mainnet.mjs
```

No key is read (a key in the environment is a **refusal**), nothing is signed, nothing is
sent. Every precondition is evaluated and printed; the three signature-dependent proofs
are reported as **skipped**, not as passed. `preflight` green = "a live run would be allowed".

### 4.3 Live — CI only, `base-mainnet` environment approval only

1. Add the label `smoke-delegated-base-mainnet` to a PR (or run *Delegated executor smoke
   test (Base Mainnet)* from `main` with `confirm = smoke-delegated-base-mainnet`).
2. `rehearse` (no secrets) runs the offline gate suite, then the fork rehearsal.
3. `preflight` (no key) audits real mainnet state for the pinned wallet.
4. `live` starts **only** if both succeeded, waits for the `base-mainnet` environment
   reviewer, and only then injects the key into a single step. It re-runs the entire gate
   table, claims the one-shot ledger, and broadcasts **exactly one** transaction.
5. Each job prints annotations, writes the report to the step summary and (for PRs) upserts
   a marker-guarded comment, uploads the JSON/MD artifacts, and exits with the script's status.

There is **no deploy step anywhere** in the workflow: it never runs `forge script`, never
verifies, never broadcasts a creation, and never calls a setter.

## 5. The strict one-shot guard (three independent layers)

| Layer | Mechanism | Failure it prevents |
|---|---|---|
| Deterministic single-use Permit2 nonce | `permitNonce = uint256(keccak256("mpgr-delegated-nonce:<campaign>:<wallet>"))`; the gate reads `nonceBitmap(wallet, nonce >> 8)` and refuses unless that exact bit is **unset**; after a successful swap it is set on-chain, so a replay reverts | re-running the same canary with the same wallet, from any machine, even with the local state deleted |
| Historical `SwapExecuted` scan | chunked `eth_getLogs` (2 000 blocks/chunk) from the deployment block (`52252520`) for `taker == wallet`; any hit refuses. The scan is bounded at 2 000 chunks (~4M blocks, ~3 months of Base blocks) and **fails closed** beyond that — point `BASE_MAINNET_RPC_URL` at your own full node, or (the intended answer) start a new campaign with a new wallet. **`rehearsal` scans only the last 10 blocks of the local fork** (`REHEARSAL_LOG_WINDOW` in `scripts/delegated-smoke-gates.mjs`): a local anvil fork does not hold its pre-fork history, so the deployment-block-anchored scan would push hundreds of chunked calls at the fork's upstream, whose `eth_getLogs` range cap (public Base endpoints: as low as 10 blocks) it cannot satisfy — and the fork-only principals cannot have real history anyway. The report's one-shot line marks the rehearsal bound explicitly; `live`/`preflight` keep the full certification | a broadcast that happened outside this workflow's knowledge |
| Local one-shot ledger | `.mpgr-delegated-smoke/<campaign>-8453-<wallet>.json`, created with `O_EXCL` **before** the broadcast, then updated with the tx hash; a recorded broadcast = permanent refusal for that wallet; an interrupted claim needs the operator to echo the recorded `claimId` via `SMOKE_DELEGATED_LEDGER_ACK`; CI caches the directory keyed by the wallet and never cancels a run mid-broadcast | a double-clicked dispatch, a retried job, two concurrent runs |

**Re-running the canary after a success requires a NEW wallet** (new key, new secret, new
variable, new funding). That is intentional: one wallet, one canary. Deleting the ledger is
*not* sufficient — the on-chain nonce is already spent, which is the point.

After an interrupted run (claimed, never broadcast): read `claimId` from the ledger file or
the job log, then re-dispatch with `SMOKE_DELEGATED_LEDGER_ACK=<claimId>` set deliberately.
Any other ack value is refused.

## 6. Gate catalogue — what a refusal means

All decisions are pure functions in `scripts/delegated-smoke-gates.mjs`, exhaustively tested
offline in `scripts/delegated-smoke-gates.test.ts`; the runner reads facts and calls them, and
a **missing read never counts as a pass** (the only fatal row that can pass with zero facts is
the campaign's own fee arithmetic).

| Stage | Representative refusals |
|---|---|
| 0. environment | unknown/missing mode; no RPC; rehearsal RPC not local or more than one; preflight RPC is a local fork; key present in a keyless mode; malformed key; malformed wallet pin; `live` outside GitHub Actions; emergency kill switch set |
| 1. signer identity | derived address ≠ pinned address; any denylisted address (v1 smoke wallet, Phase-5/6 canary, deployer, owner, fee recipient, either executor, Permit2, router, quoter, factory, pool, USDC, WETH, zero address); malformed address |
| 2. committed configuration | missing/renamed config; `contract` not `MPGRExecutorDelegated`; wrong `chainId`/`owner`/`feeRecipient`/`feeBps`/`maxFeeBps`; non-canonical WETH or Permit2; missing or duplicated Uniswap V3 venue; venue/pool/fee drift; token allowlist or decimals drift; `denied.*` drift; Sepolia address used as mainnet infrastructure; deployment record contradicting the pinned executor/tx/block/paused/proxy posture (absent record = non-fatal note, the pins + live reads carry it) |
| 3–5. live preconditions | wrong chain; no/short executor bytecode; bytecode without the `swapOnBehalfOfUniswapV3` dispatch; code hash ≠ the operator pin; target is the v1 executor; `paused`; `pendingOwner` set; rotated owner/fee recipient; `feeBps != 25`; `MAX_FEE_BPS != 100`; witness type string / struct string / typehash drift; `witnessHashOf` ≠ the local EIP-712 hash; `unwrapNativeOut`; signer is the fee recipient; router kind ≠ 2; token not allowlisted; dead router/quoter/pool code; `factory.getPool` ≠ pinned pool; token decimals drift; a registered typed swap module; `quoteFee` ≠ the local split; fee that rounds to zero; quote outside the $500–$20 000 implied-ETH band; `minOut` above the quote or not the pinned 100 bps; deadline already past, with < 90 s margin, or beyond the 300 s window; wallet short of USDC or of worst-case gas ETH; `maxFeePerGas` > 1 gwei or tip > 0.05 gwei; estimated L2 cost above the cap; **any** standing ERC-20 allowance to the executor; a **missing or short** one-time ERC-20 approval to the Permit2 contract (`< 500000` raw — the state that makes the Permit2 pull revert `TRANSFER_FROM_FAILED`); any standing Permit2 `AllowanceTransfer` allowance; nonce already spent (caller's flag **and** an independent bitmap recomputation); bitmap read for the wrong owner; residue on the executor (USDC/WETH/ETH); a pre-existing executor→router allowance; any prior `SwapExecuted` for this wallet; an existing ledger; simulation of the signed payload reverting (its revert data is decoded and reported — `Error(string)`, `Panic`, or any executor/Permit2/ERC-20 custom error) or returning less than `minOut` (a reverted simulation produces **no** `amountOut`, so that row fails too — it is never satisfied by the quoter's number); calldata not `0x9d5fea22` or not decoding back to the exact params; signature not recovering to the pinned signer; missing/mismatched confirmation phrase (live) |
| 6–7. post-trade | reverted receipt; `to` not the delegated executor; broadcaster identity wrong for the mode (`live` = self-broadcast, `rehearsal` = the separate relayer); non-zero `value`; wire calldata ≠ the simulated payload; `recipient` or `witness.owner` redirected; foreign `intentId`; permit for the wrong token or more than the gross; zero or multiple `SwapExecuted`; `taker` ≠ signer; wrong router/pair/gross/fee/swap/`feeBps`/`routerKind`/`flags`; `amountOut` below the signed minimum; the owner→executor pull, the executor→fee-recipient 1 250 transfer, the executor→pool 498 750 leg or the WETH-to-owner sum not matching exactly; WETH to any non-owner; wallet USDC delta ≠ −500 000; wallet WETH delta ≠ the event's `amountOut`; fee-recipient delta ≠ 1 250 at the receipt block; residue or a leftover allowance on the executor; the nonce not spent afterwards; broadcast count ≠ 1 |

## 7. After the canary (checklist)

1. Read `smoke-delegated-live.{json,md}` (also in the job summary + PR comment). Every row must be ✅.
2. Independently confirm on the explorer: the one tx, `SwapExecuted(taker = smoke wallet)`,
   `Transfer` USDC wallet → executor `500000`, executor → fee recipient `1250`,
   executor → pool `498750`, WETH pool → wallet `amountOut ≥ minOut`, and
   **0** allowance left on the executor.
3. Confirm `nonceBitmap(smoke wallet, nonce >> 8)` now has the campaign bit set (the guard
   asserts this from the receipt block).
4. Keep the ledger file (and the Actions cache) so a re-run for that wallet stays refused.
5. Destroy or park the smoke key. Its balance is the residual USDC + gas; sweeping it is an
   operator action outside this workflow.
6. If anything failed **after** broadcast (e.g. a post-trade check): the funds are where the
   event says they are. Do not re-broadcast with the same wallet; reconcile from the receipt.

## 8. State observed while preparing this test (for the reviewer)

* `deployments/base-mainnet/mpgr-executor-delegated.json` is **not committed** (the deploy
  job wrote it to the runner's workspace only). The gates therefore treat a missing record as
  a non-fatal note and rely on the guard-script pins plus live re-verification, and refuse a
  record that *contradicts* those pins.
* Explorer state at authoring time: the executor exists with `creation_status: success`
  created by the pinned deployer; its code is 30 378 bytes with hash
  `0xc61147…8228a4d6`; it has received **no** `SwapExecuted` events and holds zero USDC/WETH
  and zero allowances — i.e. the delegated path is live but so far unused, so a first
  canary is also the contract's first real trade.
* The Blockscout contract page is **not verified** (`is_verified: false`); the smoke test does
  not depend on source verification — it reads the deployed ABI's own views
  (`WITNESS_TYPE_STRING`, `ACTION_WITNESS_TYPEHASH`, `witnessHashOf`, `quoteFee`, …) and
  proves the encoding against them.
* `mainnetDelegatedExecutorAddress()` returns `null` unless the operator sets
  `MPGR_MAINNET_DELEGATED_EXECUTOR`, so this campaign pins the address itself (and asserts
  the guard's `EXPECTED_EXECUTOR` and, when the operator pin exists, the production registry
  entry, in `scripts/delegated-smoke-gates.test.ts`).
* A rehearsal against a local anvil instance **without** a real Base Mainnet fork cannot
  proceed: the reads have no contract state, and the run aborts on the chain-id/posture
  gates. That is the expected fail-closed behaviour, not a defect; use `--fork-url`.
* Offline evidence: `npx vitest run scripts/delegated-smoke-gates.test.ts
  test/workflows/smoke-delegated-executor-base-mainnet.test.ts` → 256 passing checks of the
  gate table, every refusal above, and the workflow's trigger/secret/one-shot wiring.

## 9. Out of scope (deliberately)

No deployment or redeployment of any contract; no change to `contracts/**`, to the deploy
workflows, or to the v1 smoke test; no `approve` transaction; no pause/fee/router/token
change; no real mainnet transaction executed during development; no re-use of any existing
key or wallet.
