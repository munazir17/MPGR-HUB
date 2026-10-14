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
import type { AutonomyConfig } from "@/hooks/useAgentAutonomy";
import { delegatedActionId } from "@/lib/executor/delegated-executor";
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

function renderPanel(draft: AutonomyGoalDraft | null, config: AutonomyConfig | null = null, extra: Record<string, unknown> = {}) {
  hooks.beginRender();
  return AgentAutonomyPanel({
    autonomy: {
      config,
      goals: [],
      policies: [],
      tokens: [],
      slots: [],
      slotsSigningSupported: false,
      draft,
      busy: false,
      error: null,
      dismissError: () => {},
      pause: async () => true,
      resume: async () => true,
      cancel: async () => true,
      revokePolicy: async () => true,
      revokeSlot: async () => true,
      signDelegatedSlots: async () => ({ ok: true as const }),
      authorizeGoal: async () => ({ ok: true as const }),
      mutate: async () => true,
      authenticated: false,
      authenticating: false,
      signIn: async () => true,
      ...extra,
    } as never,
  });
}

function header(tree: ReturnType<typeof AgentAutonomyPanel>) {
  const children = tree.props.children as ReactNode[];
  return children[0] as ReactElement<{ "aria-expanded": boolean; onClick: () => void }>;
}

function findByTestId(node: ReactNode, testId: string): ReactElement<{ children?: ReactNode; "data-testid"?: string }> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByTestId(child, testId);
      if (found) return found;
    }
    return null;
  }
  if (node === null || typeof node !== "object" || !("props" in node)) return null;
  const element = node as ReactElement<{ children?: ReactNode; "data-testid"?: string }>;
  if (element.props["data-testid"] === testId) return element;
  return findByTestId(element.props.children, testId);
}

function renderedText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(renderedText).join("");
  if (node === null || typeof node !== "object" || !("props" in node)) return "";
  return renderedText((node as ReactElement<{ children?: ReactNode }>).props.children);
}

function openPanel(config: AutonomyConfig) {
  const closed = renderPanel(null, config);
  header(closed).props.onClick();
  return renderPanel(null, config);
}

function runtimeConfig(overrides: Partial<AutonomyConfig> = {}): AutonomyConfig {
  return {
    enabled: true,
    emergencyDisabled: false,
    productionGate: false,
    executionAvailable: false,
    delegated: {
      chainId: 8453,
      executor: "0x39B1C6Ea88A01e70cbF4899BF3cEfB2c43cD32Bb",
      walletSigningSupported: true,
    },
    limits: {
      maxGoalsPerWallet: 10,
      minCooldownSeconds: 60,
      maxPolicyTtlDays: 30,
      maxPerTradeHuman: "10000",
      maxDailyHuman: "100000",
      maxSlippageBps: 500,
    },
    ...overrides,
  };
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

describe("delegated dashboard status follows the runtime configuration", () => {
  it("reports the selected Mainnet chain and pinned executor while the production gate is OFF", () => {
    const config = runtimeConfig();
    const tree = openPanel(config);
    const network = findByTestId(tree, "delegated-execution-network");
    const executor = findByTestId(tree, "delegated-execution-executor");
    const readiness = findByTestId(tree, "delegated-execution-readiness");

    expect(network).not.toBeNull();
    expect(renderedText(network)).toContain("Base Mainnet");
    expect(renderedText(network)).toContain("Chain ID 8453");
    expect(renderedText(network)).not.toContain("Base Sepolia");
    expect(executor).not.toBeNull();
    expect(renderedText(executor)).toBe("0x39B1C6Ea88A01e70cbF4899BF3cEfB2c43cD32Bb");
    expect(readiness).not.toBeNull();
    expect(renderedText(readiness)).toContain("Watch-only");
    expect(renderedText(readiness)).toContain("production gate OFF");
    expect(renderedText(readiness)).not.toContain("not configured");
  });

  it("keeps a selected Sepolia adapter visibly separate from Mainnet", () => {
    const config = runtimeConfig({
      delegated: {
        chainId: 84532,
        executor: "0xa9568499D7e58854F2590a56B6D32788DbfA58F9",
        walletSigningSupported: true,
      },
    });
    const tree = openPanel(config);
    const network = findByTestId(tree, "delegated-execution-network");
    const executor = findByTestId(tree, "delegated-execution-executor");

    expect(renderedText(network)).toContain("Base Sepolia");
    expect(renderedText(network)).toContain("Chain ID 84532");
    expect(renderedText(network)).not.toContain("Base Mainnet");
    expect(renderedText(executor)).toBe("0xa9568499D7e58854F2590a56B6D32788DbfA58F9");
  });

  it("shows a selected Mainnet chain as unconfigured if its executor pin is missing", () => {
    const config = runtimeConfig({
      delegated: { chainId: 8453, executor: null, walletSigningSupported: false },
      productionGate: true,
    });
    const tree = openPanel(config);
    const network = findByTestId(tree, "delegated-execution-network");
    const executor = findByTestId(tree, "delegated-execution-executor");
    const readiness = findByTestId(tree, "delegated-execution-readiness");

    expect(renderedText(network)).toContain("Base Mainnet");
    expect(renderedText(network)).toContain("Chain ID 8453");
    expect(executor).toBeNull();
    expect(renderedText(readiness)).toContain("no executor is pinned");
    expect(renderedText(readiness)).not.toContain("Watch-only");
  });

  it("does not present an unselected adapter as configured on either network", () => {
    const config = runtimeConfig({
      delegated: { chainId: null, executor: null, walletSigningSupported: false },
    });
    const tree = openPanel(config);
    const network = findByTestId(tree, "delegated-execution-network");
    const executor = findByTestId(tree, "delegated-execution-executor");
    const readiness = findByTestId(tree, "delegated-execution-readiness");

    expect(renderedText(network)).toContain("No adapter configured");
    expect(renderedText(network)).not.toContain("Base Mainnet");
    expect(renderedText(network)).not.toContain("Base Sepolia");
    expect(executor).toBeNull();
    expect(renderedText(readiness)).toContain("no delegated adapter is selected");
  });
});

it("preserves a manually edited goal form across closing and reopening", () => {
  const config = runtimeConfig();
  let tree = openPanel(config);
  const collect = (node: ReactNode): ReactElement<Record<string, unknown>>[] => {
    if (Array.isArray(node)) return node.flatMap(collect);
    if (!node || typeof node !== "object" || !("props" in node)) return [];
    const el = node as ReactElement<Record<string, unknown>>;
    return [el, ...collect(el.props.children as ReactNode)];
  };
  const amount = collect(tree).find((el) => el.type === "input" && el.props.inputMode === "decimal" && el.props.value === "50");
  expect(amount).toBeDefined();
  (amount!.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: "2.5" } });
  tree = renderPanel(null, config); header(tree).props.onClick();
  tree = renderPanel(null, config); expect(header(tree).props["aria-expanded"]).toBe(false);
  header(tree).props.onClick(); tree = renderPanel(null, config);
  expect(collect(tree).some((el) => el.type === "input" && el.props.value === "2.5")).toBe(true);
});

it("offers pending-goal recovery without another signature even when all five nonce indexes exist", () => {
  const sell = "0x1111111111111111111111111111111111111111";
  const buy = "0x2222222222222222222222222222222222222222";
  const extra = { goals: [{ id: "goal_saved", policyId: "policy_saved", status: "DRAFT", trade: { sellToken: sell, buyToken: buy, sellAmountRaw: "1000000" } }],
    policies: [{ id: "policy_saved", chainId: 8453, enabled: true, revokedAt: null, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), maxPerTradeRaw: "1000000" }],
    slots: Array.from({ length: 5 }, (_, i) => ({ id: `slot_${i}`, policyId: "policy_saved", goalId: "goal_saved", slotIndex: i, status: i ? "consumed" : "active",
      sellToken: sell, buyToken: buy, amountRaw: "1000000", minAmountOutRaw: "1", actionId: delegatedActionId("goal_saved"), deadline: Math.floor(Date.now() / 1000) + 3600, consumedAt: i ? new Date().toISOString() : null, revokedAt: null })) };
  const config = runtimeConfig(); let tree = renderPanel(null, config, extra);
  header(tree).props.onClick(); tree = renderPanel(null, config, extra);
  const button = findByTestId(tree, "delegated-sign-button")!;
  expect(renderedText(button)).toContain("Activate with saved permission");
  expect((button.props as Record<string, unknown>).disabled).toBe(false);
});
