import { describe, expect, it } from "vitest";

import { extractBaseSwapIntent, extractUnresolvedSwapOrder } from "@/lib/agent-intelligence";
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
describe("execution-order phrasings (live routing, not research)", () => {
  it("parses 'Sell 5 usdc of eth' as a USDC → ETH order with a size", () => {
    const intent = extractBaseSwapIntent("Sell 5 usdc of eth");
    expect(intent).not.toBeNull();
    expect(intent?.sell.symbol).toBe("USDC");
    expect(intent?.buy.symbol).toBe("ETH");
    expect(intent?.amount).toBe("5");
    expect(intent?.quoteOnly).toBe(false);
  });

  it("parses 'Buy 5 USDC of ETH' as spending 5 USDC for ETH", () => {
    const intent = extractBaseSwapIntent("Buy 5 USDC of ETH");
    expect(intent).not.toBeNull();
    expect(intent?.sell.symbol).toBe("USDC");
    expect(intent?.buy.symbol).toBe("ETH");
    expect(intent?.amount).toBe("5");
    expect(intent?.quoteOnly).toBe(false);
  });

  it("parses 'Sell my USDC worth of MSTRc' as an order with no size yet", () => {
    const intent = extractBaseSwapIntent("Sell my USDC worth of MSTRc");
    expect(intent).not.toBeNull();
    expect(intent?.sell.symbol).toBe("USDC");
    expect(intent?.buy.symbol).toBe("MSTRc");
    // No amount is invented — the caller asks for it.
    expect(intent?.amount).toBeNull();
    expect(intent?.quoteOnly).toBe(false);
  });

  it("parses 'sell all my USDC for cbADA' and 'swap 10 USDC worth of cbADA'", () => {
    const all = extractBaseSwapIntent("sell all my USDC for cbADA");
    expect(all?.sell.symbol).toBe("USDC");
    expect(all?.buy.symbol).toBe("cbADA");
    expect(all?.amount).toBeNull();

    const worthOf = extractBaseSwapIntent("swap 10 USDC worth of cbADA");
    expect(worthOf?.sell.symbol).toBe("USDC");
    expect(worthOf?.buy.symbol).toBe("cbADA");
    expect(worthOf?.amount).toBe("10");
  });

  it("still keeps one-token dollar buys on the USDC-funded path", () => {
    const dollars = extractBaseSwapIntent("Buy $25 of cbDOGE");
    expect(dollars?.sell.symbol).toBe("USDC");
    expect(dollars?.buy.symbol).toBe("cbDOGE");
    expect(dollars?.amount).toBe("25");
    expect(dollars?.amountIsDollar).toBe(true);

    const units = extractBaseSwapIntent("buy 25 cbDOGE");
    expect(units?.buy.symbol).toBe("cbDOGE");
    expect(units?.amount).toBe("25");
  });

  it("leaves price/ research phrasings to the research path", () => {
    expect(extractBaseSwapIntent("check cbADA price")).toBeNull();
    expect(extractBaseSwapIntent("what is the cbADA premium vs feed")).toBeNull();
    expect(extractBaseSwapIntent("how do I sell cbADA?")).toBeNull();
  });

  it("reads the possessive funding side of an order", () => {
    // "sell my 5 USDC worth of MSTRc" — the sell verb funds the trade; the
    // size belongs to USDC and MSTRc is what is acquired.
    const funded = extractBaseSwapIntent("Sell my 5 USDC worth of MSTRc");
    expect(funded?.sell.symbol).toBe("USDC");
    expect(funded?.buy.symbol).toBe("MSTRc");
    expect(funded?.amount).toBe("5");

    const possessed = extractBaseSwapIntent("swap my 2 usdc for eth");
    expect(possessed?.sell.symbol).toBe("USDC");
    expect(possessed?.buy.symbol).toBe("ETH");
    expect(possessed?.amount).toBe("2");

    const bought = extractBaseSwapIntent("buy my 5 usdc of eth");
    expect(bought?.sell.symbol).toBe("USDC");
    expect(bought?.buy.symbol).toBe("ETH");
    expect(bought?.amount).toBe("5");
  });

  it("reads 'X USDC of TOKEN' both ways round", () => {
    const buy = extractBaseSwapIntent("Buy 5 USDC of ETH");
    expect(buy?.sell.symbol).toBe("USDC");
    expect(buy?.buy.symbol).toBe("ETH");
    expect(buy?.amount).toBe("5");

    const sell = extractBaseSwapIntent("Sell 5 USDC of ETH");
    expect(sell?.sell.symbol).toBe("USDC");
    expect(sell?.buy.symbol).toBe("ETH");
    expect(sell?.amount).toBe("5");

    const stock = extractBaseSwapIntent("Buy 10 USDC of MSTRc");
    expect(stock?.sell.symbol).toBe("USDC");
    expect(stock?.buy.symbol).toBe("MSTRc");
    expect(stock?.amount).toBe("10");
  });
});

// A sized order over an asset this app does not support must be reported,
// never silently prepared — the reason extractUnresolvedSwapOrder exists.
describe("extractUnresolvedSwapOrder", () => {
  it("names the unsupported operand of a sized order", () => {
    expect(extractUnresolvedSwapOrder("buy 10 USDC of FAKECOIN")).toEqual({
      sell: "USDC",
      buy: "FAKECOIN",
      amount: "10",
      unresolved: ["FAKECOIN"],
    });
    expect(extractUnresolvedSwapOrder("sell 5 SCAMCOIN for USDC")?.unresolved).toEqual([
      "SCAMCOIN",
    ]);
    expect(extractUnresolvedSwapOrder("buy $10 of FAKECOIN")?.unresolved).toEqual(["FAKECOIN"]);
  });

  it("stays silent for supported orders, unsized prompts and conversation", () => {
    expect(extractUnresolvedSwapOrder("Swap 10 USDC to cbADA")).toBeNull();
    expect(extractUnresolvedSwapOrder("Buy 5 USDC of ETH")).toBeNull();
    expect(extractUnresolvedSwapOrder("buy me a coffee")).toBeNull();
    expect(extractUnresolvedSwapOrder("swap 1 eth")).toBeNull();
    expect(extractUnresolvedSwapOrder("check MSTRc price")).toBeNull();
  });
});
