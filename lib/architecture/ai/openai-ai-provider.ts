import { getAgentActions, getAgentHighlights, getFollowUpPrompts } from "@/lib/agent-actions";
import { AGENT_INTENTS, type AgentIntent } from "@/lib/agent-intelligence";
import type { AIProvider, AIProviderRequest, AIProviderResponse } from "./ai-provider";

// Phase 3C Part 6 — the first real network AIProvider. Talks ONLY to this
// app's own /api/agent/complete Route Handler (app/api/agent/complete/route.ts)
// — never directly to OpenAI, and never with an API key anywhere in this
// file or anywhere else client-side. That route is the only place
// OPENAI_API_KEY is read, server-side only.
//
// Division of responsibility, deliberately narrow: OpenAI is asked for
// exactly two things — `intent` (one of lib/agent-intelligence.ts's
// AGENT_INTENTS, Phase 3C Part 4) and `reply` (natural-language text).
// Everything structured and UI-bound — actions, highlight chips,
// follow-up prompts — is still produced by lib/agent-actions.ts's
// existing deterministic getAgentActions/getAgentHighlights/getFollowUpPrompts,
// using the REAL AgentContext and the model's classified intent. This is
// intentional: action targets (routes, command names) must always be
// grounded in actual app state, never generated or hallucinated by a
// model. It's the exact same reuse DeterministicAIProvider already relies
// on via lib/agent-intelligence.ts's generateIntelligentReply — no new
// action system, no duplicated logic.
//
// Output still passes through lib/architecture/ai/ai-provider-guardrails.ts
// (already wired in ai-provider-registry.ts's default composition) before
// reaching lib/agent-engine.ts, so a malformed or oversized model
// response is still caught even if something here lets one through. And
// because createAIProvider() (Phase 3C Part 3) composes this behind
// CircuitBreakerAIProvider and FallbackAIProvider (Part 5), any failure
// here — missing key, network error, invalid JSON — degrades to the
// deterministic engine rather than breaking the Agent.
export class OpenAIAIProvider implements AIProvider {
  readonly name = "openai";
  readonly requiresNetwork = true;

  async generateReply(request: AIProviderRequest): Promise<AIProviderResponse> {
    const systemPrompt = buildSystemPrompt(request);
    const userPrompt = request.prompt;

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
    const { intent, reply } = parseModelContent(content, request.previousIntent);

    return {
      intent,
      reply,
      actions: getAgentActions(intent, request.agentContext),
      highlights: getAgentHighlights(intent, request.agentContext),
      followUps: getFollowUpPrompts(intent),
    };
  }
}

function isValidIntent(value: unknown): value is AgentIntent {
  return typeof value === "string" && (AGENT_INTENTS as readonly string[]).includes(value);
}

function parseModelContent(
  content: string,
  previousIntent: AgentIntent | null
): { intent: AgentIntent; reply: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("OpenAI response was not valid JSON.");
  }

  const record = parsed as Record<string, unknown>;
  const reply = typeof record.reply === "string" ? record.reply : "";
  if (!reply.trim()) {
    throw new Error("OpenAI response was missing a non-empty reply.");
  }

  const intent = isValidIntent(record.intent) ? record.intent : previousIntent ?? "general_help";
  return { intent, reply };
}

// Builds the system prompt from the exact same AgentContext + memory
// context every other provider already receives via the Context Builder
// (lib/agent-prompt-context.ts, Phase 3B Part 4) — no new data source, no
// second read of wallet/XP/staking state.
function buildSystemPrompt(request: AIProviderRequest): string {
  const { agentContext, memoryContext } = request;

  const lines: string[] = [
    "You are the MPGR Agent, the assistant inside MPGR HUB (a Web3 rewards/XP/staking app).",
    `Respond ONLY with a JSON object of the exact shape {"intent": string, "reply": string} — no markdown, no extra keys.`,
    `"intent" must be exactly one of: ${AGENT_INTENTS.join(", ")}.`,
    'Keep "reply" concise (2-4 sentences), friendly, and grounded ONLY in the facts below — never invent numbers.',
  ];

  if (!agentContext.isConnected) {
    lines.push("The user's wallet is not connected. If asked about their data, tell them to connect their wallet.");
    return lines.join("\n");
  }

  lines.push("Known facts about this user right now:");
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
      `- Staking: ${agentContext.staking.totalStaked} staked, ${agentContext.staking.earnedRewards} claimable${agentContext.staking.currentAPRPercent !== null ? `, ${agentContext.staking.currentAPRPercent}% APR` : ""}.`
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

  return lines.join("\n");
}
