# MAINNET CANARY RUNBOOK — PREPARED, NOT EXECUTED

**Status: READY (awaiting explicit operator approval). No Mainnet transaction has been sent.**
This runbook is the complete preparation for the ONE-transaction Base Mainnet canary. It is executed only after the operator explicitly approves. Nothing in the product changes: **autonomous execution remains OFF by default**, no Vercel/production env is touched, no keys are provisioned by this repo, and no contract is modified.

Canary trade: **BUY 1.00 USDC → AAPLc through the real Mainnet runtime path** (Goal → Scheduler → Policy → fresh quote → v1 prepare → broadcast → receipt verification → audit → goal COMPLETED). Maximum total exposure: **1.00 USDC**.

---

## 1. Canary configuration requirements (all operator-side; none provisioned yet)

| Requirement | Value | Notes |
|---|---|---|
| Dedicated canary key | NEW GitHub secret `MPGR_MAINNET_CANARY_PRIVATE_KEY` | Generated OFFLINE by the operator. NEVER the user's main wallet, the deployer, the fee recipient, or the Sepolia broadcaster (`MPGR_BROADCASTER_PRIVATE_KEY`). Used ONLY by the canary job. Never placed in any file, Vercel env, or log. |
| Canary key address | NEW GitHub secret `CANARY_ADDRESS` | Derived offline from the canary key (e.g. `cast wallet address`). Used read-only for balance/allowance/sender checks. |
| Dedicated Mainnet RPC | NEW GitHub secret `BASE_MAINNET_RPC_URL` | Dedicated provider endpoint; the app's chain reader uses a single transport with no silent fallback. Falls back to publicnode only if unset. |
| Canary funding | canary address holds **≥ 1.00 USDC** + **≥ 0.0001 ETH** | Sent by the operator from their own funds to the canary address. The canary can only ever move ITS OWN funds. |
| Canary approval | canary address → executor allowance **≥ 1.00 USDC** | One operator-made approval tx from the canary key BEFORE arming, so the canary itself is **exactly ONE transaction**: `approve(0xD982726e28275661F8aB64054E6b17a70a63505A, 2000000)` (USDC `0x8335…2913`). |
| Tiny limits (enforced in code by the canary test) | per-trade **1.00 USDC**; daily **2.00 USDC**; **1 action/day**; slippage **100 bps** (policy cap 300) | Hard-coded in the canary goal/policy; runtime + policy engine enforce them; absolute runtime ceilings (10 000/100 000 human) unchanged. |
| Kill switch (in-sandbox) | `MPGR_AUTONOMOUS_EMERGENCY_DISABLE=true` | Evaluated inside the runtime before every action → goal PARKED, nothing signed. The canary test ALSO refuses to start when this is set. |
| Master switch | `MPGR_AUTONOMOUS_AGENT_ENABLED` | Exists ONLY inside the canary test process of an explicitly armed dispatch (Phase-5-armed pattern). The product default remains OFF; no Vercel/production env changes. |

**Exact wallet roles (and the reuse guard):**

| Role | Identity | Chain | Rules |
|---|---|---|---|
| **Mainnet canary broadcaster** | NEW dedicated key — GitHub secret `MPGR_MAINNET_CANARY_PRIVATE_KEY`; address pinned as `CANARY_ADDRESS` | 8453 ONLY | The ONLY key that can sign the canary. Exposure capped by its own funding (≤ ~1 USDC + gas). Pre-approved to the executor. Drained + rotatable post-canary. |
| **Sepolia broadcaster (operator)** | existing GitHub secret `MPGR_BROADCASTER_PRIVATE_KEY` | 84532 ONLY | Belongs to the delegated Phase 2–5 path, which hard-refuses chain 8453 (`UNSUPPORTED_CHAIN`) — it can never transact on Mainnet even if misconfigured. NEVER used by the canary. |
| Executor owner | `0xE0e0d239853c5F2Fe0a524d544eC9eB71fef486e` | 8453 | `pause()`/config authority — the on-chain kill switch. Never a broadcaster. |
| Fee recipient | `0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4` | 8453 | Receives the exact 25 bps fee. Never a broadcaster. |
| User main wallet | user-custodied | any | Never provisioned, requested, or used as a broadcaster by this repo (standing constraint). Assisted/manual trading only. |
| Deployer | deployment-time only | 8453/84532 | Not part of the canary in any role. |

**Sepolia-reuse guard (deterministic, fail-closed, enforced pre-sign in the canary AND in the read-only preflight):** the canary address must differ from the owner, the fee recipient, the executor, the delegated Sepolia executor, AND the Sepolia broadcaster — checked (1) against the live `MPGR_BROADCASTER_PRIVATE_KEY` env if a runner ever carries it, and (2) against the non-secret address pin `SEPOLIA_BROADCASTER_ADDRESS` (repo variable/secret). Any equality is FATAL: nothing is signed or broadcast.

**Emergency kill-switch procedure (any time):**
1. Immediate: re-dispatch `Mainnet Canary` with `armed=false` (all jobs then read-only) — and/or set `MPGR_AUTONOMOUS_EMERGENCY_DISABLE=true` in the repo/runner environment and re-run anything armed; the canary test checks it first and refuses.
2. Structural: the canary only executes inside its explicitly dispatched job — there is no standing Mainnet execution anywhere (the production Mainnet adapter `noDelegationAdapter` refuses every action; F-15).
3. On-chain: the executor owner can `pause()` the executor (owner-gated) — quoting/prepare/execution then fail closed (`EXECUTOR_PAUSED`).
4. Funds ceiling: the canary key holds ≤ ~1 USDC + gas; exposure cannot exceed that even if everything else failed.

## 2. Exact preflight checklist (all read-only — `Mainnet Canary` workflow, `armed=false`)

1. CI green at the pinned SHA: full vitest, `tsc`, lint, `audit:high`, contracts, **contracts-fork (includes F-13 13/13 stock bytecode proof)**.
2. Phase 6 fork rehearsal green on the same SHA (workflow `Phase 6 Fork Rehearsal`).
3. `Mainnet Canary` dispatch with `armed=false`:
   - [ ] chain is 8453;
   - [ ] executor owner / feeRecipient / feeBps==25 / **not paused** match pins;
   - [ ] bytecode present: executor, Permit2, USDC, WETH, **13/13 stocks**;
   - [ ] decimals: USDC 6, WETH 18, stocks 8;
   - [ ] USDC/AAPLc tick-10 Slipstream pool exists; live quoter 1 USDC → AAPLc inside sanity band [0.0001, 1] AAPLc;
   - [ ] (with `CANARY_ADDRESS` secret set) canary wallet: ETH ≥ 10¹⁴ wei, USDC ≥ 1.00, allowance ≥ 1.00, and distinct from owner/feeRecipient/executor **and the Sepolia broadcaster** (`SEPOLIA_BROADCASTER_ADDRESS` pin).
4. Operator sanity: expected proceeds ≈ quote; slippage tolerance 100 bps; verify the dispatch is on `arena/01a0e784-mpgr-hub` at the approved SHA.

## 3. Exact one-transaction canary procedure (after explicit operator approval)

1. Operator replies with explicit approval naming this SHA (the approval IS the authorization required by the task constraints).
2. Confirm preflight job green (Section 2) on that SHA.
3. Dispatch `Mainnet Canary` with **`armed=true`**. The `canary` job:
   - refuses to start unless `MPGR_MAINNET_CANARY_PRIVATE_KEY` exists (fail closed);
   - re-asserts, ON MAINNET, before signing: chain 8453; owner/feeRecipient/feeBps/not-paused; Permit2; canary ≠ owner/feeRecipient; USDC ≥ 1.00; allowance ≥ 1.00; emergency switch unset;
   - runs the REAL runtime chain (in-memory goal/policy with the tiny limits above) → exactly **ONE** broadcast: the prepared executor swap (600k gas) from the canary key;
   - verifies the receipt: status success, `to == executor`, `from == canary`, and the executor's `SwapExecuted` event: `tokenIn==USDC`, `tokenOut==AAPLc`, `grossAmountIn==1_000_000`, `feeAmount==2_500` (EXACT 25 bps), `feeRecipient==pinned`, `feeBps==25`, `flags==0`, `amountOut ≥ minOut`;
   - completes the runtime verification pass → goal **COMPLETED**, exactly **1** broadcast ever, ordered audit chain, no key material in the audit dump;
   - writes `mainnet-canary-tx.txt` + evidence artifact and emits `::error::MAINNET_CANARY ok tx=…` (annotation is used because Actions log download is flaky).
4. The `reconcile` job re-proves everything independently (Section 4).

## 4. Exact post-transaction reconciliation (read-only, `scripts/mainnet-canary-reconcile.mjs`)

- [ ] receipt status `success`; `to == executor`; `from == canary`;
- [ ] exactly one executor-emitted `SwapExecuted`: taker == canary; tokenIn == USDC; tokenOut == AAPLc; gross == 1 000 000 raw; fee == 2 500 raw (exact 25 bps); `fee + swapAmountIn == gross`; feeRecipient == pinned; feeBps == 25; routerKind == 1 (Slipstream); flags == 0; amountOut > 0; intentId ≠ 0;
- [ ] balance deltas AT the receipt block: canary USDC **−1 000 000 raw exactly**; canary AAPLc **+amountOut exactly** (no partial fill, no skim);
- [ ] goal state COMPLETED in the evidence artifact; audit chain ordered; broadcaster/canary key material never present;
- [ ] gas spent by the canary ≈ expected (≤ 600k gas × current base fee) — recorded from basescan;
- [ ] run the standalone reconciler any time later: `node scripts/mainnet-canary-reconcile.mjs 0x<tx>` (or dispatch the workflow with `canaryTxHash`).

**Post-canary state:** autonomous remains OFF in the product; the canary key is drained (operator sweeps remaining dust) and its secret can be rotated/deleted; no further Mainnet transactions occur without a new explicit approval.

## 5. Remaining risks (honest)

- **R1 (LOW):** first-ever Mainnet runtime execution — mitigations: full Phase 6 fork rehearsal + preflight + tiny exposure; the executor path itself is production-proven (assisted trades, incl. USDC→AAPLc, have executed on Mainnet before).
- **R2 (LOW):** public-RPC degradation can fail the canary mid-run — fails closed before signing (preflight/re-assertions); worst case is no transaction.
- **R3 (LOW):** price movement between quote and broadcast → minOut revert — costs gas only; no bad fill possible (minOut immutable in calldata; Phase-6 fork-proven).
- **R4 (INFORMATIONAL):** the canary key, if leaked, exposes ≤ ~1 USDC + gas (keep it that way; drain after the canary).
- **R5 (INFORMATIONAL):** the executor is not externally audited (documented in-app) — exposure limited to 1 USDC by design.
- **R6 (MEDIUM, process):** operator arming is a human gate — the workflow cannot distinguish an authorized operator click from any other committer with dispatch rights once merged. Mitigation: only this repo's admins can dispatch; the explicit approval message must name the SHA; the canary job refuses without the dedicated secret which only the operator can add.

## 6. Artifacts

- Workflow: `.github/workflows/mainnet-canary.yml` (armed defaults to **false**)
- Preflight (read-only): `scripts/mainnet-canary-preflight.mjs`
- Canary executor (env-gated OFF; exactly ONE tx): `lib/autonomy/__tests__/mainnet-canary.execution.test.ts`
- Reconciler (read-only): `scripts/mainnet-canary-reconcile.mjs`
- F-13 fork proof (13/13 stock bytecode): `test/fork/B20StockBytecodeFork.t.sol` (runs in `contracts-fork`)
- F-13 registry↔fork lockstep pin: `phase6-mainnet-audit.test.ts` §G
- Phase 6 report: `docs/PHASE6-MAINNET-AUDIT.md`
