// app/api/mcp/route.ts — MPGR Agent MCP server (Streamable HTTP, stateless,
// JSON responses). Non-custodial: tools return quotes, unsigned transactions
// and EIP-712 payloads only; the user's wallet signs and sends.

import { requestIdFromRequest, withRequestId, readJsonBody } from "@/lib/api/request-guard";
import { resolveTrustedAppOrigin } from "@/lib/auth/config";
import { createMcpDeps, isMcpOriginAllowed } from "@/lib/mcp/mcp-deps";
import { handleMcpBody, JSONRPC_ERRORS, MCP_SUPPORTED_PROTOCOL_VERSIONS } from "@/lib/mcp/mcp-server";
import { checkRateLimit, clientIpFromRequest } from "@/lib/trade/trade-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

const BASE_HEADERS = { "Cache-Control": "no-store", "Content-Type": "application/json" } as const;

function rpcErrorResponse(status: number, code: number, message: string, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }), {
    status,
    headers: { ...BASE_HEADERS, ...(extra ?? {}) },
  });
}

function appOriginOrNull(request: Request): string | null {
  try {
    return resolveTrustedAppOrigin(request);
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = requestIdFromRequest(request);
  const done = (r: Response) => withRequestId(r, requestId);

  if (!isMcpOriginAllowed(request.headers.get("origin"), appOriginOrNull(request))) {
    return done(rpcErrorResponse(403, JSONRPC_ERRORS.INVALID_REQUEST, "Origin not allowed"));
  }
  const version = request.headers.get("mcp-protocol-version");
  if (version && !(MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return done(rpcErrorResponse(400, JSONRPC_ERRORS.INVALID_REQUEST, `Unsupported MCP-Protocol-Version: ${version.slice(0, 32)}`));
  }
  const rate = await checkRateLimit(`${clientIpFromRequest(request)}:mcp`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rate.allowed) {
    return done(
      rpcErrorResponse(429, JSONRPC_ERRORS.INVALID_REQUEST, "Too many requests", { "Retry-After": String(rate.retryAfterSeconds) }),
    );
  }
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) {
    const status = body.response.status;
    return done(
      rpcErrorResponse(status, status === 413 ? JSONRPC_ERRORS.INVALID_REQUEST : JSONRPC_ERRORS.PARSE_ERROR, status === 413 ? "Request body too large" : "Parse error"),
    );
  }
  const result = await handleMcpBody(body.value, createMcpDeps());
  if (result === null) return done(new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } }));
  return done(new Response(JSON.stringify(result), { status: 200, headers: BASE_HEADERS }));
}

function methodNotAllowed(): Response {
  // Stateless server: no SSE stream (GET) and no sessions to delete (DELETE).
  return new Response(JSON.stringify({ error: "Method not allowed. POST JSON-RPC messages to this endpoint." }), {
    status: 405,
    headers: { ...BASE_HEADERS, Allow: "POST" },
  });
}

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
