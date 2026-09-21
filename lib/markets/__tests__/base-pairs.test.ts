import { describe, expect, it } from "vitest";

import {
  BASE_PAIRS,
  BASE_STOCKS_DISCLAIMER,
  B20_ORACLE_REGISTRY,
  TAPE_STOCK_PAIRS,
  TAPE_WRAPPED_PAIRS,
  basescanTokenUrl,
  findBasePair,
  findBasePairByAddress,
  verifyB20Address,
} from "@/lib/markets/base-pairs";
import { COINBASE_B20_TOKENIZED_STOCKS } from "@/lib/trade/tokenized-stocks";
import { BASE_USDC } from "@/lib/trade/trade-config";

describe("base-pairs allowlist", () => {
  it("tape segment A leads with cbBTC, cbETH and native USDC (never cbUSDC)", () => {
    const symbols = TAPE_WRAPPED_PAIRS.map((pair) => pair.symbol);
    expect(symbols.slice(0, 3)).toEqual(["cbBTC", "cbETH", "USDC"]);
    expect(BASE_PAIRS.some((pair) => pair.symbol.toLowerCase() === "cbusdc")).toBe(false);

    const usdc = findBasePair("USDC");
    expect(usdc?.kind).toBe("stable");
    expect(usdc?.address.toLowerCase()).toBe(BASE_USDC.toLowerCase());
  });

  it("tape segment B is the ten official stock tickers in product order", () => {
    expect(TAPE_STOCK_PAIRS.map((pair) => pair.symbol)).toEqual([
      "NVDAc",
      "AAPLc",
      "GOOGLc",
      "METAc",
      "AMZNc",
      "MSFTc",
      "TSLAc",
      "SPCXc",
      "SNDKc",
      "MSTRc",
    ]);
  });

  it("every B20 entry mirrors the docs-verified trade catalog exactly", () => {
    const b20 = BASE_PAIRS.filter((pair) => pair.kind === "b20-stock");
    expect(b20).toHaveLength(COINBASE_B20_TOKENIZED_STOCKS.length);
    for (const stock of COINBASE_B20_TOKENIZED_STOCKS) {
      const pair = b20.find((entry) => entry.symbol === stock.ticker);
      expect(pair, `missing tape entry for ${stock.ticker}`).toBeTruthy();
      expect(pair!.address.toLowerCase()).toBe(stock.address.toLowerCase());
      expect(pair!.chainlinkFeed?.toLowerCase()).toBe(stock.chainlinkFeed.toLowerCase());
      expect(pair!.address.toLowerCase().startsWith("0xb200")).toBe(true);
      // B20 decimals must stay on-chain-verified, never hardcoded.
      expect(pair!.decimals).toBeNull();
    }
  });

  it("keeps the whole registry on Base mainnet without duplicates", () => {
    const addresses = new Set<string>();
    const symbols = new Set<string>();
    for (const pair of BASE_PAIRS) {
      expect(pair.chainId).toBe(8453);
      const address = pair.address.toLowerCase();
      expect(addresses.has(address)).toBe(false);
      addresses.add(address);
      const symbol = pair.symbol.toLowerCase();
      expect(symbols.has(symbol)).toBe(false);
      symbols.add(symbol);
    }
    expect(B20_ORACLE_REGISTRY.toLowerCase()).toBe(
      "0x3f3e8cf41cdd3b1d118c16471ab0113dfddd5cad",
    );
  });

  it("resolves symbols case-insensitively and underlying tickers to B20", () => {
    expect(findBasePair("aaplc")?.symbol).toBe("AAPLc");
    expect(findBasePair("AAPL")?.symbol).toBe("AAPLc");
    expect(findBasePair("cbbtc")?.symbol).toBe("cbBTC");
    expect(findBasePair("BTC")).toBeNull(); // no underlying-ticker guessing for wrapped assets
    expect(findBasePair("")).toBeNull();
  });

  it("verifies official 0xb200 addresses regardless of case", () => {
    const official = verifyB20Address("0xb20000000000000000000078ee7ce2fE4908108C");
    expect(official.official).toBe(true);
    expect(official.symbol).toBe("NVDAc");
    expect(official.source).toBeTruthy();

    const lowercased = verifyB20Address(official.address.toLowerCase());
    expect(lowercased.official).toBe(true);
    expect(lowercased.symbol).toBe("NVDAc");
  });

  it("rejects unknown and look-alike addresses with official:false", () => {
    // Well-formed but unlisted 0xb200… address
    const unlisted = verifyB20Address("0xb200000000000000000000000000000000000001");
    expect(unlisted.official).toBe(false);
    expect(unlisted.symbol).toBeNull();
    expect(unlisted.source).toBeNull();
    expect(unlisted.reason).toMatch(/allowlist/i);

    // Wrapped asset address is official on the tape but is NOT a B20 stock
    const wrapped = verifyB20Address("0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf");
    expect(wrapped.official).toBe(false);

    expect(verifyB20Address("not-an-address").official).toBe(false);
    expect(verifyB20Address("").official).toBe(false);
  });

  it("looks pairs up by address and builds basescan links", () => {
    const pair = findBasePairByAddress("0xb2000000000000000000001e800a7f5189430cd0");
    expect(pair?.symbol).toBe("TSLAc");
    expect(basescanTokenUrl(pair!.address)).toBe(
      `https://basescan.org/token/${pair!.address}`,
    );
  });

  it("ships the non-US eligibility disclaimer verbatim", () => {
    expect(BASE_STOCKS_DISCLAIMER).toContain("eligible non-US persons");
    expect(BASE_STOCKS_DISCLAIMER).toContain("0xb200");
    expect(BASE_STOCKS_DISCLAIMER).toContain("Not financial advice");
  });
});
