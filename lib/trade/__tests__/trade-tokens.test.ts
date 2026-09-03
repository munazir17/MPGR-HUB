import { describe, expect, it } from "vitest";

import { BASE_USDC, NATIVE_ETH_SENTINEL } from "../trade-config";
import { findKnownTradeToken, resolveTradeToken } from "../trade-tokens";
import { COINBASE_B20_TOKENIZED_STOCKS, findTokenizedStock } from "../tokenized-stocks";

describe("resolveTradeToken", () => {
  it("resolves ETH / USDC / WETH aliases onto documented Base addresses", () => {
    const eth = resolveTradeToken("eth");
    expect(eth.ok).toBe(true);
    if (eth.ok) expect(eth.token.address).toBe(NATIVE_ETH_SENTINEL);

    const usdc = resolveTradeToken("USDC");
    expect(usdc.ok).toBe(true);
    if (usdc.ok) {
      expect(usdc.token.address.toLowerCase()).toBe(BASE_USDC.toLowerCase());
      expect(usdc.token.decimals).toBe(6);
      expect(usdc.token.verified).toBe(true);
    }
  });

  it("resolves Coinbase B20 tickers from the official catalog", () => {
    const aapl = resolveTradeToken("AAPLc");
    expect(aapl.ok).toBe(true);
    if (aapl.ok) {
      expect(aapl.token.kind).toBe("b20-tokenized-stock");
      expect(aapl.token.address.toLowerCase()).toBe(
        COINBASE_B20_TOKENIZED_STOCKS[0].address.toLowerCase(),
      );
    }
    expect(findTokenizedStock("AAPL")?.ticker).toBe("AAPLc");
  });

  it("rejects unknown tickers instead of inventing a contract", () => {
    const result = resolveTradeToken("FAKESHARE");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/Refusing to invent/i);
  });

  it("accepts a raw 0x address as unverified", () => {
    const result = resolveTradeToken("0x1111111111111111111111111111111111111111");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.token.verified).toBe(false);
  });

  it("findKnownTradeToken is case-insensitive", () => {
    expect(findKnownTradeToken("usdc")?.symbol).toBe("USDC");
    expect(findKnownTradeToken("NvDaC")?.symbol).toBe("NVDAc");
  });
});

describe("Coinbase B20 catalog", () => {
  it("contains exactly the 13 documented tickers and 42-char addresses", () => {
    expect(COINBASE_B20_TOKENIZED_STOCKS).toHaveLength(13);
    for (const stock of COINBASE_B20_TOKENIZED_STOCKS) {
      expect(stock.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(stock.chainlinkFeed).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(stock.network).toBe("base");
      expect(stock.primaryMintRedeem).toBe("authorized-participant-only");
    }
  });
});
