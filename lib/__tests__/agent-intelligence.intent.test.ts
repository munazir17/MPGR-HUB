import { describe, expect, it } from "vitest";
import { detectIntent, generateIntelligentReply } from "@/lib/agent-intelligence";
import type { AgentContext } from "@/lib/agent-context";

const ctx: AgentContext = {
  isConnected: true,
  xp: {
    xp: 1200,
    level: 3,
    nextLevel: 4,
    xpIntoLevel: 200,
    xpNeededForLevel: 500,
    progress: 40,
    streak: 2,
    referralCount: 1,
  },
  portfolio: {
    walletBalance: 100,
    stakedBalance: 50,
    lockedBalance: 25,
    totalHoldings: 175,
    claimableRewards: 4,
    nativeEth: "0.01",
    usdc: "12.5",
  },
  premium: null,
  holderTier: {
    tierLabel: "Bronze",
    totalScore: 175,
    nextTierLabel: "Silver",
    progressToNextTier: 10,
    amountToNextTier: 25,
    votingWeight: 175,
    reputationScore: 1,
  },
  staking: { totalStaked: 50, earnedRewards: 2, currentAPRPercent: 8 },
  tokenLock: { totalLocked: 25, activeLocksCount: 1, upcomingUnlockAt: null },
  season: { seasonNumber: 1, seasonPoints: 40, level: 2, progress: 20 },
  rewards: { claimableTotal: 4, totalClaimed: 1 },
};

describe("detectIntent routing", () => {
  it("routes research questions away from portfolio even after a portfolio turn", () => {
    expect(detectIntent("What is MPGR HUB and what does $MPGR do?", "portfolio_summary").intent).toBe(
      "research_query",
    );
    expect(
      detectIntent(
        "Research the current Base ecosystem and explain how MPGR HUB fits into it",
        "portfolio_summary",
      ).intent,
    ).toBe("research_query");
  });

  it("does not use memory dominant intent for standalone research", () => {
    const memory = { dominantRecentIntent: "portfolio_summary" } as never;
    expect(detectIntent("What is MPGR HUB and what does $MPGR do?", null, memory).intent).toBe(
      "research_query",
    );
  });

  it("routes portfolio, xp, holder tier, rewards, market", () => {
    expect(detectIntent("Analyze my portfolio", null).intent).toBe("portfolio_summary");
    expect(detectIntent("How much XP do I have?", null).intent).toBe("xp_status");
    expect(detectIntent("What's my Holder Tier?", null).intent).toBe("holder_tier");
    expect(detectIntent("What rewards can I claim?", null).intent).toBe("claimable_rewards");
    expect(detectIntent("What's moving in the market?", null).intent).toBe("market_overview");
    expect(detectIntent("Analyze ETH", null).intent).toBe("market_overview");
  });
});

describe("generateIntelligentReply portfolio vs research", () => {
  it("includes ETH and USDC in portfolio text and keeps progress separate", () => {
    const result = generateIntelligentReply("Analyze my portfolio", ctx, null);
    expect(result.intent).toBe("portfolio_summary");
    expect(result.reply).toContain("0.01 ETH");
    expect(result.reply).toContain("USDC");
    expect(result.reply).toContain("account progress");
  });

  it("answers research without portfolio capability dump", () => {
    const result = generateIntelligentReply("What is MPGR HUB and what does $MPGR do?", ctx, "portfolio_summary");
    expect(result.intent).toBe("research_query");
    expect(result.reply.toLowerCase()).toContain("base");
    expect(result.reply).not.toContain("I can help with: Portfolio Summary");
  });

  it("answers research without a connected wallet", () => {
    const result = generateIntelligentReply("What is MPGR HUB and what does $MPGR do?", {
      ...ctx,
      isConnected: false,
    }, null);
    expect(result.intent).toBe("research_query");
  });
});
