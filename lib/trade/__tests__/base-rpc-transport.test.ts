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
  classifyBaseRpcFailure,
  createBaseRpcClient,
  describeBaseRpcHealth,
  getTradePublicClient,
  orderRpcUrlsForCall,
  readRpcErrorCode,
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

/** A capped plan's eth_getLogs refusal: HTTP 400 + a JSON-RPC error envelope. */
function cappedPlanRefusal(res: import("node:http").ServerResponse, body: { id: number }): void {
  res.statusCode = 400;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: body.id,
      error: {
        code: -32600,
        message:
          "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range based on your current plan. Upgrade to PAYG for expanded block range.",
      },
    }),
  );
}

const DEAD_PORT_1 = "http://127.0.0.1:1"; // nothing listens → instant ECONNREFUSED
const DEAD_PORT_2 = "http://127.0.0.1:2";

afterEach(() => {
  resetBaseRpcProbeForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Base RPC fallback transport", () => {
  it("orders providers: configured server URL first, then browser URL, then public defaults, deduped", () => {
    vi.stubEnv("BASE_RPC_URL", "  https://rpc.example.internal  ");
    vi.stubEnv("BASE_RPC_URLS", "https://rpc-b.example.internal, https://rpc.example.internal");
    vi.stubEnv("NEXT_PUBLIC_BASE_RPC_URL", "https://mainnet.base.org");
    expect(rpcUrls()).toEqual([
      "https://rpc.example.internal",
      "https://rpc-b.example.internal",
      "https://mainnet.base.org",
      "https://base-rpc.publicnode.com",
      "https://base.drpc.org",
      "https://base.meowrpc.com",
      "https://base.gateway.tenderly.co",
    ]);
  });

  it("round-robins configured RPC urls and keeps public endpoints as failover only", () => {
    vi.stubEnv("BASE_RPC_URL", "https://rpc-a.example.internal");
    vi.stubEnv("BASE_RPC_URLS", "https://rpc-b.example.internal");
    const pool = ["https://rpc-a.example.internal", "https://rpc-b.example.internal", "https://mainnet.base.org"];
    expect(orderRpcUrlsForCall(pool, "test-rotate")).toEqual(pool);
    expect(orderRpcUrlsForCall(pool, "test-rotate")).toEqual([
      "https://rpc-b.example.internal",
      "https://rpc-a.example.internal",
      "https://mainnet.base.org",
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

  it("records the JSON-RPC method and numeric error code of a failed response, and nothing else", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const capped = await startRpcServer((body, res) => cappedPlanRefusal(res, body));
    try {
      // The key lives in the URL PATH (providers commonly do this) — it must
      // never reach a log line.
      const client = createBaseRpcClient([`${capped.url}/v2/SECRETKEY-DO-NOT-LOG`]);

      await expect(client.getLogs({ address: TOKEN, fromBlock: 0n, toBlock: 1n })).rejects.toThrow();

      // viem does not retry on a 4xx (and -32600 is not a retryable code).
      expect(capped.requestCount()).toBe(1);

      const health = describeBaseRpcHealth();
      expect(health).toContain("→400");
      expect(health).toContain("eth_getLogs");
      expect(health).toContain("code=-32600");
      expect(health).not.toContain("SECRETKEY-DO-NOT-LOG");

      const reported = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(reported).toContain("[base-rpc] transport failure");
      expect(reported).toContain("eth_getLogs"); // method: a protocol constant
      expect(reported).toContain("code=-32600"); // numeric code only
      expect(reported).not.toContain("SECRETKEY-DO-NOT-LOG");
      expect(reported).not.toContain("/v2/"); // no path segments
      expect(reported).not.toContain("PAYG"); // and never provider wording
    } finally {
      await capped.close();
      errorSpy.mockRestore();
    }
  });

  it("chunked 400 (no Content-Length): the bounded read still records the code, and viem reads the original", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // No Content-Length is set, so Node uses transfer-encoding: chunked —
    // exactly the shape the old `response.clone().json()` path read unbounded.
    const capped = await startRpcServer((body, res) => {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.removeHeader("Content-Length");
      res.write(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32600, message: "capped" } }));
      res.end();
    });
    try {
      const client = createBaseRpcClient([capped.url]);

      // viem still parses the ORIGINAL response body: the mapped JSON-RPC
      // error code proves the body was neither consumed nor mutated.
      await expect(client.getLogs({ address: TOKEN, fromBlock: 0n, toBlock: 1n })).rejects.toMatchObject({
        code: -32600,
      });

      expect(describeBaseRpcHealth()).toContain("code=-32600");
    } finally {
      await capped.close();
      errorSpy.mockRestore();
    }
  });
});

// Review finding: readRpcErrorCode() used response.clone().json(), which reads
// the whole body when Content-Length is missing or unreliable. These tests pin
// the strictly bounded replacement: at most PROBE_MAX_ERROR_BODY_BYTES (8 KiB)
// is ever buffered, the read is cancelled beyond that, the original response
// stays readable, and only an integer can come out.
describe("sanitized RPC error diagnostics (strictly bounded body reads)", () => {
  const MAX = 8_192; // PROBE_MAX_ERROR_BODY_BYTES
  const encoder = new TextEncoder();
  const PROVIDER_WORDING =
    "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. Upgrade to PAYG.";

  const envelope = (code: unknown, message = PROVIDER_WORDING) =>
    JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message } });

  function jsonResponse(body: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
    return new Response(body, { status: 400, headers: { "Content-Type": "application/json", ...headers } });
  }

  function streamOf(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });
  }

  /**
   * Resolves as soon as `promise` settles, or reports `settled: false` at the
   * deadline. Used to assert PROMPTNESS: a promise that never settles (the
   * tee-cancel hang this suite guards against) must fail the test instead of
   * hanging the run until the vitest timeout.
   */
  async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<{ settled: boolean; value?: T }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<{ settled: boolean; value?: T }>((resolve) => {
      timer = setTimeout(() => resolve({ settled: false }), ms);
    });
    try {
      return await Promise.race([promise.then((value) => ({ settled: true, value })), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  it("missing Content-Length: the body is read through the bounded path and the code is returned", async () => {
    const res = jsonResponse(streamOf(envelope(-32600)));
    expect(res.headers.get("Content-Length")).toBeNull(); // precondition

    const code = await readRpcErrorCode(res);
    expect(code).toBe(-32600);
    expect(typeof code).toBe("number"); // no wording, URL, or params can ride along
  });

  it("invalid Content-Length is not trusted, and the read is still capped at the limit", async () => {
    // Non-numeric: the old Number() guard evaluated to NaN and read freely.
    const bogus = jsonResponse(envelope(-32600), { "Content-Length": "not-a-number" });
    await expect(readRpcErrorCode(bogus)).resolves.toBe(-32600);

    // Absurdly long / out-of-range: unusable, so again the bounded path decides.
    const hugeHeader = jsonResponse(envelope(-32600), { "Content-Length": "99999999999999999999" });
    await expect(readRpcErrorCode(hugeHeader)).resolves.toBe(-32600);

    // Invalid header AND an oversized body: the bound still wins.
    const oversized = jsonResponse(streamOf("x".repeat(MAX * 3)), { "Content-Length": "abc" });
    await expect(readRpcErrorCode(oversized)).resolves.toBeNull();
  });

  it("declared size above the limit: the body is never read at all", async () => {
    const res = jsonResponse(envelope(-32600), { "Content-Length": String(MAX + 1) });

    await expect(readRpcErrorCode(res)).resolves.toBeNull();
    // Never touched: the original still yields its full content.
    expect(await res.text()).toBe(envelope(-32600));
  });

  it("oversized body with NO Content-Length: stops at the limit, cancels, and returns null", async () => {
    const body = "x".repeat(MAX * 3);
    const res = jsonResponse(streamOf(body));
    expect(res.headers.get("Content-Length")).toBeNull(); // precondition

    await expect(readRpcErrorCode(res)).resolves.toBeNull();
    // Cancelling the clone's branch left the original fully readable — the
    // property viem depends on.
    expect(await res.text()).toBe(body);
  });

  it("malformed JSON and body-read failures return null (never throw)", async () => {
    await expect(readRpcErrorCode(jsonResponse('{"jsonrpc":"2.0","error":{"code":'))).resolves.toBeNull();
    await expect(readRpcErrorCode(jsonResponse(""))).resolves.toBeNull();

    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"error":{"code":-32600}}'));
        controller.error(new Error("stream failed"));
      },
    });
    await expect(readRpcErrorCode(jsonResponse(failing))).resolves.toBeNull();
  });

  it("unexpected shapes and non-integer codes return null", async () => {
    await expect(readRpcErrorCode(jsonResponse(JSON.stringify({ result: "0x1" })))).resolves.toBeNull();
    await expect(readRpcErrorCode(jsonResponse(JSON.stringify([])))).resolves.toBeNull();
    await expect(readRpcErrorCode(jsonResponse(JSON.stringify({ error: { code: "-32600" } })))).resolves.toBeNull();
    await expect(readRpcErrorCode(jsonResponse(JSON.stringify({ error: { code: 1.5 } })))).resolves.toBeNull();
    await expect(readRpcErrorCode(jsonResponse(JSON.stringify({ error: null })))).resolves.toBeNull();
    // The documented top-level-code shape still works.
    await expect(readRpcErrorCode(jsonResponse(JSON.stringify({ code: -32000 })))).resolves.toBe(-32000);
  });

  it("non-JSON content type is never read, whatever the body contains", async () => {
    const res = new Response(envelope(-32600), { status: 400, headers: { "Content-Type": "text/plain" } });
    await expect(readRpcErrorCode(res)).resolves.toBeNull();
    expect(await res.text()).toBe(envelope(-32600)); // untouched
  });

  it("oversized body from a genuinely OPEN stream: settles promptly with null without waiting on the tee", async () => {
    // Regression: response.clone() TEES the body, and a teed branch's
    // cancel() promise only settles once BOTH branches cancel — viem's branch
    // never does. The pre-fix code awaited reader.cancel() on the over-limit
    // path, so this input left readRpcErrorCode() pending forever and turned
    // a provider error into a 12 s transport timeout downstream.
    //
    // The source here stays OPEN on purpose: it delivers far more than the
    // limit and never calls controller.close(), exactly like a provider
    // socket that still has bytes to send. That is the shape the existing
    // closed-stream fixtures could not reach.
    const payload = encoder.encode(
      '{"jsonrpc":"2.0","error":{"code":-32600,"message":"' + "x".repeat(100_000) + '"}}',
    );
    let delivered = 0;
    const openSource = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (delivered >= payload.byteLength) return; // stays OPEN — never closed
        const chunkSize = 1_000;
        const chunk = payload.subarray(delivered, Math.min(delivered + chunkSize, payload.byteLength));
        delivered += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const res = new Response(openSource, { status: 400, headers: { "Content-Type": "application/json" } });
    expect(res.headers.get("Content-Length")).toBeNull(); // precondition: unbounded header

    const outcome = await settleWithin(readRpcErrorCode(res), 2_000);

    // The finding: this MUST settle quickly. Pre-fix it never settled at all.
    expect(outcome.settled).toBe(true);
    expect(outcome.value).toBeNull(); // over the limit -> no code, never a throw
    // The 8 KiB ceiling on what WE buffer is unchanged: reading stopped after
    // ~9-11 chunks instead of draining 100 kB. A few chunks of read-ahead are
    // pulled by the stream/tee machinery before we stop (out of our control,
    // and independent of the ceiling — the retained buffer never exceeds MAX).
    expect(delivered).toBeLessThanOrEqual(MAX + 4_000);
    expect(delivered).toBeLessThan(payload.byteLength / 4); // nowhere near draining
  });

  it("the same open-stream shape still leaves the original response usable by the RPC client", async () => {
    // Bound + reachability together: our inspection stops at the limit, and
    // the bytes viem needs are still there on the original branch. The source
    // is closed here only so the assertion can read the full body.
    const body = JSON.stringify({ jsonrpc: "2.0", error: { code: -32005, message: "y".repeat(50_000) } });
    const res = new Response(streamOf(body), { status: 400, headers: { "Content-Type": "application/json" } });

    const outcome = await settleWithin(readRpcErrorCode(res), 2_000);
    expect(outcome.settled).toBe(true);
    expect(outcome.value).toBeNull(); // 50 kB > 8 KiB

    // viem's read is intact: the full original body is still available.
    expect(await res.text()).toBe(body);
  });

  it("the original response stays readable by the RPC client after inspection", async () => {
    const res = jsonResponse(envelope(-32600));
    expect(await readRpcErrorCode(res)).toBe(-32600);
    // The full envelope is still there for viem to parse.
    const parsed = (await res.json()) as { error: { code: number; message: string } };
    expect(parsed.error.code).toBe(-32600);
    expect(parsed.error.message).toBe(PROVIDER_WORDING);
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
    let configuredRpc = 0;
    let healthyRpc = 0;
    const configured = await startRpcServer((body, res) => {
      if (body.method) configuredRpc += 1;
      rateLimited(res);
    });
    const healthy = await startRpcServer((body, res) => {
      if (body.method) healthyRpc += 1;
      healthyJsonRpc(res, body);
    });
    vi.stubEnv("BASE_RPC_URL", configured.url);
    vi.stubEnv("BASE_RPC_URLS", "");
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", ((input: string | URL | Request, init?: RequestInit) =>
      realFetch(input, init)) as typeof fetch);
    try {
      const reader = createChainReader(8453);
      await expect(
        reader.readContract({ address: TOKEN, abi: erc20Abi, functionName: "decimals" } as never),
      ).rejects.toThrow();
      // Every JSON-RPC call went to the CONFIGURED URL — never to the healthy one.
      // Empty non-RPC probes (no method) are ignored so a local port scan cannot
      // look like a fallback.
      expect(configuredRpc).toBeGreaterThanOrEqual(1);
      expect(healthyRpc).toBe(0);
    } finally {
      await configured.close();
      await healthy.close();
    }
  });

  it("without BASE_RPC_URL: mainnet.base.org failure falls through to the second public endpoint", async () => {
    const limited = await startRpcServer((_body, res) => rateLimited(res));
    const healthy = await startRpcServer((body, res) => healthyJsonRpc(res, body));
    vi.stubEnv("BASE_RPC_URL", "");
    vi.stubEnv("BASE_RPC_URLS", "");
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

describe("RPC failure classification and deterministic non-retryable handling", () => {
  it("classifies HTTP 400/-32600/-32602/range-cap, HTTP 401/403, HTTP 429, 5xx, timeout, and network errors distinctly", () => {
    expect(
      classifyBaseRpcFailure({
        status: 400,
        code: -32600,
        message: "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.",
      }),
    ).toBe("invalid_request");
    expect(classifyBaseRpcFailure({ code: -32602, message: "invalid params" })).toBe("invalid_request");
    expect(classifyBaseRpcFailure({
      code: -32602,
      message: "Invalid parameters were provided to the RPC method. Details: Archive requests require a personal token.",
    })).toBe("server_error");
    expect(classifyBaseRpcFailure({ status: 413, message: "response size exceeded" })).toBe("invalid_request");
    expect(
      classifyBaseRpcFailure({
        code: -32005,
        message: "eth_getLogs block range is too large, max block range is 2000",
      }),
    ).toBe("invalid_request");
    expect(classifyBaseRpcFailure({ status: 403, message: "Forbidden" })).toBe("forbidden");
    expect(classifyBaseRpcFailure({ status: 401, message: "Unauthorized" })).toBe("forbidden");
    expect(classifyBaseRpcFailure({ status: 429, code: -32016, message: "Too Many Requests" })).toBe("rate_limited");
    expect(classifyBaseRpcFailure({ status: 503, message: "Service Unavailable" })).toBe("server_error");
    expect(classifyBaseRpcFailure({ status: 400, message: "HTTP request failed." })).toBe("server_error");
    expect(classifyBaseRpcFailure({ status: 422, message: "Bad gateway filter" })).toBe("server_error");
    expect(classifyBaseRpcFailure({ status: 400, message: "execution reverted: STF" })).toBe("invalid_request");
    expect(classifyBaseRpcFailure({
      status: 400,
      code: -32602,
      message: "Missing or invalid parameters. The method eth_getLogs is not supported.",
    })).toBe("server_error");
    expect(classifyBaseRpcFailure({ name: "TimeoutError", message: "The request took too long" })).toBe("timeout");
    expect(classifyBaseRpcFailure({ name: "HttpRequestError", message: "fetch failed: ECONNREFUSED" })).toBe(
      "network_error",
    );
  });

  it("does NOT mask a primary provider's Free-tier 10-block eth_getLogs refusal behind fallback providers", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const primaryCapped = await startRpcServer((body, res) => cappedPlanRefusal(res, body));
    const secondaryRange = await startRpcServer((body, res) => {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32005, message: "block range is too large" },
        }),
      );
    });
    try {
      const client = createBaseRpcClient([primaryCapped.url, secondaryRange.url]);
      await expect(
        client.getLogs({ address: TOKEN, fromBlock: 0n, toBlock: 500_000n }),
      ).rejects.toThrow(/10 block range/i);

      // Stops immediately on the primary's deterministic -32600 refusal:
      // 1 request to primary, 0 to secondary, 0 retries.
      expect(primaryCapped.requestCount()).toBe(1);
      expect(secondaryRange.requestCount()).toBe(0);
    } finally {
      await primaryCapped.close();
      await secondaryRange.close();
      errorSpy.mockRestore();
    }
  });

  it("falls over once on HTTP 403 to a healthy fallback, and does NOT retry when all providers return 403", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const forbidden = await startRpcServer((_body, res) => {
      res.statusCode = 403;
      res.end("forbidden");
    });
    const healthy = await startRpcServer((body, res) => healthyJsonRpc(res, body));
    try {
      const withFallback = createBaseRpcClient([forbidden.url, healthy.url]);
      const decimals = await withFallback.readContract({
        address: TOKEN,
        abi: erc20Abi,
        functionName: "decimals",
      });
      expect(decimals).toBe(6);
      expect(forbidden.requestCount()).toBe(1);
      expect(healthy.requestCount()).toBe(1);

      const forbiddenOnly = await startRpcServer((_body, res) => {
        res.statusCode = 403;
        res.end("forbidden");
      });
      try {
        const singleClient = createBaseRpcClient([forbiddenOnly.url]);
        await expect(
          singleClient.readContract({ address: TOKEN, abi: erc20Abi, functionName: "decimals" }),
        ).rejects.toThrow();
        expect(forbiddenOnly.requestCount()).toBe(1);
      } finally {
        await forbiddenOnly.close();
      }
    } finally {
      await forbidden.close();
      await healthy.close();
      errorSpy.mockRestore();
    }
  });

  it("caches getTradePublicClient() per resolved URL list and refreshes when env changes", () => {
    vi.stubEnv("BASE_RPC_URL", "https://rpc-a.example.internal");
    const first = getTradePublicClient();
    const second = getTradePublicClient();
    expect(second).toBe(first);

    vi.stubEnv("BASE_RPC_URL", "https://rpc-b.example.internal");
    const third = getTradePublicClient();
    expect(third).not.toBe(first);
  });
});
