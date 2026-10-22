import { expect, it } from "vitest";
import { publicSwapMessage } from "../public-message";

it("hides executor and calldata language from the swap screen", () => {
  expect(publicSwapMessage("The mined transaction does not match the reviewed swap. Do not resubmit; inspect it on BaseScan.")).toBe("This swap could not be confirmed. Check it on BaseScan before trying again.");
  expect(publicSwapMessage("Some direct-pool evidence is unavailable; retry the quote. No route through the reviewed MPGR executors could be prepared for this pair and amount.")).toBe("No route for this pair right now. Try another token or amount.");
  expect(publicSwapMessage("Insufficient USDC balance. Lower the pay amount.")).toBe("Insufficient USDC balance. Lower the pay amount.");
});
