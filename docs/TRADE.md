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
- Recipient: `NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT` (validated as a
  non-zero Base address; never a private key — signing stays with the
  user's connected wallet).
- Collection: a SEPARATE wallet-signed transfer AFTER the swap settles
  (ERC-20 `transfer` on the sell token, or a native value transfer when
  selling ETH). The swap quote, calldata, approvals, slippage, routing,
  min-out, price impact, and gas estimate are never modified by the fee.
- Disclosure: quoted fee, recipient, and post-confirmation steps are on
  the `TradeProposal` (`agentFee`), shown in the confirmation modal, and
  re-validated before execution — only the exact displayed fee is sent.
- Safety: fail-open for the swap, fail-closed for the fee. Unconfigured/
  invalid recipient, dust (fee rounds to 0), taker-equals-recipient, or a
  failed/cancelled fee transfer never blocks or fails the swap; the fee
  outcome is recorded on the execution snapshot (`feeHash` / `feeError`).

## Env
