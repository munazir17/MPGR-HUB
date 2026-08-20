// lib/architecture/tools/agent-tool-result.ts
//
// P0.1 — the standardized result every AgentTool.execute() (and
// AgentToolRuntime.executeTool()) resolves with. Never throws past this
// boundary — see agent-tool-runtime.ts, which catches everything and
// turns it into a PROVIDER_ERROR result rather than letting an exception
// escape to a caller.

export const AGENT_TOOL_ERROR_CODES = [
  "TOOL_NOT_FOUND",
  "INVALID_INPUT",
  "INVALID_ADDRESS",
  "WALLET_NOT_CONNECTED",
  "CHAIN_UNSUPPORTED",
  "DATA_UNAVAILABLE",
  "PROVIDER_ERROR",
  "RATE_LIMITED",
  "PERMISSION_DENIED",
  "TOOL_NOT_IMPLEMENTED",
  "EXECUTION_NOT_ALLOWED",
] as const;
export type AgentToolErrorCode = (typeof AGENT_TOOL_ERROR_CODES)[number];

export interface AgentToolError {
  code: AgentToolErrorCode;
  /** User-safe message — never a raw stack trace or internal exception message. See agent-tool-runtime.ts's catch block. */
  message: string;
  /** True if the same call might succeed on retry (e.g. RATE_LIMITED) — false/omitted for a deterministic failure (e.g. INVALID_INPUT). */
  retryable?: boolean;
}

export interface AgentToolResultMetadata {
  /** Where this data actually came from once P0.2 implements real fetching — e.g. "onchain", "coingecko". Never populated with a guess; omitted rather than fabricated. */
  source?: string;
  /** ISO 8601 — always populated by AgentToolRuntime, not by individual tools. */
  timestamp: string;
  chainId?: number;
  /**
   * Left as `number` rather than `bigint` for P0.1: no tool here reads a
   * real block yet, and a `number` metadata field serializes trivially
   * everywhere (JSON, persisted agent messages) that a `bigint` would
   * need special handling for — see lib/reward-allocation's bigint-safe
   * JSON round-trip for what that handling looks like when it's
   * actually needed. Revisit if/when a P0.2 tool needs a real block
   * number beyond Number.MAX_SAFE_INTEGER-safe range.
   */
  blockNumber?: number;
  /** Echoes AgentToolContext.requestId — set by AgentToolRuntime, not by the tool itself. */
  requestId?: string;
  /** Wall-clock duration of the execute() call, set by AgentToolRuntime. */
  durationMs?: number;
}

export interface AgentToolResult<T = unknown> {
  success: boolean;
  toolId: string;
  data?: T;
  error?: AgentToolError;
  metadata: AgentToolResultMetadata;
}

// --- Result builders ---------------------------------------------------------
//
// Small helpers so every tool/the runtime builds results the same way —
// metadata.timestamp is never forgotten, success/error are never both
// (or neither) populated.

export function toolSuccess<T>(
  toolId: string,
  data: T,
  metadata?: Partial<Omit<AgentToolResultMetadata, "timestamp">>
): AgentToolResult<T> {
  return {
    success: true,
    toolId,
    data,
    metadata: { ...metadata, timestamp: new Date().toISOString() },
  };
}

export function toolError(
  toolId: string,
  error: AgentToolError,
  metadata?: Partial<Omit<AgentToolResultMetadata, "timestamp">>
): AgentToolResult<never> {
  return {
    success: false,
    toolId,
    error,
    metadata: { ...metadata, timestamp: new Date().toISOString() },
  };
}
