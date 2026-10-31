import { simulatedExecutorQuote } from "./flow-fixtures";
import { swapRouteCandidates, swapRouteKey } from "../../lib/swap/swap-route-candidates";
import { MPGR_EXECUTOR_ABI } from "../../lib/executor/mpgr-executor-abi";
import { decodeFunctionData, encodeFunctionData, keccak256 } from "viem";
import { NATIVE_ETH_SENTINEL } from "../../lib/trade/trade-config";
import { test, expect, type Page } from "@playwright/test";
import { setup, evidence, walletCalls, importedAddress, token } from "./flow-setup";
import { MANUAL_SWAP_TOKENS } from "../../lib/trade/manual-swap";
const address = (symbol: string) => MANUAL_SWAP_TOKENS.find(t => t.symbol === symbol)!.address;
const scenario = (page: Page, value: string) => page.evaluate(s => { (window as unknown as { simulatedWalletScenario: string }).simulatedWalletScenario = s; }, value);
const choose = async (page: Page, side: "receive" | "pay", symbol: string) => {
  await page.getByRole("button", { name: new RegExp(`^You ${side} token:`) }).tap();
  await page.getByLabel("Search tokens or Base contract").fill(symbol);
  await page.getByRole("button", { name: `Select ${symbol} ${address(symbol)}`, exact: true }).tap();
};
async function quoted(page: Page) {
  await page.getByLabel("You pay amount", { exact: true }).fill("1");
  await expect(page.getByRole("button", { name: "Confirm Swap", exact: true })).toBeEnabled();
}
async function review(page: Page) { await quoted(page); await page.getByRole("button", { name: "Confirm Swap", exact: true }).tap(); await expect(page.getByRole("dialog", { name: "Confirm Swap", exact: true })).toBeVisible(); }
const sends = async (page: Page) => (await walletCalls(page)).filter(c => c === "simulated-send");
test("Swap: pay/receive order, real quote, one review, exact approval then separate swap and verified receipt", async ({ page }, info) => {
  const state = await setup(page); await choose(page, "receive", "AAPLc"); await quoted(page);
  expect(await page.getByTestId("pay-panel").evaluate((e) => e.getBoundingClientRect().top)).toBeLessThan(await page.getByTestId("receive-panel").evaluate(e => e.getBoundingClientRect().top));
  await expect(page.getByRole("button", { name: "Review swap", exact: true })).toHaveCount(0); expect(await walletCalls(page)).toEqual([]);
  await page.getByRole("button", { name: "Confirm Swap", exact: true }).tap(); await page.getByRole("button", { name: "Confirm & Swap", exact: true }).tap();
  await expect(page.getByTestId("swap-status")).toContainText("output verified"); expect(await sends(page)).toHaveLength(2);
  const approval = await page.getByRole("link", { name: "View approval", exact: true }).getAttribute("href"); const swap = await page.getByRole("link", { name: "View swap on BaseScan", exact: true }).getAttribute("href"); expect(approval).not.toBe(swap);
  expect(state.policies).toHaveLength(0); expect(state.slots).toHaveLength(0); await evidence(page, info, state.trace);
});
test("Swap: direction reversal uses previous output as new pay, invalidates old quote and preserves token identity", async ({ page }, info) => {
  const state = await setup(page); await quoted(page);
  const output = await page.getByLabel("You receive amount", { exact: true }).inputValue();
  await page.getByRole("button", { name: "Reverse swap direction" }).tap();
  await expect(page.getByRole("button", { name: "You pay token: ETH", exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "You receive token: USDC", exact: true })).toBeVisible();
  await expect(page.getByLabel("You pay amount", { exact: true })).toHaveValue(output);
  await expect(page.getByRole("button", { name: "Confirm Swap", exact: true })).toBeEnabled();
  expect(await sends(page)).toHaveLength(0); await evidence(page, info, state.trace);
});
test("Swap: compact slippage validates custom input, requotes real minOut and persists session setting", async ({ page }, info) => {
  const state = await setup(page); await quoted(page); const before = await page.getByText(/^Minimum received:/).textContent();
  await page.getByRole("button", { name: "Slippage settings" }).tap();
  await page.getByLabel("Custom slippage (%)").fill("5.01"); await expect(page.getByRole("button", { name: "Apply slippage" })).toBeDisabled();
  await page.getByLabel("Custom slippage (%)").fill("2"); await expect(page.getByRole("alert")).toContainText("High slippage");
  await page.getByRole("button", { name: "0.5%", exact: true }).tap(); await page.getByRole("button", { name: "Apply slippage" }).tap();
  await expect(page.getByRole("button", { name: "Confirm Swap", exact: true })).toBeEnabled(); expect(await page.getByText(/^Minimum received:/).textContent()).not.toBe(before);
  await page.reload(); await expect(page.getByRole("button", { name: "Slippage settings" })).toContainText("0.5%"); await evidence(page, info, state.trace);
});
test("Swap: expired quote requires refresh; editing amount invalidates prior executable output", async ({ page }, info) => {
  const state = await setup(page, { shortQuote: true }); await quoted(page);
  await expect(page.getByText(/Quote needs updating/)).toBeVisible({ timeout: 4000 }); await expect(page.getByRole("button", { name: "Confirm Swap", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh quote", exact: true }).tap(); await expect(page.getByRole("button", { name: "Confirm Swap", exact: true })).toBeEnabled();
  await page.getByLabel("You pay amount", { exact: true }).fill("2"); await expect(page.getByLabel("You receive amount", { exact: true })).toHaveValue(""); expect(await sends(page)).toHaveLength(0); await evidence(page, info, state.trace);
});
for (const status of [429, 503]) test(`Swap: actionable HTTP ${status}, no execution`, async ({ page }, info) => {
  const state = await setup(page, { quoteStatus: status }); await page.getByLabel("You pay amount", { exact: true }).fill("1");
  await expect(page.getByRole("alert")).toContainText("Simulated quote service refusal"); await expect(page.getByRole("button", { name: "Confirm Swap", exact: true })).toHaveCount(0); expect(await sends(page)).toHaveLength(0); await evidence(page, info, state.trace);
});
test("Swap: expired session requires explicit SIWE retry", async ({ page }, info) => {
  const state = await setup(page, { authExpired: true }); await page.getByLabel("You pay amount", { exact: true }).fill("1"); await expect(page.getByRole("alert")).toContainText("Simulated quote service refusal");
  await page.getByRole("button", { name: "Sign in and retry quote", exact: true }).tap(); await expect(page.getByRole("button", { name: "Confirm Swap", exact: true })).toBeEnabled(); expect(await walletCalls(page)).toEqual(["siwe-signature"]); await evidence(page, info, state.trace);
});
for (const change of ["wrong-network", "other-wallet"]) test(`Swap: ${change} after review blocks before a signature`, async ({ page }, info) => {
  const state = await setup(page); await review(page);
  // Native dialog correctly makes background inert. Change the fixture via
  // the same controlled event, without pretending it is a wallet signature.
  await page.getByLabel("Wallet fixture").evaluate((node, value) => { const select = node as HTMLSelectElement; const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!; setter.call(select, value); select.dispatchEvent(new Event("change", { bubbles: true })); }, change);
  await page.getByRole("button", { name: "Confirm & Swap", exact: true }).tap(); await expect(page.getByRole("dialog").getByRole("alert")).toContainText(change === "wrong-network" ? /Switch|Network/ : /wallet/i); expect(await sends(page)).toHaveLength(0); await evidence(page, info, state.trace);
});
test("Swap: disconnected wallet can select tokens; no fabricated balances or quote", async ({ page }, info) => {
  const state = await setup(page); await page.getByLabel("Wallet fixture").selectOption("disconnected");
  await expect(page.getByTestId("pay-panel")).toContainText("Connect wallet"); await page.getByLabel("You pay amount", { exact: true }).fill("1"); await page.getByRole("button", { name: "Connect wallet", exact: true }).tap(); expect(state.quoteCount()).toBe(0); expect(await sends(page)).toHaveLength(0); await evidence(page, info, state.trace);
});
test("Swap: search, exact contract validation, duplicate symbols and unsupported fee route stay unambiguous", async ({ page }, info) => {
  const state = await setup(page, { quoteStatus: 422, importSymbol: "USDC", importName: "<img src=x onerror=alert(1)>" });
  await page.getByRole("button", { name: "You receive token: ETH", exact: true }).tap(); const search = page.getByLabel("Search tokens or Base contract");
  await search.fill("No such token"); await expect(page.getByText(/No results\./)).toBeVisible(); await search.fill("0x123"); await expect(page.getByRole("alert")).toContainText("Invalid address");
  await search.fill(importedAddress); await page.getByRole("button", { name: "Validate Base token" }).tap(); await expect(page.getByText(/Import is not endorsement/)).toBeVisible();
  await expect(page.getByRole("button", { name: `Select USDC ${importedAddress}`, exact: true })).toBeEnabled();
  await expect(page.getByTestId("token-route-status")).toHaveCount(0);
  await page.getByRole("button", { name: "Close Select a token" }).tap();
  await page.getByRole("button", { name: "You receive token: ETH", exact: true }).tap(); await page.getByLabel("Search tokens or Base contract").fill("USDC");
  await expect(page.getByRole("button", { name: `Select USDC ${token("USDC")}`, exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: `Select USDC ${importedAddress}`, exact: true })).toBeVisible(); await expect(page.getByRole("dialog").locator("img")).toHaveCount(1); await expect(page.getByRole("button", { name: `Select USDC ${importedAddress}`, exact: true }).locator("img")).toHaveCount(0); await expect(page.getByRole("button", { name: `Select USDC ${importedAddress}`, exact: true }).getByTestId("token-logo-fallback")).toHaveCount(1);
  await expect(page.getByRole("button", { name: `Select USDC ${importedAddress}`, exact: true })).toBeEnabled(); expect(state.quoteCount()).toBe(0); expect(await sends(page)).toHaveLength(0); await evidence(page, info, state.trace);
});
test("Swap: failed metadata never offers selectable token", async ({ page }, info) => {
  const state = await setup(page, { importStatus: 503 }); await page.getByRole("button", { name: "You receive token: ETH", exact: true }).tap(); await page.getByLabel("Search tokens or Base contract").fill(importedAddress); await page.getByRole("button", { name: "Validate Base token" }).tap(); await expect(page.getByRole("alert")).toContainText("metadata unavailable"); await expect(page.getByRole("button", { name: `Select NEW ${importedAddress}`, exact: true })).toHaveCount(0); expect(state.quoteCount()).toBe(0); await evidence(page, info, state.trace);
});
test("Swap: fee-less provider quote cannot become executable in Swap", async ({ page }, info) => {
  const state = await setup(page, { feeSkipped: true }); await page.getByLabel("You pay amount", { exact: true }).fill("1"); await expect(page.getByRole("alert")).toContainText("cannot safely collect"); await expect(page.getByRole("button", { name: "Confirm Swap", exact: true })).toHaveCount(0); expect(await sends(page)).toHaveLength(0); await evidence(page, info, state.trace);
});
for (const value of ["approval-rejected", "approval-reverted", "swap-rejected", "swap-reverted", "missing-fee-event", "wrong-fee-recipient", "allowance-insufficient", "insufficient", "fee-changed"] as const) test(`Swap: ${value} has truthful lifecycle, no unverified success`, async ({ page }, info) => {
  const state = await setup(page); await review(page); await scenario(page, value); await page.getByRole("button", { name: "Confirm & Swap", exact: true }).tap();
  const dialog = page.getByRole("dialog", { name: "Confirm Swap", exact: true });
  await expect(dialog.getByRole("alert")).toContainText(value === "approval-rejected" ? "Approval cancelled" : value === "swap-rejected" ? "Swap cancelled" : value.includes("fee-event") || value === "wrong-fee-recipient" ? "did not verify" : value === "allowance-insufficient" ? "allowance" : value === "insufficient" ? /holds 0 USDC|balance/i : value === "fee-changed" ? "configuration changed" : /failed/);
  await expect(page.getByTestId("swap-status")).toHaveCount(0);
  if (["insufficient", "fee-changed"].includes(value)) expect(await sends(page)).toHaveLength(0);
  if (value === "missing-fee-event" || value === "wrong-fee-recipient") { await expect(dialog.getByRole("button", { name: "Refresh quote & retry", exact: true })).toHaveCount(0); await expect(dialog.getByTestId("mpgr-fee-row")).toContainText("submitted, unverified"); await expect(dialog.getByTestId("mpgr-fee-row")).not.toContainText("collection verified"); }
  await evidence(page, info, state.trace);
});
test("Swap: successful approval survives swap rejection and retry; no second approval", async ({ page }, info) => {
  const state = await setup(page); await review(page); await scenario(page, "swap-rejected"); await page.getByRole("button", { name: "Confirm & Swap", exact: true }).tap(); await expect(page.getByRole("alert")).toContainText("Swap cancelled");
  await scenario(page, "connected"); await page.getByRole("button", { name: "Refresh quote & retry", exact: true }).tap(); await expect(page.getByRole("button", { name: "Confirm & Swap", exact: true })).toBeEnabled(); await page.getByRole("button", { name: "Confirm & Swap", exact: true }).tap(); await expect(page.getByTestId("swap-status")).toBeVisible();
  const transactions = await page.evaluate(() => (window as unknown as { simulatedTransactions: { data: string }[] }).simulatedTransactions); expect(transactions.filter(t => t.data.startsWith("0x095ea7b3"))).toHaveLength(1); expect(transactions).toHaveLength(2); await evidence(page, info, state.trace);
});
test("Swap: unknown approval receipt blocks a duplicate approval until status recheck", async ({ page }, info) => {
  const state = await setup(page); await review(page); await scenario(page, "approval-receipt-error"); await page.getByRole("button", { name: "Confirm & Swap", exact: true }).tap(); await expect(page.getByRole("alert")).toContainText("receipt is unavailable");
  await expect(page.getByRole("button", { name: "Refresh quote & retry", exact: true })).toHaveCount(0); expect(await sends(page)).toHaveLength(1);
  await scenario(page, "approval-rpc-lag"); await page.getByRole("button", { name: "Check approval status", exact: true }).tap(); await expect(page.getByRole("button", { name: "Refresh quote & retry", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Refresh quote & retry", exact: true }).tap();
  await page.getByRole("button", { name: "Confirm & Swap", exact: true }).tap();
  await expect(page.getByTestId("swap-status")).toBeVisible(); expect(await sends(page)).toHaveLength(2);
  await evidence(page, info, state.trace);
});
test("Swap: quote expiry after approval preserves approval and requires fresh review", async ({ page }, info) => {
  const state = await setup(page, { shortQuote: true }); await review(page); await scenario(page, "approval-expired"); await page.getByRole("button", { name: "Confirm & Swap", exact: true }).tap(); await expect(page.getByRole("dialog")).toContainText("Quote updated — review new output."); expect(await sends(page)).toHaveLength(1);
  await scenario(page, "connected"); await page.getByRole("button", { name: "Confirm & Swap", exact: true }).tap(); await expect(page.getByTestId("swap-status")).toBeVisible(); expect(await sends(page)).toHaveLength(2); await evidence(page, info, state.trace);
});
test("Swap: exact balances, ERC20 MAX and native ETH reserve are not WETH balance", async ({ page }, info) => {
  const state = await setup(page); await expect(page.getByTestId("pay-panel")).toContainText("Balance: 100"); await page.getByRole("button", { name: "MAX", exact: true }).tap(); await expect(page.getByLabel("You pay amount", { exact: true })).toHaveValue("100");
  await page.getByRole("button", { name: "Reverse swap direction" }).tap(); await expect(page.getByTestId("pay-panel")).toContainText("Balance: 2"); await page.getByRole("button", { name: "MAX", exact: true }).tap(); await expect(page.getByLabel("You pay amount", { exact: true })).toHaveValue("1.999998"); await expect(page.getByText(/MAX reserves/)).toBeVisible(); expect(await sends(page)).toHaveLength(0); await evidence(page, info, state.trace);
});
test("Swap: real receipt-backed session history, separate hashes, exact output and collected fee", async ({ page }, info) => {
  const state = await setup(page); await page.getByRole("button", { name: "Recent swaps", exact: true }).tap(); await expect(page.getByRole("dialog")).toContainText("No swaps submitted"); await page.getByRole("button", { name: "Close Recent swaps", exact: true }).tap();
  await review(page); await page.getByRole("button", { name: "Confirm & Swap", exact: true }).tap(); await expect(page.getByTestId("swap-status")).toBeVisible(); await page.getByRole("button", { name: /^Close (Confirm Swap|Transaction overview)$/ }).tap();
  await page.getByRole("button", { name: "Recent swaps", exact: true }).tap(); const dialog = page.getByRole("dialog"); await expect(dialog.getByText("Approval · confirmed", { exact: true })).toBeVisible(); await expect(dialog.getByText("Swap · confirmed", { exact: true })).toBeVisible(); await expect(dialog.getByTestId("mpgr-fee-row")).toHaveCount(0); await expect(dialog.getByRole("link", { name: "View approval on BaseScan" })).toHaveAttribute("href", /\/tx\/0x[0-9a-f]{64}$/);
  await evidence(page, info, state.trace);
});

test("Swap: auth expiry on approval recovery requires explicit sign-in and never repeats confirmed approval", async ({ page }, info) => {
  const state = await setup(page, { authExpiresOnRefresh: true }); await review(page); await scenario(page, "swap-rejected"); await page.getByRole("button", { name: "Confirm & Swap", exact: true }).tap(); await expect(page.getByRole("alert")).toContainText("Swap cancelled");
  await scenario(page, "connected"); await page.getByRole("button", { name: "Refresh quote & retry", exact: true }).tap(); await expect(page.getByRole("alert")).toContainText("Simulated quote service refusal");
  await page.getByRole("button", { name: "Sign in & refresh quote", exact: true }).tap(); await page.getByRole("button", { name: "Confirm & Swap", exact: true }).tap(); await expect(page.getByTestId("swap-status")).toBeVisible();
  expect(await walletCalls(page)).toContain("siwe-signature");
  const approved = await page.evaluate(() => (window as unknown as { simulatedTransactions: { data: string }[] }).simulatedTransactions.filter(t => t.data.startsWith("0x095ea7b3")).length); expect(approved).toBe(1); await evidence(page, info, state.trace);
});
test("Swap: duplicate confirmation clicks cannot duplicate approval or swap, balances refresh from simulated RPC after receipt", async ({ page }, info) => {
  const state = await setup(page); await review(page);
  await page.getByRole("button", { name: "Confirm & Swap", exact: true }).evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
  await expect(page.getByTestId("swap-status")).toBeVisible(); expect(await sends(page)).toHaveLength(2);
  await page.getByRole("button", { name: /^Close (Confirm Swap|Transaction overview)$/ }).tap(); await expect(page.getByTestId("pay-panel")).toContainText("Balance: 99"); await expect(page.getByTestId("receive-panel")).toContainText("Balance: 2.009998"); await evidence(page, info, state.trace);
});
test("Swap: balance read failure is explicit, retry reads exact wallet and wallet switch cannot reuse balance or history", async ({ page }, info) => {
  await page.addInitScript(() => { (window as unknown as { simulatedWalletScenario: string }).simulatedWalletScenario = "balance-error"; });
  const state = await setup(page); await expect(page.getByTestId("pay-panel")).toContainText("Read unavailable"); await expect(page.getByRole("button", { name: "MAX", exact: true })).toBeDisabled();
  await scenario(page, "connected"); await page.getByTestId("pay-panel").getByRole("button", { name: "Retry balance", exact: true }).tap(); await expect(page.getByTestId("pay-panel")).toContainText("Balance: 100");
  await page.getByLabel("Wallet fixture").selectOption("other-wallet"); await expect(page.getByTestId("pay-panel")).toContainText("Balance: 42");
  await page.getByRole("button", { name: "Recent swaps", exact: true }).tap(); await expect(page.getByRole("dialog")).toContainText("No swaps submitted"); await evidence(page, info, state.trace);
});

test("Swap: wrong receipt hash cannot promote submitted metadata to confirmed activity", async ({ page }, info) => {
  const state = await setup(page); await review(page); await scenario(page, "wrong-receipt-hash"); await page.getByRole("button", { name: "Confirm & Swap", exact: true }).tap();
  await expect(page.getByRole("alert")).toContainText("Receipt hash does not match"); await expect(page.getByTestId("swap-status")).toHaveCount(0);
  await page.getByRole("button", { name: /^Close (Confirm Swap|Transaction overview)$/ }).tap(); await page.getByRole("button", { name: "Recent swaps", exact: true }).tap();
  await page.getByRole("button", { name: "Refresh transaction status", exact: true }).tap(); await expect(page.getByRole("dialog")).toContainText("Received: Not verified"); await expect(page.getByRole("dialog")).toContainText("Swap · verification unavailable");
  await scenario(page, "connected"); await page.getByRole("button", { name: "Refresh transaction status", exact: true }).tap(); await expect(page.getByRole("dialog")).toContainText("Swap · confirmed"); expect(await sends(page)).toHaveLength(2); await evidence(page, info, state.trace);
});

test("Swap: delayed history receipt cannot overwrite a different review as successfully settled", async ({ page }, info) => {
  const state = await setup(page); await review(page); await page.getByRole("button", { name: "Confirm & Swap", exact: true }).tap(); await expect(page.getByTestId("swap-status")).toBeVisible(); await page.getByRole("button", { name: /^Close (Confirm Swap|Transaction overview)$/ }).tap();
  await page.evaluate(() => { (window as unknown as { simulatedHistoryDelay: boolean }).simulatedHistoryDelay = true; });
  await page.getByRole("button", { name: "Recent swaps", exact: true }).tap();
  await page.waitForFunction(() => !!(window as unknown as { simulatedHistoryResolvers?: unknown[] }).simulatedHistoryResolvers?.length);
  await page.getByRole("button", { name: "Close Recent swaps", exact: true }).tap(); await page.getByLabel("You pay amount", { exact: true }).fill("2"); await expect(page.getByRole("button", { name: "Confirm Swap", exact: true })).toBeEnabled(); await page.getByRole("button", { name: "Confirm Swap", exact: true }).tap();
  await page.evaluate(() => { const w = window as unknown as { simulatedHistoryDelay: boolean; simulatedHistoryResolvers: (() => void)[] }; w.simulatedHistoryDelay = false; w.simulatedHistoryResolvers.splice(0).forEach(resolve => resolve()); });
  await page.waitForFunction(() => (window as unknown as { simulatedWalletCalls: string[] }).simulatedWalletCalls.filter(c => c === "history-read-completed").length >= 2);
  await expect(page.getByTestId("swap-status")).toHaveCount(0); await expect(page.getByRole("button", { name: "Confirm & Swap", exact: true })).toBeEnabled(); expect(await sends(page)).toHaveLength(2); await evidence(page, info, state.trace);
});

test("Swap correction: pay first, MAX belongs only to pay, one contextual fee across review and no redundant copy", async({page},info)=>{
 const state=await setup(page); await quoted(page);
 const pay=page.getByTestId("pay-panel"), receive=page.getByTestId("receive-panel");
 expect(await pay.evaluate(e=>e.getBoundingClientRect().top)).toBeLessThan(await receive.evaluate(e=>e.getBoundingClientRect().top));
 await expect(pay.getByRole("button",{name:"MAX",exact:true})).toBeVisible(); await expect(receive.getByRole("button",{name:"MAX",exact:true})).toHaveCount(0);
 await expect(page.getByLabel("You pay amount",{exact:true})).toBeEditable(); await expect(page.getByLabel("You receive amount",{exact:true})).not.toBeEditable();
 expect(await page.getByLabel("You pay amount",{exact:true}).evaluate(e=>e.getBoundingClientRect().bottom)).toBeLessThan(info.project.use.viewport!.height);
 for(const text of ["Non-custodial · Atomic 0.25% MPGR fee","Direction reversed. Enter a new pay amount.","Wallet-controlled. Approval is not a swap. Quotes are estimates; receipt verification establishes execution.","Your wallet explicitly signs each transaction. No separate MPGR fee transaction. Never resubmit an unknown-status swap without checking its hash."]) await expect(page.getByText(text,{exact:true})).toHaveCount(0);
 expect(await page.getByRole("button",{name:"Confirm Swap",exact:true}).evaluate(e=>e.getBoundingClientRect().bottom)).toBeLessThan(info.project.use.viewport!.height);
 await page.screenshot({path:info.outputPath("pay-first-compact.png"),fullPage:true});
 await expect(page.getByTestId("mpgr-fee-row")).toHaveCount(1); await page.locator("summary").filter({hasText:"Costs & execution details"}).tap(); await expect(page.getByTestId("mpgr-fee-row")).toContainText("0.0025 USDC"); await expect(page.getByTestId("mpgr-fee-row")).toContainText("included in executable route; collection not verified");
 await page.screenshot({path:info.outputPath("pay-first.png"),fullPage:true});
 await page.getByRole("button",{name:"Confirm Swap",exact:true}).tap(); await expect(page.getByTestId("mpgr-fee-row")).toHaveCount(1); await expect(page.getByRole("dialog").getByTestId("mpgr-fee-row")).toHaveCount(1);
 expect((await page.locator("body").textContent())!.match(/0\.25% Trading Fee/g)).toHaveLength(1); await evidence(page,info,state.trace);
});
test("Swap correction: receive selection never changes pay or silently reverses the pair",async({page},info)=>{
 const state=await setup(page);await quoted(page);
 await page.getByRole("button",{name:"You receive token: ETH",exact:true}).tap(); await page.getByLabel("Search tokens or Base contract").fill("USDC");
 await expect(page.getByRole("button",{name:`Select USDC ${address("USDC")}`,exact:true})).toBeDisabled(); await page.getByRole("button",{name:"Close Select a token"}).tap();
 await expect(page.getByRole("button",{name:"You pay token: USDC",exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"You receive token: ETH",exact:true})).toBeVisible();await expect(page.getByLabel("You pay amount",{exact:true})).toHaveValue("1");
 await choose(page,"receive","AAPLc");await expect(page.getByLabel("You pay amount",{exact:true})).toHaveValue("1");await expect(page.getByRole("button",{name:"You pay token: USDC",exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"Confirm Swap",exact:true})).toBeEnabled();expect(await sends(page)).toHaveLength(0);await evidence(page,info,state.trace);
});
test("Swap correction: expired review refreshes changed output/minimum before any signature and updates the same fee row",async({page},info)=>{
 const state=await setup(page,{shortQuote:true,refreshOutputAtomic:"20000000000000000"});await review(page);
 await expect(page.getByRole("dialog")).toContainText("Quote needs updating.",{timeout:6000});
 await page.getByRole("button",{name:"Refresh quote & retry",exact:true}).evaluate(node=>{(node as HTMLButtonElement).click();(node as HTMLButtonElement).click();});
 await expect(page.getByRole("dialog")).toContainText("Quote updated — review new output.");await expect(page.getByRole("dialog")).toContainText("0.02 ETH");await expect(page.getByRole("dialog")).toContainText("0.0198 ETH");await expect(page.getByTestId("mpgr-fee-row")).toHaveCount(1);
 expect(state.quoteCount()).toBe(2);expect(state.quoteBodies[1].refreshQuote).toBe(true);expect(await sends(page)).toHaveLength(0);
 await page.getByRole("button",{name:"Confirm & Swap",exact:true}).tap();await expect(page.getByTestId("swap-status")).toBeVisible();await expect(page.getByTestId("mpgr-fee-row")).toContainText("collection verified");expect(await sends(page)).toHaveLength(2);await evidence(page,info,state.trace);
});
test("Swap correction: late aborted response cannot overwrite the newer amount, output or quote",async({page},info)=>{
 const state=await setup(page,{firstQuoteDelayMs:2500,refreshOutputAtomic:"20000000000000000"});await page.getByLabel("You pay amount",{exact:true}).fill("1");await expect.poll(()=>state.quoteCount()).toBe(1);
 await page.getByLabel("You pay amount",{exact:true}).fill("2");await expect(page.getByRole("button",{name:"Confirm Swap",exact:true})).toBeEnabled();await expect(page.getByLabel("You receive amount",{exact:true})).toHaveValue("0.02");
 await page.waitForTimeout(2600);await expect(page.getByLabel("You pay amount",{exact:true})).toHaveValue("2");await expect(page.getByLabel("You receive amount",{exact:true})).toHaveValue("0.02");expect(state.quoteCount()).toBe(2);expect(await sends(page)).toHaveLength(0);await evidence(page,info,state.trace);
});
test("Swap correction: MAX refuses dust instead of filling an invalid amount",async({page},info)=>{
 await page.addInitScript(()=>{(window as unknown as {simulatedWalletScenario:string}).simulatedWalletScenario="dust-balance";});const state=await setup(page);await expect(page.getByTestId("pay-panel")).toContainText("0.000399");await expect(page.getByRole("button",{name:"MAX",exact:true})).toBeDisabled();await expect(page.getByLabel("You pay amount",{exact:true})).toHaveValue("");expect(state.quoteCount()).toBe(0);expect(await sends(page)).toHaveLength(0);await evidence(page,info,state.trace);
});
test("Swap correction: pending swap remains locked against duplicate confirmation until its actual receipt",async({page},info)=>{
 const state=await setup(page);await review(page);await scenario(page,"swap-pending");await page.getByRole("button",{name:"Confirm & Swap",exact:true}).tap();await expect(page.getByText("Waiting for Base confirmation…",{exact:true})).toBeVisible();await expect(page.getByTestId("swap-status")).toHaveCount(0);await expect(page.getByRole("button",{name:"Confirm & Swap",exact:true})).toHaveCount(0);expect(await sends(page)).toHaveLength(2);
 await page.evaluate(()=>{(window as unknown as {simulatedPendingSwap:()=>void}).simulatedPendingSwap();});await expect(page.getByTestId("swap-status")).toBeVisible();expect(await sends(page)).toHaveLength(2);await evidence(page,info,state.trace);
});
test("Swap correction: explicit reversal exchanges native/token balances and input, clears old output, then requotes",async({page},info)=>{
 const state=await setup(page);await page.getByRole("button",{name:"Reverse swap direction"}).tap();await quoted(page);
 await expect(page.getByTestId("pay-panel")).toContainText("Balance: 2");await expect(page.getByTestId("receive-panel")).toContainText("Balance: 100");await page.getByRole("button",{name:"Reverse swap direction",exact:true}).tap();
 await expect(page.getByRole("button",{name:"You pay token: USDC",exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"You receive token: ETH",exact:true})).toBeVisible();await expect(page.getByTestId("pay-panel")).toContainText("Balance: 100");await expect(page.getByTestId("receive-panel")).toContainText("Balance: 2");await expect(page.getByLabel("You pay amount",{exact:true})).toHaveValue("0.01");await expect(page.getByLabel("You receive amount",{exact:true})).toHaveValue("");await expect(page.getByRole("button",{name:"Confirm Swap",exact:true})).toBeEnabled();expect(state.quoteCount()).toBe(2);expect(await sends(page)).toHaveLength(0);await evidence(page,info,state.trace);
});
test("Swap correction: manual quote double click and debounce produce only one request",async({page},info)=>{
 const state=await setup(page,{firstQuoteDelayMs:1500});await page.getByLabel("You pay amount",{exact:true}).fill("1");await page.getByRole("button",{name:"Get quote",exact:true}).evaluate(node=>{(node as HTMLButtonElement).click();(node as HTMLButtonElement).click();});await expect(page.getByRole("button",{name:"Confirm Swap",exact:true})).toBeEnabled();expect(state.quoteCount()).toBe(1);expect(await sends(page)).toHaveLength(0);await evidence(page,info,state.trace);
});
test("Swap correction: long decimal entry wraps legibly without field or page clipping",async({page},info)=>{
 const state=await setup(page);const field=page.getByLabel("You pay amount",{exact:true});await field.fill("12345678901234567890.123456");await expect(field).toHaveValue("12345678901234567890.123456");expect(await field.evaluate(e=>e.scrollWidth<=e.clientWidth&&e.scrollHeight<=e.clientHeight)).toBe(true);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await evidence(page,info,state.trace);
});

test("Swap: ETH/WETH same underlying selection is disabled before quote or wallet prompt", async ({ page }, info) => {
 const state = await setup(page); await page.getByRole("button", { name: "Reverse swap direction" }).tap();
 await page.getByRole("button", { name: "You receive token: USDC", exact: true }).tap(); await page.getByLabel("Search tokens or Base contract").fill("WETH");
 await expect(page.getByRole("button", { name: `Select WETH ${address("WETH")}`, exact: true })).toBeDisabled();
 await expect(page.getByTestId("token-route-unavailable")).toContainText("Same asset"); expect(state.quoteCount()).toBe(0); expect(await sends(page)).toHaveLength(0); await evidence(page, info, state.trace);
});
test("Swap: unknown allowance never causes an approval prompt", async ({ page }, info) => {
 const state = await setup(page); await review(page); await scenario(page, "allowance-read-error"); await page.getByRole("button", { name: "Confirm & Swap", exact: true }).tap();
 await expect(page.getByRole("dialog").getByRole("alert")).toContainText("allowance could not be verified"); expect(await sends(page)).toHaveLength(0); await evidence(page, info, state.trace);
});

test("Swap: registered token status requires a fresh quote and never promises execution", async ({ page }, info) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "You receive token: ETH", exact: true }).tap();
  const eth = page.getByRole("button", { name: `Select ETH ${NATIVE_ETH_SENTINEL}`, exact: true });
  await expect(eth).toBeEnabled();
  await expect(eth.getByTestId("token-route-status")).toHaveCount(0);
  expect(state.quoteCount()).toBe(0); expect(await sends(page)).toHaveLength(0);
  await evidence(page, info, state.trace);
});

test("Swap: approved but non-registered pair is draft-searchable, not a liquidity or execution claim",async({page},info)=>{
 const state=await setup(page);
 await page.getByRole("button",{name:"You receive token: ETH",exact:true}).tap();
 await page.getByLabel("Search tokens or Base contract").fill("AAPLc");
 const row=page.getByRole("button",{name:`Select AAPLc ${token("AAPLc")}`,exact:true});
 // The initial pay is USDC, so first select AAPLc, then inspect WETH as a new pay counterasset.
 await row.tap();await page.getByRole("button",{name:"You pay token: USDC",exact:true}).tap();
 await page.getByLabel("Search tokens or Base contract").fill("WETH");
 const weth=page.getByRole("button",{name:`Select WETH ${token("WETH")}`,exact:true});
 await expect(weth).toBeEnabled();await expect(weth.getByTestId("token-route-status")).toHaveCount(0);
 expect(state.quoteCount()).toBe(0);expect(await sends(page)).toHaveLength(0);await evidence(page,info,state.trace);
});

test("Swap: alternate canonical venue/tier passes actual controller approval, submission and receipt verification",async({page},info)=>{
 const state=await setup(page);
 await page.route("**/api/swap/quote",async request=>{
   const body=request.request().postDataJSON();
   const p=simulatedExecutorQuote({sell:body.fromToken,buy:body.toToken,sellAmount:body.amount,slippageBps:body.slippageBps} as Parameters<typeof simulatedExecutorQuote>[0]);
   const routes=swapRouteCandidates(p.from.address,p.to.address),route=routes.find(r=>r.poolFee===500)!;
   const decoded=decodeFunctionData({abi:MPGR_EXECUTOR_ABI,data:p.transaction!.data});
   if(decoded.functionName!=="swapUniswapV3ExactInputSingle"&&decoded.functionName!=="swapSlipstreamExactInputSingle")throw Error("Unexpected fixture selector");
   p.transaction={...p.transaction!,data:encodeFunctionData({abi:MPGR_EXECUTOR_ABI,functionName:"swapUniswapV3ExactInputSingle",args:[{...decoded.args[0],router:route.router},500,decoded.args[2]]})};
   const routed={...p,swapRouting:{version:1,hops:1,route,pool:"0x7777777777777777777777777777777777777777",blockNumber:"100",blockHash:`0x${"ab".repeat(32)}`,calldataHash:keccak256(p.transaction.data),selection:"highest-quoted-output",comparisonComplete:false,
    outcomes:routes.map(r=>({key:swapRouteKey(r),state:swapRouteKey(r)===swapRouteKey(route)?"quoted":"unavailable",reason:"MOCKED_BROWSER_ONLY",output:swapRouteKey(r)===swapRouteKey(route)?p.toAmount:null})),quoterGasUnits:"10000",executionSimulation:"not-run-wallet-preflight-required"}};
   await page.evaluate(p=>{(window as unknown as {simulatedProposal:unknown}).simulatedProposal=p;},routed);
   await request.fulfill({json:{proposal:routed}});
 });
 await page.getByLabel("You pay amount",{exact:true}).fill("1");
 await expect(page.getByRole("button",{name:"Confirm Swap",exact:true})).toBeEnabled();
 await page.locator("summary").filter({hasText:"Costs & execution details"}).tap();
 await expect(page.getByText(/Highest quoted output among/)).toContainText("Partial search");
 await expect(page.getByText("not total transaction cost",{exact:false})).toBeVisible();
 await page.getByRole("button",{name:"Confirm Swap",exact:true}).tap();
 await page.getByRole("button",{name:"Confirm & Swap",exact:true}).tap();
 await expect(page.getByRole("dialog")).toContainText("Swap confirmed");
 expect(await sends(page)).toHaveLength(2);await evidence(page,info,state.trace);
});


test("Swap: mined approval survives lagging latest RPC; same dialog becomes final non-actionable overview", async ({ page }, info) => {
  const state = await setup(page); await choose(page, "receive", "AAPLc"); await review(page);
  await scenario(page, "approval-rpc-lag");
  await page.getByRole("button", { name: "Confirm & Swap", exact: true }).tap();
  const overview = page.getByRole("dialog", { name: "Transaction overview", exact: true });
  await expect(overview).toBeVisible(); await expect(overview.getByTestId("swap-status")).toContainText("confirmed");
  await expect(overview).toContainText("You paid · verified"); await expect(overview).toContainText("1 USDC");
  await expect(overview).toContainText("You received · verified");
  await expect(overview.getByTestId("mpgr-fee-row")).toContainText("0.0025 USDC");
  await expect(overview).not.toContainText("estimated"); await expect(overview).not.toContainText("Minimum:");
  await expect(overview.getByRole("button", { name: "Confirm & Swap", exact: true })).toHaveCount(0);
  await expect(overview.getByRole("button", { name: /Refresh quote/ })).toHaveCount(0);
  await expect(overview.getByRole("link", { name: "View swap on BaseScan", exact: true })).toHaveAttribute("href", /https:\/\/basescan.org\/tx\/0x[0-9a-f]{64}$/);
  expect(await sends(page)).toHaveLength(2); await evidence(page, info, state.trace);
  await overview.getByRole("button", { name: "Done", exact: true }).tap(); await expect(overview).toHaveCount(0);
});
test("Swap: success event with different mined calldata cannot show a final success or resubmit", async ({ page }, info) => {
  const state = await setup(page); await review(page); await scenario(page, "wrong-mined-input");
  await page.getByRole("button", { name: "Confirm & Swap", exact: true }).tap();
  await expect(page.getByRole("alert")).toContainText("could not be confirmed");
  await expect(page.getByTestId("swap-status")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Confirm & Swap", exact: true })).toHaveCount(0);
  expect(await sends(page)).toHaveLength(2); await evidence(page, info, state.trace);
});


test("Swap: published-list discovery checks exact Base metadata without granting trading permission", async ({ page }, info) => {
  const state = await setup(page);
  const aero = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
  await page.route("**/api/swap/tokens", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ chainId: 8453, tokens: [{ address: aero, symbol: "AERO", name: "Aerodrome Finance" }] }) }));
  await page.route("**/api/swap/token", route => {
    expect(route.request().postDataJSON()).toEqual({ address: aero, chainId: 8453 });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ chainId: 8453, executionAuthorized: false, token: { address: aero, symbol: "AERO", name: "Aerodrome Finance", decimals: 18, kind: "erc20", verified: false } }) });
  });
  await page.getByRole("button", { name: "You receive token: ETH", exact: true }).tap();
  await page.getByLabel("Search tokens or Base contract").fill("AERO");
  const listed = page.getByRole("button", { name: `Select AERO ${aero}`, exact: true });
  await expect(listed).toBeEnabled();
  await expect(listed.getByTestId("token-route-status")).toHaveCount(0);
  expect(state.quoteCount()).toBe(0); expect(await sends(page)).toHaveLength(0); await evidence(page, info, state.trace);
});
test("Swap: high price impact demands explicit acknowledgement before confirmation", async ({ page }, info) => {
  const state = await setup(page, { priceImpactBps: 620 });
  await page.getByLabel("You pay amount", { exact: true }).fill("1");
  await expect(page.getByTestId("swap-risk-warning").first()).toBeVisible();
  await expect(page.getByTestId("swap-risk-warnings")).toContainText("checks can never prove");
  const confirm = page.getByRole("button", { name: "Confirm Swap", exact: true });
  await expect(confirm).toBeDisabled();
  await page.getByTestId("swap-risk-ack").tap();
  await expect(confirm).toBeEnabled();
  expect(await sends(page)).toHaveLength(0); await evidence(page, info, state.trace);
});
test("Swap: a calm quote shows no risk banner and needs no acknowledgement", async ({ page }, info) => {
  const state = await setup(page);
  await page.getByLabel("You pay amount", { exact: true }).fill("1");
  await expect(page.getByRole("button", { name: "Confirm Swap", exact: true })).toBeEnabled();
  await expect(page.getByTestId("swap-risk-warnings")).toHaveCount(0);
  expect(await sends(page)).toHaveLength(0); await evidence(page, info, state.trace);
});
test("Swap: token-list outage is temporary unavailability, never missing liquidity or successful import", async ({ page }, info) => {
  const state = await setup(page);
  await page.route("**/api/swap/tokens", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Base token search is temporarily unavailable. Retry or paste the exact Base contract to check it." }) }));
  await page.getByRole("button", { name: "You receive token: ETH", exact: true }).tap();
  await page.getByLabel("Search tokens or Base contract").fill("VIRTUAL");
  await page.getByRole("button", { name: "Search more Base tokens", exact: true }).tap();
  await expect(page.getByRole("alert")).toContainText("temporarily unavailable");
  await expect(page.getByRole("dialog")).not.toContainText("No liquidity");
  expect(state.quoteCount()).toBe(0); expect(await sends(page)).toHaveLength(0); await evidence(page, info, state.trace);
});
test("Swap: final overview uses actual event output instead of the quote estimate", async ({ page }, info) => {
  const state = await setup(page); await review(page); await scenario(page, "actual-output-over-quote");
  await page.getByRole("button", { name: "Confirm & Swap", exact: true }).tap();
  const overview = page.getByRole("dialog", { name: "Transaction overview", exact: true });
  await expect(overview).toContainText("0.010000000000001234 ETH");
  await expect(overview).not.toContainText("estimated"); expect(await sends(page)).toHaveLength(2); await evidence(page, info, state.trace);
});


test("Swap: ETH to AAPLc 0.0001 at 1 percent keeps provider failure distinct from liquidity", async ({ page }, info) => {
  const state = await setup(page); await choose(page, "receive", "AAPLc"); await choose(page, "pay", "ETH");
  await page.route("**/api/swap/quote", route => {
    expect(route.request().postDataJSON()).toMatchObject({ fromToken: NATIVE_ETH_SENTINEL, toToken: address("AAPLc"), amount: "0.0001", slippageBps: 100 });
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "PROVIDER_ERROR", error: "Base network verification is temporarily unavailable. Retry the quote; no swap was prepared." }) });
  });
  await page.getByLabel("You pay amount", { exact: true }).fill("0.0001");
  await expect(page.getByRole("alert")).toContainText("temporarily unavailable");
  await expect(page.getByLabel("You receive amount", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Confirm Swap", exact: true })).toHaveCount(0);
  expect(await sends(page)).toHaveLength(0); await evidence(page, info, state.trace);
});
