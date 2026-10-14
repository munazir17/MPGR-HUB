import { isValidElement, type ReactElement, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ mode: null as unknown }));
vi.mock("react", async (load) => ({ ...await load<typeof import("react")>(),
  useId: () => "trading", useState: () => [state.mode, (next: (value: unknown) => unknown) => { state.mode = next(state.mode); }],
}));
import { AgentTradingLauncher } from "./AgentTradingLauncher";
import { AgentAutonomyPanel } from "./AgentAutonomyPanel";
import { AgentTradeProposalCard } from "./AgentTradeProposalCard";
import { reviewQuoteFixture } from "./test-fixtures/chat-review-quote";
import { chatDraftToForm } from "./chat-autonomy-review";
import { buildGoalDraft, detectAutonomousTradeRequest } from "@/lib/autonomy/chat-draft";

type Props = Record<string, unknown> & { children?: ReactNode };
function nodes(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...nodes(node.props.children)];
}
const byId = (tree: ReactNode, id: string) => nodes(tree).find((el) => el.props["data-testid"] === id)!;
const connect = vi.fn(); const review = vi.fn();
const autonomy = { authorizeGoal: vi.fn(), signDelegatedSlots: vi.fn(), activateDraft: vi.fn() };
const prompt = "Buy AAPLc when it drops 1% worth 1 USDC";
const proposal = reviewQuoteFixture(chatDraftToForm(buildGoalDraft(detectAutonomousTradeRequest(prompt)!, prompt, { referencePrice: "347" })));
const render = (connected = true) => AgentTradingLauncher({ autonomy: autonomy as never, connected, onConnect: connect, proposals: [proposal], onReviewTrade: review });
const click = (tree: ReactNode, id: string) => (byId(tree, id).props.onClick as () => void)();
beforeEach(() => { state.mode = null; vi.clearAllMocks(); });

describe("external Manual / Autonomy launcher", () => {
  it("is visible with both panels closed; opening or closing performs no writes, quotes or authorization", () => {
    let tree = render();
    expect(byId(tree, "trading-manual-content").props.hidden).toBe(true);
    expect(byId(tree, "trading-autonomy-content").props.hidden).toBe(true);
    click(tree, "trading-launcher-manual"); tree = render();
    expect(byId(tree, "trading-manual-content").props.hidden).toBe(false);
    click(tree, "trading-launcher-manual"); tree = render();
    expect(byId(tree, "trading-manual-content").props.hidden).toBe(true);
    expect(review).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
    expect(autonomy.activateDraft).not.toHaveBeenCalled(); expect(autonomy.authorizeGoal).not.toHaveBeenCalled();
    expect(autonomy.signDelegatedSlots).not.toHaveBeenCalled();
  });
  it("keeps one identical Autonomy panel in the tree while switching modes", () => {
    const panel = (tree: ReactNode) => nodes(tree).filter((el) => el.type === AgentAutonomyPanel);
    let tree = render(); expect(panel(tree)).toHaveLength(1);
    click(tree, "trading-launcher-autonomy"); tree = render();
    expect(panel(tree)[0].props.expanded).toBe(true);
    expect(panel(tree)[0].props.autonomy).toBe(autonomy);
    click(tree, "trading-launcher-manual"); tree = render();
    expect(panel(tree)).toHaveLength(1); expect(panel(tree)[0].props.expanded).toBe(false);
    click(tree, "trading-launcher-autonomy"); tree = render();
    expect(panel(tree)[0].type).toBe(AgentAutonomyPanel); expect(panel(tree)[0].key).toBeNull();
    expect(panel(tree)[0].props.expanded).toBe(true);
  });
  it("reviews the same immediate proposal through the existing handler, never the goal form", () => {
    const tree = render(); const card = nodes(tree).find((el) => el.type === AgentTradeProposalCard)!;
    expect(card.props.proposal).toBe(proposal);
    expect(card.props.onReview).toBe(review);
    (card.props.onReview as typeof review)(proposal); expect(review).toHaveBeenCalledExactlyOnceWith(proposal);
    expect(autonomy.authorizeGoal).not.toHaveBeenCalled();
  });
  it("disconnected controls are visible but require explicit connect; never mount authoring", () => {
    const tree = render(false); expect(nodes(tree).some((el) => el.type === AgentAutonomyPanel)).toBe(false);
    click(tree, "trading-launcher-autonomy"); expect(connect).not.toHaveBeenCalled();
    expect(byId(render(false), "trading-launcher-autonomy").props["aria-expanded"]).toBe(true);
  });
  it("is placed after the chat surface and dock but before the page's branding, with wrapping 44px targets", () => {
    const source = readFileSync(new URL("./AgentExperience.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/<\/div>\s*<AgentTradingLauncher/);
    expect(source.indexOf("<AgentTradingLauncher")).toBeGreaterThan(source.indexOf("{/* DOCK"));
    const tree = render(); expect(nodes(tree).some((el) => String(el.props.className).includes("flex-wrap"))).toBe(true);
    expect(byId(tree, "trading-launcher-manual").props.className).toContain("min-h-[44px]");
    expect(byId(tree, "trading-launcher-manual").props["aria-controls"]).toBe("trading-manual");
  });
});
