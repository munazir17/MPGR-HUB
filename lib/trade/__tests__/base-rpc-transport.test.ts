import { afterEach, describe, expect, it, vi } from "vitest";
import { erc20Abi } from "viem";
import { createServer, type Server } from "node:http";

// Base RPC transport hardening — regression tests for the EXACT failure
// that produced preview 502s (all Base transports failing under public-RPC
// rate limiting). These prove, against real viem fallback/http transports
// and local mock JSON-RPC servers:
//
//   1. one provider failing falls through to the next, in order;
//   2. temporary HTTP 429 on one provider does NOT fail a read while
//      another provider is healthy;
//   3. a transient 429 on the ONLY provider recovers via viem's bounded
//      client-level retry;
//   4. when EVERY provider is unavailable the read rejects (fail-closed)
//      and the sanitized diagnostic identifies the failed transports
//      WITHOUT leaking paths, credentials, or API keys;
//   5. the B20 on-chain verification batches its reads into ONE multicall
//      round trip, preserves per-field null semantics, and still returns
//      null decimals when all transports fail (quotes then refuse).

import {
  createBaseRpcClient,
  describeBaseRpcHealth,
  resetBaseRpcProbeForTests,
  rpcUrls,
} from "../trade-public-client";
import { findTokenizedStock } from "../tokenized-stocks";
import { readTokenizedStockOnchain } from "../tokenized-stocks-onchain";
import { createChainReader } from "@/lib/executor/executor-chain";

const TOKEN = "0x1111111111111111111111111111111111111111" as const;

type RpcHandler = (body: { id: number; method: string }, res: import("node:http").ServerResponse) => void;

function startRpcServer(handler: RpcHandler): Promise<{ url: string; requestCount: () => number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    let requests = 0;
    const server: Server = createServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        requests += 1;
        let body: { id: number; method: string } = { id: 0, method: "" };
        try {
          body = JSON.parse(data || "{}");
        } catch {
          res.statusCode = 400;
          res.end("{}");
          return;
        }
        handler(body, res);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        requestCount: () => requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function healthyJsonRpc(res: import("node:http").ServerResponse, body: { id: number }): void {
  res.setHeader("Content-Type", "application/json");
  // decimals() → uint8, ABI-encoded as one 32-byte word.
  res.end(JSON.stringify({
    jsonrpc: "2.0",
    id: body.id,
    result: "0x" + 6n.toString(16).padStart(64, "0"),
  }));
}

function rateLimited(res: import("node:http").ServerResponse): void {
  res.statusCode = 429;
  res.end("rate limited");
}

const DEAD_PORT_1 = "http://127.0.0.1:1"; // nothing listens → instant ECONNREFUSED
const DEAD_PORT_2 = "http://127.0.0.1:2";

afterEach(() => {
  resetBaseRpcProbeForTests();
  vi.unstubAllEnvs();
});

describe("Base RPC fallback transport", () => {
  it("orders providers: configured server URL first, then browser URL, then public defaults, deduped", () => {
    vi.stubEnv("BASE_RPC_URL", "  https://rpc.example.internal  ");
    vi.stubEnv("NEXT_PUBLIC_BASE_RPC_URL", "https://mainnet.base.org");
    expect(rpcUrls()).toEqual([
      "https://rpc.example.internal",
      "https://mainnet.base.org",
      "https://base-rpc.publicnode.com",
    ]);
  });

  it("falls through to the next provider when the first is unreachable", async () => {
    const healthy = await startRpcServer((body, res) => healthyJsonRpc(res, body));
    try {
      const client = createBaseRpcClient([DEAD_PORT_1, healthy.url]);
      const decimals = await client.readContract({ address: TOKEN, abi: erc20Abi, functionName: "decimals" });
      expect(decimals).toBe(6);
      expect(healthy.requestCount()).toBeGreaterThanOrEqual(1);
    } finally {
      await healthy.close();
    }
  });

  it("does NOT fail a read while one provider is rate-limited and another is healthy", async () => {
    const limited = await startRpcServer((_body, res) => rateLimited(res));
    const healthy = await startRpcServer((body, res) => healthyJsonRpc(res, body));
    try {
      const client = createBaseRpcClient([limited.url, healthy.url]);
      const decimals = await client.readContract({ address: TOKEN, abi: erc20Abi, functionName: "decimals" });
      expect(decimals).toBe(6);
      expect(limited.requestCount()).toBeGreaterThanOrEqual(1);
      expect(healthy.requestCount()).toBeGreaterThanOrEqual(1);
    } finally {
      await limited.close();
      await healthy.close();
    }
  });

  it("recovers from a transient 429 on the only provider via bounded client retry", async () => {
    let calls = 0;
    const flaky = await startRpcServer((body, res) => {
      calls += 1;
      if (calls <= 2) rateLimited(res);
      else healthyJsonRpc(res, body);
    });
    try {
      const client = createBaseRpcClient([flaky.url]);
      const decimals = await client.readContract({ address: TOKEN, abi: erc20Abi, functionName: "decimals" });
      expect(decimals).toBe(6);
      expect(calls).toBe(3); // two 429s, then success — finite, no infinite retry
    } finally {
      await flaky.close();
    }
  });

  it("fails closed when every provider is unavailable, and diagnostics never leak paths or credentials", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const client = createBaseRpcClient([
        "http://user:pass@127.0.0.1:1/v3/SECRETKEY",
        "http://127.0.0.1:2/path/ALSO-SECRET",
      ]);
      await expect(
        client.readContract({ address: TOKEN, abi: erc20Abi, functionName: "decimals" }),
      ).rejects.toThrow();

      const health = describeBaseRpcHealth();
      expect(health).toContain("127.0.0.1:1");
      expect(health).toContain("network-error");
      // Sanitization: origin-only. No userinfo, no paths, no keys.
      expect(health).not.toContain("pass");
      expect(health).not.toContain("SECRETKEY");
      expect(health).not.toContain("ALSO-SECRET");

      // One sanitized auto-report identifies the failing transports.
      const reported = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(reported).toContain("[base-rpc] transport failure");
      expect(reported).not.toContain("pass");
      expect(reported).not.toContain("SECRETKEY");
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("B20 on-chain verification batching (multicall)", () => {
  function entry() {
    const found = findTokenizedStock("AAPLc");
    if (!found) throw new Error("AAPLc missing from catalog");
    return found;
  }

  function fakeClient(
    multicall: ReturnType<typeof vi.fn>,
    readContract?: ReturnType<typeof vi.fn>,
  ) {
    return { multicall, readContract } as unknown as Parameters<typeof readTokenizedStockOnchain>[1];
  }

  it("issues exactly ONE multicall round trip for token fields plus guarded feed reads, preserving per-field null semantics", async () => {
    const multicall = vi.fn(async ({ contracts }: { contracts: Array<{ functionName: string }> }) =>
      contracts.map((contract, index) => {
        if (contract.functionName === "decimals" && index === 2) {
          return { status: "failure" as const, error: new Error("reverted") };
        }
        switch (contract.functionName) {
          case "symbol":
            return { status: "success" as const, result: "AAPLc" };
          case "name":
            return { status: "success" as const, result: "Apple tokenized stock" };
          case "totalSupply":
            return { status: "success" as const, result: 1_000_000n };
          case "multiplier":
            return { status: "success" as const, result: 10n ** 18n };
          case "paused":
            return { status: "success" as const, result: false };
          default:
            return { status: "success" as const, result: 8 };
        }
      }),
    );
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "latestRoundData") {
        return [1n, 22_500_000_000n, 1n, 1_700_000_000n, 1n];
      }
      return 8; // aggregator decimals
    });

    const state = await readTokenizedStockOnchain(entry(), fakeClient(multicall, readContract));

    // token fields batched into one RPC round trip, not six
    expect(multicall).toHaveBeenCalledTimes(1);
    const batched = multicall.mock.calls[0][0].contracts as Array<{ functionName: string }>;
    expect(batched).toHaveLength(6);
    // feed reads happen only for the catalog's chainlink feed (guarded, not batched)
    expect(readContract).toHaveBeenCalledTimes(2);
    expect(state.symbol).toBe("AAPLc");
    expect(state.decimals).toBeNull(); // failed read → null (never guessed)
    expect(state.paused).toBe(false);
    expect(state.totalSupply).toBe("1000000");
    expect(state.multiplierWad).toBe("1000000000000000000");
    expect(state.chainlinkPriceUsd).toBe("225"); // formatUnits strips trailing zeros
    expect(state.chainlinkUpdatedAt).toBe(1_700_000_000);
  });

  it("skips feed reads entirely when the catalog entry has no chainlink feed (fail-closed nulls)", async () => {
    const multicall = vi.fn(async ({ contracts }: { contracts: Array<{ functionName: string }> }) =>
      contracts.map(() => ({ status: "success" as const, result: 8 })),
    );
    const readContract = vi.fn();
    const feedless = { ...entry(), chainlinkFeed: undefined } as ReturnType<typeof entry>;

    const state = await readTokenizedStockOnchain(feedless, fakeClient(multicall, readContract));

    expect(multicall).toHaveBeenCalledTimes(1);
    expect(readContract).not.toHaveBeenCalled(); // no feed → no reads
    expect(state.chainlinkPriceUsd).toBeNull();
    expect(state.chainlinkUpdatedAt).toBeNull();
  });

  it("returns all-null state (never a guess) when the whole multicall fails", async () => {
    const multicall = vi.fn(async () => {
      throw new Error("all transports down");
    });
    const state = await readTokenizedStockOnchain(entry(), fakeClient(multicall));
    expect(state.decimals).toBeNull();
    expect(state.symbol).toBeNull();
    expect(state.paused).toBeNull();
    expect(state.chainlinkPriceUsd).toBeNull();
  });

  it("still yields null decimals through the REAL transport stack when every provider is down", async () => {
    const state = await readTokenizedStockOnchain(entry(), createBaseRpcClient([DEAD_PORT_1, DEAD_PORT_2]));
    expect(state.decimals).toBeNull(); // quotes must refuse (fail-closed), never guess
  });
});

describe("executor chain reader (server RPC selection)", () => {
  it("with BASE_RPC_URL configured: a failing configured provider does NOT silently fall back", async () => {
    const configured = await startRpcServer((_body, res) => rateLimited(res));
    const healthy = await startRpcServer((body, res) => healthyJsonRpc(res, body));
    vi.stubEnv("BASE_RPC_URL", configured.url);
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", ((input: string | URL | Request, init?: RequestInit) =>
      realFetch(input, init)) as typeof fetch);
    try {
      const reader = createChainReader(8453);
      await expect(
        reader.readContract({ address: TOKEN, abi: erc20Abi, functionName: "decimals" } as never),
      ).rejects.toThrow();
      // Every request went to the CONFIGURED URL — never to the healthy one.
      expect(configured.requestCount()).toBeGreaterThanOrEqual(1);
      expect(healthy.requestCount()).toBe(0);
    } finally {
      await configured.close();
      await healthy.close();
    }
  });

  it("without BASE_RPC_URL: mainnet.base.org failure falls through to the second public endpoint", async () => {
    const limited = await startRpcServer((_body, res) => rateLimited(res));
    const healthy = await startRpcServer((body, res) => healthyJsonRpc(res, body));
    vi.stubEnv("BASE_RPC_URL", "");
    const realFetch = globalThis.fetch;
    // Redirect the hard-coded public hostnames to local mocks (no egress).
    vi.stubGlobal("fetch", ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://mainnet.base.org")) return realFetch(limited.url, init);
      if (url.startsWith("https://base-rpc.publicnode.com")) return realFetch(healthy.url, init);
      return realFetch(input as string, init);
    }) as typeof fetch);
    try {
      const reader = createChainReader(8453);
      const decimals = await reader.readContract({ address: TOKEN, abi: erc20Abi, functionName: "decimals" } as never);
      expect(decimals).toBe(6);
      expect(limited.requestCount()).toBeGreaterThanOrEqual(1);
      expect(healthy.requestCount()).toBeGreaterThanOrEqual(1);
    } finally {
      await limited.close();
      await healthy.close();
    }
  });
});
