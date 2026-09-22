import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// components/features/agent/AgentStage.render.test.ts
//
// Renders the real Agent stage (AgentExperience + the folded hero) to a
// string and locks the redesign's structural contract — the composition,
// not the styling:
//
//   1. The stage exists with its three zones (top bar / body / dock) and
//      the preserved testids (agent-chat-surface, agent-composer,
//      stocks-agent-hero).
//   2. STATE A (disconnected) is a real workspace: the AgentCore, the
//      existing empty-state line, ALL SIX chips (visible while
//      disconnected — a tap opens the connect modal), and the 56px
//      Connect CTA.
//   3. STATE A (connected + empty) keeps the chips and the line, drops
//      the Connect CTA.
//   4. STATE B (connected + messages) mounts the conversation window,
//      the Clear control, and the 28px core JEWEL inside the folded hero
//      (the big empty-state core is gone).
//
// The chat controller and payment hooks are mocked at the module
// boundary — this test never sends anything; it only asserts what the
// stage renders per connection/thread state. JSX is expressed with
// createElement because this repo's vitest config only picks up
// *.test.ts files.

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

const chatState = (overrides: Record<string, unknown>) => ({
  ...disconnectedChat,
  ...overrides,
});

vi.mock("@rainbow-me/rainbowkit", () => ({
  useConnectModal: () => ({ connectModalOpen: false, openConnectModal: () => {} }),
}));
vi.mock("wagmi", () => ({ useAccount: () => ({ address: undefined, isConnected: false }) }));
vi.mock("@/hooks/useAgentChat", () => ({
  useAgentChat: vi.fn(() => disconnectedChat),
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

const { useAgentChat } = await import("@/hooks/useAgentChat");
const { AgentExperience } = await import("@/components/features/agent/AgentExperience");
const { StocksAgentHero } = await import("@/components/features/agent/StocksAgentHero");

import { STOCKS_AGENT_CHIPS, STOCKS_AGENT_EMPTY_STATE } from "@/lib/agent-stocks-config";

const heroSlot = (
  statuses: Parameters<typeof StocksAgentHero>[0]["statuses"],
  opts: { thread: boolean },
) => createElement(StocksAgentHero, { statuses, thread: opts.thread });

const stage = () =>
  createElement(AgentExperience, {
    heroSlot,
    suggestions: STOCKS_AGENT_CHIPS,
    emptyStateText: STOCKS_AGENT_EMPTY_STATE,
  });

describe("Agent stage (rendered)", () => {
  it("renders the stage with the preserved testids and the /help hint", () => {
    const html = renderToString(stage());
    expect(html).toContain('data-testid="agent-chat-surface"');
    expect(html).toContain('data-testid="agent-composer"');
    expect(html).toContain('data-testid="stocks-agent-hero"');
    expect(html).toContain("MPGR AGENT");
    expect(html).toContain("/help");
  });

  it("STATE A (disconnected): core + existing line + all 6 chips + Connect CTA", () => {
    (useAgentChat as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
      chatState({ isConnected: false, hasLoaded: false }),
    );
    const html = renderToString(stage());

    // The 3D core object and its contact shadow exist.
    expect(html).toContain("agent-core-float");
    expect(html).toContain("agent-core-shadow");

    // The one existing empty-state line.
    expect(html).toContain(STOCKS_AGENT_EMPTY_STATE);

    // ALL six chips render while disconnected (a tap opens the connect modal).
    for (const chip of STOCKS_AGENT_CHIPS) {
      expect(html).toContain(chip.label);
    }

    // The physical Connect CTA lives in the body.
    expect(html).toContain("Connect Wallet");
    expect(html).toContain("btn-primary");

    // No conversation chrome yet.
    expect(html).not.toContain("agent-chat-window");
    expect(html).not.toContain(">Clear<");
  });

  it("STATE A (connected + empty): keeps line + chips, drops the Connect CTA", () => {
    (useAgentChat as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
      chatState({ isConnected: true, hasLoaded: true, messages: [] }),
    );
    const html = renderToString(stage());

    expect(html).toContain(STOCKS_AGENT_EMPTY_STATE);
    for (const chip of STOCKS_AGENT_CHIPS) {
      expect(html).toContain(chip.label);
    }
    expect(html).toContain("agent-core-float");
    expect(html).not.toContain("Connect Wallet");
  });

  it("STATE B (connected + messages): thread fills the body, Clear appears, hero shows the jewel", () => {
    (useAgentChat as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
      chatState({
        isConnected: true,
        hasLoaded: true,
        messages: [
          { id: "m1", role: "user", content: "hi", timestamp: new Date().toISOString() },
        ],
      }),
    );
    const html = renderToString(stage());

    expect(html).toContain('data-testid="agent-chat-window"');
    expect(html).toContain(">Clear<");
    // The chips moved into the dock, above the composer.
    expect(html).toContain('data-testid="agent-composer-suggestions"');
    // The big empty-state core is replaced by the 28px top-bar jewel.
    expect(html).not.toContain("agent-core-shadow");

    // The folded hero renders the jewel next to the runtime status.
    const heroHtml = renderToString(
      createElement(StocksAgentHero, { statuses: ["online"], thread: true }),
    );
    expect(heroHtml).toContain('data-testid="stocks-agent-hero"');
    expect(heroHtml).toContain("h-7 w-7");
    const heroNoThread = renderToString(
      createElement(StocksAgentHero, { statuses: ["online"], thread: false }),
    );
    expect(heroNoThread).not.toContain("h-7 w-7");
  });
});
