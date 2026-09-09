import { describe, expect, it } from "vitest";
import { getAddress } from "viem";

import { BASE_USDC, BASE_WETH, NATIVE_ETH_SENTINEL } from "../trade-config";
import {
  AERODROME_SLIPSTREAM_SWAP_ROUTER,
  AERODROME_SLIPSTREAM_PROVIDER_ID,
} from "../trade-config";
import {
  applySlippageBps,
  encodeAerodromeExactInputSingle,
  resolveAerodromeB20Pair,
} from "../aerodrome-slipstream";
import { involvesCoinbaseB20 } from "../tokenized-stocks";
import { revalidateTradeProposal } from "../trade-confirmation";
import { buildTradeProposal } from "../trade-proposal";
import type { CdpSwapQuote, TradeTokenRef } from "../trade-types";
import { isSupportedTradeProvider } from "../trade-types";
import { COINBASE_B20_TOKENIZED_STOCKS } from "../tokenized-stocks";

const TAKER = "0x2222222222222222222222222222222222222222";
const AAPL = COINBASE_B20_TOKENIZED_STOCKS[0].address;

const usdc: TradeTokenRef = {
  address: BASE_USDC,
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
  kind: "erc20",
  verified: true,
};

const aapl: TradeTokenRef = {
  address: AAPL,
  symbol: "AAPLc",
  name: "Apple Tokenized Stock (Coinbase)",
  decimals: 8,
  kind: "b20-tokenized-stock",
  verified: true,
};

describe("resolveAerodromeB20Pair", () => {
  it("accepts USDC → AAPLc and AAPLc → USDC", () => {
    const buy = resolveAerodromeB20Pair(BASE_USDC, AAPL);
    expect(buy.ok).toBe(true);
    if (buy.ok) {
      expect(buy.tokenIn).toBe(getAddress(BASE_USDC));
      expect(buy.tokenOut).toBe(getAddress(AAPL));
      expect(buy.b20Ticker).toBe("AAPLc");
    }

    const sell = resolveAerodromeB20Pair(AAPL, BASE_USDC);
    expect(sell.ok).toBe(true);
    if (sell.ok) expect(sell.b20Ticker).toBe("AAPLc");
  });

  it("rejects ETH/WETH ↔ B20 with a convert-to-USDC message", () => {
    const eth = resolveAerodromeB20Pair(NATIVE_ETH_SENTINEL, AAPL);
    expect(eth.ok).toBe(false);
    if (!eth.ok) expect(eth.error.message).toMatch(/USDC/i);

    const weth = resolveAerodromeB20Pair(BASE_WETH, AAPL);
    expect(weth.ok).toBe(false);
    if (!weth.ok) expect(weth.error.code).toBe("UNSUPPORTED_ASSET");
  });

  it("rejects B20-to-B20", () => {
    const tsla = COINBASE_B20_TOKENIZED_STOCKS.find((s) => s.ticker === "TSLAc");
    expect(tsla).toBeTruthy();
    const result = resolveAerodromeB20Pair(AAPL, tsla!.address);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/B20-to-B20/i);
  });
});

describe("involvesCoinbaseB20", () => {
  it("detects B20 on either side and ignores regular pairs", () => {
    expect(involvesCoinbaseB20(BASE_USDC, AAPL)).toBe(true);
    expect(involvesCoinbaseB20(AAPL, BASE_USDC)).toBe(true);
    expect(involvesCoinbaseB20(BASE_USDC, BASE_WETH)).toBe(false);
  });
});

describe("applySlippageBps / calldata", () => {
  it("applies 100 bps as 1% haircut", () => {
    expect(applySlippageBps(1_000_000n, 100)).toBe(990_000n);
    expect(applySlippageBps(318834n, 100)).toBe(315645n);
  });

  it("encodes exactInputSingle with the Aerodrome tickSpacing struct", () => {
    const data = encodeAerodromeExactInputSingle({
      tokenIn: getAddress(BASE_USDC),
      tokenOut: getAddress(AAPL),
      recipient: TAKER,
      deadline: 1_800_000_000n,
      amountIn: 1_000_000n,
      amountOutMinimum: 315645n,
    });
    expect(data.startsWith("0x")).toBe(true);
    expect(data.length).toBeGreaterThan(10);
  });
});

describe("Aerodrome trade proposal + confirmation", () => {
  function quote(): CdpSwapQuote {
    return {
      liquidityAvailable: true,
      fromToken: BASE_USDC,
      toToken: AAPL,
      fromAmount: "1000000",
      toAmount: "318834",
      minToAmount: "315645",
      issues: {
        allowance: { currentAllowance: "0", spender: AERODROME_SLIPSTREAM_SWAP_ROUTER },
        balance: null,
        simulationIncomplete: false,
      },
      transaction: {
        to: AERODROME_SLIPSTREAM_SWAP_ROUTER,
        data: "0x1234",
        value: "0",
      },
      permit2: null,
    };
  }

  it("labels the Aerodrome router approval (not Permit2) and confirms", () => {
    expect(isSupportedTradeProvider(AERODROME_SLIPSTREAM_PROVIDER_ID)).toBe(true);

    const built = buildTradeProposal({
      from: usdc,
      to: aapl,
      quote: quote(),
      slippageBps: 100,
      taker: TAKER,
      provider: AERODROME_SLIPSTREAM_PROVIDER_ID,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.kind).toBe("tokenized-stock-swap");
    expect(built.proposal.provider).toBe("aerodrome-slipstream");
    expect(built.proposal.providerLabel).toMatch(/Aerodrome/i);
    expect(built.proposal.permit2).toBeNull();
    expect(built.proposal.needsPermit2Approval).toBe(true);
    expect(built.proposal.permit2Spender?.toLowerCase()).toBe(
      AERODROME_SLIPSTREAM_SWAP_ROUTER.toLowerCase(),
    );
    expect(built.proposal.postConfirmationSteps.some((s) => /Aerodrome Slipstream SwapRouter/i.test(s))).toBe(
      true,
    );
    expect(built.proposal.postConfirmationSteps.some((s) => /Permit2/i.test(s))).toBe(false);

    const validated = revalidateTradeProposal(built.proposal, TAKER);
    expect(validated.state).toBe("VALIDATED");
  });
});

