import "server-only";

// lib/mcp/mcp-deps.ts — production wiring for the MCP trade service.
// Everything here is server-side configuration; nothing is secret-bearing in
// the tool outputs (the quote secret only keys the HMAC on quote ids).

import { createChainReader, type ChainReader } from "@/lib/executor/executor-chain";
import {
  MPGR_EXECUTOR_DEPLOYMENTS,
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  type ExecutorChainId,
  type ExecutorDeployment,
} from "@/lib/executor/executor-config";
import {
  BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT,
  mainnetDelegatedExecutorDeployment,
} from "@/lib/executor/delegated-executor";
import { getAgentFeeRecipient } from "@/lib/trade/trade-agent-fee";

import type { McpDeps } from "./mcp-trade-service";

const readers = new Map<ExecutorChainId, ChainReader>();

export function isMcpMainnetEnabled(): boolean {
  return process.env.MPGR_MCP_ENABLE_BASE_MAINNET?.trim() === "true";
}

/**
 * The delegated-executor registries, keyed by chain (audit MC-2 remediation).
 *
 * Base Sepolia is always present (code-pinned Phase 2 deployment). Base
 * mainnet is present ONLY when the operator has pinned
 * MPGR_MAINNET_DELEGATED_EXECUTOR — absent that, no mainnet registry exists,
 * quoting and execution both fail closed, and nothing silently falls back to
 * the Sepolia contract.
 */
export function delegatedRegistries(): Partial<Record<ExecutorChainId, ExecutorDeployment>> {
  const registries: Partial<Record<ExecutorChainId, ExecutorDeployment>> = {
    [BASE_SEPOLIA_CHAIN_ID]: BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT,
  };
  const mainnet = mainnetDelegatedExecutorDeployment();
  if (mainnet) registries[BASE_MAINNET_CHAIN_ID] = mainnet;
  return registries;
}

export function createMcpDeps(): McpDeps {
  const fee = getAgentFeeRecipient();
  const secret = process.env.AUTH_SESSION_SECRET;
  return {
    registry: MPGR_EXECUTOR_DEPLOYMENTS,
    delegatedRegistry: delegatedRegistries(),
    reader: (chainId) => {
      let r = readers.get(chainId);
      if (!r) {
        r = createChainReader(chainId);
        readers.set(chainId, r);
      }
      return r;
    },
    nowSeconds: () => Math.floor(Date.now() / 1000),
    quoteSecret: secret && secret.length >= 32 ? secret : undefined,
    mainnetEnabled: isMcpMainnetEnabled(),
    mainnetFeeRecipient: fee.ok ? fee.recipient : null,
  };
}

/**
 * Origin policy for the MCP endpoint (DNS-rebinding protection per the MCP
 * transport spec). Server-to-server MCP clients (ChatGPT / Claude / Grok
 * connectors) send no Origin and are allowed; a browser Origin must be the
 * app's own origin or listed in MPGR_MCP_ALLOWED_ORIGINS (comma separated).
 * The endpoint is unauthenticated and holds no user state, so this is
 * defence-in-depth rather than CSRF protection.
 */
export function isMcpOriginAllowed(origin: string | null, appOrigin: string | null): boolean {
  if (origin === null || origin === "") return true;
  let normalized: string;
  try {
    normalized = new URL(origin).origin;
  } catch {
    return false;
  }
  if (appOrigin && normalized === appOrigin) return true;
  const extra = (process.env.MPGR_MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return extra.includes(normalized);
}
