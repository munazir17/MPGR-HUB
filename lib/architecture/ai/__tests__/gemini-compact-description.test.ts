import { describe, expect, it } from "vitest";
import {
  compactToolDescription,
  toGeminiFunctionDeclarations,
} from "../gemini-function-declarations";
import type { AnyAgentTool } from "@/lib/architecture/tools/agent-tool";

const LONG_X402_DESCRIPTION = [
  "Looks up whether a URL is an x402-gated resource and returns accepted payment requirements.",
  "This helper is only for discovery and never signs, never broadcasts, and never submits a payment.",
  "The argument name is resourceUrl — never url.",
  "Preparing a payment only creates a proposal for explicit confirmation.",
  "Filler sentence about seasonal XP streaks that is not needed in Gemini declarations.",
  "Recipient must come from the resource server; never invent a recipient.",
].join(" ");

const LONG_TRADE_DESCRIPTION = [
  "Prepares a Base Mainnet swap quote for review.",
  "Never signs and never broadcasts.",
  "Supported assets include ETH, USDC, and MPGR. Never call tokenized_stock_research for those.",
  "Dollar buys use fromToken USDC. Omit taker.",
  "Another filler line about leaderboard XP multipliers.",
].join(" ");

function fakeTool(id: string, description: string): AnyAgentTool {
  return {
    id,
    name: id,
    description,
    category: "research",
    mode: "prepare",
    riskLevel: "medium",
    requiresWallet: false,
    requiresConfirmation: true,
    inputSchema: {
      type: "object",
      properties: {
        resourceUrl: { type: "string", description: "https resource URL" },
      },
      required: ["resourceUrl"],
    },
    execute: async () => ({ success: true, toolId: id, metadata: { timestamp: new Date().toISOString() } }),
  };
}

describe("compactToolDescription", () => {
  it("keeps never-sign / never-broadcast / explicit confirmation / resourceUrl", () => {
    const compact = compactToolDescription(LONG_X402_DESCRIPTION);
    expect(compact.toLowerCase()).toContain("never signs");
    expect(compact.toLowerCase()).toContain("never broadcasts");
    expect(compact).toContain("resourceUrl");
    expect(compact.toLowerCase()).toContain("explicit confirmation");
    expect(compact.toLowerCase()).toContain("recipient");
    expect(compact).not.toMatch(/XP streaks/i);
  });

  it("keeps Base routing exclusions and supported-asset constraints", () => {
    const compact = compactToolDescription(LONG_TRADE_DESCRIPTION);
    expect(compact).toMatch(/Base Mainnet/);
    expect(compact.toLowerCase()).toContain("never signs");
    expect(compact.toLowerCase()).toContain("never broadcasts");
    expect(compact).toMatch(/Never call tokenized_stock_research/);
    expect(compact).toMatch(/ETH/);
    expect(compact).toMatch(/fromToken/);
    expect(compact).not.toMatch(/leaderboard XP/i);
  });

  it("does not mid-cut a safety sentence to 180 characters", () => {
    const safety =
      "This prepare tool never signs, never broadcasts, and only builds a proposal for explicit confirmation after resourceUrl is supplied on Base Mainnet with a server-provided recipient.";
    const compact = compactToolDescription(safety);
    expect(compact).toBe(safety);
    expect(compact.length).toBeGreaterThan(180);
  });

  it("toGeminiFunctionDeclarations preserves those phrases on descriptions", () => {
    const decls = toGeminiFunctionDeclarations([
      fakeTool("x402_prepare_payment", LONG_X402_DESCRIPTION),
      fakeTool("trade_prepare_swap", LONG_TRADE_DESCRIPTION),
    ]);
    const x402 = decls.find((d) => d.name === "x402_prepare_payment");
    const trade = decls.find((d) => d.name === "trade_prepare_swap");
    expect(x402?.description).toContain("resourceUrl");
    expect(x402?.description.toLowerCase()).toContain("never signs");
    expect(trade?.description).toMatch(/Never call tokenized_stock_research/);
    expect(x402?.parameters.required).toEqual(["resourceUrl"]);
  });
});
