import { describe, expect, it } from "vitest";
import { buildGatedCapabilityInstructions, selectAdvertisedToolsForPrompt } from "../agent-tool-calling";

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

describe("buildGatedCapabilityInstructions vs advertised tools", () => {
  it("hi prompt has no capability essays and no execute verbs", () => {
    const text = buildGatedCapabilityInstructions("hi").join("\n").toLowerCase();
    expect(text).toBe("");
    expect(text).not.toMatch(/execute|sign and submit|broadcast/);
  });

  it("buy $5 AAPLc keeps prepare_order instructions and never advertise execute", () => {
    const selected = ids("buy $5 AAPLc");
    expect(selected.some((id) => id.toLowerCase().includes("execute"))).toBe(false);
    const text = buildGatedCapabilityInstructions("buy $5 AAPLc").join("\n");
    expect(text).toContain("tokenized_stock_prepare_order");
    expect(text.toLowerCase()).not.toContain("wallet_execute");
  });
});

const STOCKS_TOOLS = [
  "get_tape",
  "get_pair",
  "get_premium",
  "verify_b20_contract",
  "describe_x402_tape",
];

describe("Base Stocks Agent prompt gating", () => {
  it("chip 1 — NVDAc premium vs feed advertises the tape tools and the premium essay", () => {
    const prompt = "Show NVDAc premium vs feed.";
    const advertised = ids(prompt);
    expect(advertised).toEqual(expect.arrayContaining(["get_premium", "get_pair", "get_tape"]));
    const text = buildGatedCapabilityInstructions(prompt).join("\n").toLowerCase();
    expect(text).toContain("base stocks tools");
    expect(text).toContain("never invent");
  });

  it("chip 2 — quote USDC → AAPLc still routes through the trade tool family", () => {
    const prompt = "Quote 10 USDC → AAPLc on Base.";
    expect(ids(prompt)).toEqual(expect.arrayContaining(["trade_prepare_swap", "prepare_swap", "tokenized_stock_prepare_order"]));
  });

  it("chip 3 — Coinbase stock holdings advertises get_stock_holdings, never XP/portfolio tools", () => {
    const prompt = "What are my Coinbase stock holdings on Base?";
    const advertised = ids(prompt);
    expect(advertised).toContain("get_stock_holdings");
    expect(advertised).not.toContain("portfolio_overview");
    expect(advertised).not.toContain("xp_balance");
  });

  it("chip 4 — verify a look-alike 0xb200 address advertises verify_b20_contract", () => {
    const prompt = "Verify this 0xb200 contract: 0xb200111111111111111111111111111111111111";
    expect(ids(prompt)).toContain("verify_b20_contract");
  });

  it("chip 5 — paid tape snapshot advertises describe_x402_tape + the x402 payment tools", () => {
    const prompt = "Live tape snapshot $0.02 x402.";
    const advertised = ids(prompt);
    expect(advertised).toEqual(
      expect.arrayContaining(["describe_x402_tape", "get_tape", "x402_discover_resource", "x402_prepare_payment"]),
    );
    const text = buildGatedCapabilityInstructions(prompt).join("\n");
    expect(text).toContain("/api/x402/tape");
    expect(text).toContain("x402_prepare_payment");
  });

  it("chip 6 — prepare swap USDC → TSLAc advertises prepare_swap and the stock essay", () => {
    const prompt = "Prepare a swap of 10 USDC to TSLAc on Base. I will confirm before anything is signed.";
    const advertised = ids(prompt);
    expect(advertised).toEqual(expect.arrayContaining(["prepare_swap", "tokenized_stock_prepare_order"]));
    const text = buildGatedCapabilityInstructions(prompt).join("\n").toLowerCase();
    expect(text).toContain("base stocks tools");
  });

  it("unrelated prompts never advertise the stocks tools", () => {
    for (const prompt of ["hi", "what is the MPGR price?", "explain staking", "send 10 USDC to alice.base.eth"]) {
      const advertised = ids(prompt);
      for (const tool of STOCKS_TOOLS) expect(advertised).not.toContain(tool);
      expect(advertised).not.toContain("get_stock_holdings");
    }
  });

  it("MPGR premium-tier style questions do not trip the stock premium detector", () => {
    const advertised = ids("What does MPGR Premium include?");
    expect(advertised).not.toContain("get_premium");
  });

  it("stock tool ids are read/prepare-only catalog entries (no execute verb leaks)", () => {
    const text = buildGatedCapabilityInstructions("Show NVDAc premium vs feed.").join("\n").toLowerCase();
    expect(text).not.toContain("execute the swap");
    expect(text).not.toContain("sign automatically");
  });
});
