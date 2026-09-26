import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionResult } from "viem";

import { createChainReader, executorRpcUrl } from "@/lib/executor/executor-chain";
import { MPGR_EXECUTOR_ABI } from "@/lib/executor/mpgr-executor-abi";
import { createMcpDeps } from "@/lib/mcp/mcp-deps";
import { LIVE_PINS } from "@/lib/mcp/__tests__/base-mainnet-live-fixtures";

// No real endpoint or credential. Intercept the actual viem HTTP transport.
const SERVER_RPC = "https://private-rpc.invalid/v2/placeholder";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("production MCP RPC selection", () => {
  it("honors a configured server URL, trims whitespace, and ignores browser/Sepolia URLs", () => {
    vi.stubEnv("BASE_RPC_URL", `  ${SERVER_RPC}\n`);
    vi.stubEnv("NEXT_PUBLIC_BASE_RPC_URL", "https://browser-rpc.invalid");
    vi.stubEnv("BASE_SEPOLIA_RPC_URL", "https://sepolia-rpc.invalid");
    expect(executorRpcUrl(8453)).toBe(SERVER_RPC);
    expect(executorRpcUrl(84532)).toBe("https://sepolia-rpc.invalid");
  });

  it.each([undefined, "", "  \n"])("uses the documented public default only when server configuration is empty: %s", (value) => {
    vi.stubEnv("BASE_RPC_URL", value);
    vi.stubEnv("NEXT_PUBLIC_BASE_RPC_URL", "https://browser-rpc.invalid");
    expect(executorRpcUrl(8453)).toBe("https://mainnet.base.org");
  });

  it("passes mainnet enablement into dependencies and routes actual chain reads to BASE_RPC_URL", async () => {
    vi.stubEnv("BASE_RPC_URL", SERVER_RPC);
    vi.stubEnv("MPGR_MCP_ENABLE_BASE_MAINNET", " true ");
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.method).toBe("eth_call");
      expect(body.params[0].to.toLowerCase()).toBe(LIVE_PINS.executor.toLowerCase());
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: encodeFunctionResult({ abi: MPGR_EXECUTOR_ABI, functionName: "feeBps", result: 25 }) }), { headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetcher);
    const deps = createMcpDeps();
    expect(deps.mainnetEnabled).toBe(true);
    const reader = deps.reader(8453);
    expect(reader.chainId).toBe(8453);
    expect(await reader.readContract({ address: LIVE_PINS.executor, abi: MPGR_EXECUTOR_ABI, functionName: "feeBps" })).toBe(25);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toBe(SERVER_RPC);
  });

  it("does not silently fall back to mainnet.base.org if the configured provider fails", async () => {
    vi.stubEnv("BASE_RPC_URL", SERVER_RPC);
    const fetcher = vi.fn<typeof fetch>(async () => new Response("Unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    const reader = createChainReader(8453);
    await expect(reader.readContract({ address: LIVE_PINS.executor, abi: MPGR_EXECUTOR_ABI, functionName: "feeBps" })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalled();
    expect(fetcher.mock.calls.every(([url]) => String(url) === SERVER_RPC)).toBe(true);
  });
});
