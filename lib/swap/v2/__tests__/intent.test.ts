// Intent inspection for the V2 executor: the calldata a wallet signs must be
// re-derived independently, and every rule mirrors the deployed contract so the
// app can never build calldata the executor would revert on. Offline only.
import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { inspectV2SwapTransaction, v2FeeFloor } from "../intent";
import { V4_MANAGER, WETH, auth, deployment, encodeSingle, encodeSplit, hop, intentContext, params, TAKER, TOKEN_A, TOKEN_B, TOKEN_C, TOKEN_D, POOL_AB, POOL_AB_2, INTENT_ID, HOOKS, lc, UNI_V3_ROUTER } from "./helpers";

const inspect = (data: string, value: bigint = 0n, ctx = intentContext()) =>
  inspectV2SwapTransaction({ to: deployment.executor, data: data as `0x${string}`, value }, ctx);

const validSingle = () => encodeSingle(params(), [hop()]);

describe("v2 fee arithmetic", () => {
  it("floors 25 bps on the GROSS sell amount, never on net", () => {
    expect(v2FeeFloor(1_000_000n)).toBe(2500n);
    expect(v2FeeFloor(1n)).toBe(0n);
    expect(v2FeeFloor(39n)).toBe(0n);
    expect(v2FeeFloor(40n)).toBe(0n); // floor(40*25/10000) = 0
    expect(v2FeeFloor(10_000n)).toBe(25n);
  });
});

describe("v2 intent inspection — accepted shapes", () => {
  it("accepts a direct arbitrary token/token pair with no major asset involved", () => {
    const r = inspect(validSingle());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.entry).toBe("swapExactInput");
    // Decoded addresses come back EIP-55 checksummed; fixtures are lowercase.
    expect(lc(r.value.tokenIn)).toBe(lc(TOKEN_A));
    expect(lc(r.value.tokenOut)).toBe(lc(TOKEN_B));
    expect(r.value.grossAmountIn).toBe(1_000_000n);
    expect(r.value.expectedFeeAmount).toBe(2500n);
    expect(r.value.swapAmountIn).toBe(997_500n);
    expect(r.value.feeBps).toBe(25);
    expect(lc(r.value.spender)).toBe(lc(deployment.executor));
    expect(lc(r.value.executor)).toBe(lc(deployment.executor));
    expect(lc(r.value.recipient)).toBe(lc(TAKER));
    expect(r.value.intentId).toBe(INTENT_ID);
    expect(r.value.hops).toBe(1);
  });

  it("accepts a three-hop path through two non-major intermediates", () => {
    const data = encodeSingle(params(), [
      hop({ tokenOut: TOKEN_C, pool: "0xe999999999999999999999999999999999999999" }),
      hop({ tokenOut: TOKEN_D, pool: "0xeaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
      hop({ tokenOut: TOKEN_B, pool: "0xebbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
    ]);
    const r = inspect(data);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.hops).toBe(3);
  });

  it("accepts a canonical v4 hop through the PoolManager", () => {
    const key = { currency0: TOKEN_A, currency1: TOKEN_B, fee: 3000, tickSpacing: 60, hooks: HOOKS };
    // params.router must equal the first hop's router, so it is the PoolManager.
    const data = encodeSingle(params(1_000_000n, { router: V4_MANAGER }), [hop({ kind: 7, router: V4_MANAGER, pool: V4_MANAGER, poolFee: 0, tickSpacing: 0, v4Key: key })]);
    const r = inspect(data);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.routerKind).toBe(7);
      expect(r.value.paths[0][0].v4Key?.tickSpacing).toBe(60);
      expect(r.value.paths[0][0].v4Key?.fee).toBe(3000);
    }
  });

  it("accepts a split route whose legs allocate exactly the net amount (one fee on gross)", () => {
    const gross = 1_000_000n;
    const net = gross - v2FeeFloor(gross);
    const data = encodeSplit(params(gross), [[hop({ pool: POOL_AB })], [hop({ pool: POOL_AB_2, id: undefined } as never)]], [500_000n, net - 500_000n]);
    const r = inspect(data);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.entry).toBe("swapExactInputSplit");
      expect(r.value.legAmounts.reduce((a, b) => a + b, 0n)).toBe(net);
      expect(r.value.expectedFeeAmount).toBe(v2FeeFloor(gross));
    }
  });

  it("accepts a native ETH sell with value equal to gross and APPROVAL auth", () => {
    const data = encodeSingle(params(1_000_000n, { tokenIn: WETH, router: V4_MANAGER }), [
      hop({ kind: 7, router: V4_MANAGER, pool: V4_MANAGER, tokenOut: TOKEN_B, poolFee: 0, tickSpacing: 0,
        v4Key: { currency0: "0x0000000000000000000000000000000000000000", currency1: TOKEN_B, fee: 0, tickSpacing: 200, hooks: HOOKS } })], auth(0));
    const r = inspect(data, 1_000_000n, intentContext({ fromAddress: WETH, nativeIn: true }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.nativeIn).toBe(true);
  });
});

describe("v2 intent inspection — rejected shapes", () => {
  it("rejects a forged or skipped fee", () => {
    expect(inspect(encodeSingle(params(1_000_000n, { expectedFeeAmount: 0n }), [hop()])).ok).toBe(false);
    expect(inspect(encodeSingle(params(1_000_000n, { expectedFeeAmount: 2400n }), [hop()])).ok).toBe(false);
    expect(inspect(encodeSingle(params(1_000_000n, { expectedFeeAmount: 2600n }), [hop()])).ok).toBe(false);
    // A fee computed on NET instead of GROSS is the classic undercharge.
    const net = 1_000_000n - 2500n;
    expect(inspect(encodeSingle(params(1_000_000n, { expectedFeeAmount: (net * 25n) / 10_000n }), [hop()])).ok).toBe(false);
  });

  it("rejects a fee that rounds to zero at the governed fee", () => {
    const r = inspect(encodeSingle(params(39n, { expectedFeeAmount: 0n, amountOutMinimum: 1n }), [hop()]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/too small/i);
  });

  it("rejects a redirected recipient, a zero minimum, and a missing deadline", () => {
    expect(inspect(encodeSingle(params(1_000_000n, { recipient: TOKEN_C }), [hop()])).ok).toBe(false);
    expect(inspect(encodeSingle(params(1_000_000n, { amountOutMinimum: 0n }), [hop()])).ok).toBe(false);
    expect(inspect(encodeSingle(params(1_000_000n, { deadline: 0n }), [hop()])).ok).toBe(false);
  });

  it("rejects a substituted pair", () => {
    expect(inspect(encodeSingle(params(1_000_000n, { tokenIn: TOKEN_C }), [hop()])).ok).toBe(false);
    expect(inspect(encodeSingle(params(1_000_000n, { tokenOut: TOKEN_C }), [hop({ tokenOut: TOKEN_C })])).ok).toBe(false);
  });

  it("rejects native-value mismatches and a native sell that is not WETH", () => {
    expect(inspect(validSingle(), 1n).ok).toBe(false); // value on a token sell
    const data = encodeSingle(params(1_000_000n, { tokenIn: TOKEN_A }), [hop()]);
    expect(inspect(data, 1_000_000n, intentContext({ nativeIn: true })).ok).toBe(false);
  });

  it("rejects an unwrap flag that disagrees with the requested output", () => {
    expect(inspect(encodeSingle(params(1_000_000n, { unwrapNativeOut: true }), [hop()])).ok).toBe(false);
    const data = encodeSingle(params(1_000_000n, { tokenOut: WETH, unwrapNativeOut: false }), [hop({ tokenOut: WETH })]);
    expect(inspect(data, 0n, intentContext({ toAddress: WETH, nativeOut: true })).ok).toBe(false);
  });

  it("rejects paths the contract's _validatePath would revert on", () => {
    const p = (o = {}) => params(1_000_000n, o);
    // more than three hops
    expect(inspect(encodeSingle(p(), [hop({ tokenOut: TOKEN_C }), hop({ tokenOut: TOKEN_D }), hop({ tokenOut: "0xf000000000000000000000000000000000000001" }), hop()])).ok).toBe(false);
    // duplicate intermediate
    expect(inspect(encodeSingle(p(), [hop({ tokenOut: TOKEN_C }), hop({ tokenOut: TOKEN_C })])).ok).toBe(false);
    // hop routes back to the sell token
    expect(inspect(encodeSingle(p(), [hop({ tokenOut: TOKEN_A })])).ok).toBe(false);
    // a non-final hop delivers the receive token
    expect(inspect(encodeSingle(p(), [hop({ tokenOut: TOKEN_B }), hop({ tokenOut: TOKEN_B })])).ok).toBe(false);
    // final hop does not deliver the receive token
    expect(inspect(encodeSingle(p(), [hop({ tokenOut: TOKEN_C })])).ok).toBe(false);
  });

  /** The first-hop router check runs before path validation, so every rejection
   * below pins params.router to the hop router. Otherwise the assertion would
   * pass for the wrong reason and prove nothing about the rule under test. */
  const rejectFor = (router: Address, hops: readonly unknown[], reason: RegExp) => {
    const r = inspect(encodeSingle(params(1_000_000n, { router }), hops as never));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  };

  it("rejects disabled venues: Pancake (5) and the 0x Settler (6)", () => {
    const pancake = "0x1b81d678ffb9c0263b24a97847620c99d213eb14" as Address;
    const settler = "0x0000000000001ff3684f28c67538d4d072c22734" as Address;
    rejectFor(pancake, [hop({ kind: 5, router: pancake })], /not an enabled V2 venue/i);
    rejectFor(settler, [hop({ kind: 6, router: settler })], /not an enabled V2 venue/i);
  });

  it("rejects a router that is not the allowlisted router for its kind", () => {
    const bogus = "0x1111111111111111111111111111111111111111" as Address;
    rejectFor(bogus, [hop({ kind: 1, router: bogus })], /not the allowlisted/i);
    // params.router must equal the first hop's router
    const mismatch = inspect(encodeSingle(params(1_000_000n, { router: TOKEN_C }), [hop()]));
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.reason).toMatch(/first hop/i);
  });

  it("rejects a v4 hop that is not the canonical PoolManager or has a malformed PoolKey", () => {
    const ok = { currency0: TOKEN_A, currency1: TOKEN_B, fee: 3000, tickSpacing: 60, hooks: HOOKS };
    const v4 = (overrides: Parameters<typeof hop>[0]) => hop({ kind: 7, router: V4_MANAGER, pool: V4_MANAGER, ...overrides });
    rejectFor(V4_MANAGER, [v4({ pool: POOL_AB, v4Key: ok })], /canonical PoolManager/i);
    // currency0 must sort below currency1
    rejectFor(V4_MANAGER, [v4({ v4Key: { ...ok, currency0: TOKEN_B, currency1: TOKEN_A } })], /currency0 < currency1/);
    // tickSpacing out of range
    rejectFor(V4_MANAGER, [v4({ v4Key: { ...ok, tickSpacing: 0 } })], /tickSpacing/i);
    // PoolKey currencies must match this hop's sell/receive tokens
    rejectFor(V4_MANAGER, [v4({ v4Key: { ...ok, currency1: TOKEN_C } })], /do not match/i);
  });

  it("rejects a non-v4 hop carrying a live PoolKey", () => {
    rejectFor(UNI_V3_ROUTER, [hop({ v4Key: { currency0: TOKEN_A, currency1: TOKEN_B, fee: 500, tickSpacing: 10, hooks: "0x0000000000000000000000000000000000000001" } })], /PoolKey zeroed/i);
  });

  it("rejects split allocations that double-charge, under-charge or mis-shape the batch", () => {
    const gross = 1_000_000n;
    const net = gross - v2FeeFloor(gross);
    const legs = [[hop({ pool: POOL_AB })], [hop({ pool: POOL_AB_2 })]];
    // legs allocate GROSS: the fee would effectively be charged twice
    expect(inspect(encodeSplit(params(gross), legs, [500_000n, gross - 500_000n])).ok).toBe(false);
    // legs allocate less than net: input not fully consumed
    expect(inspect(encodeSplit(params(gross), legs, [1n, 2n])).ok).toBe(false);
    // amounts length mismatch
    expect(inspect(encodeSplit(params(gross), legs, [net])).ok).toBe(false);
    // a single leg is not a split
    expect(inspect(encodeSplit(params(gross), [legs[0]], [net])).ok).toBe(false);
    // five legs exceed the contract's bound of four
    expect(inspect(encodeSplit(params(gross), [legs[0], legs[1], legs[0], legs[1], legs[0]], [1n, 1n, 1n, 1n, net - 4n])).ok).toBe(false);
    // a zero leg amount
    expect(inspect(encodeSplit(params(gross), legs, [0n, net])).ok).toBe(false);
  });

  it("rejects calldata aimed at any executor other than the sealed V2 address", () => {
    const r = inspectV2SwapTransaction({ to: "0xbcdE809b4b72bCe8f61c87daC6Be12e3F7c6b3E", data: validSingle(), value: 0n }, intentContext());
    expect(r.ok).toBe(false);
  });

  it("rejects a malformed or empty payload without throwing", () => {
    expect(inspect("0x").ok).toBe(false);
    expect(inspect("0xdeadbeef").ok).toBe(false);
  });
});
