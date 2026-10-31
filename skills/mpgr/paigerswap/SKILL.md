---
name: paigerswap
description: Quote and prepare a Base buy or sell with the existing PaigerSwap MCP tools. Use for swap, buy, and sell requests. The quote and the prepared transaction are not broadcasts. The user wallet signs.
metadata:
  version: "2.0"
  author: munazir17
license: All Rights Reserved
---

# PaigerSwap

## Overview

PaigerSwap pricing and execution already live in the app. This skill calls the same MCP trade service (`mpgr_get_quote`, `mpgr_prepare_trade`). It does not calculate a second route and it does not change the 0.25% Trading Fee (25 bps).

On Base mainnet, with MCP mainnet trading enabled:

- USDC paired with WETH or an allowlisted B20 stock stays on the legacy MPGR Executor.
- MPGR and every other pair are quoted through the sealed PaigerSwap V2 executor (`0x4be1154440b26145d76608D41d403a33e76b9d0A`) using that executor's discovery, calldata, single 25 bps gross fee, and simulation.
- V2 prepare uses `authorization: "APPROVAL"` only. Do not call `mpgr_finalize_trade` for a V2 quote.
- If V2 returns an error, say so. Do not invent a route. A no-liquidity result may come back as the existing 0x provider; a simulation or RPC failure must not.

## When to use

| User says | Do |
| --- | --- |
| "Buy AAPLc with 10 USDC" | Quote, then prepare. Stop for the wallet |
| "Sell MPGR for ETH" | Quote, then prepare. Stop for the wallet |
| "What will I get?" | Quote only |
| "Did my tx land?" | `mpgr_get_trade_status`, then `mpgr_verify_trade` |

## Call

`POST https://mpgrhub.xyz/api/mcp`

Quote (does not broadcast):

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mpgr_get_quote","arguments":{"chainId":8453,"taker":"<user wallet>","sellToken":"USDC","buyToken":"AAPLc","sellAmountHuman":"10","slippageBps":100}}}
```

Prepare (does not broadcast):

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mpgr_prepare_trade","arguments":{"quoteId":"<from quote>","authorization":"APPROVAL"}}}
```

`authorization` is `APPROVAL`, `EIP2612`, or `PERMIT2`. For permit modes, the wallet signs the typed data, then `mpgr_finalize_trade` returns the unsigned swap. The wallet sends that transaction.

## Rules

- `taker` must be the connected wallet. Do not substitute another address.
- Show sell amount, exact fee (`floor(sellAmount * 25 / 10000)` of the sell token), minimum received, and executor before the user signs.
- If the tool returns `isError`, say so. Do not invent calldata or a price.
- A thin pool (high price impact) is a warning, not a failed app. Leave that warning visible.
- Unsupported pairs stay unsupported. Do not mark them executable.
- The in-app Swap page is the user path. A successful tool result is not an on-chain receipt.
