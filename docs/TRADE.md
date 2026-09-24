# P4 — Advanced Execution / Trading

MPGR does not invent swap routers, stock mint APIs, or custodial brokerage endpoints.

## Official providers used

### 1. Coinbase CDP Trade API (onchain swaps on Base) — regular tokens

- Docs: https://docs.cdp.coinbase.com/trade-api/quickstart
- Quote: `POST https://api.cdp.coinbase.com/platform/v2/evm/swaps`
- Price: `GET https://api.cdp.coinbase.com/platform/v2/evm/swaps/quote`
- Auth: CDP Secret API Key JWT (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`)
- Network enum: `base` only
- Execution: BYO wallet (user signs via wagmi). Permit2 + optional ERC-20 approve.
- This is **not** Coinbase Advanced Trade / Coinbase for Agents MCP (those trade a Coinbase custodial account).
- Used for ETH / WETH / USDC / MPGR / arbitrary Base ERC-20. **Not** used for Coinbase B20 tokenized stocks.

BYO flow (documented):

1. Optional ERC-20 `approve(Permit2)` when CDP reports an allowance issue
2. Sign the quote's Permit2 EIP-712 (`EIP712Domain` stripped for viem)
3. Concat `[tx.data, signatureLength32, signature]`
4. `sendTransaction` with the quote's `to` / `data` / `value`

Quotes older than 30s are re-fetched. A worse `minToAmount` aborts as `QUOTE_CHANGED`.

If CDP rejects the token or reports no liquidity, the 0x Swap API v2 AllowanceHolder path on Base is tried next. Same unsigned-proposal + wallet-confirm contract.

### 2. Coinbase Tokenized Stocks on Base (B20) — Aerodrome Slipstream

- Product: https://www.coinbase.com/tokenize
- Spec: https://docs.base.org/specifications/b20/tokenized-stocks-on-base
- 13 official B20 tokens + Chainlink equity feeds + oracle registry `0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD`
- Holding / secondary-market trading is permissionless
- Primary mint/redeem is Authorized Participant only — **no retail mint API is implemented**
- Coinbase CDP Trade API and 0x Swap API reject B20 with `BUY/SELL_TOKEN_NOT_AUTHORIZED_FOR_TRADE`. They are **not** used as a fallback on this path.

Buy/sell in this app = a single-hop Aerodrome Slipstream (Gauges V3) USDC pool swap:

| Contract | Address |
|---|---|
| CL Factory | `0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef` |
| SwapRouter | `0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F` |
| QuoterV2 | `0x514c8B5f54112481E28028F1166Bd78501089259` |

- tickSpacing **10** (0.05% fee). Not the legacy Aerodrome factory `0x5e7BB1…` — that public quoter reverts on these pools.
- Quote: `QuoterV2.quoteExactInputSingle({tokenIn, tokenOut, amountIn, tickSpacing, sqrtPriceLimitX96:0})`
- Execution: unsigned `SwapRouter.exactInputSingle` (struct with `tickSpacing`, not `fee`). ERC-20 `approve` the SwapRouter, then the user signs the swap. No Permit2.
- ETH/WETH ↔ B20 is rejected: convert to USDC first. v1 does not invent a multi-hop.
- Tickers without a live USDC pool (e.g. some newer listings) stay research-only.

Chainlink Coinbase equity feeds already publish **total return** (underlying price × on-chain multiplier, 8 decimals). This app does **not** multiply the feed by the WAD multiplier a second time. The token's `multiplier()` is still shown as a research field.

## Agent tools (read / prepare only)

| Tool | Mode | Signs? |
|---|---|---|
| `trade_get_price` | read | no |
| `trade_prepare_swap` | prepare | no |
| `tokenized_stock_research` | read | no |
| `tokenized_stock_prepare_order` | prepare | no |

Signing happens only after **Confirm & Swap** in the agent modal. Network in that modal always shows **Base**.

## MPGR Agent fee (0.25% / 25 bps)

Every supported swap carries a 0.25% MPGR Agent fee on the SELL leg:

- Amount: `floor(fromAmount * 25 / 10_000)` in sell-token atomic units
  (exact integer math in `lib/trade/trade-agent-fee.ts` — no float step,
  so all token decimals are exact by construction; decimals are used for
  display only).
- Recipient: `MPGR_AGENT_FEE_RECIPIENT` (preferred, server-only) with
  `NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT` as fallback — validated as a
  non-zero Base address; never a private key — signing stays with the
  user's connected wallet. The public var is inlined at BUILD time: after
  adding/rotating it you MUST redeploy or the running build quotes no fee
  (incident 2026-09-24). The server is the source of truth — execution
  re-validates the quoted fee structurally and never depends on the
  client's build-time env.
- Collection: **provider-aware, atomic with the swap either way**. The fee
  is never a third transaction and never a second prompt:
  - **0x Swap API v2 (fallback path) — provider-native.** The router sends
    `swapFeeRecipient`, `swapFeeBps = 25`, `swapFeeToken = sellToken` on
    the `/swap/allowance-holder/*` request, so 0x embeds the fee in the
    swap transaction it generates. 0x's own documented formula is
    `swapFeeBps / 10000 * sellAmount` **in the sell token**, i.e. exactly
    `floor(fromAmount * 25 / 10_000)`. The returned
    `fees.integratorFee.amount/.token` is parsed and becomes the
    authoritative displayed amount, and `agentFee.collection` is
    `"provider-native"` — execution then sends **only** the swap.
  - **CDP Trade API and Aerodrome Slipstream — app-side atomic batch.**
    The fee is the second call of an EIP-5792 atomic batch —
    `[swapCall, feeCall]` — so the wallet signs ONE swap transaction. The
    provider's swap quote, calldata, approvals, slippage, routing,
    min-out, price impact, and gas estimate are never modified by the fee
    (`lib/trade/trade-calls-batch.ts`).
- Why this split (and not a single mechanism): CDP Trade API has **no**
  integrator-fee parameter at all, and the Aerodrome Slipstream
  `exactInputSingle` this app builds has no fee hook that preserves a
  sell-token fee (its `sweepTokenWithFee` charges the fee on the router's
  post-swap balance of the **output** token — a buy-side fee, which is a
  different economic model and was deliberately not implemented). The
  0x native fee is requested only where it is **faithful**: the sell token
  must be a real ERC-20, because `swapFeeToken` must be `buyToken` or
  `sellToken`. A **native-ETH sell is excluded** — the only legal fee token
  would be the buy token, i.e. a buy-side fee. WETH is a normal ERC-20 and
  is eligible. No provider route is ever mutated; the router only adds
  fee params to its own 0x request.
- Eligibility gates (all fail-closed → the app-side path, never a broken
  fee): a valid non-zero recipient, `swapFeeBps` inside 0x's documented
  1–1000 range, and an ERC-20 (non-sentinel) sell token. When any gate
  fails, **no** `swapFee*` param is sent, 0x returns a plain quote, and
  the existing app-side collection applies — exactly as before.
- Trust boundary: `agentFee.collection === "provider-native"` is set only
  when 0x actually reported an integrator fee **in the sell token** with a
  positive amount smaller than `fromAmount`. A fee in another token, a
  zero/oversized/unparseable amount, or no fee at all falls back to
  `"post-swap"` with the app-derived amount, so a provider that silently
  drops the fee params cannot cost revenue or mis-report to the user.
- Safety: fail-open for the swap, fail-closed for the fee. Unconfigured/
  invalid recipient, dust (fee rounds to 0), taker-equals-recipient, a
  wallet without `wallet_getCapabilities` atomic support on Base, or a
  wallet that does not hold sell + fee all mean the swap is broadcast
  exactly as before with **no** fee and **no** extra transaction; the
  reason is surfaced on the execution snapshot (`feeSkippedReason`).
  There is never a fallback to a separate fee transfer. A
  provider-native fee is *not* reported as skipped — it was collected,
  just by 0x inside the swap.
- Never both: on the 0x native path `resolveExecutionAgentFee` returns
  `send: false`, so the atomic batch is never built and the fee cannot be
  charged twice. `trade-execution.ts` gates `feeSkippedReason` on
  `!providerNativeFee` for the same reason.
- Requires live verification (not verifiable offline): whether 0x's
  `buyAmount`/`minBuyAmount` are already net of the integrator fee, and
  whether the taker must hold `sellAmount` or `sellAmount + fee`. The
  implementation treats the provider's returned amounts as authoritative
  and never adjusts them.
- Atomicity trade-off (deliberate): inside an atomic batch the fee leg and
  the swap succeed or revert together, so a fee-leg revert reverts the
  swap. The eligibility gates above (atomic capability + sell + fee
  balance, both fail-closed) exist precisely so that can only happen for a
  genuinely broken fee leg, never for an underfunded or unsupported one.
- Disclosure: quoted fee, recipient, and post-confirmation steps are on
  the `TradeProposal` (`agentFee`), shown in the confirmation modal, and
  re-validated before execution — only the exact displayed fee is batched.
  A missing recipient also warns once in the server log so an uncollected
  fee is diagnosable instead of silent.

## Env
