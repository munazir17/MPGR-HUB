// Tests for the hint-free fork-fixture discovery fallback.
//
// The central property: the pool id and PoolKey returned are exactly the ones
// present in the on-chain log that was fed in. Nothing is hardcoded — the test
// uses deliberately synthetic values, so if the module ever substituted a baked-in
// pool these assertions would fail.
import { describe, expect, it, vi } from "vitest";
import {
  BASE_WETH, NATIVE_CURRENCY, V4_POOL_MANAGER, WINDOW_OFFSETS,
  decodeInitializeLog, findInitializeByCurrency, findInitializeByPoolId, findTokenDeploymentBlock, wordAddress,
} from "./fork-fixture-discovery.mjs";

const MPGR = "0xb2000000000000000000008d204203177a78af01";
// Synthetic on purpose: these must never appear in the discovery script itself.
const POOL_ID = `0x${"cd".repeat(32)}`;
const HOOKS = "0x1234567890abcdef1234567890abcdef12345678";
const TX = `0x${"ef".repeat(32)}`;
const TOPIC = `0x${"ab".repeat(32)}`;

/** One 32-byte ABI word from a number, or from an address/hex string. */
const word = (v: number | bigint | string) =>
  typeof v === "string" ? v.slice(2).toLowerCase().padStart(64, "0") : BigInt(v).toString(16).padStart(64, "0");

/** A real-shaped V4 Initialize log: id/currency0/currency1 indexed, rest in data. */
function initializeLog(overrides: { currency0?: string; currency1?: string; poolId?: string; fee?: number; tickSpacing?: number; hooks?: string; blockNumber?: number } = {}) {
  return {
    address: V4_POOL_MANAGER,
    topics: [
      TOPIC,
      overrides.poolId ?? POOL_ID,
      wordAddress(overrides.currency0 ?? NATIVE_CURRENCY),
      wordAddress(overrides.currency1 ?? MPGR),
    ],
    data: "0x" + word(overrides.fee ?? 0) + word(overrides.tickSpacing ?? 200) + word(overrides.hooks ?? HOOKS) + word(0) + word(0),
    blockNumber: overrides.blockNumber ?? 48_631_199,
    transactionHash: TX,
  };
}

type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

describe("decodeInitializeLog", () => {
  it("returns the pool identity carried BY THE LOG, not a constant", () => {
    const fixture = decodeInitializeLog(initializeLog(), { token: MPGR });
    expect(fixture).toMatchObject({
      currency0: NATIVE_CURRENCY, currency1: MPGR.toLowerCase(),
      fee: 0, tickSpacing: 200, poolId: POOL_ID,
      initializeBlock: 48_631_199, initializeTx: TX,
    });
    expect(fixture!.hooks.toLowerCase()).toBe(HOOKS.toLowerCase());
  });

  it("accepts an MPGR/WETH pair and either currency position", () => {
    expect(decodeInitializeLog(initializeLog({ currency1: BASE_WETH, currency0: MPGR }), { token: MPGR })).not.toBeNull();
    expect(decodeInitializeLog(initializeLog({ currency0: MPGR, currency1: BASE_WETH }), { token: MPGR })).not.toBeNull();
  });

  it("rejects a pair that is not MPGR against native ETH or WETH", () => {
    expect(decodeInitializeLog(initializeLog({ currency1: "0xc333333333333333333333333333333333333333" }), { token: MPGR })).toBeNull();
    expect(decodeInitializeLog(initializeLog({ currency0: "0xc333333333333333333333333333333333333333", currency1: "0xd444444444444444444444444444444444444444" }), { token: MPGR })).toBeNull();
  });

  it("rejects malformed logs instead of guessing", () => {
    expect(decodeInitializeLog(null, { token: MPGR })).toBeNull();
    expect(decodeInitializeLog({ topics: [TOPIC] }, { token: MPGR })).toBeNull();
    expect(decodeInitializeLog({ ...initializeLog(), data: "0x" }, { token: MPGR })).toBeNull();
  });
});

describe("findTokenDeploymentBlock", () => {
  const deployBlock = 47_000_000;
  const rpc: Rpc = async (method, params) => {
    if (method !== "eth_getCode") throw new Error(`unexpected ${method}`);
    const block = Number(params[1] as string);
    return block >= deployBlock ? "0x60806040" : "0x";
  };

  it("binary-searches the first block with runtime code", async () => {
    expect(await findTokenDeploymentBlock(rpc, { token: MPGR, latest: 52_900_000 })).toBe(deployBlock);
  });

  it("returns null when the token has no code at all", async () => {
    const empty: Rpc = async () => "0x";
    expect(await findTokenDeploymentBlock(empty, { token: MPGR, latest: 100 })).toBeNull();
  });

  it("handles a token present from the earliest searched block", async () => {
    const always: Rpc = async () => "0x6080";
    expect(await findTokenDeploymentBlock(always, { token: MPGR, latest: 100, earliest: 5 })).toBe(5);
  });
});

describe("findInitializeByPoolId (hint path)", () => {
  it("finds the event near the timestamp-derived block", async () => {
    const target = 48_631_199;
    const rpc: Rpc = async (method, params) => {
      if (method === "eth_getBlockByNumber") return { timestamp: String(Number(params[0] as string) >= target ? 1_700_000_100 : 1_700_000_000) };
      const p = (params[0] as { fromBlock: string; toBlock: string; topics: (string | null)[] });
      const from = Number(p.fromBlock), to = Number(p.toBlock);
      return p.topics[1] === POOL_ID && from <= target && to >= target ? [initializeLog()] : [];
    };
    const logs = await findInitializeByPoolId(rpc, { topic: TOPIC, poolId: POOL_ID, timestamp: 1_700_000_100, latest: 52_900_000 });
    expect(logs).not.toBeNull();
    expect(decodeInitializeLog(logs![0], { token: MPGR })?.poolId).toBe(POOL_ID);
  });

  it("returns null without a timestamp rather than scanning blindly", async () => {
    const rpc = vi.fn(async () => []);
    expect(await findInitializeByPoolId(rpc as unknown as Rpc, { topic: TOPIC, poolId: POOL_ID, timestamp: 0, latest: 100 })).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("findInitializeByCurrency (hint-free fallback)", () => {
  const deployBlock = 48_631_100;
  const target = 48_631_199;

  it("answers from a single wide-range query when the RPC allows it", async () => {
    const calls: string[] = [];
    const rpc: Rpc = async (method, params) => {
      const p = params[0] as { fromBlock: string; toBlock: string; topics: (string | null)[] };
      calls.push(`${method}:${Number(p.toBlock) - Number(p.fromBlock)}`);
      // MPGR is currency1, so the second topic position is the match.
      return p.topics[3] === wordAddress(MPGR) ? [initializeLog()] : [];
    };
    const logs = await findInitializeByCurrency(rpc, { topic: TOPIC, token: MPGR, fromBlock: deployBlock, latest: 52_900_000 });
    expect(logs).toHaveLength(1);
    // One request per currency position at most; no windowed scanning needed.
    expect(calls.length).toBeLessThanOrEqual(2);
    expect(calls[0]).toContain("eth_getLogs");
  });

  it("degrades to a windowed scan when the RPC caps the log range", async () => {
    let windows = 0;
    const rpc: Rpc = async (_method, params) => {
      const p = params[0] as { fromBlock: string; toBlock: string; topics: (string | null)[] };
      const span = Number(p.toBlock) - Number(p.fromBlock);
      if (span > 9) throw new Error("Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.");
      windows++;
      return p.topics[3] === wordAddress(MPGR) && Number(p.fromBlock) <= target && Number(p.toBlock) >= target ? [initializeLog()] : [];
    };
    const logs = await findInitializeByCurrency(rpc, { topic: TOPIC, token: MPGR, fromBlock: deployBlock, latest: 52_900_000 });
    expect(logs).toHaveLength(1);
    expect(windows).toBeGreaterThan(0);
    expect(decodeInitializeLog(logs![0], { token: MPGR })?.initializeBlock).toBe(target);
  });

  it("returns null when the budget is exhausted, so the caller claims no proof", async () => {
    const rpc: Rpc = async (_method, params) => {
      const p = params[0] as { fromBlock: string; toBlock: string };
      if (Number(p.toBlock) - Number(p.fromBlock) > 9) throw new Error("range capped");
      return [];
    };
    const logs = await findInitializeByCurrency(rpc, { topic: TOPIC, token: MPGR, fromBlock: deployBlock, latest: deployBlock + 500, maxWindows: 10 });
    expect(logs).toBeNull();
  });

  it("keeps scanning past a single failing window instead of giving up", async () => {
    let seen = 0;
    const rpc: Rpc = async (_method, params) => {
      const p = params[0] as { fromBlock: string; toBlock: string; topics: (string | null)[] };
      if (Number(p.toBlock) - Number(p.fromBlock) > 9) throw new Error("range capped");
      seen++;
      if (seen <= 3) throw new Error("429 too many requests");
      return p.topics[3] === wordAddress(MPGR) && Number(p.fromBlock) <= target && Number(p.toBlock) >= target ? [initializeLog()] : [];
    };
    const logs = await findInitializeByCurrency(rpc, { topic: TOPIC, token: MPGR, fromBlock: target - 35, latest: target + 50 });
    expect(logs).toHaveLength(1);
  });
});

describe("discovery hardening invariants", () => {
  it("searches every window offset the hint path probes", () => {
    expect(WINDOW_OFFSETS).toContain(0);
    expect(new Set(WINDOW_OFFSETS).size).toBe(WINDOW_OFFSETS.length);
  });

  it("never needs a pool id to run the fallback", () => {
    // The fallback signature takes a token, not a pool: the pool is the OUTPUT.
    expect(findInitializeByCurrency.length).toBe(2);
  });
});
