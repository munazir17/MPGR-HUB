// lib/architecture/ai/gemini-ai-provider.ts

import type {
  AIProvider,
  AIProviderRequest,
  AIProviderResponse,
} from "./ai-provider";
import {
  getReadAndPrepareToolCatalog,
  runToolCallingLoop,
} from "./agent-tool-calling";
import { toGeminiFunctionDeclarations } from "./gemini-function-declarations";
import { AGENT_INTENTS } from "@/lib/agent-intelligence";

// Phase 3C Gemini addendum — a second real network AIProvider, added
// alongside lib/architecture/ai/openai-ai-provider.ts (not replacing it).
//
// P3 tool-calling addendum — Gemini now receives the same read/prepare
// AgentTool catalog used by the shared provider-agnostic tool-calling
// loop, lowered into Gemini's native functionDeclaration format.
//
// The provider still talks ONLY to this app's own
// /api/agent/complete/gemini Route Handler — never directly to Google,
// and never with an API key anywhere client-side.
//
// The Route Handler is responsible for the Gemini wire protocol.
// This provider is responsible for:
//   1. building the normal MPGR Agent system prompt,
//   2. obtaining the production read/prepare tool catalog,
//   3. lowering that catalog into Gemini function declarations,
//   4. forwarding those declarations to the server route.
//
// runToolCallingLoop remains the single shared execution loop. It
// receives Gemini's native functionCall through the adapter in the
// Route Handler, translates it to the existing vendor-neutral
// {"toolCall": ...} protocol, and then executes the selected tool through
// AgentToolRuntime.
//
// Safety boundary:
//   - Only "read" and "prepare" tools are advertised.
//   - No "execute" tool is ever sent to Gemini.
//   - x402_prepare_payment only creates a proposal.
//   - No AI provider can sign or submit a payment.
//   - Wallet signing remains behind the explicit Confirm & Pay flow.
//
// Output still passes through the existing provider guardrails,
// CircuitBreakerAIProvider, and FallbackAIProvider composition before
// reaching lib/agent-engine.ts.

export class GeminiAIProvider implements AIProvider {
  readonly name = "gemini";
  readonly requiresNetwork = true;

  async generateReply(
    request: AIProviderRequest,
  ): Promise<AIProviderResponse> {
    const baseSystemPrompt = buildSystemPrompt(request);

    return runToolCallingLoop(
      request,
      baseSystemPrompt,
      sendCompletion,
    );
  }
}

// The only network call this provider makes.
//
// P3 change:
// Gemini now receives native function declarations for the production
// read/prepare tool catalog. The server-side Gemini route converts those
// declarations into Google's generateContent request shape and converts
// any native Gemini functionCall response back into the vendor-neutral
// {"toolCall": ...} format expected by runToolCallingLoop.
//
// No Gemini API key is exposed here. A 429/empty-content from the
// route is a controlled throw so FallbackAIProvider / the circuit
// breaker can still catch it — this provider does not swallow those
// errors itself.
async function sendCompletion(
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const functionDeclarations = toGeminiFunctionDeclarations(
    getReadAndPrepareToolCatalog(),
  );

  const res = await fetch("/api/agent/complete/gemini", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      systemPrompt,
      userPrompt,
      functionDeclarations,
    }),
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => null);

    const message =
      typeof errorBody?.error === "string" &&
      errorBody.error.trim()
        ? errorBody.error
        : "Request to /api/agent/complete/gemini failed with " + String(res.status);

    // Preserve the route's classification code (e.g.
    // "PROVIDER_RATE_LIMITED") on the thrown error so callers up the
    // chain — FallbackAIProvider, then the UI — can tell an expected,
    // already-recovered provider-availability failure apart from an
    // unexpected one. A plain `throw new Error(message)` would discard
    // this and every failure would look identical by the time it
    // reaches the UI.
    const code =
      typeof errorBody?.code === "string" && errorBody.code.trim()
        ? errorBody.code
        : undefined;
    const err = new Error(message) as Error & { code?: string };
    if (code) err.code = code;
    throw err;
  }

  const { content } = (await res.json()) as {
    content: string;
  };

  if (typeof content !== "string" || !content.trim()) {
    throw new Error(
      "Gemini completion route returned an empty response.",
    );
  }

  return content;
}

// Identical in core content to openai-ai-provider.ts's buildSystemPrompt.
//
// P3 change:
// The prompt explicitly tells Gemini that native tools are available and
// that it should prefer a provided tool when the user's request genuinely
// requires live information or x402 resource discovery/preparation.
//
// IMPORTANT:
// The final-answer format remains {"intent","reply"}.
// A native Gemini functionCall is handled by the Gemini route before it
// reaches this parser, so this instruction does NOT conflict with the
// native function-calling transport.
//
// Built from the exact same AgentContext + memory context every provider
// receives through the Context Builder. No new data source and no second
// wallet/XP/staking read is introduced.
function buildSystemPrompt(request: AIProviderRequest): string {
  const { agentContext, memoryContext } = request;

  const lines: string[] = [
    "You are the MPGR Agent, the assistant inside MPGR HUB (a Web3 rewards/XP/staking app).",

    "You have native tools available for looking up live facts, discovering or preparing an x402-gated resource, researching Coinbase Tokenized Stocks on Base, and preparing a Base swap quote. Prefer calling an appropriate provided tool when the user's request genuinely requires live information, a swap/quote, tokenized-stock research, or x402 resource access.",

    'If the user\'s message already contains an https URL and they ask you to inspect, discover, access, or determine whether it is an x402-gated resource, call x402_discover_resource with arguments {"resourceUrl":"<that URL>"} instead of asking the user to provide the URL again. The argument name is resourceUrl — never url.',

    "If an x402 resource has been discovered and the user explicitly wants to access/pay for it, use x402_prepare_payment with arguments {\"resourceUrl\":\"<that URL>\"} when appropriate. Preparing an x402 payment only creates a proposal for the user to review; it never signs or submits a payment.",

    "Trading tools (Base Mainnet only, Coinbase CDP Trade API). They never sign or broadcast.",
    "If the user asks to research a Coinbase tokenized stock (COINc, AAPLc, TSLAc, NVDAc, or \"tokenized stocks\"), call tokenized_stock_research with {\"symbol\":\"COINc\"} or {} to list the catalog.",
    "If the user asks to buy, sell, swap, or prepare a quote (including \"$10 of COINc\"), call trade_prepare_swap. For a dollar-denominated buy use fromToken=\"USDC\", toToken=\"COINc\", amount=\"10\" (human units — do NOT convert to wei). Omit taker; the connected wallet is filled automatically.",
    "If the wallet is connected, never say you cannot retrieve wallet details. Do not answer a trade/quote request from the MPGR portfolio/XP help text.",

    'When you are ready to answer the user, respond ONLY with a JSON object of the exact shape {"intent": string, "reply": string} — no markdown, no extra keys.',

    'Keep "reply" concise (2-4 sentences), friendly, and grounded ONLY in the facts below (or in a tool result you requested) — never invent numbers, addresses, payment amounts, or tool results.',
  ];

  if (!agentContext.isConnected) {
    lines.push(
      "The user's wallet is not connected. If asked about their data, tell them to connect their wallet.",
    );
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
      lines.push(
        "- Holder Tier: " + (agentContext.holderTier.tierLabel ?? "none yet") + ".",
      );
    }

    if (agentContext.premium) {
      lines.push(
        "- Premium: " +
          (agentContext.premium.isPremium
            ? agentContext.premium.tierLabel
            : "not on a Premium tier") +
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
    lines.push(
      "This is a returning user (" +
        memoryContext.interactionCount +
        " past interactions).",
    );

    if (memoryContext.favoriteTopics.length > 0) {
      lines.push(
        "They usually ask about: " + memoryContext.favoriteTopics.join(", ") + ".",
      );
    }
  }

  if (memoryContext.conversationSummaries.length > 0) {
    lines.push(
      "Earlier conversation summary: " +
        memoryContext.conversationSummaries[
          memoryContext.conversationSummaries.length - 1
        ],
    );
  }

  lines.push(
    '"intent" must be exactly one of: ' + AGENT_INTENTS.join(", ") + ".",
  );

  return lines.join("\n");
}
