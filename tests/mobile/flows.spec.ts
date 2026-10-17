import { test, expect, type Page } from "@playwright/test";
import { setup, evidence, walletCalls } from "./flow-setup";
async function draft(page: Page) {
  await page.getByTestId("trading-launcher-autonomy").tap(); await page.getByLabel("USDC per trade").fill("1"); await page.getByLabel("Trigger price (USD)").fill("200");
  await page.getByRole("button", { name: "Review local draft", exact: true }).tap();
}
test("Autonomy: gated Preview still permits local draft → real review, but zero policy/permission/activation writes", async ({ page }, info) => {
  const state = await setup(page); await draft(page);
  await expect(page.getByTestId("autonomy-draft-amount")).toHaveValue("1"); await expect(page.getByTestId("autonomy-draft-price")).toHaveValue("200");
  await expect(page.getByTestId("agent-autonomy-draft-authorize")).toBeDisabled(); await expect(page.getByText(/Mainnet autonomous authorization is unavailable in Preview/)).toBeVisible();
  expect(state.trace.filter(t => t.path.startsWith("/api/agent/autonomy/") && t.method !== "GET")).toEqual([]);
  expect(state.goals).toHaveLength(0); expect(state.slots).toHaveLength(0); expect(await walletCalls(page)).toEqual([]); await evidence(page, info, state.trace);
});
test("Autonomy: isolated ready configuration traverses policy → goal → own-goal permission → activation, without swap/broadcast", async ({ page }, info) => {
  const state = await setup(page, { ready: true }); await draft(page); const activate = page.getByTestId("agent-autonomy-draft-authorize"); await expect(activate).toBeEnabled(); await activate.tap();
  await expect.poll(() => state.goals[0]?.status).toBe("ACTIVE"); expect(state.policies).toHaveLength(1); expect(state.goals).toHaveLength(1); expect(state.slots).toHaveLength(1);
  await expect(page.getByTestId("agent-autonomy-draft-review")).toContainText("Active — awaiting trigger");
  expect(state.slots[0].goalId).toBe(state.goals[0].id); expect(await walletCalls(page)).toEqual(["delegated-signature"]); await evidence(page, info, state.trace);
});
test("Autonomy: server policy refusal stops before goal creation, signing or activation", async ({ page }, info) => {
  const state = await setup(page, { ready: true, policyBlocked: true }); await draft(page); await page.getByTestId("agent-autonomy-draft-authorize").tap();
  await expect(page.getByText("Simulated policy refusal", { exact: false }).first()).toBeVisible(); expect(state.policies).toHaveLength(0); expect(state.goals).toHaveLength(0); expect(state.slots).toHaveLength(0);
  expect(await walletCalls(page)).toEqual([]); await evidence(page, info, state.trace);
});
test("Autonomy: permission persistence failure leaves DRAFT; retry uses same policy/goal and saves own permission before ACTIVE", async ({ page }, info) => {
  const state = await setup(page, { ready: true, permissionFailsOnce: true }); await draft(page); await page.getByTestId("agent-autonomy-draft-authorize").tap();
  await expect(page.getByText("Simulated permission persistence failure", { exact: false }).first()).toBeVisible(); expect(state.goals[0].status).toBe("DRAFT"); expect(state.slots).toHaveLength(0);
  await page.getByTestId("agent-autonomy-draft-authorize").tap(); await expect.poll(() => state.goals[0]?.status).toBe("ACTIVE");
  await expect(page.getByTestId("agent-autonomy-draft-review")).toContainText("Active — awaiting trigger");
  expect(state.policies).toHaveLength(1); expect(state.goals).toHaveLength(1); expect(state.slots).toHaveLength(1); expect(await walletCalls(page)).not.toContain("simulated-send"); await evidence(page, info, state.trace);
});
