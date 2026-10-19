import { test, expect } from "@playwright/test";
import { setup, evidence, walletCalls } from "./flow-setup";
test.use({viewport:{width:1280,height:900},isMobile:false,hasTouch:false});
test("Swap desktop correction: editable long decimals, pay-first layout, compact action and one fee in review",async({page},info)=>{
 const state=await setup(page);const pay=page.getByLabel("You pay amount",{exact:true});
 await pay.fill("12345678901234567890.123456");await expect(pay).toHaveValue("12345678901234567890.123456");
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 expect(await pay.evaluate(e=>e.scrollWidth<=e.clientWidth && e.scrollHeight<=e.clientHeight)).toBe(true);
 await pay.fill("1");await expect(page.getByRole("button",{name:"Confirm Swap",exact:true})).toBeEnabled();
 expect(await page.getByTestId("pay-panel").evaluate(e=>e.getBoundingClientRect().top)).toBeLessThan(await page.getByTestId("receive-panel").evaluate(e=>e.getBoundingClientRect().top));
 expect(await page.getByRole("button",{name:"Confirm Swap",exact:true}).evaluate(e=>e.getBoundingClientRect().bottom)).toBeLessThan(900);
 await page.getByRole("button",{name:"Confirm Swap",exact:true}).click();await expect(page.getByRole("dialog").getByTestId("mpgr-fee-row")).toHaveCount(1);await expect(page.getByTestId("mpgr-fee-row")).toHaveCount(1);expect(await walletCalls(page)).toEqual([]);await evidence(page,info,state.trace);
});
