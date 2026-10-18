import { beforeEach, describe, expect, it, vi } from "vitest";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT as d, BASE_MAINNET_UNISWAP_V3, BASE_MAINNET_SLIPSTREAM } from "@/lib/executor/executor-config";
import { qualifyRegisteredSwapRoute, selectRegisteredSwapRoute, verifyQualifiedSwapBlock, type SwapRouteReadClient } from "../swap-route-selection";
import { MANUAL_SWAP_TOKENS } from "@/lib/trade/manual-swap";
import { NATIVE_ETH_SENTINEL } from "@/lib/trade/trade-config";
const pool = "0x7777777777777777777777777777777777777777";
const hash = `0x${"ab".repeat(32)}` as const;
let route = d.routes[0];
const read = vi.fn(), code = vi.fn(), simulate = vi.fn(), balance = vi.fn();
let blockAge = 0;
const client = { getChainId: async () => 8453, getBlockNumber: async () => 100n,
  getBlock: async () => ({ number: 100n, hash, timestamp: BigInt(Math.floor((Date.now() - blockAge) / 1000)) }),
  readContract: read, getCode: code, simulateContract: simulate, getBalance: balance } as unknown as SwapRouteReadClient;
beforeEach(() => {
  vi.resetAllMocks(); route = d.routes[0]; blockAge = 0;
  code.mockResolvedValue("0x6000"); simulate.mockResolvedValue({ result: [99n] }); balance.mockResolvedValue(1000n);
  read.mockImplementation(async ({ address, functionName, args }) => {
    if (functionName === "isTokenAllowed") return true;
    if (functionName === "routerKind") return route.kind;
    if (functionName === "getPool") return pool;
    if (address === d.executor) return ({ owner: d.owner, feeBps: 25, feeRecipient: d.feeRecipient, paused: false, MAX_FEE_BPS: 100 } as Record<string, unknown>)[functionName];
    if (address === pool) return ({ factory: route.kind === 2 ? BASE_MAINNET_UNISWAP_V3.factory : BASE_MAINNET_SLIPSTREAM.factory, token0: route.tokenA, token1: route.tokenB, fee: route.poolFee, tickSpacing: route.tickSpacing } as Record<string, unknown>)[functionName];
    if (functionName === "decimals") return d.tokens.find(t => t.address.toLowerCase() === address.toLowerCase())?.decimals;
    return args;
  });
});
describe("Swap-only registered route admission — offline boundary tests, NOT live execution evidence", () => {
  it.each(d.routes.flatMap(r => [[r.tokenA, r.tokenB], [r.tokenB, r.tokenA]]))("%s → %s pins all permission, metadata, pool and builder calls", async (a, b) => {
    route = selectRegisteredSwapRoute(a, b).route;
    const result = await qualifyRegisteredSwapRoute(client, a, b);
    expect(result.pool).toBe(pool); expect(result.blockNumber).toBe(100n); expect(result.route).toBe(route);
    await result.reader.readContract({ address: d.executor, abi: [], functionName: "feeBps" });
    await result.reader.simulateContract({ address: route.quoter, abi: [], functionName: "quoteExactInputSingle" });
    await result.reader.getBalance({ address: d.owner });
    expect([...read.mock.calls, ...simulate.mock.calls, ...balance.mock.calls, ...code.mock.calls].every(([args]) => args.blockNumber === 100n)).toBe(true);
  });
  it("native ETH selects the existing WETH route, never a sentinel contract", async () => {
    await qualifyRegisteredSwapRoute(client, NATIVE_ETH_SENTINEL, route.tokenA);
    expect(read.mock.calls.some(([p]) => JSON.stringify(p, (_, v) => typeof v === "bigint" ? String(v) : v).includes(NATIVE_ETH_SENTINEL))).toBe(false);
  });
  it.each(MANUAL_SWAP_TOKENS.filter(t => !d.tokens.some(a => a.address.toLowerCase() === t.address.toLowerCase()) && t.kind !== "native"))("discovered $symbol cannot enter route admission", async token => {
    await expect(qualifyRegisteredSwapRoute(client, route.tokenA, token.address)).rejects.toMatchObject({ reason: "FEE_ROUTE_UNREGISTERED" });
    expect(read).not.toHaveBeenCalled();
  });
  it.each([
    ["isTokenAllowed", false, "EXECUTOR_PERMISSION_MISMATCH"], ["routerKind", 0, "EXECUTOR_PERMISSION_MISMATCH"],
    ["feeRecipient", pool, "FEE_RECIPIENT_CHANGED"], ["feeBps", 0, "FEE_POLICY_INVALID"], ["feeBps", 26, "FEE_POLICY_INVALID"],
    ["owner", pool, "EXECUTOR_POSTURE_CHANGED"], ["paused", true, "EXECUTOR_POSTURE_CHANGED"],
    ["decimals", 9, "TOKEN_METADATA_UNAVAILABLE"], ["factory", pool, "POOL_UNVERIFIED"],
    ["token0", pool, "POOL_UNVERIFIED"], ["fee", 500, "POOL_UNVERIFIED"],
    ["getPool", "0x0000000000000000000000000000000000000000", "POOL_UNVERIFIED"],
  ])("rejects changed %s without guessing or fallback", async (name, value, reason) => {
    const original = read.getMockImplementation()!;
    read.mockImplementation(args => args.functionName === name ? Promise.resolve(value) : original(args));
    await expect(qualifyRegisteredSwapRoute(client, route.tokenA, route.tokenB)).rejects.toMatchObject({ reason });
  });
  it("a missing quoter/router/pool/executor/factory contract is not a supported route", async () => {
    code.mockResolvedValue("0x"); await expect(qualifyRegisteredSwapRoute(client, route.tokenA, route.tokenB)).rejects.toMatchObject({ reason: "POOL_UNVERIFIED" });
  });
  it("does not accept stale block identity as live qualification", async () => {
    blockAge = 60_000; await expect(qualifyRegisteredSwapRoute(client, route.tokenA, route.tokenB)).rejects.toMatchObject({ reason: "STALE_BLOCK" }); expect(read).not.toHaveBeenCalled();
  });
  it("provider failures are sanitized, not converted into permission denial", async () => {
    read.mockRejectedValue(new Error("secret provider diagnostics"));
    await expect(qualifyRegisteredSwapRoute(client, route.tokenA, route.tokenB)).rejects.toMatchObject({ status: 503, reason: "ROUTE_VERIFICATION_UNAVAILABLE" });
  });
});

it("duplicate registrations fail closed rather than claiming a best route", async () => {
  const filter = vi.spyOn(d.routes, "filter").mockReturnValueOnce([d.routes[0], { ...d.routes[0] }]);
  try { await expect(qualifyRegisteredSwapRoute(client, route.tokenA, route.tokenB)).rejects.toMatchObject({ reason: "ROUTE_AMBIGUOUS" }); expect(read).not.toHaveBeenCalled(); }
  finally { filter.mockRestore(); }
});
it("a block hash change after quote preparation is detected", async () => {
  await expect(verifyQualifiedSwapBlock(client, { blockNumber: 100n, blockHash: `0x${"cd".repeat(32)}` })).rejects.toMatchObject({ reason: "BLOCK_CHANGED" });
});
it("a snapshot expiring during quote preparation is detected", async () => {
  blockAge = 31_000;
  await expect(verifyQualifiedSwapBlock(client, { blockNumber: 100n, blockHash: hash })).rejects.toMatchObject({ reason: "STALE_BLOCK" });
});
