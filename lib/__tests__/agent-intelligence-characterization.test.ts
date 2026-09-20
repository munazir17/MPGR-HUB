import { describe, expect, it } from "vitest";
import {
  detectIntent,
  generateIntelligentReply,
  isTradePrompt,
  isTradeQuotePrompt,
  isTradeSellPrompt,
  extractTradeSymbol,
  extractTradeHumanAmount,
  extractCryptoSwapPair,
  extractCryptoSwapAmount,
  isCryptoSwapQuotePrompt,
  isTransferPrompt,
  extractTransferRequest,
  extractX402ResourceUrl,
  isX402PaymentPrompt,
  AGENT_INTENTS,
} from "@/lib/agent-intelligence";
import type { AgentContext } from "@/lib/agent-context";
import type { ConversationMemoryContext } from "@/lib/architecture/memory/memory-context";

const emptyMemory: ConversationMemoryContext = {
  relevantHistory: [],
  conversationSummaries: [],
  sessionTurnCount: 0,
  sessionRecentTopics: [],
  interactionCount: 0,
  lastAction: null,
  isReturningUser: false,
  dominantRecentIntent: null,
  favoriteTopics: [],
  walletDelta: null,
  mostUsedCommands: [],
  recentPages: [],
  preferredToken: "MPGR",
};

const mockFullContext: AgentContext = {
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
  holderTier: {
    tierLabel: "Bronze",
    totalScore: 1700,
    nextTierLabel: "Silver",
    progressToNextTier: 45,
    amountToNextTier: 800,
    votingWeight: 1700,
    reputationScore: 50,
  },
  premium: {
    isPremium: true,
    tierLabel: "Plus",
    xpMultiplier: 1.25,
    rewardsMultiplier: 1.2,
    nextTierLabel: "Pro",
    progressToNextTier: 20,
    amountToNextTier: 300,
  },
  rewards: {
    claimableTotal: 50,
    totalClaimed: 250,
  },
  staking: {
    totalStaked: 500,
    earnedRewards: 15,
    currentAPRPercent: 14.5,
  },
  tokenLock: {
    totalLocked: 200,
    activeLocksCount: 1,
    upcomingUnlockAt: "2026-10-15T00:00:00.000Z",
  },
  season: {
    seasonNumber: 3,
    seasonPoints: 450,
    level: 4,
    progress: 60,
  },
};

describe("agent-intelligence Characterization & Extracted Modules (Task 13)", () => {
  describe("types: AGENT_INTENTS integrity", () => {
    it("preserves exact list of 19 defined agent intents", () => {
      expect(AGENT_INTENTS).toHaveLength(19);
      expect(AGENT_INTENTS).toContain("portfolio_summary");
      expect(AGENT_INTENTS).toContain("research_query");
      expect(AGENT_INTENTS).toContain("market_overview");
      expect(AGENT_INTENTS).toContain("suggest_next_action");
    });
  });

  describe("prompt-parsers: entities, trade, transfer, and x402 extraction", () => {
    it("extracts Coinbase tokenized stock symbol, side, and human amounts", () => {
      const buyPrompt = "Prepare a buy quote for $50 worth of AAPLc";
      expect(isTradePrompt(buyPrompt)).toBe(true);
      expect(isTradeQuotePrompt(buyPrompt)).toBe(true);
      expect(isTradeSellPrompt(buyPrompt)).toBe(false);
      expect(extractTradeSymbol(buyPrompt)).toBe("AAPLc");
      expect(extractTradeHumanAmount(buyPrompt)).toBe("50");

      const sellPrompt = "Sell 10 shares of TSLA";
      expect(isTradePrompt(sellPrompt)).toBe(true);
      expect(isTradeSellPrompt(sellPrompt)).toBe(true);
      expect(extractTradeSymbol(sellPrompt)).toBe("TSLAc");
      expect(extractTradeHumanAmount(sellPrompt)).toBe("10");
    });

    it("extracts crypto swap pair and amount accurately", () => {
      const prompt = "swap 2.5 WETH to USDC";
      expect(isCryptoSwapQuotePrompt(prompt)).toBe(true);
      const pair = extractCryptoSwapPair(prompt);
      expect(pair).toEqual({ fromToken: "WETH", toToken: "USDC" });
      const amount = extractCryptoSwapAmount(prompt);
      expect(amount).toBe("2.5");
    });

    it("extracts Base transfer requests with address or Basename", () => {
      const hexPrompt = "send 15 MPGR to 0x1234567890123456789012345678901234567890";
      expect(isTransferPrompt(hexPrompt)).toBe(true);
      expect(extractTransferRequest(hexPrompt)).toEqual({
        token: "MPGR",
        amount: "15",
        recipient: "0x1234567890123456789012345678901234567890",
      });

      const basePrompt = "transfer 1.2 ETH to jesse.base.eth";
      expect(isTransferPrompt(basePrompt)).toBe(true);
      expect(extractTransferRequest(basePrompt)).toEqual({
        token: "ETH",
        amount: "1.2",
        recipient: "jesse.base.eth",
      });
    });

    it("extracts and validates x402 resource URLs", () => {
      const validPrompt = "inspect https://api.payai.network/data.json for x402 payment";
      expect(isX402PaymentPrompt(validPrompt)).toBe(true);
      expect(extractX402ResourceUrl(validPrompt)).toBe("https://api.payai.network/data.json");

      const invalidHttpPrompt = "inspect http://insecure.site/test";
      expect(extractX402ResourceUrl(invalidHttpPrompt)).toBeNull();
    });
  });

  describe("intent-detector: prioritization, follow-ups, and memory resolution", () => {
    it("prioritizes direct action commands over general help", () => {
      expect(detectIntent("open rewards", null).intent).toBe("open_rewards");
      expect(detectIntent("take me to staking", null).intent).toBe("open_staking");
      expect(detectIntent("open leaderboard", null).intent).toBe("open_leaderboard");
      expect(detectIntent("what should i do next?", null).intent).toBe("suggest_next_action");
    });

    it("distinguishes greeting from general help", () => {
      const greetingRes = detectIntent("hey there", null);
      expect(greetingRes.intent).toBe("general_help");
      expect(greetingRes.greeting).toBe(true);

      const helpRes = detectIntent("what can you do?", null);
      expect(helpRes.intent).toBe("general_help");
      expect(helpRes.greeting).toBe(false);
    });

    it("resolves conversational pronoun follow-ups using previousIntent", () => {
      const followUpRes = detectIntent("how about that?", "staking_summary");
      expect(followUpRes.intent).toBe("staking_summary");
    });

    it("resolves dominant recent intent from ConversationMemoryContext on follow-ups", () => {
      const mockMemory: ConversationMemoryContext = {
        ...emptyMemory,
        isReturningUser: true,
        dominantRecentIntent: "season_progress",
        favoriteTopics: ["season_progress"],
        sessionRecentTopics: ["season_progress"],
      };

      const res = detectIntent("what else about it?", null, mockMemory);
      expect(res.intent).toBe("season_progress");
    });
  });

  describe("reply-generators: grounded replies across all domain handlers", () => {
    it("generates XP status reply correctly", () => {
      const res = generateIntelligentReply("how much xp do i have?", mockFullContext, null);
      expect(res.intent).toBe("xp_status");
      expect(res.reply).toContain("Level 5");
      expect(res.reply).toContain("5K XP total");
    });

    it("generates Holder Tier reply correctly", () => {
      const res = generateIntelligentReply("what is my holder tier?", mockFullContext, null);
      expect(res.intent).toBe("holder_tier");
      expect(res.reply).toContain("Bronze Holder Tier");
      expect(res.reply).toContain("Silver");
    });

    it("generates Premium status reply correctly", () => {
      const res = generateIntelligentReply("my premium status", mockFullContext, null);
      expect(res.intent).toBe("premium_status");
      expect(res.reply).toContain("Plus Premium tier");
      expect(res.reply).toContain("1.25× XP");
    });

    it("generates Staking summary reply correctly", () => {
      const res = generateIntelligentReply("staking position", mockFullContext, null);
      expect(res.intent).toBe("staking_summary");
      expect(res.reply).toContain("500 MPGR staked");
      expect(res.reply).toContain("14.5% APR");
    });

    it("generates Claimable rewards reply correctly", () => {
      const res = generateIntelligentReply("what rewards can i claim?", mockFullContext, null);
      expect(res.intent).toBe("claimable_rewards");
      expect(res.reply).toContain("50 MPGR claimable");
      expect(res.reply).toContain("15 MPGR in staking rewards");
    });

    it("generates Locked tokens reply correctly with upcoming unlock date", () => {
      const res = generateIntelligentReply("my token lock", mockFullContext, null);
      expect(res.intent).toBe("locked_tokens");
      expect(res.reply).toContain("200 MPGR locked");
      expect(res.reply).toContain("Oct 15");
    });

    it("generates Season progress reply correctly", () => {
      const res = generateIntelligentReply("season pass progress", mockFullContext, null);
      expect(res.intent).toBe("season_progress");
      expect(res.reply).toContain("Season 3");
      expect(res.reply).toContain("450 season points");
    });

    it("generates Suggest next action reply recommending reward claiming when claimable > 0", () => {
      const res = generateIntelligentReply("what should i do next?", mockFullContext, null);
      expect(res.intent).toBe("suggest_next_action");
      expect(res.reply).toContain("claiming your rewards is the best next move");
    });

    it("appends memory recall notes when returning user context is present", () => {
      const mockMemoryWithDelta: ConversationMemoryContext = {
        ...emptyMemory,
        isReturningUser: true,
        dominantRecentIntent: "xp_status",
        favoriteTopics: ["xp_status"],
        sessionRecentTopics: ["xp_status"],
        walletDelta: {
          xpGained: 250,
          holdingsChange: null,
          tierChanged: false,
          previousTierLabel: null,
          currentTierLabel: null,
          stakedChange: null,
          lockedChange: null,
          seasonPointsChange: null,
        },
      };

      const res = generateIntelligentReply("my xp", mockFullContext, null, mockMemoryWithDelta);
      expect(res.reply).toContain("Since we last talked, you've gained 250 XP.");
    });
  });
});
