import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutonomyGoalDraft } from "@/lib/autonomy/chat-draft";
import { autonomyDraftToForm } from "./autonomy-authorize-form";

// Chat draft vs manual Autonomous Goals — the two entry points must stay
// separate. This file locks the UX contract:
//   1. A chat-created draft card appears in the thread.
//   2. Clicking it opens the draft-specific review UI (not the manual form).
//   3. Review values come from AutonomyGoalDraft, not reparsed chat text.
//   4. The manual Autonomous Goals panel stays independently accessible.
//   5. Closing the draft review does not open the manual panel.

const fixtures = vi.hoisted(() => {
  const DRAFT: AutonomyGoalDraft = {
    targetAsset: "AAPLc",
    spendAsset: "USDC",
    side: "buy",
    triggerKind: "price_below",
    triggerPrice: "0.10",
    amountPerTrade: "1",
    // Intentionally not parseable as an autonomous prompt — the review UI
    // must reuse the structured draft rather than reconstructing from text.
    sourcePrompt: "please set that up for me",
  };
  const USDC = { address: "0x1111111111111111111111111111111111111111", symbol: "USDC", decimals: 6 };
  const AAPLc = { address: "0x2222222222222222222222222222222222222222", symbol: "AAPLc", decimals: 8 };
  const autonomy = {
    config: {
      enabled: true,
      emergencyDisabled: false,
      executionAvailable: false,
      limits: {
        maxGoalsPerWallet: 5,
        minCooldownSeconds: 60,
        maxPolicyTtlDays: 30,
        maxPerTradeHuman: "100",
        maxDailyHuman: "500",
        maxSlippageBps: 100,
      },
    },
    goals: [] as unknown[],
    policies: [] as unknown[],
    tokens: [USDC, AAPLc],
    slots: [] as unknown[],
    slotsSigningSupported: false,
    busy: false,
    error: null as string | null,
    draft: null as AutonomyGoalDraft | null,
    dismissError: () => {},
    refresh: async () => {},
    pause: async () => true,
    resume: async () => true,
    cancel: async () => true,
    revokePolicy: async () => true,
    revokeSlot: async () => true,
    signDelegatedSlots: async () => ({ ok: true as const }),
    authorizeGoal: async () => ({ ok: true as const }),
    mutate: async () => true,
    openWithDraft: (next: AutonomyGoalDraft) => {
      autonomy.draft = next;
    },
    clearDraft: () => {
      autonomy.draft = null;
    },
  };
  return { DRAFT, USDC, AAPLc, autonomy };
});

const disconnectedChat = {
  messages: [],
  thinking: false,
  isConnected: false,
  hasLoaded: false,
  error: null,
  canRegenerate: false,
  sendMessage: () => {},
  clearChat: () => {},
  retryLastMessage: () => {},
  regenerateLastMessage: () => {},
  sendFeedback: () => {},
  dismissError: () => {},
  commandPalette: {
    isOpen: false,
    results: [],
    highlightedIndex: -1,
    highlighted: null,
    open: () => {},
    close: () => {},
    setQuery: () => {},
    moveHighlight: () => {},
  },
  selectPaletteCommand: () => {},
  actionHistory: [],
  clearHistory: () => {},
  streamingMessageId: null,
  appendTradeExecutionResult: () => {},
  appendTransferExecutionResult: () => {},
  stopGeneration: () => {},
  personalization: { mostUsedCommands: [] },
};

vi.mock("@rainbow-me/rainbowkit", () => ({
  useConnectModal: () => ({ connectModalOpen: false, openConnectModal: () => {} }),
}));
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: undefined, isConnected: false }),
  useSignTypedData: () => ({ signTypedDataAsync: async () => { throw new Error("not used in render tests"); } }),
}));
vi.mock("@/hooks/useAgentChat", () => ({
  useAgentChat: vi.fn(() => disconnectedChat),
}));
vi.mock("@/hooks/useAgentAutonomy", () => ({
  useAgentAutonomy: () => fixtures.autonomy,
}));
vi.mock("@/hooks/useX402Payment", () => ({
  useX402Payment: () => ({
    open: false,
    proposal: null,
    confirmationState: { phase: "idle" },
    confirmationError: null,
    executionState: { phase: "idle" },
    executionError: null,
    settlement: null,
    openProposal: () => {},
    close: () => {},
    confirmAndPay: () => {},
  }),
}));
vi.mock("@/hooks/useTradeQuote", () => ({
  useTradeQuote: () => ({
    open: false,
    proposal: null,
    confirmationState: { phase: "idle" },
    confirmationError: null,
    executionState: { phase: "idle" },
    executionError: null,
    approvalHash: null,
    swapHash: null,
    stepLabel: null,
    openProposal: () => {},
    close: () => {},
    confirmAndSwap: () => {},
  }),
}));
vi.mock("@/hooks/useTransferQuote", () => ({
  useTransferQuote: () => ({
    open: false,
    proposal: null,
    confirmationState: { phase: "idle" },
    confirmationError: null,
    executionState: { phase: "idle" },
    executionError: null,
    txHash: null,
    stepLabel: null,
    openProposal: () => {},
    close: () => {},
    confirmAndSend: () => {},
  }),
}));
vi.mock("@/hooks/useStreamingText", () => ({
  useStreamingText: (text: string) => ({ text, done: true }),
}));

const { useAgentChat } = await import("@/hooks/useAgentChat");
const { AgentExperience } = await import("@/components/features/agent/AgentExperience");
const { AgentChatBubble } = await import("@/components/features/agent/AgentChatBubble");
const { AgentAutonomyDraftCard } = await import("@/components/features/agent/AgentAutonomyDraftCard");
const { AgentAutonomyDraftReview } = await import("@/components/features/agent/AgentAutonomyDraftReview");

const DRAFT = fixtures.DRAFT;

function chatWithDraft() {
  return {
    ...disconnectedChat,
    isConnected: true,
    hasLoaded: true,
    messages: [
      {
        id: "u1",
        role: "user" as const,
        content: "Buy AAPLc whenever it falls below $0.10, max 1 USDC per trade",
        timestamp: "2026-10-04T00:00:00Z",
      },
      {
        id: "a1",
        role: "assistant" as const,
        content: "I can create this as an autonomous goal.",
        timestamp: "2026-10-04T00:00:01Z",
        autonomyGoalDraft: DRAFT,
      },
    ],
  };
}

function stage() {
  return createElement(AgentExperience, {
    heroSlot: () => createElement("div", { "data-testid": "hero" }, "hero"),
    suggestions: [],
    emptyStateText: "empty",
  });
}

function renderStage() {
  (useAgentChat as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => chatWithDraft());
  return renderToStaticMarkup(stage());
}

beforeEach(() => {
  fixtures.autonomy.draft = null;
  fixtures.autonomy.error = null;
  fixtures.autonomy.busy = false;
});

describe("chat autonomous draft vs manual goal flow", () => {
  it("shows the chat draft card from the structured AutonomyGoalDraft", () => {
    const html = renderToStaticMarkup(
      createElement(AgentChatBubble, {
        message: {
          id: "a1",
          role: "assistant",
          content: "I can create this as an autonomous goal.",
          timestamp: "2026-10-04T00:00:01Z",
          autonomyGoalDraft: DRAFT,
        },
        onReviewAutonomyGoal: () => {},
      }),
    );
    expect(html).toContain('data-testid="agent-autonomy-draft-card"');
    expect(html).toContain("Autonomous goal draft — inactive until you authorize it");
    expect(html).toContain("AAPLc");
    expect(html).toContain("0.10");
    expect(html).toContain("1 USDC");

    const stageHtml = renderStage();
    expect(stageHtml).toContain('data-testid="agent-autonomy-draft-card"');
  });

  it("clicking the chat draft opens the draft-specific review UI, not the manual form", () => {
    const seen: AutonomyGoalDraft[] = [];
    const card = AgentAutonomyDraftCard({
      draft: DRAFT,
      onReview: (next) => seen.push(next),
    }) as ReactElement<{ children: ReactElement<{ onClick: () => void }> }>;
    card.props.children.props.onClick();
    expect(seen).toEqual([DRAFT]);
    expect(seen[0]).toBe(DRAFT);

    fixtures.autonomy.openWithDraft(DRAFT);
    const html = renderStage();
    expect(html).toContain('data-testid="agent-autonomy-draft-review"');
    expect(html).toContain("Review autonomous goal");
    expect(html).toContain("Authorize &amp; activate goal");
    expect(html).not.toContain('data-testid="agent-autonomy-manual-form"');
    expect(html).not.toContain("New autonomous goal");
    expect(html).toContain('data-testid="agent-autonomy-panel"');
    expect(html).toContain('aria-expanded="false"');
  });

  it("pre-fills review values from the AutonomyGoalDraft, not from chat text", () => {
    const mapped = autonomyDraftToForm(DRAFT, [fixtures.USDC, fixtures.AAPLc]);
    expect(mapped.sell).toBe(fixtures.USDC.address);
    expect(mapped.buy).toBe(fixtures.AAPLc.address);
    expect(mapped.kind).toBe("price_below");
    expect(mapped.threshold).toBe("0.10");
    expect(mapped.sellAmount).toBe("1");

    fixtures.autonomy.draft = DRAFT;
    const html = renderToStaticMarkup(createElement(AgentAutonomyDraftReview, { autonomy: fixtures.autonomy as never }));
    expect(html).toContain('data-testid="agent-autonomy-draft-review"');
    expect(html).toContain('data-testid="agent-autonomy-draft-values"');
    expect(html).toContain("Sell/spend token");
    expect(html).toContain("Buy/receive token");
    expect(html).toContain("Trigger price");
    expect(html).toContain("Amount per trade");
    expect(html).toContain("USDC");
    expect(html).toContain("AAPLc");
    expect(html).toContain("0.10");
    expect(html).toContain("1 USDC");
    expect(html).toContain("please set that up for me");
    expect(html).toContain(`value="${fixtures.USDC.address}"`);
    expect(html).toContain(`value="${fixtures.AAPLc.address}"`);
    expect(html).toContain('data-testid="autonomy-draft-amount"');
    expect(html).toContain('value="1"');
    expect(html).toContain('data-testid="autonomy-draft-price"');
    expect(html).toContain('value="0.10"');
    expect(html).toContain("below");
    // Must not reconstruct a trigger from the unparseable sourcePrompt.
    expect(html).not.toContain("$200");
  });

  it("keeps the manual Autonomous Goals panel independently accessible", () => {
    const html = renderStage();
    expect(html).toContain('data-testid="agent-autonomy-panel"');
    expect(html).toContain("Autonomous Goals");
    expect(html).not.toContain('data-testid="agent-autonomy-draft-review"');
    expect(html).not.toContain('data-testid="agent-autonomy-manual-form"');
  });

  it("closing the chat draft review does not open the manual panel", () => {
    fixtures.autonomy.openWithDraft(DRAFT);
    let html = renderStage();
    expect(html).toContain('data-testid="agent-autonomy-draft-review"');
    expect(html).not.toContain('data-testid="agent-autonomy-manual-form"');

    fixtures.autonomy.clearDraft();
    html = renderStage();
    expect(html).not.toContain('data-testid="agent-autonomy-draft-review"');
    expect(html).not.toContain("Review autonomous goal");
    expect(html).not.toContain('data-testid="agent-autonomy-manual-form"');
    expect(html).not.toContain("New autonomous goal");
    expect(html).toContain('data-testid="agent-autonomy-panel"');
    expect(html).toContain('aria-expanded="false"');
  });
});
