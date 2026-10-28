---
name: mpgr-mcp
description: Connect to the existing MPGR MCP server and discover unsigned trading tools. Use when an agent needs capabilities, tool schemas, or the Base trade flow. Does not sign or broadcast.
metadata:
  version: "2.0"
  author: munazir17
license: All Rights Reserved
---

# MPGR MCP

## Overview

The remote MCP server is already implemented. This skill only documents it. Do not start a second server and do not invent tools.

## Endpoint

`POST /api/mcp` on the deployed app.

Verified hosts:

- `https://mpgrhub.xyz/api/mcp`
- `https://mpgr-hub-ezxs.vercel.app/api/mcp`

Transport: JSON-RPC 2.0, stateless JSON responses (no SSE session). Optional header `MCP-Protocol-Version: 2025-06-18`. Body limit 64KB. About 60 requests per minute per IP.

A missing `Origin` is allowed for server-side clients. A browser `Origin` must be the app origin.

## Tools

Call `tools/list`, then only these names:

| Tool | Effect |
| --- | --- |
| `mpgr_get_capabilities` | Chains, executor, 25 bps fee, auth modes |
| `mpgr_list_tokens` | Allowlisted tokens on `chainId` 8453 or 84532 |
| `mpgr_get_quote` | Quote only. Returns `quoteId` (about 120s). Legacy allowlisted pairs use the MPGR Executor. Other Base pairs use PaigerSwap V2 when that gate is on. No transaction is sent |
| `mpgr_prepare_trade` | Unsigned steps for the user's wallet. V2 quotes require `APPROVAL` and return the V2 executor transaction |
| `mpgr_finalize_trade` | Permit modes on the legacy executor only. Not used for PaigerSwap V2 |
| `mpgr_get_trade_status` | Receipt state for a hash the user already sent |
| `mpgr_verify_trade` | Checks the receipt against the quote, including the exact fee |

Every tool is read-only with respect to funds (`readOnlyHint: true`, `destructiveHint: false`). None accepts a private key.

## Flow

1. `initialize` with `protocolVersion` `2025-06-18`.
2. `tools/list`.
3. `tools/call` `mpgr_get_capabilities`.
4. Hand any swap to the `paigerswap` skill.

## Rules

- Never ask for a seed phrase, private key, or `NVIDIA_API_KEY`.
- Never treat a chat "yes" as a signature.
- Never add a tool that submits calldata the model invented.
- OAuth is not required for these public prepare-only tools. Do not fake an OAuth server.
- ChatGPT, Claude, or Gemini are not connected by installing this file. A person still adds the HTTPS endpoint in that client's custom-connector UI.
