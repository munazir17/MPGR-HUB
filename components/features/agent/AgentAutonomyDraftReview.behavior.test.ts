import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Small hook harness, following the existing hook tests. Real review component
// and effects; only wallet/session/network state is mocked. No signing, goals,
// activation, executor, or transaction endpoint can be called by this harness.
const harness = vi.hoisted(() => ({
  states: [] as unknown[], stateIndex: 0, effectIndex: 0,
  deps: [] as unknown[][], cleanup: [] as (undefined | (() => void))[], pending: [] as (() => void)[],
  wallet: { isConnected: true, chainId: 8453 },
}));
vi.mock("react", async (load) => {
  const real = await load<typeof import("react")>();
  return { ...real, useId: () => "review-title", useState: (initial: unknown) => {
    const i = harness.stateIndex++;
    if (!(i in harness.states)) harness.states[i] = initial;
    return [harness.states[i], (next: unknown) => { harness.states[i] = typeof next === "function" ? next(harness.states[i]) : next; }];
  }, useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const i = harness.effectIndex++;
    if (!harness.deps[i] || deps.some((v, j) => !Object.is(v, harness.deps[i][j]))) {
      harness.cleanup[i]?.();
      harness.deps[i] = deps;
      harness.pending.push(() => { harness.cleanup[i] = effect() || undefined; });
    }
  } };
});
vi.mock("wagmi", () => ({ useAccount: () => harness.wallet }));
vi.mock("framer-motion", async () => ({ AnimatePresence: (await import("react")).Fragment, motion: { div: "div" } }));
import type { AutonomySettingsDiagnostic } from "@/lib/api/autonomy-settings";
import { AgentAutonomyDraftReview } from "./AgentAutonomyDraftReview";
import { CHAT_REVIEW_TOKENS } from "./chat-autonomy-review";
import { buildGoalDraft, detectAutonomousTradeRequest } from "@/lib/autonomy/chat-draft";

const prompt = "Buy AAPLc whenever price falls 1% worth 1 USDC";
const config = {
  enabled: true, emergencyDisabled: false, productionGate: true, executionAvailable: true,
  delegated: { chainId: 8453, executor: "0x1111111111111111111111111111111111111111", walletSigningSupported: true },
  limits: { maxGoalsPerWallet: 5, minCooldownSeconds: 60, maxPolicyTtlDays: 30, maxPerTradeHuman: "100", maxDailyHuman: "500", maxSlippageBps: 100 },
};
const autonomy = {
  draft: buildGoalDraft(detectAutonomousTradeRequest(prompt)!, prompt, { referencePrice: "347" }),
  tokens: CHAT_REVIEW_TOKENS, config, settingsRead: { state: "loaded", httpStatus: 200 } as AutonomySettingsDiagnostic, authenticated: true, authenticating: false, busy: false, error: null,
  clearDraft: vi.fn(), dismissError: vi.fn(), refresh: vi.fn(async () => {}), signIn: vi.fn(async () => true),
  activateDraft: vi.fn(async () => { throw new Error("Verification must never authorize a goal"); }),
};
const network = vi.fn<typeof fetch>();
type Props = Record<string, unknown> & { children?: ReactNode };
function render() {
  harness.stateIndex = harness.effectIndex = 0;
  const outer = AgentAutonomyDraftReview({ autonomy: autonomy as never }) as ReactElement<{ children: ReactElement }>;
  const dialog = outer.props.children as ReactElement<Record<string, unknown>>;
  return (dialog.type as (props: Record<string, unknown>) => ReactElement)(dialog.props);
}
function find(tree: ReactNode, id: string): ReactElement<Props> {
  if (isValidElement<Props>(tree)) {
    if (tree.props["data-testid"] === id) return tree;
    for (const child of Array.isArray(tree.props.children) ? tree.props.children : [tree.props.children]) {
      try { return find(child, id); } catch { /* next child */ }
    }
  }
  throw new Error(`No element ${id}`);
}
function edit(tree: ReactNode, id: string, value: string) {
  (find(tree, id).props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}
async function effects() {
  for (const effect of harness.pending.splice(0)) effect();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
beforeEach(() => {
  harness.states = []; harness.deps = []; harness.cleanup = []; harness.pending = [];
  harness.wallet = { isConnected: true, chainId: 8453 };
  autonomy.tokens = CHAT_REVIEW_TOKENS; autonomy.config = config; autonomy.settingsRead = { state: "loaded", httpStatus: 200 }; autonomy.authenticated = true;
  vi.clearAllMocks();
  network.mockImplementation(async (url, init) => {
    expect(url).toBe("/api/trade/quote");
    expect(init?.method).toBe("POST");
    return new Response(JSON.stringify({ proposal: { minToAmount: "280000" } }), { status: 200 });
  });
  vi.stubGlobal("fetch", network);
});
afterEach(() => {
  harness.cleanup.forEach((fn) => fn?.());
  vi.unstubAllGlobals();
});

describe("Chat draft review effect and validation behavior", () => {
  it("renders canonical options/selections on mobile-style first render, without fetching or signing", () => {
    autonomy.tokens = [];
    const tree = render();
    const html = renderToStaticMarkup(tree);
    expect(html).toMatch(/<option[^>]*selected=""[^>]*>USDC<\/option>/);
    expect(html).toMatch(/<option[^>]*selected=""[^>]*>AAPLc<\/option>/);
    expect(find(tree, "autonomy-draft-amount").props.value).toBe("1");
    expect(find(tree, "autonomy-draft-price").props.value).toBe("343.53");
    expect(find(tree, "agent-autonomy-draft-authorize").props.disabled).toBe(true);
    expect(network).not.toHaveBeenCalled();
    expect(autonomy.activateDraft).not.toHaveBeenCalled();
    expect(autonomy.signIn).not.toHaveBeenCalled();
  });
  it("enables only after the matching quote and all required validation succeeds, without authorizing", async () => {
    expect(find(render(), "agent-autonomy-draft-authorize").props.disabled).toBe(true);
    await effects();
    const tree = render();
    expect(find(tree, "agent-autonomy-draft-authorize").props.disabled).toBe(false);
    expect(JSON.parse(network.mock.calls[0][1]!.body as string)).toMatchObject({ amount: "1", fromToken: CHAT_REVIEW_TOKENS.find((t) => t.symbol === "USDC")!.address,
      toToken: CHAT_REVIEW_TOKENS.find((t) => t.symbol === "AAPLc")!.address, slippageBps: 100 });
    expect(autonomy.activateDraft).not.toHaveBeenCalled();
    expect(autonomy.signIn).not.toHaveBeenCalled();
  });
  it("preserves edits when runtime metadata arrives late and immediately invalidates a previous quote", async () => {
    autonomy.tokens = [];
    let tree = render();
    await effects();
    tree = render();
    edit(tree, "autonomy-draft-amount", "2");
    autonomy.tokens = CHAT_REVIEW_TOKENS;
    tree = render();
    expect(find(tree, "autonomy-draft-amount").props.value).toBe("2");
    expect(find(tree, "autonomy-draft-price").props.value).toBe("343.53");
    expect(find(tree, "agent-autonomy-draft-authorize").props.disabled).toBe(true);
    network.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    await effects();
    tree = render();
    expect(find(tree, "agent-autonomy-draft-authorize").props.disabled).toBe(true);
    expect(renderToStaticMarkup(tree)).toContain("Could not load a valid live quote");
    expect(autonomy.activateDraft).not.toHaveBeenCalled();
  });
  it("cannot authorize an invalid form even if its click handler is invoked directly", async () => {
    let tree = render(); await effects(); tree = render();
    edit(tree, "autonomy-draft-price", "");
    tree = render();
    expect(find(tree, "agent-autonomy-draft-authorize").props.disabled).toBe(true);
    await (find(tree, "agent-autonomy-draft-authorize").props.onClick as () => Promise<void>)();
    expect(autonomy.activateDraft).not.toHaveBeenCalled();
    expect(autonomy.signIn).not.toHaveBeenCalled();
  });
  it.each(["0", "NaN", "0.000000001"])("refuses a malformed or invalid quote floor %s", async (minToAmount) => {
    network.mockResolvedValueOnce(new Response(JSON.stringify({ proposal: { minToAmount } }), { status: 200 }));
    render(); await effects();
    expect(find(render(), "agent-autonomy-draft-authorize").props.disabled).toBe(true);
    expect(autonomy.activateDraft).not.toHaveBeenCalled();
  });
  it("a late response for old inputs cannot enable the edited form", async () => {
    let finishOld!: (response: Response) => void;
    network.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    let tree = render(); await effects();
    edit(tree, "autonomy-draft-amount", "2");
    tree = render();
    network.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    await effects();
    finishOld(new Response(JSON.stringify({ proposal: { minToAmount: "280000" } }), { status: 200 }));
    await effects();
    expect(find(render(), "agent-autonomy-draft-authorize").props.disabled).toBe(true);
    expect(autonomy.activateDraft).not.toHaveBeenCalled();
  });
  it("requires explicit sign-in, then a quote, then a separate explicit authorization", async () => {
    autonomy.authenticated = false;
    let tree = render(); await effects();
    expect(network).not.toHaveBeenCalled();
    expect(autonomy.signIn).not.toHaveBeenCalled();
    expect(find(tree, "agent-autonomy-draft-authorize").props.disabled).toBe(true);
    (find(tree, "agent-autonomy-draft-sign-in").props.onClick as () => void)();
    await effects();
    expect(autonomy.signIn).toHaveBeenCalledTimes(1);
    expect(autonomy.activateDraft).not.toHaveBeenCalled();
    autonomy.authenticated = true;
    tree = render(); await effects(); tree = render();
    expect(find(tree, "agent-autonomy-draft-authorize").props.disabled).toBe(false);
    expect(autonomy.activateDraft).not.toHaveBeenCalled();
  });
  it("keeps wrong-network, unavailable, and emergency states disabled even with a quote", async () => {
    render(); await effects();
    harness.wallet.chainId = 84532;
    expect(find(render(), "agent-autonomy-draft-authorize").props.disabled).toBe(true);
    harness.wallet.chainId = 8453;
    autonomy.config = { ...config, emergencyDisabled: true };
    expect(find(render(), "agent-autonomy-draft-authorize").props.disabled).toBe(true);
    autonomy.config = { ...config, enabled: false };
    expect(find(render(), "agent-autonomy-draft-authorize").props.disabled).toBe(true);
    expect(autonomy.activateDraft).not.toHaveBeenCalled();
  });
});


describe("Chat settings and production/readiness failures", () => {
  it.each(["productionGate", "executionAvailable"] as const)("blocks button AND direct handler when %s is false; performs no quote, activation or sign-in", async (gate) => {
    render(); await effects(); // a valid old quote exists before readiness changes
    autonomy.config = { ...config, [gate]: false };
    network.mockClear();
    const tree = render(); await effects();
    expect(find(tree, "agent-autonomy-draft-authorize").props.disabled).toBe(true);
    await (find(tree, "agent-autonomy-draft-authorize").props.onClick as () => Promise<void>)();
    expect(network).not.toHaveBeenCalled();
    expect(autonomy.activateDraft).not.toHaveBeenCalled();
    expect(autonomy.signIn).not.toHaveBeenCalled();
    expect(find(tree, "autonomy-draft-amount").props.value).toBe("1");
    expect(find(tree, "autonomy-draft-price").props.value).toBe("343.53");
  });
  it("shows HTTP/schema diagnostics instead of calling a stale config ready", async () => {
    render(); await effects();
    autonomy.settingsRead = { state: "http_error", httpStatus: 503 };
    network.mockClear();
    const tree = render(); await effects();
    expect(renderToStaticMarkup(tree)).toContain("HTTP 503");
    expect(renderToStaticMarkup(tree)).toContain("Settings GET failed");
    expect(find(tree, "agent-autonomy-draft-authorize").props.disabled).toBe(true);
    await (find(tree, "agent-autonomy-draft-authorize").props.onClick as () => Promise<void>)();
    expect(autonomy.activateDraft).not.toHaveBeenCalled();
    expect(autonomy.signIn).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
  it("separates a loaded but disabled runtime flag from the production gate", async () => {
    autonomy.config = { ...config, enabled: false, productionGate: false, executionAvailable: false };
    autonomy.settingsRead = { state: "loaded", httpStatus: 200, runtimeGate: "missing", productionGate: "disabled" };
    const tree = render(); await effects();
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("runtime flag: missing");
    expect(html).toContain("production safety gate");
    expect(html).toContain("loaded · HTTP 200");
    expect(find(tree, "agent-autonomy-draft-authorize").props.disabled).toBe(true);
    expect(network).not.toHaveBeenCalled();
    expect(autonomy.activateDraft).not.toHaveBeenCalled();
  });
});
