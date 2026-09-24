// lib/trade/__tests__/trade-swap-router-fee.test.ts
//
// Provider-aware fee routing: the 0x native fee is requested on the 0x
// path ONLY. CDP and Aerodrome are never sent a fee parameter (neither
// provider supports one, and inventing one would be worse than no fee).
//
// Also locks the existing routing/fallback order so the fee threading
// cannot silently change which provider answers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  cdpPrice,
  cdpQuote,
  zxPrice,
  zxQuote,
  aeroPrice,
  aeroQuote,
} = vi.hoisted(() => ({
  cdpPrice: vi.fn(),
  cdpQuote: vi.fn(),
  zxPrice: vi.fn(),
  zxQuote: vi.fn(),
  aeroPrice: vi.fn(),
  aeroQuote: vi.fn(),
}));

vi.mock("../trade-cdp-client", () => ({
  getCdpSwapPrice: (...a: unknown[]) => cdpPrice(...a),
  createCdpSwapQuote: (...a: unknown[]) => cdpQuote(...a),
}));

vi.mock("../trade-0x-client", () => ({
  getZeroExSwapPrice: (...a: unknown[]) => zxPrice(...a),
  createZeroExSwapQuote: (...a: unknown[]) => zxQuote(...a),
  hasZeroExApiKey: () => true,
}));

vi.mock("../aerodrome-slipstream", () => ({
  getAerodromeSlipstreamPrice: (...a: unknown[]) => aeroPrice(...a),
  createAerodromeSlipstreamQuote: (...a: unknown[]) => aeroQuote(...a),
}));

const { getRoutedSwapPrice, createRoutedSwapQuote } = await import("../trade-swap-router");
import type { RoutedSwapRequest } from "../trade-swap-router";
const { COINBASE_B20_TOKENIZED_STOCKS } = await import("../tokenized-stocks");

const FEE_WALLET = "0x1111111111111111111111111111111111111111";
const TAKER = "0x2222222222222222222222222222222222222222";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const AAPLc = COINBASE_B20_TOKENIZED_STOCKS[0].address;

const REQUEST = {
  fromToken: USDC,
  toToken: WETH,
  fromAmount: "10000000",
  taker: TAKER,
  slippageBps: 100,
};

function cdpSuccess() {
  return {
    ok: true,
    value: {
      liquidityAvailable: true,
      fromToken: USDC,
      toToken: WETH,
      fromAmount: "10000000",
      toAmount: "400000000000000",
      minToAmount: "396000000000000",
      issues: { allowance: null, balance: null, simulationIncomplete: false },
    },
  };
}

function cdpRejected() {
  return {
    ok: false,
    error: {
      code: "PROVIDER_ERROR" as const,
      message: "Coinbase CDP will not authorize this token for a swap.",
    },
  };
}

function zxSuccess(fees?: unknown) {
  return {
    ok: true,
    value: {
      liquidityAvailable: true,
      fromToken: USDC,
      toToken: WETH,
      fromAmount: "10000000",
      toAmount: "400000000000000",
      minToAmount: "396000000000000",
      issues: { allowance: null, balance: null, simulationIncomplete: false },
      ...(fees ? { fees } : {}),
    },
  };
}

function aeroSuccess() {
  return {
    ok: true,
    provider: "aerodrome-slipstream",
    value: {
      liquidityAvailable: true,
      fromToken: USDC,
      toToken: AAPLc,
      fromAmount: "5000000",
      toAmount: "3020310",
      minToAmount: "2990106",
      issues: { allowance: null, balance: null, simulationIncomplete: false },
      transaction: { to: USDC, data: "0xabcd", value: "0" },
      permit2: null,
    },
  };
}

describe("swap router — provider-aware fee threading", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT", FEE_WALLET);
    cdpPrice.mockReset();
    cdpQuote.mockReset();
    zxPrice.mockReset();
    zxQuote.mockReset();
    aeroPrice.mockReset();
    aeroQuote.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("CDP is the primary path and is never sent a fee parameter", async () => {
    cdpPrice.mockResolvedValue(cdpSuccess());

    const result = await getRoutedSwapPrice(REQUEST);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provider).toBe("cdp-trade-api");
    expect(cdpPrice).toHaveBeenCalledTimes(1);
    // The request CDP received carries no agentFee — CDP has no fee
    // parameter and none is invented for it.
    const sent = cdpPrice.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.agentFee).toBeUndefined();
    // The original request object is not mutated.
    expect("agentFee" in REQUEST).toBe(false);
    // 0x is not consulted at all.
    expect(zxPrice).not.toHaveBeenCalled();
  });

  it("0x fallback carries the native fee config", async () => {
    cdpPrice.mockResolvedValue(cdpRejected());
    zxPrice.mockResolvedValue(zxSuccess());

    const result = await getRoutedSwapPrice(REQUEST);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provider).toBe("0x-swap-api");
    const sent = zxPrice.mock.calls[0][0] as RoutedSwapRequest & {
      agentFee?: { recipient: string; bps: number } | null;
    };
    expect(sent.agentFee).toEqual({ recipient: FEE_WALLET, bps: 25 });
    // The rest of the request is passed through unchanged.
    expect(sent.fromToken).toBe(USDC);
    expect(sent.toToken).toBe(WETH);
    expect(sent.fromAmount).toBe("10000000");
    expect(sent.taker).toBe(TAKER);
  });

  it("0x fallback with no configured fee wallet sends no fee config", async () => {
    vi.stubEnv("NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT", "");
    cdpPrice.mockResolvedValue(cdpRejected());
    zxPrice.mockResolvedValue(zxSuccess());

    await getRoutedSwapPrice(REQUEST);

    const sent = zxPrice.mock.calls[0][0] as { agentFee?: unknown };
    expect(sent.agentFee).toBeNull();
  });

  it("B20 swaps go to Aerodrome and are never sent a fee parameter", async () => {
    aeroPrice.mockResolvedValue(aeroSuccess());

    const result = await getRoutedSwapPrice({ ...REQUEST, fromToken: USDC, toToken: AAPLc });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provider).toBe("aerodrome-slipstream");
    expect(aeroPrice).toHaveBeenCalledTimes(1);
    const sent = aeroPrice.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.agentFee).toBeUndefined();
    // Neither other provider is consulted for B20.
    expect(cdpPrice).not.toHaveBeenCalled();
    expect(zxPrice).not.toHaveBeenCalled();
  });

  it("createRoutedSwapQuote keeps the same order: CDP, then 0x with the fee", async () => {
    cdpQuote.mockResolvedValue(cdpRejected());
    zxQuote.mockResolvedValue({
      ...zxSuccess(),
      value: { ...zxSuccess().value, transaction: { to: USDC, data: "0xdead", value: "0" } },
    });

    const result = await createRoutedSwapQuote(REQUEST);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provider).toBe("0x-swap-api");
    const sent = zxQuote.mock.calls[0][0] as RoutedSwapRequest & {
      agentFee?: { recipient: string; bps: number } | null;
    };
    expect(sent.agentFee).toEqual({ recipient: FEE_WALLET, bps: 25 });
  });

  it("a 0x quote that reports an integrator fee still resolves to 0x", async () => {
    cdpPrice.mockResolvedValue(cdpRejected());
    zxPrice.mockResolvedValue(
      zxSuccess({ integratorFee: { amount: "25000", token: USDC } }),
    );

    const result = await getRoutedSwapPrice(REQUEST);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provider).toBe("0x-swap-api");
    // The fee 0x reports is surfaced for the proposal to consume.
    expect(result.value.fees?.integratorFee).toEqual({ amount: "25000", token: USDC });
  });

  it("CDP still wins when it has liquidity, even with a fee wallet configured", async () => {
    cdpPrice.mockResolvedValue(cdpSuccess());
    zxPrice.mockResolvedValue(zxSuccess());

    const result = await getRoutedSwapPrice(REQUEST);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provider).toBe("cdp-trade-api");
    expect(zxPrice).not.toHaveBeenCalled();
  });
});
