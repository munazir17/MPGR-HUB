import { describe, expect, it } from "vitest";

import { extractBaseSwapIntent } from "@/lib/agent-intelligence";
import { extractCryptoSwapPair } from "@/lib/agent-intelligence";

// The extended catalog parser is what makes "Swap 10 USDC to cbADA" and
// pasted contract addresses reach the existing swap routes at all. These
// tests pin the supported universe and the fail-closed edges.

describe("extractBaseSwapIntent", () => {
  it("parses a wrapped-asset swap by symbol with an amount", () => {
    const intent = extractBaseSwapIntent("Swap 10 USDC to cbADA");
    expect(intent).not.toBeNull();
    expect(intent?.sell.symbol).toBe("USDC");
    expect(intent?.sell.verified).toBe(true);
    expect(intent?.buy.symbol).toBe("cbADA");
    expect(intent?.amount).toBe("10");
    expect(intent?.amountIsDollar).toBe(false);
    expect(intent?.quoteOnly).toBe(false);
  });

  it("parses a raw supported contract address as the buy side", () => {
    const intent = extractBaseSwapIntent(
      "Swap 10 USDC to 0xcbADA732173e39521CDBE8bf59a6Dc85A9fc7b8c",
    );
    expect(intent).not.toBeNull();
    // A supported address resolves to its catalog entry (verified).
    expect(intent?.buy.symbol).toBe("cbADA");
    expect(intent?.buy.verified).toBe(true);
    expect(intent?.buy.address.toLowerCase()).toBe(
      "0xcbada732173e39521cdbe8bf59a6dC85A9fc7b8c".toLowerCase(),
    );
    expect(intent?.amount).toBe("10");
  });

  it("keeps an unknown address unverified instead of rejecting it", () => {
    const intent = extractBaseSwapIntent(
      "swap 5 USDC to 0x1111111111111111111111111111111111111111",
    );
    expect(intent).not.toBeNull();
    expect(intent?.buy.symbol).toBeNull();
    expect(intent?.buy.verified).toBe(false);
    expect(intent?.buy.address.toLowerCase()).toBe(
      "0x1111111111111111111111111111111111111111",
    );
  });

  it("flags quote phrasing so callers never prepare from it", () => {
    const quote = extractBaseSwapIntent("Quote 10 USDC to cbADA");
    expect(quote?.quoteOnly).toBe(true);
    expect(quote?.amount).toBe("10");

    const howMuch = extractBaseSwapIntent("How much cbBTC do I get for 0.1 ETH?");
    expect(howMuch?.quoteOnly).toBe(true);
    expect(howMuch?.amount).toBe("0.1");
    expect(howMuch?.sell.symbol).toBe("ETH");
    expect(howMuch?.buy.symbol).toBe("cbBTC");
  });

  it("parses dollar buys as USDC-funded", () => {
    const intent = extractBaseSwapIntent("Buy $25 of cbDOGE");
    expect(intent?.sell.symbol).toBe("USDC");
    expect(intent?.buy.symbol).toBe("cbDOGE");
    expect(intent?.amount).toBe("25");
    expect(intent?.amountIsDollar).toBe(true);
  });

  it("leaves a dollar amount null when the sell token is not USDC", () => {
    const intent = extractBaseSwapIntent("swap $50 of cbBTC to cbADA");
    expect(intent).not.toBeNull();
    // No unit conversion is invented — the caller must ask.
    expect(intent?.amount).toBeNull();
  });

  it("returns no intent without an amount and never invents one", () => {
    const intent = extractBaseSwapIntent("Swap USDC to ETH");
    expect(intent).not.toBeNull();
    expect(intent?.amount).toBeNull();
  });

  it("ignores prompts that are not swappable catalog pairs", () => {
    expect(extractBaseSwapIntent("What is MPGR HUB?")).toBeNull();
    expect(extractBaseSwapIntent("swap 10 FOOBAR to WHOPS")).toBeNull();
    expect(extractBaseSwapIntent("swap 10 USDC to USDC")).toBeNull();
    expect(extractBaseSwapIntent("swap -10 USDC to cbADA")).toBeNull();
  });

  it("does not mis-read wrapped tickers as core tokens", () => {
    // "cbETH" contains "eth": the core parser must decline it, and the
    // extended parser must resolve the real wrapped token.
    expect(extractCryptoSwapPair("swap 10 USDC to cbETH")).toBeNull();
    const intent = extractBaseSwapIntent("swap 10 USDC to cbETH");
    expect(intent?.buy.symbol).toBe("cbETH");
  });
});
