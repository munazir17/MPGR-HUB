import { getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ZERO_EX_ALLOWANCE_HOLDER_BASE,
  buildZeroExNativeFeeParams,
  getZeroExNativeFeeQuote,
  validateZeroExNativeFeeQuote,
  type ZeroExNativeFeeRequest,
} from "@/lib/trade/zero-ex-native-fee";

const USDC = getAddress("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
const WETH = getAddress("0x4200000000000000000000000000000000000006");
const TAKER = getAddress("0x1111111111111111111111111111111111111111");
const FEE = getAddress("0x4444444444444444444444444444444444444444");
const SETTLER = getAddress("0x5555555555555555555555555555555555555555");

const req: ZeroExNativeFeeRequest = { sellToken: USDC, buyToken: WETH, sellAmount: 10_000_000n, taker: TAKER, slippageBps: 100, feeRecipient: FEE };

function body(over: Record<string, unknown> = {}) {
  return {
    liquidityAvailable: true,
    sellToken: USDC,
    buyToken: WETH,
    sellAmount: "10000000",
    buyAmount: "3000000000000000",
    minBuyAmount: "2970000000000000",
    fees: { integratorFee: { amount: "25000", token: USDC, type: "volume" } },
    integratorFees: [{ amount: "25000", token: USDC, type: "volume" }],
    issues: { allowance: { actual: "0", spender: ZERO_EX_ALLOWANCE_HOLDER_BASE } },
    transaction: { to: ZERO_EX_ALLOWANCE_HOLDER_BASE, data: "0xdeadbeef", value: "0", gas: "300000" },
    route: { fills: [{ source: "Aerodrome_V3", proportionBps: "10000" }] },
    ...over,
  };
}

describe("0x native integrator fee", () => {
  it("always pins swapFeeToken to the SELL token with 25 bps on Base", () => {
    const p = buildZeroExNativeFeeParams(req);
    expect(p.get("chainId")).toBe("8453");
    expect(p.get("swapFeeBps")).toBe("25");
    expect(p.get("swapFeeToken")).toBe(USDC);
    expect(p.get("swapFeeRecipient")).toBe(FEE);
    expect(p.get("sellAmount")).toBe("10000000");
  });

  it("accepts a quote whose fee is exactly floor(sell * 25 / 10000) in the sell token", () => {
    const r = validateZeroExNativeFeeQuote(req, body());
    expect(r).toMatchObject({ ok: true, value: { feeAmount: "25000", feeToken: USDC, spender: ZERO_EX_ALLOWANCE_HOLDER_BASE } });
  });

  it.each([
    [{ liquidityAvailable: false }, "NO_LIQUIDITY"],
    [{ sellAmount: "9999999" }, "AMOUNT_MISMATCH"],
    [{ buyToken: USDC }, "TOKEN_MISMATCH"],
    [{ fees: {} }, "INTEGRATOR_FEE_MISSING"],
    [{ fees: { integratorFee: { amount: "25000", token: WETH } } }, "INTEGRATOR_FEE_TOKEN_MISMATCH"],
    [{ fees: { integratorFee: { amount: "24999", token: USDC } } }, "INTEGRATOR_FEE_MISMATCH"],
    [{ fees: { integratorFee: { amount: "25001", token: USDC } } }, "INTEGRATOR_FEE_MISMATCH"],
    [{ integratorFees: [{ amount: "25000" }, { amount: "25000" }] }, "INTEGRATOR_FEE_MISMATCH"],
    [{ issues: { allowance: { spender: SETTLER } } }, "UNEXPECTED_SPENDER"],
    [{ transaction: { to: SETTLER, data: "0x", value: "0" } }, "UNEXPECTED_TARGET"],
    [{ transaction: { to: ZERO_EX_ALLOWANCE_HOLDER_BASE, data: "0x", value: "1" } }, "UNEXPECTED_VALUE"],
    [{ transaction: null }, "PROVIDER_ERROR"],
  ])("rejects %o with %s", (over, code) => {
    expect(validateZeroExNativeFeeQuote(req, body(over))).toMatchObject({ ok: false, error: { code } });
  });

  describe("getZeroExNativeFeeQuote (mocked fetch)", () => {
    const prev = process.env.ZERO_EX_API_KEY;
    beforeEach(() => {
      process.env.ZERO_EX_API_KEY = "test-key";
    });
    afterEach(() => {
      if (prev === undefined) delete process.env.ZERO_EX_API_KEY;
      else process.env.ZERO_EX_API_KEY = prev;
    });

    it("sends the fee params and the api key header, then validates", async () => {
      const fetcher = vi.fn(async () => new Response(JSON.stringify(body()), { status: 200 }));
      const r = await getZeroExNativeFeeQuote(req, fetcher as unknown as typeof fetch);
      expect(r.ok).toBe(true);
      const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toContain("swapFeeToken=" + USDC);
      expect((init.headers as Record<string, string>)["0x-api-key"]).toBe("test-key");
    });

    it("refuses before calling 0x when inputs cannot carry an exact fee", async () => {
      const fetcher = vi.fn();
      const f = fetcher as unknown as typeof fetch;
      expect(await getZeroExNativeFeeQuote({ ...req, sellAmount: 0n }, f)).toMatchObject({ ok: false, error: { code: "ZERO_AMOUNT" } });
      expect(await getZeroExNativeFeeQuote({ ...req, sellAmount: 399n }, f)).toMatchObject({ ok: false, error: { code: "FEE_ROUNDS_TO_ZERO" } });
      expect(await getZeroExNativeFeeQuote({ ...req, feeRecipient: TAKER }, f)).toMatchObject({ ok: false, error: { code: "TAKER_IS_FEE_RECIPIENT" } });
      expect(fetcher).not.toHaveBeenCalled();
    });

    it("maps HTTP errors and network failures to PROVIDER_ERROR", async () => {
      const bad = vi.fn(async () => new Response("{}", { status: 500 }));
      expect(await getZeroExNativeFeeQuote(req, bad as unknown as typeof fetch)).toMatchObject({ ok: false, error: { code: "PROVIDER_ERROR" } });
      const down = vi.fn(async () => {
        throw new Error("ECONNRESET");
      });
      expect(await getZeroExNativeFeeQuote(req, down as unknown as typeof fetch)).toMatchObject({ ok: false, error: { code: "PROVIDER_ERROR" } });
    });

    it("reports missing credentials", async () => {
      delete process.env.ZERO_EX_API_KEY;
      const prevAlt = process.env.ZEROX_API_KEY;
      delete process.env.ZEROX_API_KEY;
      expect(await getZeroExNativeFeeQuote(req, vi.fn() as unknown as typeof fetch)).toMatchObject({ ok: false, error: { code: "CREDENTIALS_MISSING" } });
      if (prevAlt !== undefined) process.env.ZEROX_API_KEY = prevAlt;
    });
  });
});
