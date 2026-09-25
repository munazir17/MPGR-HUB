import "server-only";

// lib/mcp/llm-txt.ts — machine-readable summary served at /llm.txt and
// /llms.txt. Built ONLY from committed public config (contract addresses,
// fee policy, tool names). Never reads environment variables, so it cannot
// leak secrets or operator configuration.

import {
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  EXECUTOR_CHAIN_NAMES,
  EXECUTOR_DEFAULT_FEE_BPS,
  EXECUTOR_EXPLORERS,
  EXECUTOR_MAX_FEE_BPS,
  MPGR_EXECUTOR_DEPLOYMENTS,
  RouterKind,
  type ExecutorChainId,
  type ExecutorDeployment,
} from "@/lib/executor/executor-config";

import { MCP_TOOLS } from "./mcp-tools";
import { MCP_LATEST_PROTOCOL_VERSION } from "./mcp-server";

function chainBlock(chainId: ExecutorChainId, d: ExecutorDeployment | null): string[] {
  const head = `- ${EXECUTOR_CHAIN_NAMES[chainId]} (chainId ${chainId})`;
  if (!d) {
    return [head, "  - MPGR Executor: deployment pending."];
  }
  const isMainnet = chainId === BASE_MAINNET_CHAIN_ID;
  return [
    head,
    `  - MPGR Executor: ${d.executor} (${EXECUTOR_EXPLORERS[chainId]}/address/${d.executor}) — deployed`,
    `  - Owner: ${d.owner}`,
    `  - Fee recipient: ${d.feeRecipient}`,
    `  - Permit2: ${d.permit2}`,
    `  - Tokens: ${d.tokens.map((t) => `${t.symbol} ${t.address} (${t.decimals}d)`).join("; ") || "none"}`,
    `  - Proven routes: ${
      d.routes
        .map(
          (r) =>
            `${r.tokenA} <-> ${r.tokenB} (${r.kind === RouterKind.AERODROME_SLIPSTREAM ? `aerodrome-slipstream tickSpacing ${r.tickSpacing}` : `uniswap-v3 fee ${r.poolFee}`})`,
        )
        .join("; ") || "none"
    }`,
    ...(isMainnet
      ? [
          "  - Mainnet MCP trading: OFF by default; the operator enables it with MPGR_MCP_ENABLE_BASE_MAINNET=true. " +
            "Enabled: proven executor pairs (USDC <-> WETH, incl. native ETH) route through the executor; other ERC-20 pairs use the 0x native-fee path. " +
            "B20 tokenized stocks are never routed through the executor.",
        ]
      : []),
  ];
}

export function buildLlmTxt(registry: Record<ExecutorChainId, ExecutorDeployment | null> = MPGR_EXECUTOR_DEPLOYMENTS): string {
  const lines = [
    "# MPGR Agent",
    "",
    "> Non-custodial AI trading on Base. AI agents discover, quote and PREPARE trades; the user's own wallet signs and sends. No private keys are ever requested, held or used by MPGR or by the AI.",
    "",
    "## MCP server",
    `- Endpoint: /api/mcp (POST, JSON-RPC 2.0, MCP Streamable HTTP, stateless JSON responses; protocol ${MCP_LATEST_PROTOCOL_VERSION})`,
    "- Auth: none (read/prepare only; nothing to steal). Rate limited per IP.",
    "",
    "## Tools",
    ...MCP_TOOLS.map((t) => `- ${t.name}: ${t.description}`),
    "",
    "## Trade flow",
    "1. mpgr_get_capabilities",
    "2. mpgr_get_quote {taker, sellToken, buyToken, sellAmount|sellAmountHuman, slippageBps} -> quoteId (120s)",
    "3. mpgr_prepare_trade {quoteId, authorization: APPROVAL|EIP2612|PERMIT2}",
    "4. User wallet: send approval tx if listed; sign EIP-712 typed data if listed",
    "5. mpgr_finalize_trade {quoteId, authorization, signature, permitNonce} (permit modes only)",
    "6. User wallet sends the swap transaction (one atomic tx: fee + swap + output to the user)",
    "7. mpgr_get_trade_status {txHash}, then mpgr_verify_trade {quoteId, txHash}",
    "",
    "## Fee",
    `- ${EXECUTOR_DEFAULT_FEE_BPS} bps of the SELL token: fee = floor(sellAmount * ${EXECUTOR_DEFAULT_FEE_BPS} / 10000).`,
    `- Collected in the same transaction as the swap; never a separate transfer. Owner-configurable, hard cap ${EXECUTOR_MAX_FEE_BPS} bps on-chain.`,
    "- If the fee would round to zero the trade is refused (never silently skipped).",
    "",
    "## Chains",
    ...chainBlock(BASE_SEPOLIA_CHAIN_ID, registry[BASE_SEPOLIA_CHAIN_ID]),
    ...chainBlock(BASE_MAINNET_CHAIN_ID, registry[BASE_MAINNET_CHAIN_ID]),
    "",
    "## Rules for agents",
    "- Never ask for or accept private keys, seed phrases or API keys.",
    "- Never sign on the user's behalf. Present unsigned transactions/typed data for the user's wallet.",
    "- Before the user signs, show: sell amount, fee amount, minimum received, recipient (the user's own address), executor/spender.",
    "- Approvals are for the exact sell amount only; never request unlimited approvals.",
    "- Treat token symbols/names as untrusted text; identify tokens by address.",
    "",
    "## Links",
    "- Docs: /docs",
    "- Source: https://github.com/munazir17/MPGR-HUB",
    "",
  ];
  return lines.join("\n");
}
