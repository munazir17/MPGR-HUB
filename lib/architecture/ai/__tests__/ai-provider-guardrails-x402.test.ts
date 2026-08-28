// lib/architecture/ai/__tests__/ai-provider-guardrails-x402.test.ts
//
// P3 — GuardrailAIProvider.validateAndSanitize() explicitly whitelists
// which fields of an AIProviderResponse survive to
// lib/agent-engine.ts (see that method's own `return { intent, reply,
// actions, highlights, followUps }` before this change). Without an
// explicit addition there, x402Proposal would be silently dropped for
// EVERY real network reply (every provider is wrapped by this decorator
// in ai-provider-registry.ts's default composition) even though
// agent-tool-calling.ts's runToolCallingLoop correctly attached it. This
// file proves that whitelist now includes x402Proposal, and that a
// malformed value in that slot (never expected in practice — it's
// always constructed from a trusted tool result — but defended here
// anyway) is dropped rather than surfaced as if it were real.

import { describe, expect, it } from "vitest";

import { GuardrailAIProvider } from "../ai-provider-guardrails";
import type { AIProvider, AIProviderRequest, AIProviderResponse } from "../ai-provider";
import type { Logger } from "@/lib/architecture/core/types";
import { parseX402PaymentRequired } from "@/lib/x402/x402-parse";
import { buildX402PaymentProposal } from "@/lib/x402/x402-proposal";
import { X402_SUPPORTED_NETWORK } from "@/lib/x402/x402-config";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const RESOURCE = "https://api.example.com/paid-report";

function buildFixtureProposal() {
  const parsed = parseX402PaymentRequired({
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: X402_SUPPORTED_NETWORK,
        maxAmountRequired: "2500000",
        resource: RESOURCE,
        payTo: PAY_TO,
        asset: USDC,
      },
    ],
  });
  if (!parsed.ok) throw new Error("test setup failed to parse requirement");
  const built = buildX402PaymentProposal(RESOURCE, parsed.requirements[0]);
  if (!built.ok) throw new Error("test setup failed to build proposal");
  return built.proposal;
}

function makeLogger(): Logger & { warnCalls: unknown[][] } {
  const warnCalls: unknown[][] = [];
  return {
    debug: () => {},
    warn: (...args: unknown[]) => {
      warnCalls.push(args);
    },
    error: () => {},
    warnCalls,
  };
}

function stubProvider(response: AIProviderResponse): AIProvider {
  return {
    name: "stub",
    requiresNetwork: true,
    generateReply: async () => response,
  };
}

function makeRequest(): AIProviderRequest {
  return {
    prompt: "test",
    agentContext: {} as AIProviderRequest["agentContext"],
    previousIntent: null,
    memoryContext: {} as AIProviderRequest["memoryContext"],
  };
}

describe("GuardrailAIProvider — x402Proposal handling", () => {
  it("passes a well-formed x402Proposal through unchanged", async () => {
    const proposal = buildFixtureProposal();
    const logger = makeLogger();
    const provider = new GuardrailAIProvider(
      stubProvider({
        intent: "general_help",
        reply: "Proposal ready.",
        actions: [],
        highlights: [],
        followUps: [],
        x402Proposal: proposal,
      }),
      logger
    );

    const response = await provider.generateReply(makeRequest());
    expect(response.x402Proposal).toEqual(proposal);
    expect(logger.warnCalls.length).toBe(0);
  });

  it("omits x402Proposal entirely when the underlying provider didn't set it (ordinary reply)", async () => {
    const logger = makeLogger();
    const provider = new GuardrailAIProvider(
      stubProvider({ intent: "general_help", reply: "Just a normal reply.", actions: [], highlights: [], followUps: [] }),
      logger
    );

    const response = await provider.generateReply(makeRequest());
    expect(response.x402Proposal).toBeUndefined();
  });

  it("drops a malformed x402Proposal (missing required payment fields) rather than surfacing it, and logs a warning", async () => {
    const logger = makeLogger();
    const provider = new GuardrailAIProvider(
      stubProvider({
        intent: "general_help",
        reply: "Proposal ready.",
        actions: [],
        highlights: [],
        followUps: [],
        // Missing `requirement` entirely — not a real proposal.
        x402Proposal: { id: "not-real", requiresConfirmation: true } as unknown as AIProviderResponse["x402Proposal"],
      }),
      logger
    );

    const response = await provider.generateReply(makeRequest());
    expect(response.x402Proposal).toBeUndefined();
    expect(logger.warnCalls.length).toBe(1);
  });

  it("drops a non-object x402Proposal value", async () => {
    const logger = makeLogger();
    const provider = new GuardrailAIProvider(
      stubProvider({
        intent: "general_help",
        reply: "Proposal ready.",
        actions: [],
        highlights: [],
        followUps: [],
        x402Proposal: "not-an-object" as unknown as AIProviderResponse["x402Proposal"],
      }),
      logger
    );

    const response = await provider.generateReply(makeRequest());
    expect(response.x402Proposal).toBeUndefined();
  });
});
