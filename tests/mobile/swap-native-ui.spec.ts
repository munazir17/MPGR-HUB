import { test, expect, type Page } from "@playwright/test";
import { setup, evidence, walletCalls } from "./flow-setup";
import { MANUAL_SWAP_TOKENS } from "../../lib/trade/manual-swap";
import { inspectExecutorSwapTransaction } from "../../lib/executor/executor-intent";
import { BASE_WETH, NATIVE_ETH_SENTINEL } from "../../lib/trade/trade-config";
import type { TradeProposal } from "../../lib/trade/trade-types";
const token=(s:string)=>MANUAL_SWAP_TOKENS.find(t=>t.symbol===s)!;
async function select(page:Page,side:"pay"|"receive",symbol:string){await page.getByRole("button",{name:new RegExp(`^You ${side} token:`)}).click();await page.getByLabel("Search tokens or Base contract").fill(symbol);await page.getByRole("button",{name:`Select ${symbol} ${token(symbol).address}`,exact:true}).click();}
const quote=async(page:Page)=>{await page.getByLabel("You pay amount",{exact:true}).fill("1");await expect(page.getByRole("button",{name:"Confirm Swap",exact:true})).toBeEnabled();};
async function proposal(page:Page){return page.evaluate(()=>(window as unknown as {simulatedProposal:TradeProposal}).simulatedProposal);}
async function imageLoaded(page:Page,side:"pay"|"receive"){const image=page.getByTestId(`${side}-panel`).locator("img");await expect(image).toHaveCount(1);await expect.poll(()=>image.evaluate(e=>(e as HTMLImageElement).complete&&(e as HTMLImageElement).naturalWidth>0)).toBe(true);}
function viewportCases(){
 test("Native UI: official local ETH/WETH/USDC logos, names, neutral unknown fallback and distinct identities",async({page},info)=>{
  const state=await setup(page);await expect(page.getByRole("button",{name:"You receive token: ETH",exact:true})).toBeVisible();await expect(page.getByTestId("receive-panel")).toContainText("Ether · Native Base asset");await expect(page.getByTestId("receive-panel")).toContainText("Balance: 2");await imageLoaded(page,"pay");await imageLoaded(page,"receive");await page.screenshot({path:info.outputPath("native-default.png"),fullPage:true});
  await page.getByRole("button",{name:"You receive token: ETH",exact:true}).click();
  for(const symbol of ["ETH","WETH","USDC"]){const option=page.getByRole("button",{name:`Select ${symbol} ${token(symbol).address}`,exact:true});await expect(option).toContainText(token(symbol).name);await expect(option.locator("img")).toHaveAttribute("src",`/tokens/base/${token(symbol).address.toLowerCase()}.png`);await expect.poll(()=>option.locator("img").evaluate(e=>(e as HTMLImageElement).naturalWidth>0)).toBe(true);}
  await page.screenshot({path:info.outputPath("selector-logos.png"),fullPage:true});
  await expect(page.getByRole("button",{name:`Select ETH ${NATIVE_ETH_SENTINEL}`,exact:true})).toContainText("no ERC-20 contract");
  await page.getByRole("button",{name:`Select WETH ${BASE_WETH}`,exact:true}).click();await expect(page.getByTestId("receive-panel")).toContainText("Wrapped Ether");await expect(page.getByTestId("receive-panel")).toContainText("Balance: 100");await imageLoaded(page,"receive");await page.screenshot({path:info.outputPath("weth-selected.png"),fullPage:true});
  await select(page,"receive","AAPLc");await expect(page.getByTestId("receive-panel").getByTestId("token-logo-fallback")).toHaveCount(1);await expect(page.getByTestId("receive-panel").locator("img")).toHaveCount(0);expect(await walletCalls(page)).not.toContain("simulated-send");await evidence(page,info,state.trace);
 });
 test("Native UI: Go back uses actual same-origin SPA history without signing or altering quotes",async({page},info)=>{
  const state=await setup(page);await page.evaluate(()=>{history.replaceState({},"","/profile");history.pushState({},"","/swap");});await quote(page);const back=page.getByRole("button",{name:"Go back",exact:true});await expect(back).toBeVisible();expect(await back.evaluate(e=>e.getBoundingClientRect().width)).toBeGreaterThanOrEqual(44);await back.click();await expect(page).toHaveURL(/\/profile$/);expect(state.quoteCount()).toBe(1);expect(await walletCalls(page)).not.toContain("simulated-send");await evidence(page,info,state.trace);
 });
 test("Native UI: direct entry falls back to HUB dashboard rather than leaving the app",async({page},info)=>{
  const state=await setup(page);await page.route(url=>url.pathname==="/",route=>route.fulfill({contentType:"text/html",body:"<h1>MPGR HUB dashboard</h1>"}));await page.getByRole("button",{name:"Go back",exact:true}).click();await expect(page).toHaveURL("http://127.0.0.1:4173/");await expect(page.getByRole("heading",{name:"MPGR HUB dashboard"})).toBeVisible();expect(state.quoteCount()).toBe(0);await evidence(page,info,state.trace);
 });
}
viewportCases();
test.describe("Desktop",()=>{test.use({viewport:{width:1280,height:900},isMobile:false,hasTouch:false});viewportCases();});
test("Native UI: failed official logo loads fail to a neutral icon, never a remote or symbol-derived image",async({page},info)=>{
 await page.route(`**/tokens/base/${token("USDC").address.toLowerCase()}.png`,route=>route.abort());const state=await setup(page);await expect(page.getByTestId("pay-panel").getByTestId("token-logo-fallback")).toHaveCount(1);await expect(page.getByTestId("pay-panel").locator("img")).toHaveCount(0);await imageLoaded(page,"receive");await evidence(page,info,state.trace);
});
test("Native UI: native quote uses sentinel externally and the existing wrapped/unwrap route internally; WETH stays ERC20",async({page},info)=>{
 const state=await setup(page);await quote(page);let p=await proposal(page);let x=inspectExecutorSwapTransaction(p.transaction!);expect(p.chainId).toBe(8453);expect(p.to.address).toBe(NATIVE_ETH_SENTINEL);expect(p.to.kind).toBe("native");expect(x.ok).toBe(true);if(!x.ok)throw Error(x.reason);expect(x.value.tokenOut.toLowerCase()).toBe(BASE_WETH.toLowerCase());expect(x.value.unwrapNativeOut).toBe(true);expect(p.transaction!.value).toBe("0");
 await select(page,"receive","WETH");await expect(page.getByRole("button",{name:"Confirm Swap",exact:true})).toBeEnabled();p=await proposal(page);x=inspectExecutorSwapTransaction(p.transaction!);expect(p.to.address).toBe(BASE_WETH);expect(p.to.kind).toBe("erc20");expect(x.ok&&x.value.unwrapNativeOut).toBe(false);expect(state.quoteBodies.map(b=>b.toToken)).toEqual([NATIVE_ETH_SENTINEL,BASE_WETH]);await page.getByRole("button",{name:"Confirm Swap",exact:true}).click();await page.getByRole("button",{name:"Confirm & Swap",exact:true}).click();await expect(page.getByTestId("swap-status")).toBeVisible();expect((await walletCalls(page)).filter(x=>x==="simulated-send")).toHaveLength(2);await expect(page.getByTestId("mpgr-fee-row")).toContainText("collection verified");await evidence(page,info,state.trace);
});
test("Native UI: native pay carries gross ETH value, no ERC20 approval or sentinel contract calls",async({page},info)=>{
 const state=await setup(page);await page.getByRole("button",{name:"Reverse swap direction"}).click();await quote(page);const p=await proposal(page);expect(p.from.address).toBe(NATIVE_ETH_SENTINEL);expect(p.chainId).toBe(8453);expect(p.transaction!.value).toBe("1000000000000000000");expect(p.needsPermit2Approval).toBe(false);await page.getByRole("button",{name:"Confirm Swap",exact:true}).click();await page.getByRole("button",{name:"Confirm & Swap",exact:true}).click();await expect(page.getByTestId("swap-status")).toBeVisible();expect((await walletCalls(page)).filter(x=>x==="simulated-send")).toHaveLength(1);await expect(page.getByRole("link",{name:"View approval",exact:true})).toHaveCount(0);await expect(page.getByTestId("mpgr-fee-row")).toContainText("0.0025 ETH");await evidence(page,info,state.trace);
});
