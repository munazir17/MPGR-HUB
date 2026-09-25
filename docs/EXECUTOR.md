# MPGR Executor + MCP trading

Non-custodial, AI-native trading for MPGR Agent. An AI (in-app or any external MCP client such as ChatGPT, Claude or Grok) can **discover → quote → prepare** a trade. The **user's own wallet** signs and sends it. The server then **verifies** it on-chain.

No component of MPGR, and no AI, ever receives, stores or uses a private key.

```
AI / MCP client ──JSON-RPC──▶ /api/mcp (stateless, read/prepare only)
                                 │  reads: executor config, balances, allowances, quoter (eth_call)
                                 ▼
                     unsigned approval tx / EIP-712 typed data / unsigned swap tx
                                 │
User wallet ── signs & sends ──▶ MPGRExecutor ──typed call──▶ allowlisted router (Uniswap V3 / Slipstream)
                                 │  one tx: pull G → fee to feeRecipient → swap (G-fee) → output to user
                                 ▼
                     SwapExecuted event ──▶ mpgr_verify_trade (exact fee, taker, tokens, minOut)
```

## Contract: `contracts/executor/MPGRExecutor.sol`

Solidity 0.8.24. Built on OpenZeppelin `Ownable2Step`, `Pausable`, `ReentrancyGuard` and `SafeERC20`.

### Entry points (the only ways to move user funds)

| function | adapter |
|---|---|
| `swapUniswapV3ExactInputSingle(SwapParams, uint24 poolFee, Authorization)` | Uniswap `SwapRouter02.exactInputSingle` |
| `swapSlipstreamExactInputSingle(SwapParams, int24 tickSpacing, Authorization)` | Aerodrome Slipstream `SwapRouter.exactInputSingle` |

There is **no** generic `execute(target, data)`. The router calldata is built *inside* the contract from typed parameters. The caller never supplies calldata.

`SwapParams { router, tokenIn, tokenOut, grossAmountIn, expectedFeeAmount, amountOutMinimum, recipient, deadline, intentId, unwrapNativeOut }`

### Validation (all revert, nothing is skipped)

- **Router:** `routerKind[router]` must equal the adapter's kind. Routers are allowlisted by the owner; each router maps to exactly one kind and can never also be an allowlisted token.
- **Tokens:** `tokenIn` and `tokenOut` must be allowlisted and different.
- **Amounts:** `grossAmountIn > 0` and `amountOutMinimum > 0`. `deadline >= block.timestamp`.
- **Recipient:** `recipient == msg.sender`, so output can never be redirected. The fee recipient cannot trade (`TakerIsFeeRecipient`).
- **Fee:**
  - `fee = floor(G * feeBps / 10_000)` must equal `expectedFeeAmount`. This catches a fee change between quote and execution, so the user never pays a fee they did not see.
  - If `feeBps > 0` and the fee rounds to 0, the call reverts (`FeeRoundsToZero`). A fee is never silently skipped.
- **Pull:**
  - The contract pulls exactly `G` **from `msg.sender` only**, and the balance delta must equal `G`. Fee-on-transfer and rebasing tokens are rejected.
  - The fee is sent to `feeRecipient` in the same tx.
- **Router allowance:** exactly `G - fee`, reset to 0 afterwards.
- **Input consumption:** the input must be fully consumed; the contract balance must return to its pre-trade value.
- **Output:** measured by the user's balance delta, never trusted from the router return value. It must be `>= amountOutMinimum`.
- **Native ETH in:** `tokenIn == WETH`, `msg.value == G`, and only the APPROVAL auth mode is allowed. `G - fee` is wrapped and the fee is paid in ETH.
- **Native ETH out:** `tokenOut == WETH`. The output is unwrapped and sent to `msg.sender`.
- **Guards:** `nonReentrant` on every entry point and on rescue. `whenNotPaused` on swaps.

### Authorization modes

| mode | what the user does | txs |
|---|---|---|
| `APPROVAL` (0) | `approve(executor, G)`, **exact** amount | approve (only if allowance < G) + swap |
| `EIP2612` (1) | signs an EIP-2612 `Permit(owner, executor, G, nonce, deadline)` | **1** swap tx |
| `PERMIT2` (2) | one-time `approve(Permit2, G)`, then signs a Permit2 `PermitTransferFrom{token, G}` with spender = executor | **1** swap tx per trade |

- **Allowance vs. approval vs. permit.**
  - *Allowance* is the on-chain state.
  - *Approval* is the tx that sets it.
  - A *permit* is an off-chain signature that sets it inside the swap tx.
  - *Permit2* is a separate allowance holder whose signature transfers are bound to one amount, nonce and deadline.
  - *Execution* is the swap tx itself.
- **Who can use a permit.** The executor always passes `owner = msg.sender` to Permit2 and `permit()`. A signature can therefore only ever be used in a tx **sent by the signer**. A leaked or front-run permit gives the attacker nothing.
- **EIP-2612 front-running** is tolerated: if `permit()` reverts but the allowance already exists, the swap continues.
- **EIP-2612 support.** The server only offers EIP-2612 for tokens that expose EIP-5267 `eip712Domain()` with the right chainId. Otherwise it returns `EIP2612_UNSUPPORTED`.

### Admin (owner = the user's designated wallet)

| function | notes |
|---|---|
| `setFeeBps(uint16)` | Hard cap `MAX_FEE_BPS = 100` (1%), a compile-time constant. Initial value 25. |
| `setFeeRecipient(address)` | Rejects the zero address and the executor itself. |
| `setRouter(address, RouterKind)` | Router must be a contract. `NONE` removes it. |
| `setTokenAllowed(address, bool)` | Token must be a contract. |
| `pause()` / `unpause()` | Stops swaps. Admin and rescue still work. |
| `rescueERC20` / `rescueNative` | The executor never holds funds between txs. This exists only to return accidental transfers. |
| `transferOwnership` → `acceptOwnership` | Two-step. `renounceOwnership` is disabled so the contract can never become ownerless. |

**Events:** `SwapExecuted` (taker, router, intentId, tokens, gross, fee, swapAmount, amountOut, feeRecipient, feeBps, routerKind, flags) and one event per admin change.

## Fee mechanics

- **Formula:** `fee = floor(sellAmount * feeBps / 10_000)` of the **sell** token. With `feeBps = 25`: 10,000 → 25, 799 → 1, 399 → refused.
- **Collection:** the fee is taken **in the same transaction** as the swap. There is never a separate fee tx.
- **Rounding:** never rounds up. If the fee would be 0 the trade is refused.
- **Live reads:** the server reads `feeBps()` and `feeRecipient()` live. If they change between quote and prepare, prepare fails with `QUOTE_STALE`. If they change between prepare and execution, the tx reverts with `FeeMismatch`.

## Provider strategy

| provider | how the 25 bps fee is collected | status |
|---|---|---|
| **Aerodrome Slipstream** | MPGR Executor, fee on the sell token, on-chain exact | Base mainnet fork tests pass in CI against the live router/factory the app already uses (`0x698C…`/`0xf8f2…`) on the WETH/USDC pools. `sweepTokenWithFee` is **not used**: it takes the fee from the *output* token, based on a router-computed amount, so it can't be proven exact on the sell token. |
| **Uniswap V3** | MPGR Executor | Real swaps run on Base Sepolia by the deploy workflow (Slipstream has no Sepolia deployment). |
| **0x Swap API** | Native integrator fee: `swapFeeRecipient`, `swapFeeBps=25`, `swapFeeToken=sellToken` | `lib/trade/zero-ex-native-fee.ts` rejects any quote unless `fees.integratorFee` is exactly `floor(G*25/10000)` in the sell token, there is only one integrator fee, and both the spender and `to` are AllowanceHolder (never Settler). MCP only, Base mainnet, **off** unless `MPGR_MCP_ENABLE_BASE_MAINNET=true`. The existing UI 0x client is unchanged. |
| **CDP Trade API** | none | The CDP Swap API has **no integrator-fee parameter**; CDP charges its own fee. Its calldata is taker-bound and can't be wrapped. It is not offered over MCP, and the UI keeps its existing flow. |

The existing UI routing, quotes, slippage and wallet guards (`lib/trade/*`) are **unchanged**.

## MCP server — `POST /api/mcp`

- **Transport:** Streamable HTTP. Stateless JSON responses (no SSE, no sessions). JSON-RPC 2.0; batches of up to 10 messages.
- **Protocol versions:** 2025-06-18, 2025-03-26, 2024-11-05.
- **Methods:** `initialize`, `notifications/*` (202), `ping`, `tools/list`, `tools/call`.
- **Origin:** no `Origin` header (server-to-server connectors) is allowed. An `Origin` equal to `APP_ORIGIN` or listed in `MPGR_MCP_ALLOWED_ORIGINS` is allowed. Anything else gets **403** (DNS-rebinding protection).
- **Limits:** 60 req/min per IP. Body ≤ 64 KB. An unsupported `MCP-Protocol-Version` gets 400. `GET`/`DELETE` get 405.

| tool | purpose |
|---|---|
| `mpgr_get_capabilities` | chains, executor, fee policy, auth modes, providers, flow |
| `mpgr_list_tokens` | allowlisted tokens and pairs (`"ETH"` = native) |
| `mpgr_get_quote` | exact fee, expected/min output, route, and an HMAC-signed `quoteId` (120 s) |
| `mpgr_prepare_trade` | exact approval tx, EIP-712 typed data and/or unsigned swap tx |
| `mpgr_finalize_trade` | checks that the user's permit signature recovers to the taker, then returns the one-tx swap |
| `mpgr_get_trade_status` | confirmed / reverted / pending |
| `mpgr_verify_trade` | receipt vs. intent: event emitted by the executor, exact fee, recipient, minOut |

**Intent fields:** chainId, taker, recipient (= taker), sell/buy token, sellNative/buyNative, sellAmount, expectedBuyAmount, minBuyAmount, slippageBps, feeBps, feeAmount, feeToken, feeRecipient, swapAmount, route, executor, spender, authorization, deadline, intentId, quoteId, and transactionRequest `{chainId, to, data, value}`.

**quoteId:** `q1.<base64url JSON>.<HMAC-SHA256>`, keyed from `AUTH_SESSION_SECRET` with domain separation. Every economically relevant field is bound into it. Prepare, finalize and verify **re-derive** the intent from it, so a client cannot alter the amount, fee, recipient or minOut. The intent deadline is `iat + 600 s`. `intentId = keccak256("mpgr-executor-intent:" + quoteId)` is emitted on-chain.

`/llm.txt` and `/llms.txt` give a machine-readable summary built only from committed public config. They never read the environment.

## Threat model

| threat | mitigation |
|---|---|
| Arbitrary call / malicious calldata | No generic call. Typed adapters only. Router calldata is built in-contract. |
| Malicious router | Owner allowlist plus kind binding. Exact `G-fee` allowance, reset after. Input must be fully consumed. Output measured by balance delta. |
| Output redirection | `recipient == msg.sender` enforced on-chain and in the TS intent builder. |
| Fee bypass / double fee | Fee computed on-chain and checked against the committed `expectedFeeAmount`. One transfer per trade. Zero-rounding reverts. 0x: exactly one integrator fee, validated exactly. |
| Draining via approvals | Pulls only from `msg.sender`. Approvals are exact-amount, never unlimited. Permits only work in the signer's own tx. |
| Reentrancy | `nonReentrant` on all entry points and rescue. ERC-777-style hooks can't re-enter. Checked by the invariant/fuzz tests. |
| Fee-on-transfer / rebasing tokens | Balance-delta checks revert (`UnsupportedTransferAmount`, `InputNotFullyConsumed`). |
| Trapped funds | No custody between txs. Pre/post balance equality is enforced. Owner-only rescue for accidental transfers. |
| Admin compromise | 2-step ownership, no renounce. Fee hard-capped at 1% in code. Pause only stops swaps. The owner cannot move user funds (no allowances are held; the executor has nothing to take). **Recommend a multisig owner before mainnet.** |
| AI prompt injection | The MCP returns unsigned data only, and all tools are read-only. The wallet shows the real `to`, value and calldata. Tokens are identified by address. The server can't sign. |
| Tampered quotes | HMAC-bound quoteId. Live fee re-check. On-chain `FeeMismatch`. |
| Endpoint abuse | Origin policy, per-IP rate limit, body limit, 10 s RPC timeout, generic error messages. |

## Base Sepolia deployment (GitHub Actions)

Workflow: `.github/workflows/deploy-executor-base-sepolia.yml`. It runs when the **`deploy-base-sepolia`** label is added to a PR from this repo, or through `workflow_dispatch`. It uses the protected environment `base-sepolia`.

**Required configuration.** Values are never printed and are never committed.

| kind | name | notes |
|---|---|---|
| secret | `BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY` | Throwaway deployer funded with **≥ 0.01 Base Sepolia ETH** (≈ 22.4 M gas incl. test pools + 6 swaps). The deployer is **not** the owner. |
| variable | `MPGR_EXECUTOR_OWNER` | Your wallet. Receives ownership. The deploy refuses to run without it. |
| variable (opt.) | `MPGR_EXECUTOR_FEE_RECIPIENT` | Defaults to the owner. |
| secret (opt.) | `BASE_SEPOLIA_RPC_URL` | Defaults to `https://sepolia.base.org`. |
| secret (opt.) | `ETHERSCAN_API_KEY` | Enables Basescan verification (Sourcify and Blockscout need no key). |

**What the workflow does:**
1. Preflight: chainId must be 84532.
2. Test gate: `forge test` on the executor.
3. Deploy, simulated in full first and then broadcast:
   - MPGRExecutor with Uniswap V3 SwapRouter02 allowlisted;
   - test tokens tUSD (6d, EIP-2612) and tSTOCK (18d);
   - Uniswap V3 pools tUSD/tSTOCK and WETH/tUSD at fee 3000.
4. **Six real swaps**: APPROVAL buy, APPROVAL sell-back, EIP-2612, Permit2, native-ETH in, native-ETH out.
5. The executor is constructed with `initialOwner = MPGR_EXECUTOR_OWNER`, so the owner holds admin rights immediately. There is no pending transfer to accept, and the post-deploy checks assert `pendingOwner() == 0`.
6. Source verification on Sourcify, Blockscout and Basescan.
7. Post-deploy `cast` checks.
8. The artifact `deployments/base-sepolia/mpgr-executor.json` is uploaded (address, tx, block, owner, fee recipient, routers, ABI, swap tx hashes, verification status). A PR comment is posted.

**After the run:**
- Commit `deployments/base-sepolia/mpgr-executor.json`.
- Fill the `84532` entry in `lib/executor/executor-config.ts` (`MPGR_EXECUTOR_DEPLOYMENTS`). The MCP tools and `/llm.txt` then go live on Sepolia automatically.

### Live deployment (Base Sepolia, chainId 84532)

Deployed by workflow run `36067982010` from commit `07dbc35` (merge commit `d426b08`). Recorded in `deployments/base-sepolia/mpgr-executor.json` and mirrored by `BASE_SEPOLIA_EXECUTOR_DEPLOYMENT` in `lib/executor/executor-config.ts`.

| field | value |
|---|---|
| Executor | [`0xDFcB00fB1Fe83A6333302E55E23feCF6884376C4`](https://sepolia.basescan.org/address/0xDFcB00fB1Fe83A6333302E55E23feCF6884376C4) |
| Deploy tx / block | `0xcfba1186…4378831d` / 47262106 |
| Owner | `0xE0e0d239853c5F2Fe0a524d544eC9eB71fef486e` |
| Fee recipient | `0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4` |
| Fee | 25 bps (cap 100) |
| Router | Uniswap V3 SwapRouter02 `0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4`. QuoterV2 `0xC5290058841028F1614F3A6F0F5816cAd0df5E27`. Pools at fee 3000. |
| Tokens | WETH `0x4200…0006`, tUSD `0xc5C9F70A7F3EB18FC33406275Bffe31a922fcde5` (6d, EIP-2612), tSTOCK `0x9102c5B535d25A9265e2793174701BdaCeEAAfC4` (18d) |
| Verification | Sourcify exact_match, Blockscout verified, Basescan submitted |

**Continuous verification.** On every push, the `contracts-fork` CI job runs `test/fork/MPGRExecutorBaseSepoliaDeployment.t.sol` against live Base Sepolia. It checks that:
- the address's runtime bytecode is byte-identical to a fresh build of this repo's `MPGRExecutor` with the same immutables;
- the owner, `pendingOwner == 0`, fee recipient, fee, cap, pause state, WETH/Permit2, router kind and token allowlist match the record;
- the executor holds no funds;
- the pools and quoter are live;
- a real exact-fee swap through the deployed executor succeeds on a local fork (nothing is broadcast).

**Execution path.** Only the MCP / agent executor path uses this deployment. `mpgr_get_quote` and `mpgr_prepare_trade` with `chainId` 84532 (the default) return transactions to this executor. The in-app swap UI is Base-mainnet-only and unchanged.

## Tests

| suite | what |
|---|---|
| `test/executor/*.t.sol` | Unit, fuzz and invariant tests covering: 25 bps and floor; tiny/zero amounts; allowance/balance; fee recipient ≠ taker; router/token/recipient validation; minOut; router failure and atomic revert; reentrancy (malicious token/router); fee bypass and double fee; output redirection; ERC-20/WETH/native in and out; all three auth modes against real Permit2 and Uniswap V3 bytecode; admin and caps. |
| `test/fork/MPGRExecutorBaseFork.t.sol` | Live Base mainnet fork (CI job `contracts-fork`): Slipstream exact sell-token fee (buy, sell-back, Permit2, EIP-2612 USDC), slippage atomic revert, Uniswap V3 native in and out. |
| `test/script/DeployMPGRExecutorBaseSepoliaLocal.t.sol` | Deploy-script rehearsal. |
| `test/script/DeployMPGRExecutorBaseMainnet.t.sol` | Offline run of the real mainnet deploy script (stand-in bytecode at production addresses): exact config, JSON record, refuses when not enabled, on Base Sepolia, a second deploy from the same key, or a wrong router binding. |
| `test/fork/MPGRExecutorBaseMainnetDeploy.t.sol` | Base mainnet fork: full dry run of the real mainnet deploy script against the committed pins, then a real USDC swap on the production Slipstream router through that instance (exact 25 bps to the pinned fee recipient). Every preflight guard is proven to trip. |
| `lib/executor/__tests__`, `lib/mcp/__tests__`, `lib/trade/__tests__/zero-ex-native-fee.test.ts`, `app/api/mcp/route.test.ts`, `app/llm.txt/route.test.ts` | Fee/intent/encoding; verification from synthetic receipts; quoteId tamper and expiry; 0x validator (mocked fetch); MCP protocol, origin and rate limit; the full AI flow with a wallet signing EIP-2612 and Permit2 typed data; llm.txt contains no secrets. |

## Known limitations

- **UI wiring.** The in-app swap UI still uses its existing flows. The executor path is exposed via MCP only; wiring the UI is a follow-up so current flows stay untouched.
- **Slipstream.** No Base Sepolia deployment exists, so Slipstream is proven on a mainnet fork only (USDC/WETH pools).
- **B20 tokenized stocks cannot be simulated locally.** Coinbase B20 tokens are Base-native precompiles that run in the node, not EVM contracts. Foundry's local EVM (fork tests and `forge script` simulation) cannot execute them; calls burn all forwarded gas. So:
  - the USDC↔B20 fork case skips;
  - the mainnet deploy script never calls B20 tokens (it checks code plus the `0xb2` prefix);
  - the workflow verifies them with real-node `eth_call`.
  - A USDC↔B20 swap through the executor has therefore never been executed. Validate it with one small real mainnet trade before routing B20 through the executor.
- **Single-hop only** (`exactInputSingle`). Multi-hop needs a typed path adapter and is deferred.
- **Permit2 without a witness.** The signature binds token, amount, nonce, deadline and spender, but not minOut. This is acceptable because only the signer can submit it (owner = msg.sender) and minOut is in the tx they sign.
- **Rate limiter.** The in-memory fallback is per instance when Redis is not configured.
- **Audit.** The executor has **not** been externally audited.

## Base Mainnet deployment (deploy only; app routing stays OFF)

The owner explicitly authorised a one-time Base Mainnet deployment of the executor. The deployment itself does **not** switch any trading onto it: `lib/executor/executor-config.ts` keeps chain `8453` = `null` and `MPGR_MCP_ENABLE_BASE_MAINNET` stays unset. Switching mainnet execution on is a separate, later step.

- **Script:** `script/DeployMPGRExecutorBaseMainnet.s.sol`. It deploys the executor and nothing else (no tokens, pools or swaps).
- **Workflow:** `.github/workflows/deploy-executor-base-mainnet.yml`. Label `deploy-base-mainnet` on a same-repo PR; no manual or push trigger.
  - Job `gates` (no secrets): ABI sync, unit/fuzz/invariant/script tests, the Base mainnet fork suite (the deploy dry run must pass, not skip), Slither (fail on high), Gitleaks.
  - Job `deploy`: environment `base-mainnet` with required reviewers. Steps: config preflight, RPC chain id, full simulation against live mainnet, broadcast, Sourcify/Blockscout/Basescan verification, independent `cast` checks, PR comment with the full record.
- **Pins:** `deployments/base-mainnet/deploy-config.json` (reviewed in the PR). Owner `0xE0e0d239853c5F2Fe0a524d544eC9eB71fef486e`, fee recipient `0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4`, 25 bps, cap 100 bps.
- **Allowlist.** Copied verbatim from the production trade config:
  - Router: Aerodrome Slipstream SwapRouter `0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F`. Preflight proves it is bound to factory `0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef` and WETH. The quoter `0x514c8B5f54112481E28028F1166Bd78501089259` is bound to the same factory.
  - Tokens: USDC, WETH and the 13 B20 stocks from `lib/trade/tokenized-stocks.ts`.
  - Uniswap V3 is **not** in the production trade config, so it is **not** allowlisted. The owner can add it later with `setRouter`.
- **Preflight** (any failure aborts before broadcast):
  - chain id 8453;
  - explicit enablement for this deployment only: `MPGR_MAINNET_DEPLOY_ENABLED=true` in the environment, `mainnetDeployEnabled: true` in the pins file, no existing `deployments/base-mainnet/mpgr-executor.json`, and the deployer nonce == 0;
  - environment owner and fee recipient equal the committed pins;
  - fee 25 bps, cap 100 bps;
  - dedicated deployer: not the owner, the fee recipient, or the Base Sepolia deployer;
  - no Base Sepolia or test-token address anywhere (the denylist is cross-checked against `deployments/base-sepolia/mpgr-executor.json`);
  - every address has code on 8453; USDC and WETH answer ERC-20 calls; each B20 carries the `0xb2` prefix; USDC has 6 decimals;
  - every production token answers `decimals`/`totalSupply`/`balanceOf`/`symbol` via real-node `eth_call` (both jobs).
- **Why nonce == 0:** it makes the executor address `CREATE(deployer, 0)` deterministic, and a re-run can never deploy a second executor.
- **Owner decisions:**
  - Owner is the same EOA as on Sepolia; a multisig was recommended.
  - No external audit yet. The owner accepted this for deploy-only, with routing staying off.
- **After deployment:**
  1. Commit the record.
  2. Set `mainnetDeployEnabled` to `false`.
  3. Delete `MPGR_MAINNET_DEPLOY_ENABLED` from the environment.
  4. Verify the deployment independently before any routing change.

### Live deployment (Base Mainnet, chainId 8453). App routing is OFF

Deployed by workflow run [36110098967](https://github.com/munazir17/MPGR-HUB/actions/runs/36110098967) from PR head `51ec6b9`, after owner approval in the `base-mainnet` environment. Record: `deployments/base-mainnet/mpgr-executor.json`. It is re-verified against the live chain by `test/fork/MPGRExecutorBaseMainnetDeployment.t.sol`, which checks bytecode == repo source, config, fee cap and a fork-only swap.

| field | value |
|---|---|
| Executor | [`0xD982726e28275661F8aB64054E6b17a70a63505A`](https://basescan.org/address/0xD982726e28275661F8aB64054E6b17a70a63505A) |
| Deploy tx | [`0xf17fcaef66a8a67153114a8a14b7813ffaa7ec2877eb5e9e35171467aa999d01`](https://basescan.org/tx/0xf17fcaef66a8a67153114a8a14b7813ffaa7ec2877eb5e9e35171467aa999d01) |
| Block | 51767139 |
| Gas | 2,805,700 at 0.00525 gwei, plus an L1 data fee of 0.000000149 ETH (about 0.0000149 ETH total) |
| Deployer (dedicated, nonce 0 → executor = CREATE(deployer, 0)) | `0xB54900f2c355CB0A61c62f8220191D3aAA6f4455` |
| Owner | `0xE0e0d239853c5F2Fe0a524d544eC9eB71fef486e` (pendingOwner = 0) |
| Fee recipient | `0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4` |
| Fee | 25 bps, hard cap `MAX_FEE_BPS` = 100 bps; not paused |
| Router allowlist | Aerodrome Slipstream SwapRouter `0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F` (kind 1). Factory `0xf8f2…61Ef`, QuoterV2 `0x514c…9259`. Uniswap V3 is **not** allowlisted. |
| Token allowlist (15) | USDC `0x8335…2913`, WETH `0x4200…0006`, and the B20 stocks AAPLc, AMZNc, COINc, CRCLc, GOOGLc, INTCc, METAc, MSFTc, MSTRc, NVDAc, SNDKc, SPCXc, TSLAc (addresses in the record) |
| WETH / Permit2 | `0x4200000000000000000000000000000000000006` / `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| Source verification | Sourcify `exact_match`, Blockscout verified, Basescan step success |

The one-time enablement is switched off: `mainnetDeployEnabled: false` in the pins file, and the record exists. The script and workflow refuse any further mainnet deployment.

### Before switching Mainnet execution on (NOT done)

1. External security audit of `MPGRExecutor.sol` (recommended).
2. Consider moving ownership to a multisig (`transferOwnership` + `acceptOwnership`, 2-step).
3. Fill the `8453` registry entry with the deployed address. Only then set `MPGR_MCP_ENABLE_BASE_MAINNET=true`. The 0x path also needs `ZERO_EX_API_KEY` and `MPGR_AGENT_FEE_RECIPIENT`.
4. Monitoring on `SwapExecuted`, admin events and `Paused`, plus an incident runbook (pause first).

## Rollback

- **Contract:** `pause()` stops all swaps immediately. Users can revoke approvals at any time.
- **Server:** remove the registry entry, or unset the env flags, and redeploy. Deleting `app/api/mcp` removes the endpoint.
- **Existing flows:** nothing in the existing UI or API depends on these changes, so reverting the PR is safe.
