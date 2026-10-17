import { beforeEach, describe, expect, it, vi } from "vitest";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT as d } from "@/lib/executor/executor-config";
import { BASE_USDC, NATIVE_ETH_SENTINEL } from "@/lib/trade/trade-config";
import { MPGR_TOKEN_ADDRESS } from "@/lib/chain/base";
import { MANUAL_SWAP_TOKENS } from "@/lib/trade/manual-swap";
import { swapQuotePolicyError, verifySwapSettlement } from "@/lib/swap/swap-policy";
import { inspectExecutorSwapTransaction } from "@/lib/executor/executor-intent";
import { simulatedSwapReceipt } from "@/tests/mobile/swap-receipt-fixture";
import { resetTradeQuoteCache } from "@/lib/trade/trade-quote-cache";
const m = vi.hoisted(() => ({ authenticated: true, originError: false, limited: false, chainId: 8453, decimalsMismatch: false, metadataFails: false, poolFails: false, out: 1000000000n, feeBps: 25n, feeRecipient: "0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4", allowed: true, routerMismatch: false, impactExpires: false, permissionsFail: false, allowance: 0n, routed: vi.fn(), simulate: vi.fn() }));
const wallet = "0x2222222222222222222222222222222222222222";
vi.mock("@/lib/auth/session-store", () => ({ authenticateRequest: async () => m.authenticated ? { wallet: "0x2222222222222222222222222222222222222222" } : null }));
vi.mock("@/lib/trade/trade-rate-limit", () => ({ checkRateLimit: async () => ({ allowed: !m.limited, retryAfterSeconds: 30 }), clientIpFromRequest: () => "offline" }));
vi.mock("@/lib/api/request-guard", async original => ({ ...await original<typeof import("@/lib/api/request-guard")>(), verifyTrustedOrigin: () => m.originError ? Response.json({ code: "UNTRUSTED_ORIGIN" }, { status: 403 }) : null }));
vi.mock("@/lib/trade/trade-price-impact", () => ({ estimateQuotePriceImpactBps: async () => { if (m.impactExpires) vi.setSystemTime(Date.now() + 31000); return null; } }));
vi.mock("@/lib/trade/trade-swap-router", () => ({ createRoutedSwapQuote: m.routed }));
vi.mock("@/lib/trade/trade-public-client", () => ({ getTradePublicClient: () => ({
  getChainId: async () => m.chainId,
  getCode: async () => m.metadataFails ? "0x" : "0x6000",
  readContract: async ({ address, functionName, args }: { address: string; functionName: string; args?: string[] }) => {
    if (m.permissionsFail) throw new Error("Permissions provider diagnostics");
    if (functionName === "isTokenAllowed") return m.allowed;
    if (functionName === "routerKind" && m.routerMismatch) return 0;
    if (functionName === "routerKind") return d.routes.find(r => r.router.toLowerCase() === args?.[0]?.toLowerCase())?.kind;
    const token = MANUAL_SWAP_TOKENS.find(t => t.address.toLowerCase() === address.toLowerCase()) ?? d.tokens.find(t => t.address.toLowerCase() === address.toLowerCase());
    if (!token) throw new Error("Unknown offline contract");
    return ({ decimals: m.decimalsMismatch ? 9 : token.decimals, symbol: token.symbol, name: token.symbol, totalSupply: 10n ** 30n, balanceOf: 0n } as Record<string, unknown>)[functionName];
  },
}) }));
vi.mock("@/lib/executor/executor-chain", async original => ({ ...await original<typeof import("@/lib/executor/executor-chain")>(), createChainReader: () => ({
  chainId: 8453,
  getBalance: async () => 10n ** 30n,
  readContract: async ({ functionName }: { functionName: string }) => ({ feeBps: m.feeBps, feeRecipient: m.feeRecipient, paused: false, MAX_FEE_BPS: 100n, owner: d.owner, allowance: m.allowance, balanceOf: 10n ** 30n } as Record<string, unknown>)[functionName],
  simulateContract: m.simulate,
}) }));
import { POST } from "./route";
import { POST as legacyPOST } from "@/app/api/trade/quote/route";
function request(body: Record<string, unknown> = {}) {
  return new Request("https://app.test/api/swap/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fromToken: BASE_USDC, toToken: d.weth, amount: "1", slippageBps: 100, ...body }) });
}
beforeEach(() => {
  resetTradeQuoteCache(); vi.clearAllMocks();
  Object.assign(m, { authenticated: true, originError: false, limited: false, chainId: 8453, decimalsMismatch: false, metadataFails: false, poolFails: false, out: 1000000000n, feeBps: 25n, feeRecipient: "0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4", allowed: true, routerMismatch: false, impactExpires: false, permissionsFail: false, allowance: 0n });
  m.simulate.mockImplementation(async () => { if (m.poolFails) throw new Error("Provider private diagnostics"); return { result: [m.out, 0n, 0n, 10000n] }; });
  m.routed.mockImplementation(async (arg: Record<string, unknown>) => ({ ok: true, provider: "cdp-trade-api", value: { ...arg, liquidityAvailable: true, toAmount: "1000000000", minToAmount: "990000000", transaction: { to: "0x5555555555555555555555555555555555555555", data: "0xabcd", value: "0" }, permit2: null, issues: { allowance: null, balance: null, simulationIncomplete: false } } }));
});
const directions = d.routes.flatMap(r => [[r.tokenA, r.tokenB], [r.tokenB, r.tokenA]]);
describe("all approved assisted routes, BOTH directions — real builders, offline chain boundaries", () => {
  it.each(directions)("%s → %s keeps exact 25bps fee, gross input, minimum, route and settlement proof", async (fromToken, toToken) => {
    const response = await POST(request({ fromToken, toToken, taker: d.feeRecipient }));
    expect(response.status).toBe(200); const { proposal: p } = await response.json();
    expect(p.taker.toLowerCase()).toBe(wallet); expect(p.chainId).toBe(8453);
    expect(p.agentFee).toMatchObject({ bps: 25, status: "applied", recipient: d.feeRecipient });
    expect(BigInt(p.agentFee.amountAtomic)).toBe(BigInt(p.fromAmount) * 25n / 10000n);
    expect(BigInt(p.minToAmount)).toBe(BigInt(p.toAmount) * 9900n / 10000n);
    const inspected = inspectExecutorSwapTransaction(p.transaction); expect(inspected.ok).toBe(true);
    if (!inspected.ok) throw Error(inspected.reason);
    expect(inspected.value.swapAmountIn).toBe(BigInt(p.fromAmount) - BigInt(p.agentFee.amountAtomic));
    expect(inspected.value.amountOutMinimum.toString()).toBe(p.minToAmount);
    expect(m.simulate.mock.calls[0][0].args[0].amountIn).toBe(inspected.value.swapAmountIn);
    expect(swapQuotePolicyError(p)).toBeNull();
    const receipt = simulatedSwapReceipt(p, `0x${"ab".repeat(32)}`);
    expect(verifySwapSettlement(p, receipt).verified).toBe(true);
    expect(verifySwapSettlement(p, { ...receipt, logs: [] }).verified).toBe(false);
    expect(m.routed).not.toHaveBeenCalled();
  });
  it.each([[NATIVE_ETH_SENTINEL, BASE_USDC], [BASE_USDC, NATIVE_ETH_SENTINEL]])("native %s → %s preserves value, wrapping and approval identity", async (fromToken, toToken) => {
    const { proposal: p } = await (await POST(request({ fromToken, toToken }))).json();
    expect(p.transaction.value).toBe(fromToken === NATIVE_ETH_SENTINEL ? p.fromAmount : "0");
    expect(p.needsPermit2Approval).toBe(fromToken !== NATIVE_ETH_SENTINEL);
    expect(swapQuotePolicyError(p)).toBeNull();
  });
});
it.each([[BASE_USDC, MPGR_TOKEN_ADDRESS], [MPGR_TOKEN_ADDRESS, BASE_USDC]])("MPGR %s → %s: actionable block, no provider quote or fabricated registration", async (fromToken, toToken) => {
  const r = await POST(request({ fromToken, toToken })); expect(r.status).toBe(422);
  expect(await r.json()).toMatchObject({ code: "EXECUTION_UNAVAILABLE", reason: "FEE_ROUTE_UNREGISTERED", error: expect.stringContaining("allowlist verification") });
  expect(r.headers.get("Cache-Control")).toBe("no-store"); expect(m.simulate).not.toHaveBeenCalled(); expect(m.routed).not.toHaveBeenCalled();
});
it.each([false, null, "true", 0])("caller cannot disable strict policy with %j", async requireMPGRFee => { expect((await POST(request({ requireMPGRFee }))).status).toBe(400); expect(m.simulate).not.toHaveBeenCalled(); });
it("omitting the flag is still server-owned strict; legacy Agent endpoint stays fee-skipped", async () => {
  const legacy = await legacyPOST(request({ fromToken: MPGR_TOKEN_ADDRESS, toToken: BASE_USDC })); expect(legacy.status).toBe(200); expect((await legacy.json()).proposal.agentFee.status).toBe("skipped");
  const strict = await POST(request({ fromToken: MPGR_TOKEN_ADDRESS, toToken: BASE_USDC })); expect(strict.status).toBe(422); expect(m.routed).toHaveBeenCalledTimes(1);
});
it.each([[NATIVE_ETH_SENTINEL, d.weth], [d.weth, NATIVE_ETH_SENTINEL], [BASE_USDC, BASE_USDC]])("same underlying %s → %s fails before quote", async (fromToken, toToken) => { const r = await POST(request({ fromToken, toToken })); expect(r.status).toBe(400); expect((await r.json()).code).toBe("SAME_ASSET"); expect(m.simulate).not.toHaveBeenCalled(); });
it("invalid address fails early", async () => expect((await POST(request({ toToken: "0x123" }))).status).toBe(400));
it("unregistered arbitrary import cannot become executable", async () => { const r = await POST(request({ toToken: "0x1234567890abcdef1234567890abcdef12345678" })); expect(r.status).toBe(422); expect(m.routed).not.toHaveBeenCalled(); });
it("wrong RPC chain cannot build executable quotes", async () => { m.chainId = 1; expect((await POST(request())).status).toBe(503); expect(m.simulate).not.toHaveBeenCalled(); });
it("unavailable token metadata fails before pool quote", async () => { m.metadataFails = true; expect((await POST(request())).status).toBe(400); expect(m.simulate).not.toHaveBeenCalled(); });
it("changed live token decimals are not replaced with catalog guesses", async () => { m.decimalsMismatch = true; expect((await POST(request())).status).toBe(422); expect(m.simulate).not.toHaveBeenCalled(); });
it("pool failure never falls back, and does not leak provider text", async () => { m.poolFails = true; const r = await POST(request()); expect(r.status).toBe(503); expect(JSON.stringify(await r.json())).not.toContain("private diagnostics"); expect(m.routed).not.toHaveBeenCalled(); });
it("zero liquidity is a pool error, not fee success", async () => { m.out = 0n; const r = await POST(request()); expect(r.status).toBe(422); expect((await r.json()).code).toBe("LIQUIDITY_UNAVAILABLE"); });
it.each([0n, 50n])("changed on-chain fee %s never executes as strict 25bps Swap", async feeBps => { m.feeBps = feeBps; expect((await POST(request())).status).toBe(422); });
it("refresh bypasses completed strict cache; never reuses legacy cache", async () => {
  const first = await (await POST(request())).json(); m.out = 2000000000n;
  expect((await (await POST(request())).json()).proposal.toAmount).toBe(first.proposal.toAmount);
  expect((await (await POST(request({ refreshQuote: true }))).json()).proposal.toAmount).toBe("2000000000");
});
it.each(["origin", "auth", "rate"])("%s gate refuses before chain/provider reads", async gate => {
  if (gate === "origin") m.originError = true; if (gate === "auth") m.authenticated = false; if (gate === "rate") m.limited = true;
  expect((await POST(request())).status).toBe(gate === "origin" ? 403 : gate === "auth" ? 401 : 429); expect(m.simulate).not.toHaveBeenCalled();
});

it("missing current on-chain permissions block a registered route before quoting", async () => { m.allowed = false; const r = await POST(request()); expect(r.status).toBe(422); expect((await r.json()).reason).toBe("EXECUTOR_PERMISSION_MISMATCH"); expect(m.simulate).not.toHaveBeenCalled(); });
it("unknown on-chain permissions fail closed without exposing RPC diagnostics", async () => { m.permissionsFail = true; const r = await POST(request()); expect(r.status).toBe(503); expect(JSON.stringify(await r.json())).not.toContain("diagnostics"); expect(m.simulate).not.toHaveBeenCalled(); });
it("cached proposals still require fresh permission checks", async () => { expect((await POST(request())).status).toBe(200); m.allowed = false; expect((await POST(request())).status).toBe(422); expect(m.simulate).toHaveBeenCalledTimes(1); });

it("a live fee-recipient change is not silently approved by Swap", async () => { m.feeRecipient = "0x9999999999999999999999999999999999999999"; const r = await POST(request()); expect(r.status).toBe(422); expect((await r.json()).reason).toBe("FEE_RECIPIENT_CHANGED"); });

it("router adapter-kind drift fails closed even with allowed tokens", async () => { m.routerMismatch = true; const r = await POST(request()); expect(r.status).toBe(422); expect((await r.json()).reason).toBe("EXECUTOR_PERMISSION_MISMATCH"); expect(m.simulate).not.toHaveBeenCalled(); });
it("slow price-impact reads cannot return an expired executable quote", async () => {
 vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-17T06:00:00Z"));
 try { m.impactExpires = true; const r = await POST(request()); expect(r.status).toBe(422); expect((await r.json()).code).toBe("QUOTE_EXPIRED"); } finally { vi.useRealTimers(); }
});
