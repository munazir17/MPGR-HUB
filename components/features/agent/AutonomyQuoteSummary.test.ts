import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AutonomyQuoteSummary, AutonomyQuoteDetails, quoteRiskPresentation } from "./AutonomyQuoteSummary";
import { reviewQuoteFixture } from "./test-fixtures/chat-review-quote";
import { chatDraftToForm } from "./chat-autonomy-review";
import { buildGoalDraft, detectAutonomousTradeRequest } from "@/lib/autonomy/chat-draft";
import type { TradeProposal } from "@/lib/trade/trade-types";
const prompt = "Buy AAPLc whenever price falls 1% worth 1 USDC";
const form = chatDraftToForm(buildGoalDraft(detectAutonomousTradeRequest(prompt)!, prompt, { referencePrice: "347" }));
function summary(proposal?: TradeProposal, valid = true) {
  return renderToStaticMarkup(createElement(AutonomyQuoteSummary, { form, sellSymbol: "USDC", buySymbol: "AAPLc", proposal, valid, message: valid ? "Quote ready · not a settlement" : "Quote expired", expiresAt: Date.now() + 30_000 }));
}
describe("compact quote presentation — no execution or fee arithmetic changes", () => {
  it("shows exact values, actual executor fee, approval and material stock/network disclosures", () => {
    const html = summary(reviewQuoteFixture(form, true));
    for (const text of ["USDC → AAPLc", "Below $343.53", "1 USDC", "0.0029 AAPLc", "0.0028 AAPLc", "MPGR Executor · Base Mainnet", "0.25% · 0.0025 USDC", "Not quoted", "Separate Executor approval required", "gross sell amount", "not direct shares or issuer subscription", "Liquidity may be thin", "prices may differ from Chainlink", "Nothing executes until required authorization and trigger conditions are satisfied"])
      expect(html).toContain(text);
    expect(html).not.toContain("Provider via");
  });
  it("uses fee atomic units, never a rounded/contradictory displayAmount", () => {
    const p = reviewQuoteFixture(form, true);
    p.agentFee = { ...p.agentFee!, amountAtomic: "123456", displayAmount: "9.9999 USDC", bps: 17 };
    expect(summary(p)).toContain("0.17% · 0.123456 USDC");
    expect(summary(p)).not.toContain("9.9999 USDC");
    p.risk = p.risk.filter((r) => r.id !== "executor-approval");
    p.warnings = p.warnings.filter((w) => !w.startsWith("Executor spending approval required:"));
    expect(summary(p)).toContain("Separate Executor approval may be needed (a Base transaction).");
  });
  it("does not invent 25bps or an applied fee for CDP, skipped or absent metadata", () => {
    const p = reviewQuoteFixture(form);
    expect(summary(p)).toContain("Not charged");
    expect(summary(p)).not.toContain("0.25%");
    delete p.agentFee;
    expect(summary(p)).toContain("Not quoted");
    expect(summary(p)).not.toContain("Not charged");
    expect(summary(p)).not.toContain("0.25%");
  });
  it("does not show stale outputs, provider or applied fee as valid after expiry", () => {
    const html = summary(reviewQuoteFixture(form, true), false);
    for (const value of ["0.0029 AAPLc", "0.0028 AAPLc", "MPGR Executor · Base Mainnet", "0.25%", "0.0025 USDC"]) expect(html).not.toContain(value);
    expect(html).toContain("Quote expired");
    expect(html).toContain("Separate Executor approval required");
  });
  it("keeps critical facts, unknown warnings and unmatched warnings visible; deduplicates exact repeated risk prose", () => {
    const p = reviewQuoteFixture(form);
    p.risk = [...p.risk, { id: "provider", severity: "critical", title: "Stop", detail: "Mandatory restriction; do not proceed." }, { id: "new-warning", severity: "warning", title: "New warning", detail: "Material unfamiliar requirement." }];
    p.warnings = [...p.warnings, "New warning: Material unfamiliar requirement.", "Additional eligibility restriction.", "Additional eligibility restriction."];
    const view = quoteRiskPresentation(p);
    expect(view.visible.filter((x) => x.includes("Material unfamiliar"))).toHaveLength(1);
    expect(view.visible.filter((x) => x.includes("eligibility"))).toHaveLength(1);
    expect(view.visible).toContain("Stop: Mandatory restriction; do not proceed.");
    expect(view.details).not.toContain(p.risk.at(-2));
    const html = summary(p, false);
    expect(html).toContain("Mandatory restriction; do not proceed.");
    expect(html).toContain("Additional eligibility restriction.");
    expect(html).toContain("Material unfamiliar requirement.");
  });
  it("retains exact full risk/fee/validity information in three closed native disclosures", () => {
    const p = reviewQuoteFixture(form, true);
    p.fees.gasFee = { amount: "987654321", token: "0x2222222222222222222222222222222222222222" };
    const html = renderToStaticMarkup(createElement(AutonomyQuoteDetails, { form, proposal: p, expiresAt: Date.now() + 30_000, diagnostics: "Settings unavailable", sourcePrompt: prompt }));
    expect(html.match(/<details /g)).toHaveLength(3);
    expect(html).not.toContain(' open=""');
    for (const text of ["Fee &amp; execution details", "Slippage &amp; quote validity", "Risks &amp; network requirements", "single-use, not recurring schedule permission", "987654321 atomic units", "Settings unavailable", "authorization expires in 30 days", "not autonomous signing or broadcasting", "An authorized runtime may broadcast only after the trigger and all execution checks pass"])
      expect(html).toContain(text);
    for (const risk of p.risk) if (["executor-approval", "tokenized-swap", "slippage"].includes(risk.id)) expect(html).toContain(risk.detail.replace(/'/g, "&#x27;"));
    expect(html).not.toContain("0.000000000987654321"); // gas-token decimals are NOT known
  });
  it("does not abbreviate unfamiliar restrictions even under a known warning id", () => {
    const p = reviewQuoteFixture(form, true);
    p.risk = [...p.risk.filter((r) => r.id !== "tokenized-swap"), { id: "tokenized-swap", severity: "warning", title: "Restricted eligibility", detail: "Only qualified investors; additional eligibility verification required." }];
    expect(summary(p)).toContain("Only qualified investors; additional eligibility verification required.");
    expect(summary(p)).toContain("not direct shares or issuer subscription");
  });
  it("never labels a sell-side inverse token ratio as a USD price", () => {
    const html = renderToStaticMarkup(createElement(AutonomyQuoteSummary, { form: { ...form, sell: form.buy, buy: form.sell, threshold: "0.004", kind: "price_above" }, sellSymbol: "AAPLc", buySymbol: "USDC", valid: false, message: "Loading" }));
    expect(html).toContain("Above 0.004 AAPLc/USDC");
    expect(html).not.toContain("$0.004");
  });
});
