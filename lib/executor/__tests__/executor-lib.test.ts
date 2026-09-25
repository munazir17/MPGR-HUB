import { decodeFunctionData, getAddress, parseAbi, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { RouterKind } from "@/lib/executor/executor-config";
import { applySlippage, computeExecutorFee, minimumFeeableAmount } from "@/lib/executor/executor-fee";
import {
  approvalAuthorization,
  authorizationFromSignature,
  buildExecutorIntent,
  encodeExactApproval,
  encodeExecutorSwap,
  intentIdFromQuoteId,
  type BuildIntentInput,
} from "@/lib/executor/executor-intent";
import { verifyExecutorReceipt } from "@/lib/executor/executor-verify";
import { MPGR_EXECUTOR_ABI } from "@/lib/executor/mpgr-executor-abi";
import {
  EXECUTOR,
  FEE_RECIPIENT,
  PERMIT2,
  ROUTER,
  SEPOLIA_DEPLOYMENT,
  TSTOCK,
  TUSD,
  WETH,
  swapExecutedLog,
} from "@/lib/mcp/__tests__/fixtures";

const TAKER = getAddress("0x1111111111111111111111111111111111111111");

function input(over: Partial<BuildIntentInput> = {}): BuildIntentInput {
  return {
    deployment: SEPOLIA_DEPLOYMENT,
    taker: TAKER,
    sellToken: TUSD,
    buyToken: TSTOCK,
    sellAmount: 1_000_000n,
    expectedBuyAmount: 5_000n,
    slippageBps: 100,
    authorization: "APPROVAL",
    nowSeconds: 1_700_000_000,
    quoteId: "q1.test",
    feeBps: 25,
    feeRecipient: FEE_RECIPIENT,
    ...over,
  };
}

describe("executor fee math (mirrors MPGRExecutor._begin)", () => {
  it("is exactly floor(gross * 25 / 10000)", () => {
    for (const [gross, fee] of [
      [10_000n, 25n],
      [400n, 1n],
      [799n, 1n],
      [800n, 2n],
      [1_000_000n, 2_500n],
      [123_456_789n, 308_641n],
      [10n ** 30n + 7n, (10n ** 30n + 7n) * 25n / 10_000n],
    ] as const) {
      const r = computeExecutorFee(gross, 25);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.feeAmount).toBe(fee);
        expect(r.value.feeAmount + r.value.swapAmountIn).toBe(gross);
      }
    }
  });

  it("refuses amounts whose fee rounds to zero instead of skipping the fee", () => {
    expect(minimumFeeableAmount(25)).toBe(400n);
    const r = computeExecutorFee(399n, 25);
    expect(r).toMatchObject({ ok: false, error: { code: "FEE_ROUNDS_TO_ZERO", minimumGross: 400n } });
    expect(computeExecutorFee(1n, 25).ok).toBe(false);
  });

  it("rejects zero amounts and out-of-range fee bps", () => {
    expect(computeExecutorFee(0n, 25)).toMatchObject({ ok: false, error: { code: "ZERO_AMOUNT" } });
    expect(computeExecutorFee(-1n, 25)).toMatchObject({ ok: false, error: { code: "ZERO_AMOUNT" } });
    expect(computeExecutorFee(10_000n, 101)).toMatchObject({ ok: false, error: { code: "INVALID_FEE_BPS" } });
    expect(computeExecutorFee(10_000n, 2.5)).toMatchObject({ ok: false, error: { code: "INVALID_FEE_BPS" } });
    expect(computeExecutorFee(10_000n, 100)).toMatchObject({ ok: true, value: { feeAmount: 100n } });
  });

  it("applies slippage with floor rounding", () => {
    expect(applySlippage(10_000n, 100)).toBe(9_900n);
    expect(applySlippage(999n, 50)).toBe(994n);
    expect(() => applySlippage(1n, 10_000)).toThrow();
  });
});

describe("buildExecutorIntent", () => {
  it("builds an exact, self-recipient intent", () => {
    const r = buildExecutorIntent(input());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const i = r.value;
    expect(i.recipient).toBe(TAKER);
    expect(i.executor).toBe(EXECUTOR);
    expect(i.router).toBe(ROUTER);
    expect(i.feeAmount).toBe("2500");
    expect(i.swapAmount).toBe("997500");
    expect(i.minBuyAmount).toBe("4950");
    expect(i.feeToken).toBe(TUSD);
    expect(i.spender).toBe(EXECUTOR);
    expect(i.deadline).toBe(1_700_000_600);
    expect(i.intentId).toBe(intentIdFromQuoteId("q1.test"));
  });

  it("uses Permit2 as the spender in PERMIT2 mode", () => {
    const r = buildExecutorIntent(input({ authorization: "PERMIT2" }));
    expect(r.ok && r.value.spender).toBe(PERMIT2);
  });

  it.each([
    [{ taker: "0xnope" }, "INVALID_TAKER"],
    [{ taker: FEE_RECIPIENT }, "TAKER_IS_FEE_RECIPIENT"],
    [{ sellToken: "0x9999999999999999999999999999999999999999" }, "TOKEN_NOT_ALLOWED"],
    [{ buyToken: TUSD }, "SAME_TOKEN"],
    [{ sellNative: true }, "NATIVE_REQUIRES_WETH"],
    [{ sellToken: WETH, buyToken: TUSD, sellNative: true, authorization: "PERMIT2" as const }, "NATIVE_REQUIRES_APPROVAL_MODE"],
    [{ sellToken: WETH, buyToken: TSTOCK }, "NO_ROUTE"],
    [{ slippageBps: 0 }, "INVALID_SLIPPAGE"],
    [{ slippageBps: 501 }, "INVALID_SLIPPAGE"],
    [{ sellAmount: 100n }, "FEE_ROUNDS_TO_ZERO"],
    [{ expectedBuyAmount: 0n }, "NO_LIQUIDITY"],
    [{ expectedBuyAmount: 1n }, "ZERO_MIN_OUTPUT"],
    [{ deadlineSeconds: 3600 }, "INVALID_DEADLINE"],
    [{ feeBps: 150 }, "INVALID_FEE_BPS"],
  ])("rejects %o with %s", (over, code) => {
    const r = buildExecutorIntent(input(over as Partial<BuildIntentInput>));
    expect(r).toMatchObject({ ok: false, error: { code } });
  });
});

describe("calldata encoding", () => {
  it("encodes the typed Uniswap V3 entry point with exactly the intent's parameters", () => {
    const r = buildExecutorIntent(input());
    if (!r.ok) throw new Error("intent");
    const tx = encodeExecutorSwap(r.value, approvalAuthorization());
    expect(tx).toMatchObject({ to: EXECUTOR, value: "0", chainId: 84532 });
    const decoded = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: tx.data });
    expect(decoded.functionName).toBe("swapUniswapV3ExactInputSingle");
    const [p, fee, auth] = decoded.args as unknown as [Record<string, unknown>, number, Record<string, unknown>];
    expect(p).toMatchObject({
      router: ROUTER,
      tokenIn: TUSD,
      tokenOut: TSTOCK,
      grossAmountIn: 1_000_000n,
      expectedFeeAmount: 2_500n,
      amountOutMinimum: 4_950n,
      recipient: TAKER,
      unwrapNativeOut: false,
    });
    expect(fee).toBe(3000);
    expect(auth.kind).toBe(0);
  });

  it("sends msg.value == gross only for native ETH sells", () => {
    const r = buildExecutorIntent(input({ sellToken: WETH, buyToken: TUSD, sellNative: true, sellAmount: 10n ** 15n }));
    if (!r.ok) throw new Error("intent");
    expect(r.value.feeToken).toBe("ETH");
    expect(encodeExecutorSwap(r.value, approvalAuthorization()).value).toBe("1000000000000000");
  });

  it("encodes Slipstream routes through the Slipstream entry point", () => {
    const d = {
      ...SEPOLIA_DEPLOYMENT,
      routes: [{ kind: RouterKind.AERODROME_SLIPSTREAM, router: ROUTER, quoter: ROUTER, tickSpacing: 100, tokenA: TUSD, tokenB: TSTOCK }],
    } as typeof SEPOLIA_DEPLOYMENT;
    const r = buildExecutorIntent(input({ deployment: d }));
    if (!r.ok) throw new Error("intent");
    const decoded = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: encodeExecutorSwap(r.value, approvalAuthorization()).data });
    expect(decoded.functionName).toBe("swapSlipstreamExactInputSingle");
    expect(decoded.args?.[1]).toBe(100);
  });

  it("approvals are for the exact amount, never unlimited", () => {
    const tx = encodeExactApproval(84532, TUSD, EXECUTOR, 1_000_000n);
    const d = decodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), data: tx.data });
    expect(d.args).toEqual([EXECUTOR, 1_000_000n]);
    expect(tx.to).toBe(TUSD);
  });

  it("splits EIP-2612 signatures into v/r/s and keeps Permit2 signatures whole", () => {
    const sig = `0x${"ab".repeat(32)}${"cd".repeat(32)}1b` as Hex;
    const e = authorizationFromSignature("EIP2612", sig, 3n, 99);
    expect(e).toMatchObject({ ok: true, value: { kind: 1, v: 27, nonce: 3n, deadline: 99n, signature: "0x" } });
    const p = authorizationFromSignature("PERMIT2", sig, 5n, 99);
    expect(p).toMatchObject({ ok: true, value: { kind: 2, signature: sig } });
    expect(authorizationFromSignature("PERMIT2", "0x1234", 5n, 99).ok).toBe(false);
  });
});

describe("verifyExecutorReceipt", () => {
  const intentR = buildExecutorIntent(input());
  if (!intentR.ok) throw new Error("intent");
  const intent = intentR.value;
  const ev = {
    taker: TAKER,
    router: ROUTER,
    intentId: intent.intentId,
    tokenIn: TUSD,
    tokenOut: TSTOCK,
    grossAmountIn: 1_000_000n,
    feeAmount: 2_500n,
    swapAmountIn: 997_500n,
    amountOut: 5_000n,
    feeRecipient: FEE_RECIPIENT,
    feeBps: 25,
    routerKind: RouterKind.UNISWAP_V3_ROUTER02,
    flags: 0,
  };
  const receipt = (logs = [swapExecutedLog(EXECUTOR, ev)], over = {}) => ({
    status: "success" as const,
    transactionHash: `0x${"33".repeat(32)}` as Hex,
    blockNumber: 99n,
    from: TAKER,
    to: EXECUTOR,
    logs,
    ...over,
  });

  it("verifies a matching receipt", () => {
    const v = verifyExecutorReceipt(receipt(), intent);
    expect(v.checks.filter((c) => !c.ok)).toEqual([]);
    expect(v.verified).toBe(true);
    expect(v.event?.feeAmount).toBe("2500");
  });

  it("fails on a short fee, output below minimum, or a redirected fee", () => {
    for (const bad of [{ feeAmount: 2_499n, swapAmountIn: 997_501n }, { amountOut: 4_949n }, { feeRecipient: TAKER }]) {
      expect(verifyExecutorReceipt(receipt([swapExecutedLog(EXECUTOR, { ...ev, ...bad })]), intent).verified).toBe(false);
    }
  });

  it("ignores look-alike events emitted by any other contract", () => {
    const v = verifyExecutorReceipt(receipt([swapExecutedLog(getAddress("0x000000000000000000000000000000000000bad0"), ev)]), intent);
    expect(v.verified).toBe(false);
    expect(v.event).toBeNull();
  });

  it("fails on reverted status, wrong sender or wrong target", () => {
    expect(verifyExecutorReceipt(receipt(undefined, { status: "reverted" }), intent).verified).toBe(false);
    expect(verifyExecutorReceipt(receipt(undefined, { from: FEE_RECIPIENT }), intent).verified).toBe(false);
    expect(verifyExecutorReceipt(receipt(undefined, { to: ROUTER }), intent).verified).toBe(false);
  });

  it("fails if the same intent was emitted twice (double execution)", () => {
    expect(verifyExecutorReceipt(receipt([swapExecutedLog(EXECUTOR, ev), swapExecutedLog(EXECUTOR, ev)]), intent).verified).toBe(false);
  });
});
