import { describe, expect, it } from "vitest";
import { selectAdvertisedToolsForPrompt } from "../agent-tool-calling";

function ids(prompt: string): string[] {
  return selectAdvertisedToolsForPrompt(prompt).map((tool) => tool.id);
}

const TRADE_TOOLS = [
  "trade_get_price",
  "trade_prepare_swap",
  "tokenized_stock_research",
  "tokenized_stock_prepare_order",
];
const MARKET_TOOLS = ["trade_get_price", "tokenized_stock_research", "market_intelligence"];
const X402_TOOLS = ["x402_discover_resource", "x402_prepare_payment"];
const TRANSFER_TOOLS = ["transfer_prepare_send"];
const YIELD_TOOLS = ["yield_opportunities", "yield_estimator", "yield_comparison"];
const UNRELATED = [
  ...TRADE_TOOLS,
  ...MARKET_TOOLS,
  ...X402_TOOLS,
  ...TRANSFER_TOOLS,
  ...YIELD_TOOLS,
  "wallet_analyzer",
  "agentkit_wallet_details",
];

describe("selectAdvertisedToolsForPrompt", () => {
  it("simple hi => no unrelated tools", () => {
    const selected = ids("hi");
    expect(selected).toEqual([]);
    for (const id of UNRELATED) expect(selected).not.toContain(id);
    expect(selected.some((id) => id.toLowerCase().includes("execute"))).toBe(false);
  });

  it("what is MPGR? => no trading tools", () => {
    const selected = ids("what is MPGR?");
    for (const id of TRADE_TOOLS) expect(selected).not.toContain(id);
    expect(selected).not.toContain("trade_prepare_swap");
    expect(selected).not.toContain("tokenized_stock_prepare_order");
  });

  it("check AAPLc price => stock/market tools only", () => {
    const selected = ids("check AAPLc price");
    expect(selected).toEqual(expect.arrayContaining(MARKET_TOOLS));
    expect(selected).not.toContain("trade_prepare_swap");
    expect(selected).not.toContain("tokenized_stock_prepare_order");
    expect(selected).not.toContain("x402_prepare_payment");
    expect(selected).not.toContain("transfer_prepare_send");
    expect(selected).not.toContain("yield_opportunities");
    expect(selected.some((id) => id.toLowerCase().includes("execute"))).toBe(false);
  });

  it("buy $5 AAPLc => required trading tools preserved", () => {
    const selected = ids("buy $5 AAPLc");
    for (const id of TRADE_TOOLS) expect(selected).toContain(id);
    expect(selected).not.toContain("x402_prepare_payment");
    expect(selected).not.toContain("yield_opportunities");
    expect(selected).not.toContain("transfer_prepare_send");
    expect(selected.some((id) => id.toLowerCase().includes("execute"))).toBe(false);
  });

  it("x402 request => x402 tools available", () => {
    const selected = ids(
      "Prepare a payment proposal for this x402 resource: https://x402-demo-discovery-endpoint.vercel.app/protected",
    );
    for (const id of X402_TOOLS) expect(selected).toContain(id);
  });

  it("transfer request => transfer tool available", () => {
    const selected = ids(
      "Prepare a transfer of 0.000001 ETH to 0x00000000000000000000000000000000000000aa. Do not execute it.",
    );
    for (const id of TRANSFER_TOOLS) expect(selected).toContain(id);
  });

  it("yield request => yield tools available", () => {
    const selected = ids("Compare the current MPGR yield opportunities for me.");
    for (const id of YIELD_TOOLS) expect(selected).toContain(id);
  });
});
