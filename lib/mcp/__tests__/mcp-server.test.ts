import { describe, expect, it } from "vitest";

import { MCP_TOOLS } from "@/lib/mcp/mcp-tools";
import { MCP_MAX_BATCH, handleMcpBody, handleMcpMessage, type JsonRpcResponse } from "@/lib/mcp/mcp-server";

import { newFakeState, testDeps } from "./fixtures";

const deps = testDeps(newFakeState());
const call = (m: unknown) => handleMcpMessage(m, deps) as Promise<JsonRpcResponse>;

describe("MCP JSON-RPC protocol", () => {
  it("initialize negotiates a supported protocol version and advertises tools", async () => {
    const r = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect(r.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "mpgr-agent" } });
    expect(String((r.result as { instructions: string }).instructions)).toMatch(/never sign/i);
    const latest = await call({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect((latest.result as { protocolVersion: string }).protocolVersion).toBe("2025-06-18");
  });

  it("notifications get no response; ping returns {}", async () => {
    expect(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, deps)).toBeNull();
    expect((await call({ jsonrpc: "2.0", id: "p", method: "ping" })).result).toEqual({});
  });

  it("tools/list exposes the 7 MPGR tools with schemas and read-only annotations", async () => {
    const r = await call({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const tools = (r.result as { tools: { name: string; inputSchema: { type: string }; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual([
      "mpgr_get_capabilities",
      "mpgr_list_tokens",
      "mpgr_get_quote",
      "mpgr_prepare_trade",
      "mpgr_finalize_trade",
      "mpgr_get_trade_status",
      "mpgr_verify_trade",
    ]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    // No tool accepts anything that looks like key material.
    expect(JSON.stringify(MCP_TOOLS.map((t) => t.inputSchema))).not.toMatch(/private|mnemonic|seed|apiKey/i);
  });

  it("tools/call returns text + structuredContent; tool errors are in-band", async () => {
    const r = await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "mpgr_get_capabilities", arguments: {} } });
    const res = r.result as { content: { type: string; text: string }[]; structuredContent: Record<string, unknown>; isError: boolean };
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.content[0].text)).toEqual(res.structuredContent);
    const bad = await call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "mpgr_get_quote", arguments: { taker: "nope" } } });
    expect(bad.result).toMatchObject({ isError: true, structuredContent: { error: { code: "INVALID_TAKER" } } });
  });

  it("unknown tools/methods and malformed requests map to JSON-RPC errors", async () => {
    expect((await call({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "execute", arguments: {} } })).error?.code).toBe(-32602);
    expect((await call({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "mpgr_get_capabilities", arguments: [1] } })).error?.code).toBe(-32602);
    expect((await call({ jsonrpc: "2.0", id: 8, method: "resources/list" })).error?.code).toBe(-32601);
    expect((await call({ id: 9, method: "ping" })).error?.code).toBe(-32600);
    expect((await call({ jsonrpc: "2.0", id: { x: 1 }, method: "ping" })).error?.code).toBe(-32600);
  });

  it("tool exceptions become a generic in-band error without leaking internals", async () => {
    const throwing = testDeps(newFakeState(), {
      reader: () => {
        throw new Error("secret rpc url https://key@rpc");
      },
    });
    const r = (await handleMcpMessage(
      { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "mpgr_get_quote", arguments: { taker: "0x1111111111111111111111111111111111111111", sellToken: "tUSD", buyToken: "tSTOCK", sellAmount: "1000000" } } },
      throwing,
    )) as JsonRpcResponse;
    expect(r.result).toMatchObject({ isError: true, structuredContent: { error: { code: "UPSTREAM_ERROR" } } });
    expect(JSON.stringify(r)).not.toContain("key@rpc");
  });

  it("batches: bounded size, notifications omitted", async () => {
    const out = (await handleMcpBody(
      [
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
      ],
      deps,
    )) as JsonRpcResponse[];
    expect(out).toHaveLength(1);
    const tooMany = (await handleMcpBody(Array.from({ length: MCP_MAX_BATCH + 1 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" })), deps)) as JsonRpcResponse;
    expect(tooMany.error?.code).toBe(-32600);
    expect(await handleMcpBody([{ jsonrpc: "2.0", method: "notifications/initialized" }], deps)).toBeNull();
  });
});
