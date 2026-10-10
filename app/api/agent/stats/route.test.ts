import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpRequestError, RpcRequestError, TimeoutError } from "viem";

import { LuaRedis } from "@/lib/__tests__/helpers/lua-redis";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT, BASE_MAINNET_USDC } from "@/lib/executor/executor-config";
import { VERIFIED_HISTORICAL_AGENT_TRADES } from "@/lib/agent/agent-volume-history";

// Executes the route's real Lua (lease compare-and-delete) with expiry driven by
// redis.advance(ms). Atomicity itself is a property of Redis, not of this test
// double; the double proves the script's compare-and-delete logic.
const redis = new LuaRedis();

const h = vi.hoisted(() => ({
  client: { getBlockNumber: vi.fn(), getLogs: vi.fn() },
}));

vi.mock("@/lib/api/redis", () => ({ getRedis: () => redis.client() }));
vi.mock("@/lib/trade/trade-public-client", () => ({ getTradePublicClient: () => h.client }));

const DEPLOY = BigInt(BASE_MAINNET_EXECUTOR_DEPLOYMENT.deployBlock);
const SECRET_URL = "https://rpc-provider.example/v2/SUPERSECRETKEY-123";
const CACHE_KEY = "mpgr:agent:stats:v2";
const NEGATIVE_KEY = "mpgr:agent:stats:unavailable:v1";
const LOCK_KEY = "mpgr:agent:stats:lock:v1";
const HISTORICAL_COUNT = VERIFIED_HISTORICAL_AGENT_TRADES.length;
const HISTORICAL_USD = VERIFIED_HISTORICAL_AGENT_TRADES.reduce((sum, t) => sum + t.usdcAtomic, 0n);

const SEC = 1_000;

function httpError(status: number, details = "") {
  return new HttpRequestError({ url: SECRET_URL, status, body: undefined, headers: undefined, details, cause: undefined });
}

function rpcError(code: number, message: string) {
  return new RpcRequestError({ url: SECRET_URL, body: { method: "eth_getLogs" }, error: { code, message } });
}

/** A wrapper error the way callers around viem sometimes re-throw. */
function wrapped(message: string, cause: unknown) {
  return Object.assign(new Error(message), { cause });
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

async function readLockToken(): Promise<string | null> {
  return (await redis.client().get<string>(LOCK_KEY)) ?? null;
}

/** Yields to the event loop until `cond` holds (bounded). */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i += 1) {
    await new Promise((r) => setImmediate(r));
  }
  if (!cond()) throw new Error("condition not reached");
}

/**
 * Loads a fresh copy of the route module. Each copy has its own in-process
 * single-flight slot, so two copies model two serverless instances sharing Redis.
 */
async function freshRoute(): Promise<() => Promise<Response>> {
  vi.resetModules();
  const mod = await import("./route");
  return mod.GET as () => Promise<Response>;
}

describe("GET /api/agent/stats", () => {
  let GET: () => Promise<Response>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    redis.reset();
    h.client.getLogs.mockReset();
    h.client.getBlockNumber.mockReset();
    h.client.getBlockNumber.mockResolvedValue(DEPLOY + 100n);
    h.client.getLogs.mockResolvedValue([]);
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    GET = await freshRoute();
  });

  afterEach(() => {
    vi.useRealTimers();
    warn.mockRestore();
  });

  // ---------------------------------------------------------------- success / positive cache

  it("success: sums live USDC swaps, merges verified history, caches positively", async () => {
    h.client.getLogs.mockResolvedValueOnce([usdcSwapLog(usdcSwapHash(1), 2_000_000n)]);

    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=60");
    const body = await res.json();
    expect(body.available).toBe(true);
    expect(body.tradeCount).toBe(1 + HISTORICAL_COUNT);
    expect(body.totalValueTradedUsd).toBeCloseTo(Number(2_000_000n + HISTORICAL_USD) / 1_000_000, 6);
    expect(await redis.client().get(CACHE_KEY)).toBeTruthy();

    const callsBefore = h.client.getLogs.mock.calls.length;
    const again = await (await GET()).json();
    expect(again.available).toBe(true);
    expect(h.client.getLogs.mock.calls.length).toBe(callsBefore);
  });

  it("positive cache expires after 60 s and the next request rescans", async () => {
    await GET();
    expect(h.client.getLogs).toHaveBeenCalledTimes(1);

    redis.advance(59 * SEC);
    await GET();
    expect(h.client.getLogs).toHaveBeenCalledTimes(1); // still cached

    redis.advance(2 * SEC);
    await GET();
    expect(h.client.getLogs).toHaveBeenCalledTimes(2); // expired -> rescan
  });

  // ---------------------------------------------------------------- HTTP / RPC outcomes + negative cache TTL

  it("429: unavailable (200, no-store), one request only (no range shrink), negative-cached 120 s", async () => {
    h.client.getLogs.mockRejectedValue(httpError(429, "Too Many Requests"));

    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ available: false, totalValueTradedUsd: null, tradeCount: null });
    expect(h.client.getLogs).toHaveBeenCalledTimes(1);
    expect(await redis.client().get(NEGATIVE_KEY)).toBeTruthy();

    // Negative TTL holds for 120 s: no RPC work during that window.
    redis.advance(119 * SEC);
    await GET();
    expect(h.client.getLogs).toHaveBeenCalledTimes(1);

    // After expiry the next request scans again.
    redis.advance(2 * SEC);
    await GET();
    expect(h.client.getLogs).toHaveBeenCalledTimes(2);

    const text = warnText(warn);
    expect(text).toContain("rate_limited");
    expect(text).toContain("429");
    expect(text).not.toContain("SUPERSECRETKEY");
    expect(text).not.toContain("rpc-provider.example");
  });

  it("403: unavailable, one request only, negative-cached 300 s", async () => {
    h.client.getLogs.mockRejectedValue(httpError(403, "Forbidden"));

    const res = await GET();
    expect(await res.json()).toMatchObject({ available: false });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(h.client.getLogs).toHaveBeenCalledTimes(1);

    redis.advance(299 * SEC);
    await GET();
    expect(h.client.getLogs).toHaveBeenCalledTimes(1);
    redis.advance(2 * SEC);
    await GET();
    expect(h.client.getLogs).toHaveBeenCalledTimes(2);

    const text = warnText(warn);
    expect(text).toContain("forbidden");
    expect(text).toContain("403");
    expect(text).not.toContain("SUPERSECRETKEY");
  });

  it("400 (not range wording): unavailable, one request only, negative-cached 300 s", async () => {
    h.client.getLogs.mockRejectedValue(httpError(400, "Bad Request"));

    const res = await GET();
    expect(await res.json()).toMatchObject({ available: false });
    expect(h.client.getLogs).toHaveBeenCalledTimes(1);
    expect(await redis.client().get(NEGATIVE_KEY)).toBeTruthy();
    expect(warnText(warn)).toContain("bad_request");
  });

  it("unexpected failure: unavailable, negative-cached 60 s, provider URL never leaks", async () => {
    h.client.getLogs.mockRejectedValue(new Error(`socket hang up at ${SECRET_URL}`));

    const res = await GET();
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ available: false });
    expect(text).not.toContain("SUPERSECRETKEY");
    expect(h.client.getLogs).toHaveBeenCalledTimes(1);

    redis.advance(59 * SEC);
    await GET();
    expect(h.client.getLogs).toHaveBeenCalledTimes(1);
    redis.advance(2 * SEC);
    await GET();
    expect(h.client.getLogs).toHaveBeenCalledTimes(2);

    const logged = warnText(warn);
    expect(logged).toContain("unexpected");
    expect(logged).not.toContain("SUPERSECRETKEY");
    expect(logged).not.toContain("rpc-provider.example");
  });

  // ---------------------------------------------------------------- range-size classification

  it("RPC-level range error (-32602 'block range too large') shrinks until every window fits", async () => {
    h.client.getBlockNumber.mockResolvedValue(DEPLOY + 39_999n);
    const accepted: bigint[] = [];
    h.client.getLogs.mockImplementation(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      const span = toBlock - fromBlock + 1n;
      if (span > 5_000n) throw rpcError(-32602, "block range is too large");
      accepted.push(span);
      return [];
    });

    const body = await (await GET()).json();
    expect(body.available).toBe(true);
    expect(body.tradeCount).toBe(HISTORICAL_COUNT);
    expect(accepted.every((span) => span <= 5_000n)).toBe(true);
    expect(accepted.reduce((a, b) => a + b, 0n)).toBe(40_000n);
  });

  it("HTTP 400 whose body carries range wording (in details) shrinks the window", async () => {
    h.client.getBlockNumber.mockResolvedValue(DEPLOY + 9_999n);
    const accepted: bigint[] = [];
    h.client.getLogs.mockImplementation(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      const span = toBlock - fromBlock + 1n;
      if (span > 2_000n) throw httpError(400, "query exceeded max block range");
      accepted.push(span);
      return [];
    });

    const body = await (await GET()).json();
    expect(body.available).toBe(true);
    expect(accepted.every((span) => span <= 2_000n)).toBe(true);
    expect(accepted.reduce((a, b) => a + b, 0n)).toBe(10_000n);
  });

  it("wrapped range error (cause chain) shrinks the window", async () => {
    h.client.getBlockNumber.mockResolvedValue(DEPLOY + 9_999n);
    const accepted: bigint[] = [];
    h.client.getLogs.mockImplementation(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      const span = toBlock - fromBlock + 1n;
      if (span > 4_000n) throw wrapped("getLogs failed", rpcError(-32005, "query returned more than 10000 results"));
      accepted.push(span);
      return [];
    });

    const body = await (await GET()).json();
    expect(body.available).toBe(true);
    expect(accepted.every((span) => span <= 4_000n)).toBe(true);
  });

  it("HTTP 429 whose message mentions a block range is rate-limited, never range-shrunk", async () => {
    h.client.getLogs.mockRejectedValue(wrapped("block range too large", httpError(429, "Too Many Requests")));

    expect(await (await GET()).json()).toMatchObject({ available: false });
    expect(h.client.getLogs).toHaveBeenCalledTimes(1);
    expect(await redis.client().get(NEGATIVE_KEY)).toBeTruthy();
    expect(warnText(warn)).toContain("rate_limited");
  });

  it("HTTP 403 whose message mentions a block range is forbidden, never range-shrunk", async () => {
    h.client.getLogs.mockRejectedValue(wrapped("block range too large", httpError(403, "block range too large")));

    expect(await (await GET()).json()).toMatchObject({ available: false });
    expect(h.client.getLogs).toHaveBeenCalledTimes(1);
    expect(warnText(warn)).toContain("forbidden");
  });

  it("HTTP 500 whose message mentions a block range is a generic failure, never range-shrunk", async () => {
    h.client.getLogs.mockRejectedValue(httpError(500, "block range too large"));

    expect(await (await GET()).json()).toMatchObject({ available: false });
    expect(h.client.getLogs).toHaveBeenCalledTimes(1);
    expect(warnText(warn)).toContain("unexpected");
  });

  it("RPC rate limit (-32005 'limit exceeded' with no range wording) is not range-shrunk", async () => {
    h.client.getLogs.mockRejectedValue(rpcError(-32005, "daily request limit exceeded"));

    expect(await (await GET()).json()).toMatchObject({ available: false });
    expect(h.client.getLogs).toHaveBeenCalledTimes(1);
    expect(warnText(warn)).toContain("rate_limited");
  });

  it("explicit rate-limit wording on a JSON-RPC envelope wins over range wording", async () => {
    h.client.getLogs.mockRejectedValue(rpcError(-32016, "rate limit reached: block range too large"));

    expect(await (await GET()).json()).toMatchObject({ available: false });
    expect(h.client.getLogs).toHaveBeenCalledTimes(1);
  });

  it("auth wording on a JSON-RPC envelope is labelled forbidden and never range-shrunk", async () => {
    h.client.getLogs.mockRejectedValue(rpcError(-32600, "invalid api key for block range query"));

    expect(await (await GET()).json()).toMatchObject({ available: false });
    expect(h.client.getLogs).toHaveBeenCalledTimes(1);
    expect(warnText(warn)).toContain("forbidden");
  });

  // ---------------------------------------------------------------- timeouts

  it("viem TimeoutError: unavailable, one request only, timeout negative-cached 60 s", async () => {
    h.client.getLogs.mockRejectedValue(new TimeoutError({ url: SECRET_URL, body: { method: "eth_getLogs" } }));

    expect(await (await GET()).json()).toMatchObject({ available: false });
    expect(h.client.getLogs).toHaveBeenCalledTimes(1);
    redis.advance(59 * SEC);
    await GET();
    expect(h.client.getLogs).toHaveBeenCalledTimes(1);
    redis.advance(2 * SEC);
    await GET();
    expect(h.client.getLogs).toHaveBeenCalledTimes(2);
  });

  it("a TimeoutError wrapped inside an HTTP 400 with range wording is a timeout, never range-shrunk", async () => {
    h.client.getLogs.mockRejectedValue(wrapped("block range too large", new TimeoutError({ url: SECRET_URL, body: { method: "eth_getLogs" } })));

    expect(await (await GET()).json()).toMatchObject({ available: false });
    expect(h.client.getLogs).toHaveBeenCalledTimes(1);
    expect(warnText(warn)).toContain("timeout");
  });

  it("hung provider: our bound fires after 30 s, unavailable, and the scan issues no further requests", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    h.client.getLogs.mockImplementation(() => new Promise(() => {})); // never settles

    const pending = GET();
    await vi.advanceTimersByTimeAsync(30_000);
    const res = await pending;

    expect(await res.json()).toMatchObject({ available: false });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(h.client.getLogs).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.client.getLogs).toHaveBeenCalledTimes(1);
  });

  it("slow primary that answers within the bound (e.g. after a 12 s transport timeout + fallback) succeeds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    h.client.getLogs.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve([usdcSwapLog(usdcSwapHash(3), 1_000_000n)]), 20_000)),
    );

    const pending = GET();
    await vi.advanceTimersByTimeAsync(20_000);
    const body = await (await pending).json();

    expect(body.available).toBe(true);
    expect(body.tradeCount).toBe(1 + HISTORICAL_COUNT);
  });

  // ---------------------------------------------------------------- single-flight & concurrency

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
    await until(() => h.client.getLogs.mock.calls.length >= 1);
    release();

    const bodies = await Promise.all([first, second, third].map(async (p) => (await p).json()));
    expect(h.client.getLogs).toHaveBeenCalledTimes(1);
    for (const body of bodies) expect(body.available).toBe(true);
  });

  it("a request on another instance during a held lease does not scan and writes no negative cache", async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => (releaseA = resolve));
    h.client.getLogs.mockImplementationOnce(async () => {
      await gateA;
      return [];
    });
    const instanceA = GET;
    const instanceB = await freshRoute();

    const pendingA = instanceA();
    await until(() => h.client.getLogs.mock.calls.length === 1);

    const resB = await instanceB();
    expect(await resB.json()).toMatchObject({ available: false });
    expect(h.client.getLogs).toHaveBeenCalledTimes(1);
    expect(await redis.client().get(NEGATIVE_KEY)).toBeNull();

    releaseA();
    expect(await (await pendingA).json()).toMatchObject({ available: true });
  });

  it("lease expiry and reacquisition: a held lease blocks scans until it expires, then the next request reacquires", async () => {
    await redis.client().set(LOCK_KEY, "other-instance-token", { ex: 60 });

    expect(await (await GET()).json()).toMatchObject({ available: false });
    expect(h.client.getLogs).not.toHaveBeenCalled();

    redis.advance(61 * SEC); // the other instance's lease has expired
    expect(await (await GET()).json()).toMatchObject({ available: true });
    expect(h.client.getLogs).toHaveBeenCalledTimes(1);
    // The lease this instance reacquired was released after the scan.
    expect(await readLockToken()).toBeNull();
  });

  it("an instance whose lease expired cannot delete a newer instance's lease (compare-and-delete)", async () => {
    const instanceA = GET;
    const instanceB = await freshRoute();

    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => (releaseA = resolve));
    let releaseB!: () => void;
    const gateB = new Promise<void>((resolve) => (releaseB = resolve));
    h.client.getLogs
      .mockImplementationOnce(async () => {
        await gateA;
        return [];
      })
      .mockImplementationOnce(async () => {
        await gateB;
        return [];
      });

    // A takes the lease and stalls mid-scan.
    const pendingA = instanceA();
    await until(() => h.client.getLogs.mock.calls.length === 1);
    const tokenA = await readLockToken();
    expect(tokenA).toBeTruthy();

    // A's lease expires while it is still scanning; B acquires a fresh lease.
    redis.advance(61 * SEC);
    const pendingB = instanceB();
    await until(() => h.client.getLogs.mock.calls.length === 2);
    const tokenB = await readLockToken();
    expect(tokenB).toBeTruthy();
    expect(tokenB).not.toBe(tokenA);

    // A finishes and tries to release. Its compare-and-delete must not touch B's lease.
    releaseA();
    expect(await (await pendingA).json()).toMatchObject({ available: true });
    expect(await readLockToken()).toBe(tokenB);

    // B still holds its lease until it finishes; then it releases its own.
    releaseB();
    expect(await (await pendingB).json()).toMatchObject({ available: true });
    expect(await readLockToken()).toBeNull();
  });

  it("releases its own lease after a failed scan so the next cold miss can run", async () => {
    h.client.getLogs.mockRejectedValue(httpError(429));
    await GET();
    expect(await readLockToken()).toBeNull();
  });

  it("a lease whose holder crashed expires on its own (60 s) and the lock is not stuck", async () => {
    await redis.client().set(LOCK_KEY, "crashed-instance", { ex: 60 });
    redis.advance(60 * SEC + 1);
    expect(await (await GET()).json()).toMatchObject({ available: true });
  });
});
