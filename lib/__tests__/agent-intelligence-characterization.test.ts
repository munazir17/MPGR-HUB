import { describe, expect, it } from "vitest";
import {
  detectIntent,
  generateIntelligentReply,
  isTradePrompt,
  isTradeQuotePrompt,
  extractTradeSymbol,
  extractCryptoSwapPair,
  extractCryptoSwapAmount,
  isTransferPrompt,
  extractTransferRequest,
  extractX402ResourceUrl,
  isX402PaymentPrompt,
} from "@/lib/agent-intelligence";
import type { AgentContext } from "@/lib/agent-context";

const mockContext: AgentContext = {
  isConnected: true,
  portfolio: {
    walletBalance: 1000,
    stakedBalance: 500,
    lockedBalance: 200,
    totalHoldings: 1700,
    claimableRewards: 50,
    nativeEth: "0.5",
    usdc: "100",
  },
  xp: {
    xp: 5000,
    level: 5,
    nextLevel: 6,
    xpIntoLevel: 200,
    xpNeededForLevel: 1000,
    progress: 20,
    streak: 3,
    referralCount: 2,
  },
  holderTier: null,
  premium: null,
  rewards: null,
  staking: null,
  tokenLock: null,
  season: null,
};

describe("agent-intelligence Characterization Tests (Task 13)", () => {
  describe("detectIntent", () => {
    it("detects greeting as general_help with greeting flag true", () => {
      const res = detectIntent("hello", null);
      expect(res.intent).toBe("general_help");
      expect(res.greeting).toBe(true);
    });

    it("detects portfolio request correctly", () => {
      const res = detectIntent("show my portfolio", null);
      expect(res.intent).toBe("portfolio_summary");
      expect(res.greeting).toBe(false);
    });

    it("detects research query for explanation prompts", () => {
      const res = detectIntent("what is mpgr hub?", null);
      expect(res.intent).toBe("research_query");
    });
  });

  describe("Trade and transfer extraction helpers", () => {
    it("identifies trade prompts and extracts symbol", () => {
      const prompt = "Prepare a buy quote for 10 AAPLc";
      expect(isTradePrompt(prompt)).toBe(true);
      expect(isTradeQuotePrompt(prompt)).toBe(true);
      expect(extractTradeSymbol(prompt)).toBe("AAPLc");
    });

    it("extracts crypto swap pair and amount", () => {
      const prompt = "swap 5 USDC to ETH";
      const pair = extractCryptoSwapPair(prompt);
      expect(pair).toEqual({ fromToken: "USDC", toToken: "ETH" });
      const amount = extractCryptoSwapAmount(prompt);
      expect(amount).toBe("5");
    });

    it("identifies transfer prompt and extracts details", () => {
      const prompt = "send 10 USDC to 0x1234567890123456789012345678901234567890";
      expect(isTransferPrompt(prompt)).toBe(true);
      const req = extractTransferRequest(prompt);
      expect(req).toEqual({
        token: "USDC",
        amount: "10",
        recipient: "0x1234567890123456789012345678901234567890",
      });
    });

    it("extracts x402 resource url and prompt", () => {
      const prompt = "check out https://example.com/protected and prepare payment";
      expect(isX402PaymentPrompt(prompt)).toBe(true);
      expect(extractX402ResourceUrl(prompt)).toBe("https://example.com/protected");
    });
  });

  describe("generateIntelligentReply", () => {
    it("generates portfolio summary reply from context", () => {
      const result = generateIntelligentReply("show my portfolio", mockContext, null);
      expect(result.intent).toBe("portfolio_summary");
      expect(result.reply).toContain("Wallet / portfolio on Base");
      expect(result.reply).toContain("1K MPGR in wallet");
    });

    it("returns not connected prompt when wallet is disconnected", () => {
      const disconnectedContext: AgentContext = {
        ...mockContext,
        isConnected: false,
      };
      const result = generateIntelligentReply("show my portfolio", disconnectedContext, null);
      expect(result.intent).toBe("general_help");
      expect(result.reply).toContain("Connect your wallet first");
    });
  });
});
