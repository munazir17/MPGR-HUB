// lib/agent-engine-x402.test.ts
//
// P3 — proves the last hop of the x402 chat-integration chain: an
// x402Proposal attached to an AIProviderResponse (by
// agent-tool-calling.ts's runToolCallingLoop, passed through
// GuardrailAIProvider — see the two sibling test files in
// lib/architecture/ai/__tests__/) actually reaches the AgentMessage
// that lib/agent-engine.ts persists and hands back to the UI. Uses
// setAIProvider() (ai-provider-registry.ts's existing swap point) to
// inject a fake provider rather than mocking the whole AI stack — the
// same technique this codebase already uses for provider composition
// (see fallback-ai-provider tests). LocalMemoryProvider is a no-op in
// this node test environment (no `window` — see
// lib/architecture/memory/local-memory-provider.ts /
// lib/storage.ts), so no persistence mocking is needed either.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendAssistantReply, appendUserMessage, regenerateLastReply } from "@/lib/agent-engine";
import { getAIProvider, setAIProvider } from "@/lib/architecture/ai/ai-provider-registry";
import type { AIProvider, AIProviderRequest, AIProviderResponse } from "@/lib/architecture/ai/ai-provider";
import { getMemoryProvider, setMemoryProvider } from "@/lib/architecture/memory/memory-provider-registry";
import type { MemoryProvider } from "@/lib/architecture/memory/memory-provider";
import type { AgentContext } from "@/lib/agent-context";
import { parseX402PaymentRequired } from "@/lib/x402/x402-parse";
import { buildX402PaymentProposal } from "@/lib/x402/x402-proposal";
import { X402_SUPPORTED_NETWORK } from "@/lib/x402/x402-config";

// LocalMemoryProvider (the default) is a no-op in this node test
// environment — it guards every read/write on `typeof window !==
// "undefined"` (see lib/storage.ts), which is never true here. Without
// a real in-memory implementation, appendUserMessage/appendAssistantReply/
// regenerateLastReply would each independently see an empty state and
// this test couldn't observe multi-call sequencing at all. This double
// is scoped to this test file only (installed in beforeEach, restored
// in afterEach) and implements nothing beyond the MemoryProvider
// interface itself.
class InMemoryTestMemoryProvider implements MemoryProvider {
  private store = new Map<string, unknown>();
  async get<T extends object>(key: string, fallback: T): Promise<T> {
    return this.store.has(key) ? (this.store.get(key) as T) : fallback;
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.store.delete(key);
  }
  async has(key: string): Promise<boolean> {
    return this.store.has(key);
  }
  async beginTransaction(): Promise<void> {}
  async commit(): Promise<void> {}
  async rollback(): Promise<void> {}
}

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const RESOURCE = "https://api.example.com/paid-report";
const ADDRESS = "0x000000000000000000000000000000000000aa";

function buildFixtureProposal() {
  const parsed = parseX402PaymentRequired({
    x402Version: 1,
    accepts: [
      { scheme: "exact", network: X402_SUPPORTED_NETWORK, maxAmountRequired: "2500000", resource: RESOURCE, payTo: PAY_TO, asset: USDC },
    ],
  });
  if (!parsed.ok) throw new Error("test setup failed to parse requirement");
  const built = buildX402PaymentProposal(RESOURCE, parsed.requirements[0]);
  if (!built.ok) throw new Error("test setup failed to build proposal");
  return built.proposal;
}

function fakeProvider(response: AIProviderResponse): AIProvider {
  return {
    name: "fake-x402-test-provider",
    requiresNetwork: false,
    generateReply: async (_request: AIProviderRequest) => response,
  };
}

const FAKE_CONTEXT = { isConnected: true } as unknown as AgentContext;

describe("agent-engine x402Proposal threading", () => {
  const originalAIProvider = getAIProvider();
  const originalMemoryProvider = getMemoryProvider();

  beforeEach(() => {
    setMemoryProvider(new InMemoryTestMemoryProvider());
  });

  afterEach(() => {
    setAIProvider(originalAIProvider);
    setMemoryProvider(originalMemoryProvider);
  });

  it("appendAssistantReply carries x402Proposal from the provider response onto the new AgentMessage", async () => {
    const proposal = buildFixtureProposal();
    setAIProvider(
      fakeProvider({
        intent: "general_help",
        reply: "I've prepared a payment proposal for you to review and confirm.",
        actions: [],
        highlights: [],
        followUps: [],
        x402Proposal: proposal,
      })
    );

    await appendUserMessage(ADDRESS, "Please pay for and fetch that report");
    const state = await appendAssistantReply(ADDRESS, "Please pay for and fetch that report", FAKE_CONTEXT);

    const last = state.messages[state.messages.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.x402Proposal).toEqual(proposal);
  });

  it("appendAssistantReply does not attach x402Proposal for an ordinary reply", async () => {
    setAIProvider(
      fakeProvider({
        intent: "general_help",
        reply: "Sure, here's your staking summary.",
        actions: [],
        highlights: [],
        followUps: [],
      })
    );

    await appendUserMessage(ADDRESS, "What's my staking summary?");
    const state = await appendAssistantReply(ADDRESS, "What's my staking summary?", FAKE_CONTEXT);

    const last = state.messages[state.messages.length - 1];
    expect(last.x402Proposal).toBeUndefined();
  });

  it("regenerateLastReply also carries x402Proposal through", async () => {
    const proposal = buildFixtureProposal();

    setAIProvider(
      fakeProvider({ intent: "general_help", reply: "First answer.", actions: [], highlights: [], followUps: [] })
    );
    await appendUserMessage(ADDRESS, "Pay for that report");
    await appendAssistantReply(ADDRESS, "Pay for that report", FAKE_CONTEXT);

    setAIProvider(
      fakeProvider({
        intent: "general_help",
        reply: "Regenerated: proposal ready for your review.",
        actions: [],
        highlights: [],
        followUps: [],
        x402Proposal: proposal,
      })
    );
    const state = await regenerateLastReply(ADDRESS, FAKE_CONTEXT);

    const last = state.messages[state.messages.length - 1];
    expect(last.x402Proposal).toEqual(proposal);
    expect(last.content).toBe("Regenerated: proposal ready for your review.");
  });
});
