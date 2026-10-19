import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { authenticateZeroxSettler, fetchZeroxQuote, zeroxAvailable } from "../zerox-quote";
import { ZEROX_ALLOWANCE_HOLDER } from "../swap-executor-config";

const req = {
  sellToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
  buyToken: "0x4200000000000000000000000000000000000006" as Address,
  sellAmount: 10n ** 6n,
  taker: "0x2222222222222222222222222222222222222222" as Address,
  slippageBps: 50,
};
const okBody = (over: Record<string, unknown> = {}) => JSON.stringify({
  transaction: { to: "0x1111111111111111111111111111111111111111", data: "0xdeadbeef", value: "0" },
  buyAmount: "5000000", minBuyAmount: "4950000", gas: "210000",
  issues: { allowance: { spender: ZEROX_ALLOWANCE_HOLDER } },
  ...over,
});
const fetchOk = (body: string, status = 200) => vi.fn(async () => new Response(body, { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

describe("0x quote client", () => {
  it("is unavailable without an API key and says so honestly", async () => {
    vi.stubEnv("ZEROX_API_KEY", "");
    vi.stubEnv("OX_API_KEY", "");
    expect(zeroxAvailable()).toBe(false);
    const r = await fetchZeroxQuote(req);
    expect(r.ok).toBe(false);
    vi.unstubAllEnvs();
  });
  it("validates value, spender and numeric amounts", async () => {
    vi.stubEnv("ZEROX_API_KEY", "k");
    expect((await fetchZeroxQuote(req, fetchOk(okBody({ transaction: { to: "0x1111111111111111111111111111111111111111", data: "0x01", value: "1" } })))).ok).toBe(false);
    expect((await fetchZeroxQuote(req, fetchOk(okBody({ issues: { allowance: { spender: "0x3333333333333333333333333333333333333333" } } })))).ok).toBe(false);
    expect((await fetchZeroxQuote(req, fetchOk(okBody({ buyAmount: "0x10" })))).ok).toBe(false);
    const good = await fetchZeroxQuote(req, fetchOk(okBody()));
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.quote.buyAmount).toBe(5000000n);
      expect(good.quote.minBuyAmount).toBe(4950000n);
      expect(good.quote.gasEstimate).toBe(210000n);
      expect(good.quote.allowanceHolder).toBe(ZEROX_ALLOWANCE_HOLDER);
    }
    expect((await fetchZeroxQuote(req, fetchOk("nope", 500))).ok).toBe(false);
    vi.unstubAllEnvs();
  });
  it("authenticates the settler only against the on-chain deployer registry", async () => {
    const target = "0x1111111111111111111111111111111111111111" as const;
    const reader = (owner: unknown) => ({ readContract: async () => owner });
    expect(await authenticateZeroxSettler(reader(target) as never, target)).toBe(true);
    expect(await authenticateZeroxSettler(reader("0x4444444444444444444444444444444444444444") as never, target)).toBe(false);
    expect(await authenticateZeroxSettler({ readContract: async () => { throw new Error("rpc down"); } } as never, target)).toBe(false);
  });
});
