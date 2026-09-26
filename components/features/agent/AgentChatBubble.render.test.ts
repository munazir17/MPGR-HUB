import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentChatBubble } from "./AgentChatBubble";
import type { AgentMessage } from "@/lib/agent-engine";
vi.mock("@/hooks/useStreamingText", () => ({ useStreamingText: (text: string) => ({ text, done: true }) }));
const HASH = `0x${"ab".repeat(32)}`;
function render(content: string, role: AgentMessage["role"] = "assistant") {
  return renderToStaticMarkup(createElement(AgentChatBubble, { message: { id: "fixture", role, content, timestamp: "2026-09-26T00:00:00Z" }, onFeedback: () => {} }));
}
describe("Agent chat output boundary", () => {
  it("does not render or copy raw MCP/tool JSON from old persisted chat", () => {
    const html = render('Live Base quote: {"liquidityAvailable":true,"transaction":{"data":"0xdeadbeef"},"apiKey":"private-credential"}');
    expect(html).toContain("safely");
    expect(html).not.toMatch(/liquidityAvailable|deadbeef|private-credential/);
  });
  it("renders only the BaseScan link label, not the raw transaction hash", () => {
    const html = render(`Swap confirmed.\nTransaction: https://basescan.org/tx/${HASH}`);
    expect(html).toContain(`href="https://basescan.org/tx/${HASH}"`);
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("View on BaseScan");
    expect(html).not.toContain(`>${HASH}<`);
    expect(html).toContain("whitespace-pre-line");
    expect(html).toContain("min-w-0"); expect(html).toContain("break-words");
  });
  it("does not make arbitrary RPC URLs clickable", () => {
    const html = render("Provider error https://rpc.test?key=credential");
    expect(html).not.toContain("rpc.test"); expect(html).not.toContain("credential");
  });
  it("does not rewrite the user's own supplied address", () => {
    const address = `0x${"ab".repeat(20)}`;
    expect(render(`Swap 1 USDC to ${address}`, "user")).toContain(address);
  });
});

it("cleans legacy persisted swap confirmations without approval internals", () => {
  const html = render(`✅ Swap successful\n\n1 USDC → ~0.002932 AAPLc\nStatus: Confirmed on Base\nTransaction: ${HASH}\nApproval transaction: 0x${"cd".repeat(32)}\nView on BaseScan: https://basescan.org/tx/${HASH}`);
  expect(html).toContain("Swap confirmed.");
  expect(html).toContain("View on BaseScan");
  expect(html).not.toMatch(/Approval transaction|cdcdcdcd|Transaction: 0x/);
});
