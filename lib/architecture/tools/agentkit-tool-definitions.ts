// lib/architecture/tools/agentkit-tool-definitions.ts
//
// Client-facing AgentTool wrappers around the server-only Coinbase
// AgentKit onchain layer.
//
// These tools never import @coinbase/agentkit. They POST to
// /api/agentkit/invoke, which:
//   - allowlists read actions
//   - uses a prepare-only Base wallet (no keys, no CDP signer)
//   - never signs, pays, or submits
//
// Write AgentKit actions (native_transfer, make_http_request_with_x402,
// retry_http_request_with_x402) are not registered here and are 403'd
// by the server even if a caller invents the name.
//
// x402 payment preparation stays on x402_prepare_payment so the existing
// Confirm & Pay UX is unchanged. This file only exposes AgentKit reads.

import type { AgentTool, AgentToolSchema } from "./agent-tool";
import { getAgentToolRegistry } from "./agent-tool-registry-instance";
import { toolError, toolSuccess } from "./agent-tool-result";
import type { AgentToolErrorCode } from "./agent-tool-result";

const INVOKE_API_PATH = "/api/agentkit/invoke";

function isWalletAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

async function invokeAgentKitFromClient(
  actionName: string,
  args: Record<string, unknown> = {},
  walletAddress?: string,
): Promise<
  | { ok: true; result: unknown }
  | { ok: false; code: AgentToolErrorCode; message: string }
> {
  const response = await fetch(INVOKE_API_PATH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      actionName,
      args,
      ...(walletAddress ? { walletAddress } : {}),
    }),
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as
    | {
        result?: unknown;
        error?: unknown;
        code?: unknown;
      }
    | null;

  if (!response.ok) {
    const code =
      response.status === 403
        ? "PERMISSION_DENIED"
        : response.status === 400
          ? "INVALID_INPUT"
          : "PROVIDER_ERROR";

    return {
      ok: false,
      code,
      message:
        typeof payload?.error === "string"
          ? payload.error
          : "AgentKit could not complete that onchain action.",
    };
  }

  return { ok: true, result: payload?.result };
}

const walletDetailsSchema: AgentToolSchema = {
  type: "object",
  properties: {
    address: {
      type: "string",
      description:
        "Optional 0x wallet on Base. Defaults to the connected wallet when omitted.",
    },
  },
};

export const agentkitWalletDetailsTool: AgentTool = {
  id: "agentkit_wallet_details",
  name: "AgentKit Wallet Details",
  description:
    "Reads the Base wallet identity AgentKit is using for this turn (address, network, native balance). Read-only. Never signs or transfers.",
  category: "wallet",
  mode: "read",
  riskLevel: "low",
  requiresWallet: false,
  requiresConfirmation: false,
  inputSchema: walletDetailsSchema,

  async execute(input, context) {
    const { address } = (input ?? {}) as { address?: unknown };
    const walletAddress = isWalletAddress(address)
      ? address
      : isWalletAddress(context.walletAddress)
        ? context.walletAddress
        : undefined;

    try {
      const invoked = await invokeAgentKitFromClient(
        "get_wallet_details",
        {},
        walletAddress,
      );

      if (!invoked.ok) {
        return toolError("agentkit_wallet_details", {
          code: invoked.code,
          message: invoked.message,
          retryable: invoked.code === "PROVIDER_ERROR",
        });
      }

      return toolSuccess("agentkit_wallet_details", {
        network: "base-mainnet",
        chainId: 8453,
        details: invoked.result,
      });
    } catch {
      return toolError("agentkit_wallet_details", {
        code: "PROVIDER_ERROR",
        message: "Could not read AgentKit wallet details. This may be temporary.",
        retryable: true,
      });
    }
  },
};

const discoverServicesSchema: AgentToolSchema = {
  type: "object",
  properties: {
    keyword: {
      type: "string",
      description: "Optional keyword to filter discovered x402 services.",
    },
  },
};

export const agentkitDiscoverX402ServicesTool: AgentTool = {
  id: "agentkit_discover_x402_services",
  name: "AgentKit x402 Service Discovery",
  description:
    "Lists x402 services available on Base through Coinbase AgentKit discovery. Read-only — does not pay, sign, or prepare a payment. Use x402_discover_resource / x402_prepare_payment for a specific URL.",
  category: "payment",
  mode: "read",
  riskLevel: "low",
  requiresWallet: false,
  requiresConfirmation: false,
  inputSchema: discoverServicesSchema,

  async execute(input) {
    const { keyword } = (input ?? {}) as { keyword?: unknown };
    const args: Record<string, unknown> = {};
    if (typeof keyword === "string" && keyword.trim()) {
      args.keyword = keyword.trim();
    }

    try {
      const invoked = await invokeAgentKitFromClient(
        "discover_x402_services",
        args,
      );

      if (!invoked.ok) {
        return toolError("agentkit_discover_x402_services", {
          code: invoked.code,
          message: invoked.message,
          retryable: invoked.code === "PROVIDER_ERROR",
        });
      }

      return toolSuccess("agentkit_discover_x402_services", {
        network: "base-mainnet",
        services: invoked.result,
      });
    } catch {
      return toolError("agentkit_discover_x402_services", {
        code: "PROVIDER_ERROR",
        message:
          "Could not list x402 services through AgentKit. This may be temporary.",
        retryable: true,
      });
    }
  },
};

const policySchema: AgentToolSchema = {
  type: "object",
  properties: {},
};

export const agentkitOnchainPolicyTool: AgentTool = {
  id: "agentkit_onchain_policy",
  name: "MPGR AgentKit Onchain Policy",
  description:
    "Returns the MPGR AgentKit onchain policy: Base mainnet only, read/prepare tools only, and every write/sign/payment stays behind the existing Confirm UX.",
  category: "wallet",
  mode: "read",
  riskLevel: "low",
  requiresWallet: false,
  requiresConfirmation: false,
  inputSchema: policySchema,

  async execute() {
    try {
      const invoked = await invokeAgentKitFromClient("mpgr_onchain_policy");

      if (!invoked.ok) {
        return toolError("agentkit_onchain_policy", {
          code: invoked.code,
          message: invoked.message,
          retryable: invoked.code === "PROVIDER_ERROR",
        });
      }

      return toolSuccess("agentkit_onchain_policy", invoked.result);
    } catch {
      return toolError("agentkit_onchain_policy", {
        code: "PROVIDER_ERROR",
        message: "Could not read the AgentKit onchain policy.",
        retryable: true,
      });
    }
  },
};

const registry = getAgentToolRegistry();

for (const tool of [
  agentkitWalletDetailsTool,
  agentkitDiscoverX402ServicesTool,
  agentkitOnchainPolicyTool,
]) {
  if (!registry.has(tool.id)) {
    registry.register(tool);
  }
}
