// lib/architecture/tools/transfer-tool-definitions.ts
//
// Agent-facing send/transfer tool.
//
//   transfer_prepare_send   (prepare) — native ETH or any Base ERC-20 to
//                                        an address or Basename
//
// IMPORTANT — why this calls an HTTP route instead of lib/trade/* directly:
// lib/trade/transfer-proposal.ts and transfer-basename.ts are marked
// `server-only`. This file is imported (via agent-tool-runtime-instance.ts
// -> agent-tool-calling.ts -> deterministic-ai-provider.ts ->
// ai-provider-registry.ts) from app/agent/page.tsx, a `"use client"`
// component. See trade-tool-definitions.ts's header comment for the exact
// same constraint and the Next.js build failure it avoids.
//
// There is NO execute-mode transfer tool. Signing stays behind the
// Confirm UI (hooks/useTransferQuote), same boundary as trade/x402.
//
// The model is NEVER trusted for recipient, token, or amount as final
// authority — every value here is re-resolved and re-validated server
// side in lib/trade/transfer-request.ts / transfer-proposal.ts before a
// proposal is ever built, exactly like trade_prepare_swap.

import type { AgentTool, AgentToolSchema } from "./agent-tool";
import { getAgentToolRegistry } from "./agent-tool-registry-instance";
import { toolError, toolSuccess } from "./agent-tool-result";

const CANONICAL_APP_ORIGIN = "https://mpgrhub.xyz";

function transferEndpoint(path: string): string {
  return CANONICAL_APP_ORIGIN + path;
}

function toolFailureCode(code: unknown): "INVALID_INPUT" | "WALLET_NOT_CONNECTED" | "DATA_UNAVAILABLE" | "PROVIDER_ERROR" {
  if (
    code === "INVALID_INPUT" ||
    code === "UNSUPPORTED_ASSET" ||
    code === "INVALID_RECIPIENT" ||
    code === "RECIPIENT_UNRESOLVED"
  ) {
    return "INVALID_INPUT";
  }
  if (code === "WALLET_REQUIRED") return "WALLET_NOT_CONNECTED";
  if (code === "PROVIDER_ERROR") return "DATA_UNAVAILABLE";
  return "PROVIDER_ERROR";
}

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; status: number; payload: Record<string, unknown> | null }> {
  const response = await fetch(transferEndpoint(path), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: response.ok, status: response.status, payload };
}

const transferSchema: AgentToolSchema = {
  type: "object",
  properties: {
    token: {
      type: "string",
      description: "Asset to send on Base: ETH, WETH, USDC, MPGR, a Coinbase B20 ticker, or any 0x contract address on Base.",
    },
    amount: {
      type: "string",
      description: 'Human amount in token units, e.g. "0.01" for 0.01 ETH. Do not convert to wei — the server verifies decimals on-chain.',
    },
    recipient: {
      type: "string",
      description: "Destination: a Base 0x address, or a Basename such as jesse.base.eth. Never invent an address — ask the user if unclear.",
    },
  },
  required: ["token", "amount", "recipient"],
};

export const transferPrepareSendTool: AgentTool = {
  id: "transfer_prepare_send",
  name: "Base Send Proposal",
  description:
    "Creates a structured Base send/transfer proposal for explicit user confirmation. Works for native ETH and any Base ERC-20 (USDC, WETH, MPGR, a 0x address). Recipient can be a 0x address or a Basename (name.base.eth) — resolved server-side, never guessed. Never signs. Never call this without an explicit recipient the user provided.",
  category: "wallet",
  mode: "prepare",
  riskLevel: "high",
  requiresWallet: true,
  requiresConfirmation: true,
  inputSchema: transferSchema,

  async execute(input) {
    const body = (input ?? {}) as Record<string, unknown>;
    if (typeof body.recipient !== "string" || !body.recipient.trim()) {
      return toolError("transfer_prepare_send", {
        code: "INVALID_INPUT",
        message: "A recipient (Base address or Basename) is required. I will not invent one.",
      });
    }
    try {
      const { ok, payload } = await postJson("/api/transfer/quote", body);
      if (!ok || !payload) {
        return toolError("transfer_prepare_send", {
          code: toolFailureCode(payload?.code),
          message: typeof payload?.error === "string" ? payload.error : "Could not prepare a Base transfer.",
        });
      }
      const proposal = payload.proposal as { kind?: string } | undefined;
      return toolSuccess(
        "transfer_prepare_send",
        { proposal: payload.proposal },
        { source: proposal?.kind === "native-transfer" ? "base-native-transfer" : "base-erc20-transfer", chainId: 8453 },
      );
    } catch {
      return toolError("transfer_prepare_send", {
        code: "PROVIDER_ERROR",
        message: "Could not reach the Base transfer endpoint.",
        retryable: true,
      });
    }
  },
};

const registry = getAgentToolRegistry();
if (!registry.has(transferPrepareSendTool.id)) {
  registry.register(transferPrepareSendTool);
}
