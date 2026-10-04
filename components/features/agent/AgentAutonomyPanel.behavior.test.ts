import { beforeEach, describe, expect, it, vi } from "vitest";

// Tiny hook host for this interaction test: it preserves component state
// between renders and lets the test flush effects like React does after a
// commit, without adding a DOM-rendering test dependency.
const hooks = vi.hoisted(() => {
  const states: unknown[] = [];
  let cursor = 0;
  let effects: Array<() => void> = [];

  return {
    beginRender() {
      cursor = 0;
      effects = [];
    },
    flushEffects() {
      const pending = effects;
      effects = [];
      pending.forEach((effect) => effect());
    },
    reset() {
      states.length = 0;
      cursor = 0;
      effects = [];
    },
    useState(initial: unknown) {
      const index = cursor++;
      if (index === states.length) states.push(initial);
      return [
        states[index],
        (next: unknown) => {
          states[index] = typeof next === "function"
            ? (next as (current: unknown) => unknown)(states[index])
            : next;
        },
      ] as const;
    },
    useEffect(effect: () => void) {
      effects.push(effect);
    },
    useMemo<T>(compute: () => T) {
      return compute();
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: hooks.useEffect,
    useMemo: hooks.useMemo,
    useState: hooks.useState,
  };
});

vi.mock("framer-motion", () => ({ AnimatePresence: "animate-presence", motion: { div: "motion-div" } }));
vi.mock("lucide-react", () => ({ ChevronDown: "icon", PenLine: "icon", Repeat: "icon", ShieldCheck: "icon", ShieldOff: "icon", X: "icon" }));
vi.mock("@/hooks/useAgentAutonomy", () => ({}));

import type { ReactElement, ReactNode } from "react";
import { AgentAutonomyPanel } from "./AgentAutonomyPanel";
import type { AutonomyGoalDraft } from "@/lib/autonomy/chat-draft";

const DRAFT: AutonomyGoalDraft = {
  targetAsset: "AAPLc",
  spendAsset: "USDC",
  side: "buy",
  triggerKind: "price_below",
  triggerPrice: "0.10",
  amountPerTrade: "1",
  sourcePrompt: "Buy AAPLc whenever it falls below $0.10, max 1 USDC per trade",
};

function renderPanel(draft: AutonomyGoalDraft | null) {
  hooks.beginRender();
  return AgentAutonomyPanel({
    autonomy: { config: null, goals: [], policies: [], tokens: [], draft } as never,
  });
}

function header(tree: ReturnType<typeof AgentAutonomyPanel>) {
  const children = tree.props.children as ReactNode[];
  return children[0] as ReactElement<{ "aria-expanded": boolean; onClick: () => void }>;
}

beforeEach(() => hooks.reset());

describe("AgentAutonomyPanel is independent of chat drafts", () => {
  it("does not expand when a chat draft arrives", () => {
    const closed = renderPanel(null);
    expect(header(closed).props["aria-expanded"]).toBe(false);
    hooks.flushEffects();

    renderPanel(DRAFT);
    hooks.flushEffects();
    const still = renderPanel(DRAFT);

    expect(header(still).props["aria-expanded"]).toBe(false);
  });

  it("can be opened independently while a chat draft exists", () => {
    const tree = renderPanel(DRAFT);
    expect(header(tree).props["aria-expanded"]).toBe(false);
    header(tree).props.onClick();
    const opened = renderPanel(DRAFT);
    expect(header(opened).props["aria-expanded"]).toBe(true);
  });

  it("stays however the user left it when the chat draft is cleared", () => {
    const tree = renderPanel(null);
    header(tree).props.onClick();
    expect(header(renderPanel(DRAFT)).props["aria-expanded"]).toBe(true);

    hooks.reset();
    const closed = renderPanel(DRAFT);
    expect(header(closed).props["aria-expanded"]).toBe(false);
    renderPanel(null);
    expect(header(renderPanel(null)).props["aria-expanded"]).toBe(false);
  });
});
