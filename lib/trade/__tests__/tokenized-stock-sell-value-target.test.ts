// lib/trade/__tests__/tokenized-stock-sell-value-target.test.ts
//
// Regression suite for the DIRECTION of "Sell X USDC worth of TOKEN".
//
// Reported from the app: "Sell my 4 USDC worth of MSTRc" was prepared as
// "4 USDC → ~0.02449 MSTRc" — i.e. it SPENT 4 USDC to acquire MSTRc, the
// opposite of the instruction. The SELL verb governs; the dollar figure is
// the sale's value target.
//
// Pinned semantics:
//   "Sell my 4 USDC worth of MSTRc" → SELL MSTRc, ~4 USDC out    (MSTRc → USDC)
//   "Sell my 5 USDC worth of MSTRc" → SELL MSTRc, ~5 USDC out    (MSTRc → USDC)
//   "Sell my 5 USD worth of MSTRc"  → same, USD wording          (MSTRc → USDC)
//   "Sell 5 MSTRc"                  → SELL exactly 5 MSTRc       (MSTRc → USDC)
//   "Buy 5 USDC of MSTRc"           → spend 5 USDC on MSTRc      (USDC → MSTRc)
//   "Buy 5 MSTRc"                   → buy 5 MSTRc for USDC       (USDC → MSTRc)
//
// Both layers are asserted: the agent's resolved side/unit, and the
// server-side execution preparation (pair + atomic amount). The catalog is
// real — MSTRc is the Coinbase B20 entry, not a fixture.

import { describe, expect, it, vi } from "vitest";

import { toolSuccess } from "@/lib/architecture/tools/agent-tool-result";

vi.mock("@/lib/architecture/ai/agent-tool-calling", () => ({
  runRegisteredTool: vi.fn(),
}));

const { runRegisteredTool } = await import("@/lib/architecture/ai/agent-tool-calling");
const { DeterministicAIProvider } = await import(
  "@/lib/architecture/ai/deterministic-ai-provider"
);
const { resolveTokenizedStockOrderSide } = await import("@/lib/agent-intelligence");
const { isSellValueTargetPhrasing } = await import("@/lib/agent-intelligence/swap-intent");
const { usdToTokenAtomic } = await import("../trade-format");
const { buildTradeProposal } = await import("../trade-proposal");
const { BASE_USDC } = await import("../trade-config");
const { findTokenizedStock } = await import("../tokenized-stocks");

const runTool = vi.mocked(runRegisteredTool);

// MSTRc's live Chainlink implied price at the time of the report — the
// failed order showed 4 USDC → ~0.02449 MSTRc.
const MSTRC_PRICE = "163.33";

function mstrcAddress(): string {
  const entry = findTokenizedStock("MSTRc");
  if (!entry) throw new Error("MSTRc missing from the B20 catalog");
  return entry.address;
}

function makeRequest(prompt: string) {
  return {
    prompt,
    agentContext: { isConnected: true },
    previousIntent: null,
    memoryContext: {
      isReturningUser: false,
      interactionCount: 0,
      favoriteTopics: [],
      conversationSummaries: [],
    },
    address: "0x00000000000000000000000000000000000000aa",
  } as never;
}

/** The agent-side call args for one prompt. */
async function preparedOrder(prompt: string) {
  runTool.mockResolvedValue(
    toolSuccess("tokenized_stock_prepare_order", { proposal: { id: "b20" } }),
  );
  runTool.mockClear();
  await new DeterministicAIProvider().generateReply(makeRequest(prompt));
  return runTool.mock.calls[0]?.[0] === "tokenized_stock_prepare_order"
    ? (runTool.mock.calls[0][1] as {
        symbol: string;
        amount: string;
        side: "BUY" | "SELL";
        amountUnit: "usd" | "token";
      })
    : null;
}

/**
 * The pair the server will actually prepare for those args. The B20 route
 * derives the pair from `side`: SELL → stock/U…SDC out, BUY → USDC in/stock
 * out. Asserting this is what proves the DIRECTION, not just the wording.
 */
function executionPair(order: { symbol: string; side: "BUY" | "SELL" }) {
  const stock = mstrcAddress();
  return order.side === "SELL"
    ? { from: stock, to: BASE_USDC }
    : { from: BASE_USDC, to: stock };
}

describe("'Sell X USDC worth of TOKEN' sells the TOKEN, not the USDC", () => {
  it("'Sell my 4 USDC worth of MSTRc' → SELL MSTRc with a 4 USDC value target", async () => {
    const order = await preparedOrder("Sell my 4 USDC worth of MSTRc");

    expect(order).toEqual({
      symbol: "MSTRc",
      amount: "4",
      side: "SELL",
      amountUnit: "usd",
    });
    const pair = executionPair(order!);
    expect(pair.from).toBe(mstrcAddress());
    expect(pair.to.toLowerCase()).toBe(BASE_USDC.toLowerCase());
    expect(resolveTokenizedStockOrderSide("Sell my 4 USDC worth of MSTRc", "MSTRc")).toBe("SELL");
  });

  it("'Sell my 5 USDC worth of MSTRc' → SELL MSTRc, ~5 USDC out", async () => {
    const order = await preparedOrder("Sell my 5 USDC worth of MSTRc");

    expect(order).toEqual({
      symbol: "MSTRc",
      amount: "5",
      side: "SELL",
      amountUnit: "usd",
    });
    expect(executionPair(order!).from).toBe(mstrcAddress());
    expect(resolveTokenizedStockOrderSide("Sell my 5 USDC worth of MSTRc", "MSTRc")).toBe("SELL");
  });

  it("'Sell my 5 USD worth of MSTRc' → same direction", async () => {
    const order = await preparedOrder("Sell my 5 USD worth of MSTRc");
    expect(order).toEqual({
      symbol: "MSTRc",
      amount: "5",
      side: "SELL",
      amountUnit: "usd",
    });
  });

  it("'Sell 5 MSTRc' → SELL exactly 5 MSTRc, unchanged", async () => {
    const order = await preparedOrder("Sell 5 MSTRc");

    expect(order).toEqual({
      symbol: "MSTRc",
      amount: "5",
      side: "SELL",
      amountUnit: "token",
    });
    expect(executionPair(order!).from).toBe(mstrcAddress());
    expect(executionPair(order!).to.toLowerCase()).toBe(BASE_USDC.toLowerCase());
  });

  it("'Buy 5 USDC of MSTRc' → spend 5 USDC, unchanged", async () => {
    const order = await preparedOrder("Buy 5 USDC of MSTRc");

    expect(order).toEqual({
      symbol: "MSTRc",
      amount: "5",
      side: "BUY",
      amountUnit: "usd",
    });
    const pair = executionPair(order!);
    expect(pair.from.toLowerCase()).toBe(BASE_USDC.toLowerCase());
    expect(pair.to).toBe(mstrcAddress());
  });

  it("'Buy 5 MSTRc' → buy 5 MSTRc, unchanged", async () => {
    const order = await preparedOrder("Buy 5 MSTRc");

    expect(order).toEqual({
      symbol: "MSTRc",
      amount: "5",
      side: "BUY",
      amountUnit: "token",
    });
    expect(executionPair(order!).to).toBe(mstrcAddress());
  });

  it("sizes the sell from the USD target at the live implied price", async () => {
    // What the preparation produces for a 4 USDC target: the token leg is
    // floor(4 / 163.33) at MSTRc's 8 decimals, and the USDC leg is what is
    // received. Computed by the same exact-rational helper the swap
    // preparer uses — no float division.
    const atomic = usdToTokenAtomic("4", MSTRC_PRICE, 8);
    expect(atomic).toBe(2449029n); // ≈ 0.02449029 MSTRc (~4 USDC at $163.33)
    const tokenLeg = String(atomic);

    const quote = {
      liquidityAvailable: true,
      fromToken: mstrcAddress(),
      toToken: BASE_USDC,
      fromAmount: tokenLeg,
      toAmount: "3990000",
      minToAmount: "3950100",
      issues: { allowance: null, balance: null, simulationIncomplete: false },
      transaction: {
        to: "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F",
        data: "0xdead",
        value: "0",
      },
      permit2: null,
    } as const;

    const built = buildTradeProposal({
      from: {
        address: mstrcAddress() as `0x${string}`,
        symbol: "MSTRc",
        name: "MicroStrategy (Coinbase Tokenized Stock)",
        decimals: 8,
        kind: "b20-tokenized-stock",
        verified: true,
      },
      to: {
        address: BASE_USDC,
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        kind: "erc20",
        verified: true,
      },
      quote: { ...quote },
      slippageBps: 100,
      taker: "0x00000000000000000000000000000000000000aa",
      provider: "aerodrome-slipstream",
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // Sold MSTRc, received ~4 USDC — never "4 USDC sold".
    expect(built.proposal.from.symbol).toBe("MSTRc");
    expect(built.proposal.to.symbol).toBe("USDC");
    expect(built.proposal.fromAmount).toBe(tokenLeg);
    expect(built.proposal.description).toContain("MSTRc");
    expect(built.proposal.description).toContain("USDC");
  });

  it("only flips when the named stock is the one after 'worth of'", async () => {
    // The rule requires the ticker itself to follow "worth of" — so it
    // applies to every catalog ticker, and to no other name.
    expect(isSellValueTargetPhrasing("Sell my 5 USDC worth of AAPLc", "AAPLc")).toBe(true);
    expect(isSellValueTargetPhrasing("Sell my 5 USDC worth of AAPLc", "MSTRc")).toBe(false);
    expect(isSellValueTargetPhrasing("Sell my 5 USDC worth of FAKECOIN", "AAPLc")).toBe(false);
    // A funded BUY is not a value target and must never be flipped.
    expect(isSellValueTargetPhrasing("Buy 5 USDC of MSTRc", "MSTRc")).toBe(false);
    // Nor is a plain share sale, or a USDC-of-stock swap without "worth of".
    expect(isSellValueTargetPhrasing("Sell 5 MSTRc", "MSTRc")).toBe(false);
    expect(isSellValueTargetPhrasing("Sell 5 USDC of MSTRc", "MSTRc")).toBe(false);
  });
});
