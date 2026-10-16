import { test, expect, type Page } from "@playwright/test";
import { reviewQuoteFixture } from "../../components/features/agent/test-fixtures/chat-review-quote";
import { chatDraftToForm } from "../../components/features/agent/chat-autonomy-review";
import { buildGoalDraft, detectAutonomousTradeRequest } from "../../lib/autonomy/chat-draft";
const prompt = "Buy AAPLc whenever price falls 1% worth 1 USDC";
const form = chatDraftToForm(buildGoalDraft(detectAutonomousTradeRequest(prompt)!, prompt, { referencePrice: "347" }));
const button = (page: Page) => page.getByTestId("agent-autonomy-draft-authorize");
let requests = 0;
test.beforeEach(async ({ page }) => {
  requests = 0;
  // Exhaustive isolation: no real API, session, signature or write is allowed.
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    expect(new URL(route.request().url()).pathname).toBe("/api/trade/quote");
    expect(route.request().method()).toBe("POST");
    requests++;
    const input = route.request().postDataJSON();
    const proposal = reviewQuoteFixture({ ...form, sellAmount: input.amount, slippageBps: input.slippageBps });
    const now = await page.evaluate(() => Date.now());
    proposal.quotedAt = new Date(now).toISOString();
    proposal.expiresAt = new Date(now + 30_000).toISOString();
    const state = await page.getByLabel("Fixture state").inputValue();
    if (state === "wallet-change") proposal.taker = "0x3333333333333333333333333333333333333333";
    await route.fulfill({ json: { proposal } });
  });
});
async function open(page: Page, state = "ready", modal = false) {
  await page.goto(modal ? "/?modal" : "/");
  await page.getByLabel("Fixture state").selectOption(state);
  await page.getByTestId("open-review").tap();
}
test("parsed draft initialization, scrolling, tap feedback, retry and launcher", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("autonomy-draft-sell")).toHaveValue(form.sell);
  await expect(page.getByTestId("autonomy-draft-buy")).toHaveValue(form.buy);
  await expect(page.getByTestId("autonomy-draft-amount")).toHaveValue("1");
  await expect(page.getByTestId("autonomy-draft-price")).toHaveValue("343.53");
  await expect(page.getByLabel("Daily cap (spend)")).toHaveValue(form.maxDaily);
  await expect(page.getByLabel("Max trades total")).toHaveValue(String(form.maxTrades));
  await expect(button(page)).toBeEnabled();
  await button(page).scrollIntoViewIfNeeded();
  expect(await page.getByTestId("chat-scroll").evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  expect(await button(page).evaluate((node) => {
    const r = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  })).toBe(true);
  await button(page).tap();
  await expect(button(page)).toHaveText("Working…");
  await expect(page.getByText("Fixture persistence failed; draft remains inactive. Retry safely.")).toBeInViewport();
  await expect(page.getByTestId("activation-calls")).toHaveText("1");
  await button(page).tap();
  await expect(page.getByTestId("activation-calls")).toHaveText("2");
  await expect(button(page)).toBeEnabled();
  await page.getByTestId("agent-autonomy-draft-review-close").tap();
  await page.getByTestId("open-review").tap();
  await expect(page.getByTestId("autonomy-draft-amount")).toHaveValue("1");
  await page.getByTestId("agent-autonomy-draft-review-close").tap();
  await page.getByTestId("trading-launcher-manual").tap();
  await expect(page.getByTestId("trading-manual-content")).toBeVisible();
  await page.getByTestId("trading-manual-content").getByRole("button", { name: /Swap proposal ready/i }).tap();
  await expect(page.getByTestId("manual-review")).toBeVisible();
  await page.getByTestId("trading-launcher-autonomy").tap();
  await expect(page.getByTestId("trading-autonomy-content")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
for (const [state, reason] of [
  ["runtime", /runtime is not enabled/i], ["production", /production safety gate/i],
  ["adapter", /execution is not ready/i], ["delegated", /delegated authorization is unavailable/i],
  ["emergency", /disabled by the operator/i], ["settings", /settings are loading/i],
  ["disconnected", /connect your wallet/i], ["network", /Base Mainnet/i], ["session", /sign in to load/i],
] as const) {
  test(`fail closed: ${state}`, async ({ page }) => {
    await open(page, state);
    await expect(button(page)).toBeDisabled();
    await expect(page.getByTestId("agent-autonomy-draft-review")).toContainText(reason);
    await expect(page.getByTestId("activation-calls")).toHaveText("0");
    if (state === "session") {
      await page.getByTestId("agent-autonomy-draft-sign-in").tap();
      await expect(button(page)).toBeEnabled();
    }
  });
}
test("invalid form explains the block, corrected amount gets matching fresh quote", async ({ page }) => {
  await open(page); await expect(button(page)).toBeEnabled();
  await page.getByTestId("autonomy-draft-amount").fill("0");
  await expect(button(page)).toBeDisabled();
  await expect(page.getByTestId("agent-autonomy-draft-review")).toContainText(/positive per-trade amount/);
  await page.getByTestId("autonomy-draft-amount").fill("2");
  await expect(button(page)).toBeEnabled();
  expect(requests).toBeGreaterThan(1);
});
test("quote loading, failed refresh, retry and expiry stay fail closed", async ({ page }) => {
  let complete: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { complete = resolve; });
  await page.route("**/api/trade/quote", async (route) => {
    await pending;
    await route.fulfill({ json: { proposal: reviewQuoteFixture(form) } });
  });
  await page.clock.install();
  await open(page); await expect(button(page)).toBeDisabled();
  complete!(); await expect(button(page)).toBeEnabled();
  await page.unroute("**/api/trade/quote");
  await page.route("**/api/trade/quote", (r) => r.fulfill({ status: 503, json: {} }));
  await page.getByRole("button", { name: "Refresh live quote" }).tap();
  await expect(button(page)).toBeDisabled();
  await expect(page.getByTestId("agent-autonomy-draft-review")).toContainText(/could not load a valid live quote/i);
  await page.unroute("**/api/trade/quote");
  await page.getByRole("button", { name: "Refresh live quote" }).tap();
  await expect(button(page)).toBeEnabled();
  await page.clock.fastForward(120_000);
  await expect(button(page)).toBeDisabled();
  await expect(page.getByTestId("agent-autonomy-draft-review")).toContainText(/Quote expired/);
  await page.getByRole("button", { name: "Refresh live quote" }).tap();
  await expect(button(page)).toBeEnabled();
});
test("wallet account change refreshes the wallet-bound quote automatically", async ({ page }) => {
  await open(page); await expect(button(page)).toBeEnabled();
  await page.getByLabel("Fixture state").selectOption("wallet-change");
  await expect(button(page)).toBeEnabled();
  expect(requests).toBe(2);
});
test("synchronous repeated taps call activation only once; close cannot discard in-flight review", async ({ page }) => {
  await open(page); await expect(button(page)).toBeEnabled();
  await button(page).evaluate((node) => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
  await expect(page.getByTestId("activation-calls")).toHaveText("1");
  await expect(page.getByRole("button", { name: "Close", exact: true }).last()).toBeDisabled();
});
test("unexpected activation rejection is visible, retryable, and not a success alert", async ({ page }) => {
  await open(page, "throw"); await expect(button(page)).toBeEnabled();
  await button(page).tap();
  await expect(page.getByRole("alert")).toContainText(/failed|could not|unable/i);
  await expect(button(page)).toBeEnabled();
});
test("confirmed activation is waiting for trigger, not labelled inactive", async ({ page }) => {
  await open(page, "success"); await expect(button(page)).toBeEnabled();
  await button(page).tap();
  await expect(page.getByTestId("agent-autonomy-draft-review")).toContainText("Active — awaiting trigger");
  await expect(page.getByTestId("agent-autonomy-draft-review")).not.toContainText("Draft — inactive");
});
test("modal focuses and traps keyboard, Escape closes and restores opener", async ({ page }) => {
  await open(page, "ready", true);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await page.getByTestId("agent-autonomy-draft-review-close").focus();
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("open-review")).toBeFocused();
});
test("trigger price has its own accessible input name", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("textbox", { name: "Trigger price (USDC)", exact: true })).toHaveValue("343.53");
});
test("late quote response for an old amount cannot replace the current quote", async ({ page }) => {
  let finish!: () => void;
  let arrived!: () => void;
  const seen = new Promise<void>((resolve) => { arrived = resolve; });
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  await page.route("**/api/trade/quote", async (route) => {
    const input = route.request().postDataJSON();
    if (input.amount === "1") { arrived(); await pending; }
    await route.fulfill({ json: { proposal: reviewQuoteFixture({ ...form, sellAmount: input.amount }) } });
  });
  await open(page); await seen;
  await page.getByTestId("autonomy-draft-amount").fill("2");
  await expect(button(page)).toBeEnabled();
  finish(); await page.waitForLoadState("networkidle");
  await expect(button(page)).toBeEnabled();
  await expect(page.getByTestId("autonomy-draft-amount")).toHaveValue("2");
});
test("focused inputs and action remain reachable in a shortened keyboard-style viewport", async ({ page }) => {
  await open(page);
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: size.width, height: 500 });
  const input = page.getByTestId("autonomy-draft-amount");
  await input.focus(); await input.fill("3");
  await expect(input).toBeFocused();
  await expect(input).toBeInViewport();
  await expect(button(page)).toBeEnabled();
  await button(page).scrollIntoViewIfNeeded();
  await expect(button(page)).toBeInViewport();
  await button(page).tap();
  await expect(page.getByTestId("activation-calls")).toHaveText("1");
});
test("viewport evidence: CTA is scrollable and not intercepted", async ({ page }, testInfo) => {
  await open(page); await expect(button(page)).toBeEnabled();
  await button(page).scrollIntoViewIfNeeded();
  await expect(button(page)).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("review-cta.png") });
  await page.getByLabel("Fixture state").selectOption("production");
  await button(page).scrollIntoViewIfNeeded();
  await expect(button(page)).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("review-gated.png") });
});
