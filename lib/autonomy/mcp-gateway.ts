import "server-only";

// lib/autonomy/mcp-gateway.ts
//
// The runtime's ONLY trading interface (spec §12). Every quote, prepare,
// status and verification call goes through the EXISTING MPGR MCP trade
// service functions — quote logic, fee logic, route logic, approval logic
// and executor handling are NEVER duplicated here.
//
// The gateway does three things and nothing else:
//   1. binds production McpDeps (createMcpDeps) — the operator's existing
//      switches (MPGR_MCP_ENABLE_BASE_MAINNET, fee recipient, quote secret)
//      keep working unchanged;
//   2. maps MCP error codes onto the autonomy failure taxonomy;
//   3. keeps raw MCP payloads out of the runtime (typed views only).

import { createDelegatedBroadcaster } from "@/lib/delegated/delegated-broadcaster";
import {
  delegateSwap,
  getCapabilities,
  getQuote,
  getTradeStatus,
  prepareTrade,
  verifyTrade,
  type McpDeps,
  type ToolOutcome,
} from "@/lib/mcp/mcp-trade-service";
import { createMcpDeps } from "@/lib/mcp/mcp-deps";
import type { AutonomyFailureCode } from "./types";

export interface QuotedSwap {
  quoteId: string;
  chainId: number;
  sellToken: string;
  buyToken: string;
  sellAmountRaw: string;
  expectedBuyAmountRaw: string;
  minBuyAmountRaw: string;
  slippageBps: number;
  feeBps: number;
  feeAmountRaw: string;
  quoteExpiresAt: number; // unix seconds (from the signed quoteId)
}

export interface PreparedSwap {
  quoteId: string;
  /** Unsigned transaction request(s) for the taker's wallet — from MCP. */
  steps: Array<Record<string, unknown>>;
  /** The unsigned swap transaction request, when MCP produced one. */
  transactionRequest: Record<string, unknown> | null;
  expiresAt: number;
}

export interface McpFailure {
  code: AutonomyFailureCode;
  message: string;
}

export type GatewayResult<T> =
  | { ok: true; data: T }
  | { ok: false; failure: McpFailure };

export interface McpGateway {
  getCapabilities(): Promise<ToolOutcome>;
  quote(input: Record<string, unknown>): Promise<GatewayResult<QuotedSwap>>;
  prepare(input: Record<string, unknown>): Promise<GatewayResult<PreparedSwap>>;
  status(chainId: number, txHash: string): Promise<GatewayResult<{ status: "confirmed" | "reverted" | "pending_or_unknown"; blockNumber?: string }>>;
  verify(quoteId: string, txHash: string, expectedSender?: string, expectedIntentId?: string): Promise<GatewayResult<{ verified: boolean; checks: Array<{ name: string; ok: boolean }>; actualBuyAmountRaw?: string; feeAmountRaw?: string; blockNumber?: string }>>;
  /** Phase 2 delegated execution: broadcast a fully-validated witness-authorized swap (Base Sepolia only). */
  delegateSwap(input: Record<string, unknown>): Promise<GatewayResult<{ txHash: string; expectedSender?: string | null }>>;
  /** Raw deps for callers that must reuse MCP views (verification formatting). */
  deps(): McpDeps;
}

function mapMcpError(code: string): AutonomyFailureCode {
  switch (code) {
    case "BASE_MAINNET_DISABLED":
      return "MCP_DISABLED";
    case "EXECUTOR_PAUSED":
      return "EXECUTOR_PAUSED";
    case "QUOTE_FAILED":
    case "UPSTREAM_ERROR":
    case "QUOTE_SECRET_MISSING": // quote-signing misconfiguration is a quote failure, not a generic RPC error (live-canary observability fix)
      return "QUOTE_FAILED";
    case "NO_ROUTE":
    case "LIQUIDITY_UNAVAILABLE":
      return "NO_LIQUIDITY";
    case "QUOTE_EXPIRED":
    case "QUOTE_STALE":
      return "QUOTE_STALE";
    case "TOKEN_NOT_ALLOWED":
    case "TOKEN_NOT_FOUND":
      return "TOKEN_NOT_ALLOWED";
    case "INSUFFICIENT_BALANCE":
      return "POLICY_REJECTED";
    case "RPC_ERROR":
    case "TX_NOT_FOUND":
      return "RPC_ERROR";
    default:
      return "RPC_ERROR";
  }
}

function fail(outcome: { ok: false; error: { code: string; message: string } }): { ok: false; failure: McpFailure } {
  return { ok: false, failure: { code: mapMcpError(outcome.error.code), message: outcome.error.message } };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

export class McpTradeGateway implements McpGateway {
  constructor(private readonly mcpDeps: McpDeps) {}

  static production(): McpTradeGateway {
    return new McpTradeGateway(createMcpDeps());
  }

  /**
   * Phase 2 delegated path (Base Sepolia): identical to production() plus
   * the operator broadcaster (lib/delegated — its own domain, following the
   * reward-vault operator-key seam). Fail-closed: with the broadcaster key
   * unset on the server the delegate tool refuses; nothing else in the
   * gateway changes.
   */
  static productionWithDelegation(): McpTradeGateway {
    const broadcaster = createDelegatedBroadcaster();
    return new McpTradeGateway({ ...createMcpDeps(), delegatedBroadcaster: broadcaster.address ? broadcaster.broadcast : undefined });
  }

  async getCapabilities(): Promise<ToolOutcome> {
    return getCapabilities(this.mcpDeps);
  }

  async quote(input: Record<string, unknown>): Promise<GatewayResult<QuotedSwap>> {
    const outcome = await getQuote(this.mcpDeps, input);
    if (!outcome.ok) return fail(outcome);
    // mpgr_get_quote returns the intent view FLAT at the top level
    // (quoteId, sellToken{address,...}, sellAmount, ..., expiresAt).
    const d = outcome.data as Record<string, unknown>;
    return {
      ok: true,
      data: {
        quoteId: str(d.quoteId),
        chainId: Number(d.chainId ?? 0),
        sellToken: str((d.sellToken as Record<string, unknown> | undefined)?.address),
        buyToken: str((d.buyToken as Record<string, unknown> | undefined)?.address),
        sellAmountRaw: str(d.sellAmount),
        expectedBuyAmountRaw: str(d.expectedBuyAmount),
        minBuyAmountRaw: str(d.minBuyAmount),
        slippageBps: Number(d.slippageBps ?? 0),
        feeBps: Number(d.feeBps ?? 0),
        feeAmountRaw: str(d.feeAmount),
        quoteExpiresAt: Number(d.expiresAt ?? 0),
      },
    };
  }

  async prepare(input: Record<string, unknown>): Promise<GatewayResult<PreparedSwap>> {
    const outcome = await prepareTrade(this.mcpDeps, input);
    if (!outcome.ok) return fail(outcome);
    const d = outcome.data as Record<string, unknown>;
    return {
      ok: true,
      data: {
        quoteId: str((d.intent as Record<string, unknown> | undefined)?.quoteId),
        steps: Array.isArray(d.steps) ? (d.steps as Array<Record<string, unknown>>) : [],
        transactionRequest: (d.transactionRequest as Record<string, unknown> | null) ?? null,
        expiresAt: Number(d.expiresAt ?? 0),
      },
    };
  }

  async status(chainId: number, txHash: string): Promise<GatewayResult<{ status: "confirmed" | "reverted" | "pending_or_unknown"; blockNumber?: string }>> {
    const outcome = await getTradeStatus(this.mcpDeps, { chainId, txHash });
    if (!outcome.ok) return fail(outcome);
    const d = outcome.data as Record<string, unknown>;
    return {
      ok: true,
      data: {
        status: d.status as "confirmed" | "reverted" | "pending_or_unknown",
        blockNumber: typeof d.blockNumber === "string" ? d.blockNumber : undefined,
      },
    };
  }

  async verify(quoteId: string, txHash: string, expectedSender?: string, expectedIntentId?: string): Promise<GatewayResult<{ verified: boolean; checks: Array<{ name: string; ok: boolean }>; actualBuyAmountRaw?: string; feeAmountRaw?: string; blockNumber?: string }>> {
    const input: Record<string, unknown> = { quoteId, txHash };
    if (expectedSender) input.expectedSender = expectedSender;
    if (expectedIntentId) input.expectedIntentId = expectedIntentId;
    const outcome = await verifyTrade(this.mcpDeps, input);
    if (!outcome.ok) return fail(outcome);
    const d = outcome.data as Record<string, unknown>;
    const event = (d.event ?? null) as Record<string, unknown> | null;
    return {
      ok: true,
      data: {
        verified: d.verified === true,
        checks: Array.isArray(d.checks) ? (d.checks as Array<{ name: string; ok: boolean }>) : [],
        actualBuyAmountRaw: event ? str(event.amountOut) : undefined,
        feeAmountRaw: event ? str(event.feeAmount) : undefined,
        blockNumber: typeof d.blockNumber === "string" ? d.blockNumber : undefined,
      },
    };
  }

  async delegateSwap(input: Record<string, unknown>): Promise<GatewayResult<{ txHash: string; expectedSender?: string | null }>> {
    const outcome = await delegateSwap(this.mcpDeps, input);
    if (!outcome.ok) return fail(outcome);
    const d = outcome.data as Record<string, unknown>;
    return { ok: true, data: { txHash: str(d.txHash), expectedSender: (d.expectedSender as string | undefined) ?? null } };
  }

  deps(): McpDeps {
    return this.mcpDeps;
  }
}
