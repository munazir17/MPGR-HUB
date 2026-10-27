import { expect, it } from "vitest";
import { publicSwapMessage } from "../public-message";

it("hides executor and calldata language from the swap screen", () => {
  expect(publicSwapMessage("The mined transaction does not match the reviewed swap. Do not resubmit; inspect it on BaseScan.")).toBe("This swap could not be confirmed. Check it on BaseScan before trying again.");
  expect(publicSwapMessage("The mined calldata is not V2 executor calldata.")).toBe("This swap could not be confirmed. Check it on BaseScan before trying again.");
  expect(publicSwapMessage("That transaction does not target the MPGR V2 executor.")).toBe("This swap could not be confirmed. Check it on BaseScan before trying again.");
  expect(publicSwapMessage("That transaction was not sent by the signed-in wallet.")).toBe("This swap could not be confirmed. Check it on BaseScan before trying again.");
  expect(publicSwapMessage("Some direct-pool evidence is unavailable; retry the quote. No route through the reviewed MPGR executors could be prepared for this pair and amount.")).toBe("No route for this pair right now. Try another token or amount.");
  expect(publicSwapMessage("Route discovery could not finish, so this pair was never measured. Archive requests require a personal token.")).toBe("This pair could not be priced just now. Refresh the quote and try again.");
  expect(publicSwapMessage("Insufficient USDC balance. Lower the pay amount.")).toBe("Insufficient USDC balance. Lower the pay amount.");
});
