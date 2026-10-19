import { beforeEach, afterEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ auth: vi.fn(), rate: vi.fn(), inspect: vi.fn(), client: vi.fn() }));
vi.mock("@/lib/auth/session-store", () => ({ authenticateRequest: m.auth }));
vi.mock("@/lib/trade/trade-rate-limit", () => ({ checkRateLimit: m.rate, clientIpFromRequest: () => "test-ip" }));
vi.mock("@/lib/swap/swap-liquidity", () => ({ discoverSwapLiquidity: m.inspect }));
vi.mock("@/lib/swap/swap-token-metadata", () => ({ inspectSwapToken: m.inspect }));
vi.mock("@/lib/swap/swap-discovery-read", async original => ({ ...await original<object>(), swapDiscoveryClient: m.client }));
import { SwapDiscoveryError } from "@/lib/swap/swap-discovery-read";
import { POST as liquidity } from "./route";
import { POST as token } from "../token/route";
const origin = "https://mpgrhub.xyz", a = "0x1234567890abcdef1234567890abcdef12345678", b = "0x2234567890abcdef1234567890abcdef12345678";
const req = (body: unknown, from = origin) => new Request(`${origin}/api/swap/inspection`, { method: "POST", headers: { Origin: from, "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
beforeEach(() => { vi.stubEnv("APP_ORIGIN", origin); vi.resetAllMocks(); m.auth.mockResolvedValue({ wallet: a }); m.rate.mockResolvedValue({ allowed: true }); m.client.mockReturnValue("read-client"); m.inspect.mockResolvedValue({ chainId: 8453, executionAuthorized: false }); });
afterEach(() => vi.unstubAllEnvs());
for (const [name, post, body] of [["liquidity", liquidity, { chainId: 8453, fromToken: a, toToken: b }], ["token", token, { chainId: 8453, address: a }]] as const) {
  it(`${name}: rejects foreign origin before auth`, async () => { expect((await post(req(body, "https://evil.invalid"))).status).toBe(403); expect(m.auth).not.toHaveBeenCalled(); });
  it(`${name}: requires signed wallet session`, async () => { m.auth.mockResolvedValue(null); expect((await post(req(body))).status).toBe(401); expect(m.client).not.toHaveBeenCalled(); });
  it.each([0, 1])(`${name}: wallet/IP limit %s`, async index => { m.rate.mockResolvedValueOnce({ allowed: index !== 0 }).mockResolvedValueOnce({ allowed: false }); expect((await post(req(body))).status).toBe(429); expect(m.client).not.toHaveBeenCalled(); });
  it.each([null, [], {}, { ...body, chainId: 1 }, { ...body, address: "bad", fromToken: "bad" }])(`${name}: validates shape/chain/address %#`, async input => { expect((await post(req(input))).status).toBe(400); expect(m.client).not.toHaveBeenCalled(); });
  it(`${name}: bounds raw body`, async () => { expect((await post(req("x".repeat(513)))).status).toBe(413); expect(m.client).not.toHaveBeenCalled(); });
  it(`${name}: no-store display-only response and correct reader arguments`, async () => { const r = await post(req(body)); expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toBe("no-store"); expect(await r.json()).toEqual({ chainId: 8453, executionAuthorized: false }); expect(m.inspect).toHaveBeenCalledExactlyOnceWith("read-client", a, ...(name === "liquidity" ? [b] : [])); });
  it(`${name}: caller fee/execution flags cannot enable execution`, async () => { const r = await post(req({ ...body, enforceFee: false, executionAuthorized: true })); expect(await r.json()).toEqual({ chainId: 8453, executionAuthorized: false }); });
  it(`${name}: sanitized unknown upstream error`, async () => { m.inspect.mockRejectedValue(new Error("PRIVATE_RPC_KEY")); const r = await post(req(body)); expect(r.status).toBe(503); expect(await r.text()).not.toContain("PRIVATE_RPC_KEY"); });
  it(`${name}: structured token/route/provider failure is retained`, async () => { m.inspect.mockRejectedValue(new SwapDiscoveryError("WRONG_RPC_CHAIN", "Base could not be verified.")); const r = await post(req(body)); expect(r.status).toBe(503); expect(await r.json()).toMatchObject({ code: "WRONG_RPC_CHAIN" }); });
}
