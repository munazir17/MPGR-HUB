import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcRequestError, HttpRequestError, TimeoutError } from "viem";

import { BASE_MAINNET_EXECUTOR_DEPLOYMENT, BASE_MAINNET_USDC } from "@/lib/executor/executor-config";
import { VERIFIED_HISTORICAL_AGENT_TRADES } from "@/lib/agent/agent-volume-history";

// In-memory Redis stand-in (get / set NX PX / del) shared by the route.
const h = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  const redis = {
    store,
    async get(key: string) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key: string, value: unknown, opts?: { nx?: boolean }) {
      if (opts?.nx && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    async del(key: string) {
      return store.delete(key) ? 1 : 0;
    },
  };
  const client = { getBlockNumber: vi.fn(), getLogs: vi.fn() };
  return { redis, client };
});

vi.mock("@/lib/api/redis", () => ({ getRedis: () => h.redis }));
vi.mock("@/lib/trade/trade-public-client", () => ({ getTradePublicClient: () => h.client }));

import { GET } from "./route";

const DEPLOY = BigInt(BASE_MAINNET_EXECUTOR_DEPLOYMENT.deployBlock);
const SECRET_URL = "https://rpc-provider.example/v2/SUPERSECRETKEY-123";
const CACHE_KEY = "mpgr:agent:stats:v2";
const NEGATIVE_KEY = "mpgr:agent:stats:unavailable:v1";
const LOCK_KEY = "mpgr:agent:stats:lock:v1";
const HISTORICAL_COUNT = VERIFIED_HISTORICAL_AGENT_TRADES.length;
const HISTORICAL_USD = VERIFIED_HISTORICAL_AGENT_TRADES.reduce((sum, t) => sum + t.usdcAtomic, 0n);

function httpError(status: number) {
  return new HttpRequestError({ url: SECRET_URL, status, body: undefined, headers: undefined, details: "", cause: undefined });
}

function rpcError(code: number, message: string) {
  return new RpcRequestError({ url: SECRET_URL, body: { method: "eth_getLogs" }, error: { code, message } });
}

function usdcSwapLog(hash: string, grossUsdcAtomic: bigint) {
  return {
    transactionHash: hash,
    args: {
      tokenIn: BASE_MAINNET_USDC,
      tokenOut: "0x0000000000000000000000000000000000000001",
      grossAmountIn: grossUsdcAtomic,
      amountOut: 1n,
    },
  };
}

function usdcSwapHash(n: number): string {
  return "0x" + n.toString(16).padStart(2, "0").repeat(32);
}

function warnText(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls
    .map((args: unknown[]) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
    .join("\n");
}

describe("GET /api/agent/stats", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    h.redis.store.clear();
    h.client.getLogs.mockReset();
    h.client.getBlockNumber.mockReset();
    h.client.getBlockNumber.mockResolvedValue(DEPLOY + 100n);
    h.client.getLogs.mockResolvedValue([]);
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    warn.mockRestore();
  });

  it("success: sums live USDC swaps, merges verified history, caches positively", async () => {
    h.client.getLogs.mockResolvedValueOnce([usdcSwapLog(usdcSwapHash(1), 2_000_000n)]);

    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=60");
    const body = await res.json();
    expect(body.available).toBe(true);
    expect(body.tradeCount).toBe(1 + HISTORICAL_COUNT);
    expect(body.totalValueTradedUsd).toBeCloseTo(Number(2_000_000n + HISTORICAL_USD) / 1_000_000, 6);
    expect(h.redis.store.get(CACHE_KEY)).toBeTruthy();

    // A second visitor within the TTL is served from cache: no new RPC work.
    const callsBefore = h.client.getLogs.mock.calls.length;
    const again = await (await GET()).json();
    expect(again.available).toBe(true);
    expect(h.client.getLogs.mock.calls.length).toBe(callsBefore);
  });

  it("429: unavailable (200, no-store), no range shrinking, negatively cached, sanitized log", async () => {
    h.client.getLogs.mockRejectedValue(httpError(429));

    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ available: false, totalValueTradedUsd: null, tradeCount: null });

    // One request only: a rate limit must not trigger range halving.
    expect(h.client.getLogs).toHaveBeenCalledTimes(1);
    expect(h.redis.store.get(NEGATIVE_KEY)).toBe("rate_limited");

    // Negative cache suppresses the next full scan.
    await GET();
    expect(h.client.getLogs).toHaveBeenCalledTimes(1);

    const text = warnText(warn);
    expect(text).toContain("rate_limited");
    expect(text).toContain("429");
    expect(text).not.toContain("SUPERSECRETKEY");
    expect(text).not.toContain("rpc-provider.example");
  });

  it("403: unavailable, no range shrinking, forbidden kind logged without URL", async () => {
    h.client.getLogs.mockRejectedValue(httpError(403));

    const res = await GET();
    expect(await res.json()).toMatchObject({ available: false });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(h.client.getLogs).toHaveBeenCalledTimes(1);
    expect(h.redis.store.get(NEGATIVE_KEY)).toBe("forbidden");

    const text = warnText(warn);
    expect(text).toContain("forbidden");
    expect(text).toContain("403");
    expect(text).not.toContain("SUPERSECRETKEY");
  });

  it("400 (not a range error): unavailable, no range shrinking", async () => {
    h.client.getLogs.mockRejectedValue(httpError(400));

    const res = await GET();
    expect(await res.json()).toMatchObject({ available: false });
    expect(h.client.getLogs).toHaveBeenCalledTimes(1);
    expect(h.redis.store.get(NEGATIVE_KEY)).toBe("bad_request");
    expect(warnText(warn)).toContain("bad_request");
  });

  it("400 range-size: confirmed limitation shrinks the window until every request fits", async () => {
    // Full span is 40_000 blocks; the provider only accepts <= 5_000-block windows.
    h.client.getBlockNumber.mockResolvedValue(DEPLOY + 39_999n);
    const accepted: bigint[] = [];
    h.client.getLogs.mockImplementation(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      const span = toBlock - fromBlock + 1n;
      if (span > 5_000n) throw rpcError(-32005, "query returned more than 10000 results; block range is too large");
      accepted.push(span);
      return [];
    });

    const res = await GET();
    const body = await res.json();
    expect(body.available).toBe(true);
    expect(body.tradeCount).toBe(HISTORICAL_COUNT);
    expect(accepted.length).toBeGreaterThan(0);
    expect(accepted.every((span) => span <= 5_000n)).toBe(true);
    // Shrinking covers the whole range: 40_000 blocks are fully accounted for.
    expect(accepted.reduce((a, b) => a + b, 0n)).toBe(40_000n);
  });

  it("transport timeout: unavailable, no range shrinking, timeout kind negatively cached", async () => {
    h.client.getLogs.mockRejectedValue(new TimeoutError({ url: SECRET_URL, body: { method: "eth_getLogs" } }));

    const res = await GET();
    expect(await res.json()).toMatchObject({ available: false });
    expect(h.client.getLogs).toHaveBeenCalledTimes(1);
    expect(h.redis.store.get(NEGATIVE_KEY)).toBe("timeout");
  });

  it("hung provider: our own bounded timer fires, unavailable as timeout", async () => {
    vi.useFakeTimers();
    h.client.getLogs.mockImplementation(() => new Promise(() => {})); // never settles

    const pending = GET();
    await vi.advanceTimersByTimeAsync(16_000);
    const res = await pending;

    expect(await res.json()).toMatchObject({ available: false });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(h.redis.store.get(NEGATIVE_KEY)).toBe("timeout");
  });

  it("unexpected failure: unavailable, logged as unexpected, provider URL never leaks", async () => {
    h.client.getLogs.mockRejectedValue(new Error(`socket hang up at ${SECRET_URL}`));

    const res = await GET();
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ available: false });
    expect(text).not.toContain("SUPERSECRETKEY");
    expect(h.redis.store.get(NEGATIVE_KEY)).toBe("unexpected");

    const logged = warnText(warn);
    expect(logged).toContain("unexpected");
    expect(logged).not.toContain("SUPERSECRETKEY");
    expect(logged).not.toContain("rpc-provider.example");
  });

  it("concurrent cold-cache requests on one instance share a single scan", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    h.client.getLogs.mockImplementation(async () => {
      await gate;
      return [usdcSwapLog(usdcSwapHash(2), 1_000_000n)];
    });

    const first = GET();
    const second = GET();
    const third = GET();
    // Let the in-process single-flight attach all three before the scan resolves.
    await new Promise((r) => setTimeout(r, 0));
    release();

    const bodies = await Promise.all([first, second, third].map(async (p) => (await p).json()));
    expect(h.client.getLogs).toHaveBeenCalledTimes(1);
    for (const body of bodies) expect(body.available).toBe(true);
  });

  it("another instance holds the lease: this request does not scan and does not poison the negative cache", async () => {
    h.redis.store.set(LOCK_KEY, "other-instance-token");

    const res = await GET();
    expect(await res.json()).toMatchObject({ available: false });
    expect(h.client.getLogs).not.toHaveBeenCalled();
    expect(h.redis.store.has(NEGATIVE_KEY)).toBe(false);
    // The other instance's lease is untouched.
    expect(h.redis.store.get(LOCK_KEY)).toBe("other-instance-token");
  });

  it("releases its own lease after a scan so the next cold miss can run", async () => {
    h.client.getLogs.mockRejectedValue(httpError(429));
    await GET();
    expect(h.redis.store.has(LOCK_KEY)).toBe(false);
  });
});
