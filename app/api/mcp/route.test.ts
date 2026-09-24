import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Deterministic limiter (CI sets placeholder Upstash env vars, so the real
// Redis-backed limiter would make network calls). Same pattern as the other
// route tests; the real clientIpFromRequest is kept.
const hits = new Map<string, number>();
const checkRateLimit = vi.fn(async (key: string, limit: number, _windowMs: number) => {
  const n = (hits.get(key) ?? 0) + 1;
  hits.set(key, n);
  return n > limit ? { allowed: false, remaining: 0, retryAfterSeconds: 60 } : { allowed: true, remaining: limit - n, retryAfterSeconds: 0 };
});
vi.mock("@/lib/trade/trade-rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/trade/trade-rate-limit")>()),
  checkRateLimit: (key: string, limit: number, windowMs: number) => checkRateLimit(key, limit, windowMs),
}));

import { DELETE, GET, POST } from "./route";

let ipCounter = 0;
function req(body: unknown, headers: Record<string, string> = {}, ip = `203.0.113.${++ipCounter % 250}`): Request {
  return new Request("https://app.example/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-forwarded-for": ip, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const ping = { jsonrpc: "2.0", id: 1, method: "ping" };

describe("POST /api/mcp", () => {
  const prevOrigin = process.env.APP_ORIGIN;
  const prevAllowed = process.env.MPGR_MCP_ALLOWED_ORIGINS;
  beforeEach(() => {
    process.env.APP_ORIGIN = "https://app.example";
    delete process.env.MPGR_MCP_ALLOWED_ORIGINS;
  });
  afterEach(() => {
    if (prevOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = prevOrigin;
    if (prevAllowed === undefined) delete process.env.MPGR_MCP_ALLOWED_ORIGINS;
    else process.env.MPGR_MCP_ALLOWED_ORIGINS = prevAllowed;
  });

  it("serves JSON-RPC for server-to-server clients (no Origin)", async () => {
    const res = await POST(req(ping));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("lists tools and answers capabilities end-to-end", async () => {
    const list = await (await POST(req({ jsonrpc: "2.0", id: 2, method: "tools/list" }))).json();
    expect(list.result.tools).toHaveLength(7);
    const caps = await (await POST(req({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mpgr_get_capabilities" } }))).json();
    expect(caps.result.isError).toBe(false);
    expect(caps.result.structuredContent.fee.bps).toBe(25);
  });

  it("accepts the app origin and configured origins; rejects others (DNS rebinding)", async () => {
    expect((await POST(req(ping, { origin: "https://app.example" }))).status).toBe(200);
    expect((await POST(req(ping, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await POST(req(ping, { origin: "not a url" }))).status).toBe(403);
    process.env.MPGR_MCP_ALLOWED_ORIGINS = "https://inspector.example, https://other.example/";
    expect((await POST(req(ping, { origin: "https://other.example" }))).status).toBe(200);
  });

  it("returns 202 with no body for notifications", async () => {
    const res = await POST(req({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("rejects unsupported protocol versions, bad JSON and oversized bodies", async () => {
    expect((await POST(req(ping, { "mcp-protocol-version": "2020-01-01" }))).status).toBe(400);
    expect((await POST(req(ping, { "mcp-protocol-version": "2025-06-18" }))).status).toBe(200);
    const bad = await POST(req("{not json"));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe(-32700);
    expect((await POST(req({ jsonrpc: "2.0", id: 1, method: "ping", pad: "x".repeat(70 * 1024) }))).status).toBe(413);
  });

  it("rate limits per client IP", async () => {
    const ip = "198.51.100.77";
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await POST(req(ping, {}, ip))).status);
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
    const limited = await POST(req(ping, {}, ip));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(checkRateLimit).toHaveBeenCalledWith(`${ip}:mcp`, 60, 60_000);
  });

  it("GET and DELETE are 405 (stateless server, no SSE / sessions)", async () => {
    expect(GET().status).toBe(405);
    expect(DELETE().status).toBe(405);
  });
});
