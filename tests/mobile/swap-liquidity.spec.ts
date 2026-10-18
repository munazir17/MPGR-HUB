import { test, expect, type Page } from "@playwright/test";
import { setup, walletCalls, importedAddress, token } from "./flow-setup";
const pool = "0x3333333333333333333333333333333333333333";
const payload = (partial = false) => ({ chainId: 8453, executionAuthorized: false, feeExecution: "IMMUTABLE_FEE_EXECUTOR_REQUIRED", partial,
  snapshot: { blockNumber: "123", blockHash: `0x${"ab".repeat(32)}`, observedAt: Date.now(), expiresAt: Date.now() + 30_000 },
  observations: [{ venue: "uniswap-v3", factory: "0x33128a8fc17869897dce68ed026d694621f6fdfd", key: 500, tokenA: token("USDC"), tokenB: importedAddress, pool, status: "active-liquidity" }],
  paths: [{ tokens: [token("USDC"), importedAddress], poolsPerHop: [[pool]], executionSupported: false }], scope: "Deterministic mocked pool observation, not live liquidity or settlement.", tokens: [],
});
async function imported(page: Page, pay = false, touch = true) {
  const press = async (name: string) => { const button = page.getByRole("button", { name, exact: true }); if (touch) await button.tap(); else await button.click(); };
  await press(pay ? "You pay token: USDC" : "You receive token: ETH");
  await page.getByLabel("Search tokens or Base contract").fill(importedAddress);
  await press("Validate Base token");
  await expect(page.getByRole("button", { name: `Select NEW ${importedAddress}`, exact: true })).toBeDisabled();
  await press(`Inspect NEW liquidity ${importedAddress}`);
}
test("Swap discovery: imported CA can inspect pools, never becomes an executable quote or signature", async ({ page }) => {
  const state = await setup(page); let requests = 0;
  await page.route("**/api/swap/liquidity", async route => { requests++; expect(route.request().postDataJSON()).toEqual({ chainId: 8453, fromToken: token("USDC"), toToken: importedAddress }); await route.fulfill({ json: payload() }); });
  await imported(page); await page.getByRole("button", { name: "Check liquidity on Base" }).tap();
  await expect(page.getByRole("region", { name: "Read-only liquidity inspection" })).toContainText("Not executable quotes");
  await expect(page.getByRole("link", { name: `Pool: ${pool}` })).toHaveAttribute("href", `https://basescan.org/address/${pool}`);
  await expect(page.getByRole("button", { name: `Select NEW ${importedAddress}`, exact: true })).toBeDisabled();
  expect(requests).toBe(1); expect(state.quoteCount()).toBe(0); expect(await walletCalls(page)).toEqual([]);
  expect(await page.getByRole("dialog").evaluate(e => e.scrollWidth > e.clientWidth)).toBe(false);
});
for (const status of [401, 429, 503]) test(`Swap discovery: provider/session HTTP ${status} is not missing liquidity`, async ({ page }) => {
  const state = await setup(page); await page.route("**/api/swap/liquidity", route => route.fulfill({ status, json: { error: "Simulated read provider unavailable, retry." } }));
  await imported(page); await page.getByRole("button", { name: "Check liquidity on Base" }).tap();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("provider unavailable");
  await expect(page.getByText(/No active path found/)).toHaveCount(0); expect(state.quoteCount()).toBe(0); expect(await walletCalls(page)).toEqual([]);
});
test("Swap discovery: partial coverage stays explicit; expiry removes pool evidence until refreshed", async ({ page }) => {
  await setup(page); await page.route("**/api/swap/liquidity", route => { const data = payload(true); data.snapshot.expiresAt = Date.now() + 1500; return route.fulfill({ json: data }); });
  await imported(page); await page.getByRole("button", { name: "Check liquidity on Base" }).tap();
  await expect(page.getByRole("region", { name: "Read-only liquidity inspection" })).toContainText("incomplete");
  await expect(page.getByRole("link", { name: `Pool: ${pool}` })).toBeVisible();
  await expect(page.getByText("Liquidity snapshot expired. Refresh before relying on it.")).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole("link", { name: `Pool: ${pool}` })).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh liquidity inspection" }).tap(); await expect(page.getByRole("link", { name: `Pool: ${pool}` })).toBeVisible();
});
for (const change of ["wrong-network", "other-wallet"]) test(`Swap discovery: ${change} aborts inspection and discards imported session state`, async ({ page }) => {
  const state = await setup(page); let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/swap/liquidity", async route => { await wait; await route.fulfill({ json: payload() }).catch(() => {}); });
  await imported(page); await page.getByRole("button", { name: "Check liquidity on Base" }).tap();
  await expect(page.getByText("Reading Base pools…")).toBeVisible();
  await page.getByLabel("Wallet fixture").evaluate((node, value) => { const el = node as HTMLSelectElement; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value); el.dispatchEvent(new Event("change", { bubbles: true })); }, change);
  release(); await expect(page.getByRole("dialog")).toHaveCount(0); await expect(page.getByText(`Pool: ${pool}`)).toHaveCount(0); expect(state.quoteCount()).toBe(0);
  // Existing wallet-auth provider reauthenticates a changed account. This is SIWE, not trade/approval signing.
  expect(await walletCalls(page)).toEqual(change === "other-wallet" ? ["siwe-signature"] : []);
});
test("Swap discovery: search change cancels pending inspection, late data cannot overwrite selection", async ({ page }) => {
  await setup(page); let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/swap/liquidity", async route => { await wait; await route.fulfill({ json: payload() }).catch(() => {}); });
  await imported(page); await page.getByRole("button", { name: "Check liquidity on Base" }).tap(); await expect(page.getByText("Reading Base pools…")).toBeVisible();
  await page.getByLabel("Search tokens or Base contract").fill("WETH"); release(); await expect(page.getByRole("region", { name: "Read-only liquidity inspection" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: `Select WETH ${token("WETH")}`, exact: true })).toBeVisible();
});

test("Swap discovery: inspecting a pay-side import preserves pay/receive direction", async ({ page }) => {
  const state = await setup(page);
  await page.route("**/api/swap/liquidity", async route => { expect(route.request().postDataJSON()).toEqual({ chainId: 8453, fromToken: importedAddress, toToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" }); const data = payload(); data.paths[0].tokens = [importedAddress, token("WETH")]; data.observations[0].tokenA = importedAddress; data.observations[0].tokenB = token("WETH"); await route.fulfill({ json: data }); });
  await imported(page, true); await expect(page.getByRole("region", { name: "Read-only liquidity inspection" })).toContainText("NEW → ETH"); await page.getByRole("button", { name: "Check liquidity on Base" }).tap(); await expect(page.getByRole("link", { name: `Pool: ${pool}` })).toBeVisible(); expect(state.quoteCount()).toBe(0); expect(await walletCalls(page)).toEqual([]);
});
test.describe("desktop inspection", () => {
  test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });
  test("Swap discovery: desktop selector retains read-only boundaries and fits", async ({ page }) => {
    const state = await setup(page); await page.route("**/api/swap/liquidity", route => route.fulfill({ json: payload() })); await imported(page, false, false); await page.getByRole("button", { name: "Check liquidity on Base" }).click(); await expect(page.getByRole("link", { name: `Pool: ${pool}` })).toBeVisible(); expect(await page.getByRole("dialog").evaluate(e => e.scrollWidth > e.clientWidth)).toBe(false); expect(state.quoteCount()).toBe(0); expect(await walletCalls(page)).toEqual([]);
  });
});
