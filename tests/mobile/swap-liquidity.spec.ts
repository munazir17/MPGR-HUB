import { test, expect, type Page } from "@playwright/test";
import { setup, walletCalls, importedAddress } from "./flow-setup";

async function openImport(page: Page) {
  await page.getByRole("button", { name: "You receive token: ETH", exact: true }).tap();
  await page.getByLabel("Search tokens or Base contract").fill(importedAddress);
  await page.getByRole("button", { name: "Validate Base token" }).tap();
}

test("Swap discovery: technical liquidity panels are not shown and nothing is signed", async ({ page }) => {
  const state = await setup(page);
  await openImport(page);
  await expect(page.getByText(/Import is not endorsement/)).toBeVisible();
  await expect(page.getByTestId("import-technical-details")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Check liquidity on Base" })).toHaveCount(0);
  await page.getByRole("button", { name: "Close Select a token" }).tap();
  await expect(page.getByTestId("swap-technical-details")).toHaveCount(0);
  expect(state.quoteCount()).toBe(0);
  expect(await walletCalls(page)).toEqual([]);
});
