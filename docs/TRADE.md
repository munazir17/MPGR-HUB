# P4 — Advanced Execution / Trading

MPGR does not invent swap routers, stock mint APIs, or custodial brokerage endpoints.

## Official providers used

### 1. Coinbase CDP Trade API (onchain swaps on Base)

- Docs: https://docs.cdp.coinbase.com/trade-api/quickstart
- Quote: `POST https://api.cdp.coinbase.com/platform/v2/evm/swaps`
- Price: `GET https://api.cdp.coinbase.com/platform/v2/evm/swaps`
- Auth: CDP Secret API Key JWT (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`)
- Network enum: `base` only
- Execution: BYO wallet (user signs via wagmi). Permit2 + optional ERC-20 approve.
- This is **not** Coinbase Advanced Trade / Coinbase for Agents MCP (those trade a Coinbase custodial account).

BYO flow (documented):

1. Optional ERC-20 `approve(Permit2)` when CDP reports an allowance issue
2. Sign the quote's Permit2 EIP-712 (`EIP712Domain` stripped for viem)
3. Concat `[tx.data, signatureLength32, signature]`
4. `sendTransaction` with the quote's `to` / `data` / `value`

Quotes older than 30s are re-fetched. A worse `minToAmount` aborts as `QUOTE_CHANGED`.

### 2. Coinbase Tokenized Stocks on Base (B20)

- Product: https://www.coinbase.com/tokenize
- Spec: https://docs.base.org/specifications/b20/tokenized-stocks-on-base
- 13 official B20 tokens + Chainlink equity feeds + oracle registry `0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD`
- Holding / secondary-market trading is permissionless
- Primary mint/redeem is Authorized Participant only — **no retail mint API is implemented**
- Buy/sell in this app = CDP Trade API swap **only if** CDP reports `liquidityAvailable`

Chainlink Coinbase equity feeds already publish **total return** (underlying price × on-chain multiplier, 8 decimals). This app does **not** multiply the feed by the WAD multiplier a second time. The token's `multiplier()` is still shown as a research field.

## Agent tools (read / prepare only)

| Tool | Mode | Signs? |
|---|---|---|
| `trade_get_price` | read | no |
| `trade_prepare_swap` | prepare | no |
| `tokenized_stock_research` | read | no |

Signing happens only after **Confirm & Swap** in the agent modal. Network in that modal always shows **Base**.

## Env
