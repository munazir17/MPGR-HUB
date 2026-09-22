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

  // Official underlying-company names re-checked against Base's verified
  // registry (base.org/stocks) on 2026-09-22. Two of these deliberately
  // differ from the older naming still used by the pre-existing trade
  // catalog: MSTRc is "Strategy" (MicroStrategy renamed) and SNDKc is
  // "SanDisk".
  const OFFICIAL_COMPANIES: Record<string, string> = {
    NVDAc: "NVIDIA",
    AAPLc: "Apple",
    GOOGLc: "Alphabet",
    METAc: "Meta",
    AMZNc: "Amazon",
    MSFTc: "Microsoft",
    TSLAc: "Tesla",
    MSTRc: "Strategy",
    SNDKc: "SanDisk",
    SPCXc: "SpaceX",
    COINc: "Coinbase",
    CRCLc: "Circle",
    INTCc: "Intel",
  };
  const NOT_YET_LIVE = ["COINc", "CRCLc", "INTCc"];

  it("every B20 entry mirrors the docs-verified trade catalog addresses exactly", () => {
    const b20 = BASE_PAIRS.filter((pair) => pair.kind === "b20-stock");
    expect(b20).toHaveLength(COINBASE_B20_TOKENIZED_STOCKS.length);
    for (const stock of COINBASE_B20_TOKENIZED_STOCKS) {
      const pair = b20.find((entry) => entry.symbol === stock.ticker);
      expect(pair, `missing tape entry for ${stock.ticker}`).toBeTruthy();
      // The address is the authority — Base docs state B20 metadata is
      // mutable and tokens must be identified by address.
      expect(pair!.address.toLowerCase()).toBe(stock.address.toLowerCase());
      expect(pair!.address.toLowerCase().startsWith("0xb200")).toBe(true);
      // B20 decimals must stay on-chain-verified, never hardcoded.
      expect(pair!.decimals).toBeNull();
      expect(pair!.company).toBe(OFFICIAL_COMPANIES[stock.ticker]);
      expect(pair!.name).toBe(`${OFFICIAL_COMPANIES[stock.ticker]} Tokenized Stock (Coinbase)`);
    }
  });

  it("marks exactly the ten live stocks live, and the three published-but-unlaunched ones not tradable", () => {
    const b20 = BASE_PAIRS.filter((pair) => pair.kind === "b20-stock");
    expect(b20.filter((pair) => pair.live).map((pair) => pair.symbol).sort()).toEqual(
      Object.keys(OFFICIAL_COMPANIES)
        .filter((ticker) => !NOT_YET_LIVE.includes(ticker))
        .sort(),
    );
    // base.org/stocks lists 10 live Coinbase Tokenized Stocks.
    expect(b20.filter((pair) => pair.live)).toHaveLength(10);
    expect(TAPE_STOCK_PAIRS.every((pair) => pair.live)).toBe(true);

    for (const ticker of NOT_YET_LIVE) {
      const pair = b20.find((entry) => entry.symbol === ticker)!;
      // Coinbase published these addresses, but Base's official list removed
      // the rows as not live yet (base/docs#1955) — no issued supply, and no
      // Chainlink feed to price them, so none may be surfaced as tradable.
      expect(pair.live).toBe(false);
      expect(pair.onTape).toBe(false);
      expect(pair.chainlinkFeed).toBeUndefined();
      expect(pair.notes).toMatch(/NOT LIVE/i);
    }
    // Every wrapped asset and native USDC is live.
    expect(
      BASE_PAIRS.filter((pair) => pair.kind !== "b20-stock").every((pair) => pair.live),
    ).toBe(true);
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
    expect(unlisted.status).toBe("unlisted");
    expect(unlisted.live).toBe(false);
    expect(unlisted.symbol).toBeNull();
    expect(unlisted.source).toBeNull();
    expect(unlisted.reason).toMatch(/not an official Coinbase Tokenized Stock/i);

    // Wrapped asset address is official on the tape but is NOT a B20 stock
    const wrapped = verifyB20Address("0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf");
    expect(wrapped.official).toBe(false);
    expect(wrapped.status).toBe("unlisted");

    expect(verifyB20Address("not-an-address").official).toBe(false);
    expect(verifyB20Address("").official).toBe(false);
  });

  it("does not treat a 0xB200 prefix as proof of a tokenized stock", () => {
    // Coinbase also issues B20-standard wrapped crypto at 0xB200… addresses
    // (cbHYPE, cbZEC on coinbase.com/campaigns/wrapped-assets). The verifier
    // is registry-driven, so these are unlisted stocks, not official ones.
    for (const address of [
      "0xB200000000000000000000451d033a5000cb479e", // cbHYPE
      "0xB2000000000000000000008501b13360000cb2EC", // cbZEC
    ]) {
      const result = verifyB20Address(address);
      expect(result.official).toBe(false);
      expect(result.status).toBe("unlisted");
      expect(result.live).toBe(false);
    }
  });

  it("answers announced-not-live — never tradable — for the published-but-unlaunched B20 addresses", () => {
    const coin = verifyB20Address("0xb200000000000000000000c85a31389D71F3ecfb"); // COINc
    expect(coin.official).toBe(false);
    expect(coin.status).toBe("announced-not-live");
    expect(coin.live).toBe(false);
    expect(coin.symbol).toBe("COINc");
    expect(coin.company).toBe("Coinbase");
    expect(coin.chainlinkFeed).toBeNull();
    expect(coin.reason).toMatch(/NOT LIVE/);

    const circle = verifyB20Address("0xB20000000000000000000019f6E7C675b73C2e4D"); // CRCLc
    expect(circle.status).toBe("announced-not-live");
    const intel = verifyB20Address("0xB2000000000000000000004AFF16039bA04bdFBc"); // INTCc
    expect(intel.status).toBe("announced-not-live");

    // The ten live stocks stay official:true.
    const apple = verifyB20Address("0xb200000000000000000000C2e324d24d7eEcd1fb");
    expect(apple.official).toBe(true);
    expect(apple.status).toBe("live");
    expect(apple.company).toBe("Apple");
    // AAPL/USD Chainlink feed on Base, transcribed from the official Base
    // docs table (docs.base.org tokenized stocks).
    expect(apple.chainlinkFeed?.toLowerCase()).toBe(
      "0x787f13dea48db0897cbcdd985de77809d837f988",
    );
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
