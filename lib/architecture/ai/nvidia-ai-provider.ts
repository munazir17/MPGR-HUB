// lib/architecture/ai/nvidia-ai-provider.ts

import type {
  AIProvider,
  AIProviderRequest,
  AIProviderResponse,
} from "./ai-provider";
import {
  runToolCallingLoop,
  selectAdvertisedToolsForPrompt,
} from "./agent-tool-calling";
import { toNvidiaTools } from "./nvidia-function-calling";
import { AGENT_INTENTS } from "@/lib/agent-intelligence";
import type { AnyAgentTool } from "@/lib/architecture/tools/agent-tool";

// NVIDIA NIM network AIProvider. Talks ONLY to this app's own
// /api/agent/complete/nvidia Route Handler — never directly to NVIDIA,
// and never with an API key anywhere client-side.
//
// Native OpenAI-compatible tools are forwarded to the server route.
// runToolCallingLoop remains the single shared execution loop. NVIDIA
// tool_calls are translated to {"toolCall":...} by the route before
// they reach this parser.
//
// Safety boundary:
//   - Only "read" and "prepare" tools are advertised.
//   - No "execute" tool is ever sent to NVIDIA.
//   - Prepare tools only create a proposal.
//   - This provider never signs or submits a transaction.

export class NvidiaAIProvider implements AIProvider {
  readonly name = "nvidia";
  readonly requiresNetwork = true;

  async generateReply(request: AIProviderRequest): Promise<AIProviderResponse> {
    const baseSystemPrompt = buildSystemPrompt(request);
    const advertisedTools = selectAdvertisedToolsForPrompt(request.prompt);
    return runToolCallingLoop(
      request,
      baseSystemPrompt,
      (systemPrompt, userPrompt) => sendCompletion(systemPrompt, userPrompt, advertisedTools),
      {
        compactToolCatalog: true,
        toolCatalog: advertisedTools,
      },
    );
  }
}

export async function sendCompletion(
  systemPrompt: string,
  userPrompt: string,
  tools: readonly AnyAgentTool[] = selectAdvertisedToolsForPrompt(
    userPrompt,
  ),
): Promise<string> {
  const nvidiaTools = toNvidiaTools(tools);

  const res = await fetch("/api/agent/complete/nvidia", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      systemPrompt,
      userPrompt,
      tools: nvidiaTools,
    }),
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => null);
    const message =
      typeof errorBody?.error === "string" && errorBody.error.trim()
        ? errorBody.error
        : "Request to /api/agent/complete/nvidia failed with " + String(res.status);
    const code =
      typeof errorBody?.code === "string" && errorBody.code.trim()
        ? errorBody.code
        : undefined;
    const err = new Error(message) as Error & { code?: string };
    if (code) err.code = code;
    throw err;
  }

  const { content } = (await res.json()) as { content: string };
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("NVIDIA completion route returned an empty response.");
  }
  return content;
}

function buildSystemPrompt(request: AIProviderRequest): string {
  const { agentContext, memoryContext } = request;

  const lines: string[] = [
    "You are the MPGR Agent, the assistant inside MPGR HUB (a Web3 rewards/XP/staking app).",
    "You have native tools available for looking up live facts, discovering or preparing an x402-gated resource, researching Coinbase Tokenized Stocks on Base, and preparing a Base swap quote. Prefer calling an appropriate provided tool when the user's request genuinely requires live information, a swap/quote, tokenized-stock research, or x402 resource access.",
    'If the user\'s message already contains an https URL and they ask you to inspect, discover, access, or determine whether it is an x402-gated resource, call x402_discover_resource with arguments {"resourceUrl":"<that URL>"} instead of asking the user to provide the URL again. The argument name is resourceUrl — never url.',
    "If an x402 resource has been discovered and the user explicitly wants to access/pay for it, use x402_prepare_payment with arguments {\"resourceUrl\":\"<that URL>\"} when appropriate. Preparing an x402 payment only creates a proposal for the user to review; it never signs or submits a payment.",
    "Trading tools (Base Mainnet only). They never sign or broadcast.",
    "If the user asks the price of ETH, USDC, WETH, or MPGR, call trade_get_price. Never call tokenized_stock_research for those.",
    "If the user asks to research a Coinbase tokenized stock (COINc, AAPLc, TSLAc, SPCXc, NVDAc, or \"tokenized stocks\"), call tokenized_stock_research with {\"symbol\":\"COINc\"} or {} to list the catalog.",
    "If the user asks to buy or sell a tokenized stock (\"buy $10 of SPCXc\", \"prepare a trade to buy $50 of tokenized AAPL\"), call tokenized_stock_prepare_order with {\"symbol\":\"AAPLc\",\"amount\":\"50\",\"side\":\"BUY\"}. Never call trade_prepare_swap for AAPL/AAPLc or any other Coinbase B20 ticker.",
    "If the user asks to buy, sell, or swap any other Base token (including a raw 0x address), call trade_prepare_swap. For a dollar buy use fromToken=\"USDC\", toToken=\"the asset\", amount=\"10\". Omit taker.",
    "If the wallet is connected, never say you cannot retrieve wallet details. Do not answer a trade/quote request from the MPGR portfolio/XP help text.",
    "What-is / explain / research questions about MPGR HUB, $MPGR, Base, x402, or tokenized stocks use intent research_query — never portfolio_summary or claimable_rewards.",
    "Market questions (what's moving, ETH, BTC) use intent market_overview. Call trade_get_price or market_intelligence when useful. Never invent prices.",
    "Portfolio is the whole wallet plus staked/locked MPGR. XP, Holder Tier, and Season are account progress, not the wallet book.",
    'When you are ready to answer the user, respond ONLY with a JSON object of the exact shape {"intent": string, "reply": string} — no markdown, no extra keys.',
    'Keep "reply" concise (2-4 sentences), friendly, and grounded ONLY in the facts below (or in a tool result you requested) — never invent numbers, addresses, payment amounts, or tool results.',
  ];

  if (!agentContext.isConnected) {
    lines.push("The user's wallet is not connected. If asked about their data, tell them to connect their wallet.");
  } else {
    lines.push("Known facts about this user right now:");
    if (request.address) {
      lines.push("- Connected Base wallet: " + request.address);
    }
    if (agentContext.portfolio) {
      lines.push(
        "- Portfolio: " +
          agentContext.portfolio.walletBalance +
          " MPGR in wallet, " +
          agentContext.portfolio.stakedBalance +
          " staked, " +
          agentContext.portfolio.lockedBalance +
          " locked, " +
          agentContext.portfolio.totalHoldings +
          " total Holder Score, " +
          agentContext.portfolio.claimableRewards +
          " claimable rewards.",
      );
    }
    if (agentContext.xp) {
      lines.push(
        "- XP: Level " +
          agentContext.xp.level +
          ", " +
          agentContext.xp.xp +
          " XP total, " +
          agentContext.xp.progress +
          "% into next level, " +
          agentContext.xp.streak +
          "-day streak.",
      );
    }
    if (agentContext.holderTier) {
      lines.push("- Holder Tier: " + (agentContext.holderTier.tierLabel ?? "none yet") + ".");
    }
    if (agentContext.premium) {
      lines.push(
        "- Premium: " +
          (agentContext.premium.isPremium ? agentContext.premium.tierLabel : "not on a Premium tier") +
          ".",
      );
    }
    if (agentContext.staking) {
      const aprPart =
        agentContext.staking.currentAPRPercent !== null
          ? ", " + agentContext.staking.currentAPRPercent + "% APR"
          : "";
      lines.push(
        "- Staking: " +
          agentContext.staking.totalStaked +
          " staked, " +
          agentContext.staking.earnedRewards +
          " claimable" +
          aprPart +
          ".",
      );
    }
    if (agentContext.tokenLock) {
      lines.push(
        "- Token Lock: " +
          agentContext.tokenLock.totalLocked +
          " locked across " +
          agentContext.tokenLock.activeLocksCount +
          " locks.",
      );
    }
    if (agentContext.season) {
      lines.push(
        "- Season Pass: Season " +
          agentContext.season.seasonNumber +
          ", Level " +
          agentContext.season.level +
          ", " +
          agentContext.season.seasonPoints +
          " points.",
      );
    }
  }

  if (memoryContext.isReturningUser) {
    lines.push("This is a returning user (" + memoryContext.interactionCount + " past interactions).");
    if (memoryContext.favoriteTopics.length > 0) {
      lines.push("They usually ask about: " + memoryContext.favoriteTopics.join(", ") + ".");
    }
  }
  if (memoryContext.conversationSummaries.length > 0) {
    lines.push(
      "Earlier conversation summary: " +
        memoryContext.conversationSummaries[memoryContext.conversationSummaries.length - 1],
    );
  }

  lines.push('"intent" must be exactly one of: ' + AGENT_INTENTS.join(", ") + ".");
  return lines.join("\n");
}
