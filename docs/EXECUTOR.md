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
5. Ownership is transferred to `MPGR_EXECUTOR_OWNER`, who then calls `acceptOwnership()`.
6. Source verification on Sourcify, Blockscout and Basescan.
7. Post-deploy `cast` checks.
8. The artifact `deployments/base-sepolia/mpgr-executor.json` is uploaded (address, tx, block, owner, fee recipient, routers, ABI, swap tx hashes, verification status). A PR comment is posted.

**After the run:**
- Commit `deployments/base-sepolia/*`.
- Fill the `84532` entry in `lib/executor/executor-config.ts` (`MPGR_EXECUTOR_DEPLOYMENTS`). The MCP tools and `/llm.txt` then go live on Sepolia automatically.
- The owner wallet must call `acceptOwnership()` (Ownable2Step).

## Tests

| suite | what |
|---|---|
| `test/executor/*.t.sol` | Unit, fuzz and invariant tests covering: 25 bps and floor; tiny/zero amounts; allowance/balance; fee recipient ≠ taker; router/token/recipient validation; minOut; router failure and atomic revert; reentrancy (malicious token/router); fee bypass and double fee; output redirection; ERC-20/WETH/native in and out; all three auth modes against real Permit2 and Uniswap V3 bytecode; admin and caps. |
| `test/fork/MPGRExecutorBaseFork.t.sol` | Live Base mainnet fork (CI job `contracts-fork`): Slipstream exact sell-token fee (buy, sell-back, Permit2, EIP-2612 USDC), slippage atomic revert, Uniswap V3 native in and out. |
| `test/script/DeployMPGRExecutorBaseSepoliaLocal.t.sol` | Deploy-script rehearsal. |
| `lib/executor/__tests__`, `lib/mcp/__tests__`, `lib/trade/__tests__/zero-ex-native-fee.test.ts`, `app/api/mcp/route.test.ts`, `app/llm.txt/route.test.ts` | Fee/intent/encoding; verification from synthetic receipts; quoteId tamper and expiry; 0x validator (mocked fetch); MCP protocol, origin and rate limit; the full AI flow with a wallet signing EIP-2612 and Permit2 typed data; llm.txt contains no secrets. |

## Known limitations

- **UI wiring.** The in-app swap UI still uses its existing flows. The executor path is exposed via MCP only; wiring the UI is a follow-up so current flows stay untouched.
- **Slipstream.** No Base Sepolia deployment exists, so Slipstream is proven on a mainnet fork only. No B20 tokenized stock currently has a USDC pool on the app's Slipstream factory, so that fork case skips. B20 routing through the executor would need a multi-hop adapter, which is not included.
- **Single-hop only** (`exactInputSingle`). Multi-hop needs a typed path adapter and is deferred.
- **Permit2 without a witness.** The signature binds token, amount, nonce, deadline and spender, but not minOut. This is acceptable because only the signer can submit it (owner = msg.sender) and minOut is in the tx they sign.
- **Rate limiter.** The in-memory fallback is per instance when Redis is not configured.
- **Audit.** The executor has **not** been externally audited.

## Mainnet checklist (NOT done: mainnet deployment is not authorised yet)

1. External security audit of `MPGRExecutor.sol`; fix and re-test.
2. Base Sepolia deployment exercised by real users through the MCP flow (all three auth modes, native in and out).
3. Owner = **multisig** (e.g. Safe). Fee recipient confirmed. `acceptOwnership()` executed.
4. Mainnet allowlist reviewed:
   - Slipstream router `0x698C…` / factory `0xf8f2…`;
   - Uniswap SwapRouter02 `0x2626…e481`;
   - tokens USDC, WETH and the specific B20 tickers with verified pools.
5. A mainnet deploy script and workflow gated on a separate protected environment with required reviewers (the current script refuses any chain other than 84532).
6. Fork tests are green against the exact deployment config. Gas limits reviewed.
7. Fill the `8453` registry entry. Only then set `MPGR_MCP_ENABLE_BASE_MAINNET=true` (the 0x path also needs `ZERO_EX_API_KEY` and `MPGR_AGENT_FEE_RECIPIENT`).
8. Monitoring on `SwapExecuted`, admin events and `Paused`, plus an incident runbook (pause first).

## Rollback

- **Contract:** `pause()` stops all swaps immediately. Users can revoke approvals at any time.
- **Server:** remove the registry entry, or unset the env flags, and redeploy. Deleting `app/api/mcp` removes the endpoint.
- **Existing flows:** nothing in the existing UI or API depends on these changes, so reverting the PR is safe.
