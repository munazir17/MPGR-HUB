// lib/architecture/ai/openai-ai-provider.ts

import type { AIProvider, AIProviderRequest, AIProviderResponse } from "./ai-provider";
import { runToolCallingLoop } from "./agent-tool-calling";
import { AGENT_INTENTS } from "@/lib/agent-intelligence";

export class OpenAIAIProvider implements AIProvider {
  readonly name = "openai";
  readonly requiresNetwork = true;

  async generateReply(request: AIProviderRequest): Promise<AIProviderResponse> {
    const baseSystemPrompt = buildSystemPrompt(request);
    return runToolCallingLoop(request, baseSystemPrompt, sendCompletion);
  }
}

async function sendCompletion(systemPrompt: string, userPrompt: string): Promise<string> {
  const res = await fetch("/api/agent/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ systemPrompt, userPrompt }),
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => null);
    const message = errorBody?.error ?? `Request to /api/agent/complete failed with ${res.status}`;
    throw new Error(message);
  }

  const { content } = (await res.json()) as { content: string };
  return content;
}

function buildSystemPrompt(request: AIProviderRequest): string {
  const { agentContext, memoryContext } = request;

  const lines: string[] = [
    "You are the MPGR Agent, the assistant inside MPGR HUB (a Web3 rewards/XP/staking app).",
    `Respond ONLY with a JSON object of the exact shape {"intent": string, "reply": string} — no markdown, no extra keys.`,
    'Keep "reply" concise (2-4 sentences), friendly, and grounded ONLY in the facts below (or in a tool result you requested) — never invent numbers.',
    "You also have Base trading tools. For tokenized-stock research call tokenized_stock_research. For buy/sell/swap/quote (including \"$10 of COINc\") call trade_prepare_swap with fromToken=USDC, toToken=the asset, amount=\"10\" in human units. Omit taker. Never sign. Never answer a trade request with the MPGR portfolio help text.",
  ];

  if (!agentContext.isConnected) {
    lines.push("The user's wallet is not connected. If asked about their data, tell them to connect their wallet.");
  } else {
    lines.push("Known facts about this user right now:");
    if (request.address) {
      lines.push(`- Connected Base wallet: ${request.address}`);
    }
    if (agentContext.portfolio) {
      lines.push(
        `- Portfolio: ${agentContext.portfolio.walletBalance} MPGR in wallet, ${agentContext.portfolio.stakedBalance} staked, ${agentContext.portfolio.lockedBalance} locked, ${agentContext.portfolio.totalHoldings} total Holder Score, ${agentContext.portfolio.claimableRewards} claimable rewards.`
      );
    }
    if (agentContext.xp) {
      lines.push(
        `- XP: Level ${agentContext.xp.level}, ${agentContext.xp.xp} XP total, ${agentContext.xp.progress}% into next level, ${agentContext.xp.streak}-day streak.`
      );
    }
    if (agentContext.holderTier) {
      lines.push(`- Holder Tier: ${agentContext.holderTier.tierLabel ?? "none yet"}.`);
    }
    if (agentContext.premium) {
      lines.push(
        `- Premium: ${agentContext.premium.isPremium ? agentContext.premium.tierLabel : "not on a Premium tier"}.`
      );
    }
    if (agentContext.staking) {
      lines.push(
        `- Staking: ${agentContext.staking.totalStaked} staked, \( {agentContext.staking.earnedRewards} claimable \){agentContext.staking.currentAPRPercent !== null ? `, ${agentContext.staking.currentAPRPercent}% APR` : ""}.`
      );
    }
    if (agentContext.tokenLock) {
      lines.push(
        `- Token Lock: ${agentContext.tokenLock.totalLocked} locked across ${agentContext.tokenLock.activeLocksCount} locks.`
      );
    }
    if (agentContext.season) {
      lines.push(
        `- Season Pass: Season ${agentContext.season.seasonNumber}, Level ${agentContext.season.level}, ${agentContext.season.seasonPoints} points.`
      );
    }
  }

  if (memoryContext.isReturningUser) {
    lines.push(`This is a returning user (${memoryContext.interactionCount} past interactions).`);
    if (memoryContext.favoriteTopics.length > 0) {
      lines.push(`They usually ask about: ${memoryContext.favoriteTopics.join(", ")}.`);
    }
  }
  if (memoryContext.conversationSummaries.length > 0) {
    lines.push(
      `Earlier conversation summary: ${memoryContext.conversationSummaries[memoryContext.conversationSummaries.length - 1]}`
    );
  }

  lines.push(`"intent" must be exactly one of: ${AGENT_INTENTS.join(", ")}.`);

  return lines.join("\n");
}
