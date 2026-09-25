import "server-only";

// lib/mcp/mcp-server.ts
//
// Minimal, stateless MCP server (JSON-RPC 2.0 over Streamable HTTP, JSON
// responses only — no SSE, no sessions). Implements: initialize,
// notifications/initialized, ping, tools/list, tools/call.
// Spec: https://modelcontextprotocol.io/specification (2025-06-18).

import { MCP_TOOLS, findMcpTool } from "./mcp-tools";
import { MCP_SERVER_NAME, MCP_SERVER_VERSION, jsonSafe, type McpDeps } from "./mcp-trade-service";

export const MCP_SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const MCP_LATEST_PROTOCOL_VERSION = MCP_SUPPORTED_PROTOCOL_VERSIONS[0];
export const MCP_MAX_BATCH = 10;

export const JSONRPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

type JsonRpcId = string | number | null;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const MCP_INSTRUCTIONS = [
  "MPGR Agent trading server (non-custodial). You NEVER sign or send transactions and never ask for private keys or seed phrases.",
  "Flow: mpgr_get_capabilities -> mpgr_get_quote -> mpgr_prepare_trade -> the USER signs/sends in their own wallet -> mpgr_finalize_trade (permit modes) -> mpgr_get_trade_status -> mpgr_verify_trade.",
  "Always show the user: sell amount, exact fee (25 bps of the sell token), minimum received, recipient (their own address) and the executor address before they sign.",
].join(" ");

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validId(v: unknown): v is JsonRpcId {
  return typeof v === "string" || (typeof v === "number" && Number.isFinite(v)) || v === null;
}

/** Handles one JSON-RPC message. Returns null for notifications (no response). */
export async function handleMcpMessage(message: unknown, deps: McpDeps): Promise<JsonRpcResponse | null> {
  if (!isObj(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(isObj(message) && validId(message.id) ? message.id : null, JSONRPC_ERRORS.INVALID_REQUEST, "Invalid JSON-RPC request");
  }
  const isNotification = !("id" in message);
  if (!isNotification && !validId(message.id)) return rpcError(null, JSONRPC_ERRORS.INVALID_REQUEST, "Invalid id");
  const id = (isNotification ? null : message.id) as JsonRpcId;
  const params = isObj(message.params) ? message.params : {};

  if (isNotification) return null; // notifications/initialized, notifications/cancelled, ...

  switch (message.method) {
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = (MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : MCP_LATEST_PROTOCOL_VERSION;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, title: "MPGR Agent", version: MCP_SERVER_VERSION },
          instructions: MCP_INSTRUCTIONS,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: MCP_TOOLS.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: t.annotations,
          })),
        },
      };
    case "tools/call": {
      const tool = findMcpTool(params.name);
      if (!tool) return rpcError(id, JSONRPC_ERRORS.INVALID_PARAMS, `Unknown tool: ${String(params.name)}`);
      const args = params.arguments === undefined ? {} : params.arguments;
      if (!isObj(args)) return rpcError(id, JSONRPC_ERRORS.INVALID_PARAMS, "arguments must be an object");
      try {
        const outcome = await tool.handler(deps, args);
        const structured = outcome.ok ? (jsonSafe(outcome.data) as Record<string, unknown>) : { error: outcome.error };
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(structured) }],
            structuredContent: structured,
            isError: !outcome.ok,
          },
        };
      } catch (error) {
        // Tool failures are reported in-band (isError) without leaking internals.
        console.error("[mcp] tool_failed", { tool: tool.name, message: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
        const structured = { error: { code: "UPSTREAM_ERROR", message: "The tool failed while reading chain/provider data. Retry shortly." } };
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured, isError: true },
        };
      }
    }
    default:
      return rpcError(id, JSONRPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${message.method}`);
  }
}

/** Handles a parsed HTTP body: a single message or a (legacy) batch. */
export async function handleMcpBody(body: unknown, deps: McpDeps): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(body)) {
    if (body.length === 0 || body.length > MCP_MAX_BATCH) {
      return rpcError(null, JSONRPC_ERRORS.INVALID_REQUEST, `Batch must contain 1..${MCP_MAX_BATCH} messages`);
    }
    const out: JsonRpcResponse[] = [];
    for (const m of body) {
      const r = await handleMcpMessage(m, deps);
      if (r) out.push(r);
    }
    return out.length ? out : null;
  }
  return handleMcpMessage(body, deps);
}
