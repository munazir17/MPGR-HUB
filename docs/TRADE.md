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

### 2. Coinbase Tokenized Stocks on Base (B20) — MPGR Executor on Aerodrome Slipstream

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
- Quote: `QuoterV2.quoteExactInputSingle({tokenIn, tokenOut, amountIn, tickSpacing, sqrtPriceLimitX96:0})` (research price + the executor route's pool quote, always for the **post-fee** amount).
- Execution: through the **MPGR Executor** — the user signs the executor's `swapSlipstreamExactInputSingle` (same router/pool key/tickSpacing, allowlisted kind 1 since the constructor). First-time ERC-20 = ERC-20 `approve(executor, gross)` + that swap; afterwards = swap only. The 0.25% fee is taken inside that same swap (see the fee section below). No Permit2 is used on this path.
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

Every swap routed through the **MPGR Executor** carries a 0.25% MPGR Agent
fee on the SELL leg. The fee is **taken by the Executor inside the swap
transaction** — there is no fee transaction, no fee signature, and no
post-swap step:

```
user wallet ──grossAmountIn──▶ MPGRExecutor          (one signed tx;
              + approve(executor, gross) when the    approve is a second
                standing allowance is short)         tx only when needed
     executor ──fee = floor(gross * feeBps / 10_000)──▶ feeRecipient()
     executor ──(gross - fee)──▶ allowlisted router ──▶ output to the taker
```

- Amount: `floor(fromAmount * 25 / 10_000)` in sell-token atomic units on
  the **gross** sell amount (exact integer math in
  `lib/trade/trade-agent-fee.ts`; the split itself uses the executor's
  own `computeExecutorFee`, identical to `MPGRExecutor._begin`). The pool
  is quoted for `gross - fee` and the calldata commits to
  `expectedFeeAmount`, so the contract reverts (`FeeMismatch`) if the
  on-chain fee ever moved between quote and execution.
- Recipient: the **executor's configured `feeRecipient()`**, read live at
  quote time and mirrored in `lib/executor/executor-config.ts`. It is
  never the connected (taker) wallet — the contract reverts
  `TakerIsFeeRecipient` — and never a browser-supplied address. The
  `MPGR_AGENT_FEE_RECIPIENT` / `NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT`
  variables are **not** used by the browser flow (they belong to the MCP
  0x-native-fee fallback, whose fee also settles inside the 0x quote).
- Wallet flow: first-time ERC-20 = **approve + swap** (the approval is for
  the gross amount, to the executor); with a sufficient allowance =
  **swap only**. Nothing is ever sent after the swap.
- **B20 tokenized stocks now use this architecture too**: each
  USDC <-> B20 pair is registered as an executor route (Aerodrome
  Slipstream, tickSpacing 10 — the venue the app already traded), so its
  fee is taken inside the swap exactly like USDC <-> WETH. Approve + swap
  is still the maximum first-time flow; there is no fee transaction on
  either path.
- Routes with **no registered executor route** (an arbitrary ERC-20,
  WETH <-> B20, B20 <-> B20) are quoted with **no MPGR fee**
  (`agentFee.status = "skipped"`): the UI shows no fee row and no MPGR fee
  is collected by this app. Their own provider's charge (e.g. the 0x
  native-integrator fee) is that provider's business. An MPGR fee can only
  exist where the executor can take it in-transaction — never as a
  separate transfer, and never silently dropped for a pair that is
  supposed to carry it.
- Disclosure & enforcement: the quoted fee, its recipient and the
  post-confirmation steps are on the `TradeProposal` (`agentFee`) and shown
  in the confirmation modal ("MPGR fee (0.25%) — 0.005 USDC"). Before any
  wallet prompt, execution re-verifies that an **applied** fee belongs to
  a transaction targeting the MPGR Executor, that the encoded
  `grossAmountIn` equals the reviewed amount, that
  `expectedFeeAmount == floor(gross * 25 / 10_000)`, that the recipient is
  the taker and that the value matches a native sell. Any mismatch aborts
  with nothing signed.
- Safety: fail-closed for the quote (a fee that rounds to zero, a paused
  executor, or `feeRecipient == taker` refuses the quote instead of
  signing a transaction that would revert), and no fall-back fee path
  exists by design.

## Env
