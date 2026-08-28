// lib/architecture/ai/openai-ai-provider.ts

import type { AIProvider, AIProviderRequest, AIProviderResponse } from "./ai-provider";
import { runToolCallingLoop } from "./agent-tool-calling";
import { AGENT_INTENTS } from "@/lib/agent-intelligence";

// Phase 3C Part 6 — the first real network AIProvider. Talks ONLY to this
// app's own /api/agent/complete Route Handler (app/api/agent/complete/route.ts)
// — never directly to OpenAI, and never with an API key anywhere in this
// file or anywhere else client-side. That route is the only place
// OPENAI_API_KEY is read, server-side only.
//
// Division of responsibility, deliberately narrow: OpenAI is asked for
// exactly two things — `intent` (one of lib/agent-intelligence.ts's
// AGENT_INTENTS, Phase 3C Part 4) and `reply` (natural-language text) —
// or, per the P2 production wiring addendum below, a request to call one
// read-only tool first. Everything structured and UI-bound — actions,
// highlight chips, follow-up prompts — is still produced by
// lib/agent-actions.ts's existing deterministic
// getAgentActions/getAgentHighlights/getFollowUpPrompts, using the REAL
// AgentContext and the model's classified intent. This is intentional:
// action targets (routes, command names) must always be grounded in
// actual app state, never generated or hallucinated by a model. It's the
// exact same reuse DeterministicAIProvider already relies on via
// lib/agent-intelligence.ts's generateIntelligentReply — no new action
// system, no duplicated logic.
//
// P2 production wiring addendum — generateReply() now delegates to
// lib/architecture/ai/agent-tool-calling.ts's runToolCallingLoop, the one
// shared loop every network AIProvider uses (see that file's header
// comment for the full design/safety rationale). This class's only job
// is still exactly what it was before: build the system prompt from this
// turn's AgentContext/memory, and know how to reach ITS OWN route. Parsing
// the model's JSON, deciding whether it's a tool call or a final answer,
// executing the tool via agentToolRuntime, and bounding how many rounds
// that can happen all live in the shared module — not duplicated between
// this file and gemini-ai-provider.ts.
//
// Output still passes through lib/architecture/ai/ai-provider-guardrails.ts
// (already wired in ai-provider-registry.ts's default composition) before
// reaching lib/agent-engine.ts, so a malformed or oversized model
// response is still caught even if something here lets one through. And
// because createAIProvider() (Phase 3C Part 3) composes this behind
// CircuitBreakerAIProvider and FallbackAIProvider (Part 5), any failure
// here — missing key, network error, invalid JSON, a tool-calling loop
// error — degrades to the deterministic engine rather than breaking the
// Agent.
export class OpenAIAIProvider implements AIProvider {
  readonly name = "openai";
  readonly requiresNetwork = true;

  async generateReply(request: AIProviderRequest): Promise<AIProviderResponse> {
    const baseSystemPrompt = buildSystemPrompt(request);
    return runToolCallingLoop(request, baseSystemPrompt, sendCompletion);
  }
}

// The only network call this provider makes, unchanged in shape from
// before the P2 tool-calling addendum: POST { systemPrompt, userPrompt },
// get back { content }. runToolCallingLoop calls this once per model turn
// (up to its bounded max) — it has no knowledge of OpenAI, this route, or
// fetch at all.
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

// Builds the system prompt from the exact same AgentContext + memory
// context every other provider already receives via the Context Builder
// (lib/agent-prompt-context.ts, Phase 3B Part 4) — no new data source, no
// second read of wallet/XP/staking state. runToolCallingLoop appends the
// read-tool catalog block to whatever this function returns — this
// function itself is unchanged in substance from before the P2 addendum
// (only the "intent must be one of" list moved to the end, after the
// per-user facts, purely for prompt readability).
function buildSystemPrompt(request: AIProviderRequest): string {
  const { agentContext, memoryContext } = request;

  const lines: string[] = [
    "You are the MPGR Agent, the assistant inside MPGR HUB (a Web3 rewards/XP/staking app).",
    `Respond ONLY with a JSON object of the exact shape {"intent": string, "reply": string} — no markdown, no extra keys.`,
    'Keep "reply" concise (2-4 sentences), friendly, and grounded ONLY in the facts below (or in a tool result you requested) — never invent numbers.',
  ];

  if (!agentContext.isConnected) {
    lines.push("The user's wallet is not connected. If asked about their data, tell them to connect their wallet.");
  } else {
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
