// HTTP boundary for V2 settlement verification.
//
// The client supplies ONLY a hash. The server re-fetches the transaction and
// receipt, reads live fee posture at the MINED block, re-derives the intent from
// the mined calldata, and only then compares the receipt's own events. These
// tests prove that attribution is strict and that nothing is verified on doubt.
//
// Offline: fabricated client, real calldata from the real encoder.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex, Log } from "viem";

const mocks = vi.hoisted(() => ({
  signedIn: true,
  session: { wallet: "0x7a250d5630b4cf539739df2c5dacb4c659f2488d" },
  client: { getChainId: vi.fn(), getTransaction: vi.fn(), getTransactionReceipt: vi.fn(), getCode: vi.fn(), readContract: vi.fn() },
}));
vi.mock("@/lib/auth/session-store", () => ({ authenticateRequest: async () => (mocks.signedIn ? mocks.session : null) }));
vi.mock("@/lib/api/request-guard", () => ({ verifyTrustedOrigin: () => null, readJsonBody: async (r: Request) => ({ ok: true, value: await r.json() }) }));
vi.mock("@/lib/trade/trade-rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }), clientIpFromRequest: () => "test" }));
vi.mock("@/lib/trade/trade-public-client", () => ({ getTradePublicClient: () => mocks.client }));

import { POST } from "./route";
import { __setSwapV2ExecutorForTests, SWAP_V2_SEALED_MANIFEST } from "@/lib/swap/v2/deployment";
import { V2_FEE_RECIPIENT } from "@/lib/swap/v2/discovery";
import { activatedResponse, swapExecutedLog, BLOCK } from "@/lib/swap/v2/__tests__/activation-fixtures";
import { TAKER, TOKEN_A, TOKEN_B, UNI_V3_ROUTER } from "@/lib/swap/v2/__tests__/helpers";

const EXECUTOR = SWAP_V2_SEALED_MANIFEST.executor;
const HASH = `0x${"aa".repeat(32)}` as Hex;
const VENUES: Record<string, { kind: number; factory: string }> = Object.fromEntries(
  SWAP_V2_SEALED_MANIFEST.venues.map((v) => [v.router.toLowerCase(), { kind: v.kind, factory: v.factory.toLowerCase() }]),
);

/** The mined transaction + receipt pair for a real encoded V2 swap. */
function minedFixture(overrides: { status?: "success" | "reverted"; from?: Address; to?: Address; eventOverrides?: Record<string, unknown> } = {}) {
  const response = activatedResponse();
  const tx = response.transaction as { to: string; data: string; value: string };
  const intentId = response.intentId as Hex;
  const log = swapExecutedLog({
    taker: overrides.from ?? TAKER, router: UNI_V3_ROUTER, intentId,
    tokenIn: TOKEN_A, tokenOut: TOKEN_B,
    grossAmountIn: 1_000_000n, feeAmount: 2_500n, swapAmountIn: 997_500n, amountOut: 1_000n,
    feeRecipient: V2_FEE_RECIPIENT, feeBps: 25, routerKind: 2, flags: 0,
    ...(overrides.eventOverrides ?? {}),
  });
  return {
    intentId,
    transaction: { hash: HASH, from: overrides.from ?? TAKER, to: (overrides.to ?? EXECUTOR) as Address, value: BigInt(tx.value), input: tx.data as Hex },
    receipt: {
      transactionHash: HASH, status: overrides.status ?? "success", blockNumber: BLOCK.number, blockHash: BLOCK.hash,
      from: overrides.from ?? TAKER, to: (overrides.to ?? EXECUTOR) as Address,
      logs: [log] as unknown as readonly Log[],
    },
  };
}

function wire(fixture: ReturnType<typeof minedFixture>, options: { chainId?: number; paused?: boolean; feeBps?: number } = {}) {
  const o = { chainId: 8453, paused: false, feeBps: 25, ...options };
  mocks.client.getChainId.mockResolvedValue(o.chainId);
  mocks.client.getTransaction.mockResolvedValue(fixture.transaction);
  mocks.client.getTransactionReceipt.mockResolvedValue(fixture.receipt);
  mocks.client.getCode.mockResolvedValue("0x60806040");
  mocks.client.readContract.mockImplementation(async (args: { functionName: string; args?: readonly unknown[] }) => {
    const router = (args.args?.[0] as string | undefined)?.toLowerCase();
    switch (args.functionName) {
      case "feeBps": return o.feeBps;
      case "MAX_FEE_BPS": return 100;
      case "feeRecipient": case "PINNED_FEE_RECIPIENT": return V2_FEE_RECIPIENT;
      case "owner": case "GOVERNANCE_SAFE": return SWAP_V2_SEALED_MANIFEST.owner;
      case "paused": return o.paused;
      case "pendingFeeBps": return 0;
      case "pendingFeeRecipient": return "0x0000000000000000000000000000000000000000";
      case "pendingEffectiveAt": return 0n;
      case "FEE_TIMELOCK_SECONDS": return 172_800n;
      case "V4_POOL_MANAGER": return SWAP_V2_SEALED_MANIFEST.venues.find((v) => v.kind === 7)!.router;
      case "routerKind": return VENUES[router ?? ""]?.kind ?? 0;
      case "routerFactory": return VENUES[router ?? ""]?.factory ?? "0x0000000000000000000000000000000000000000";
      default: throw new Error(`unexpected read: ${args.functionName}`);
    }
  });
}

const request = (transactionHash: unknown = HASH) => new Request("https://mpgr.test/api/swap/v2/settlement", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transactionHash }),
});

beforeEach(() => { vi.clearAllMocks(); mocks.signedIn = true; mocks.session.wallet = TAKER; });
afterEach(() => __setSwapV2ExecutorForTests(null));

describe("V2 settlement route — dormant gate", () => {
  it("verifies nothing while routing is not activated", async () => {
    // Dormancy is injected explicitly rather than inherited from the gate constant, so
    // this remains the test for the shape a one-line rollback restores.
    __setSwapV2ExecutorForTests(null);
    const r = await POST(request());
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.code).toBe("V2_NOT_ACTIVATED");
    expect(body.verified).toBe(false);
    // No chain access at all: nothing exists to verify.
    expect(mocks.client.getTransaction).not.toHaveBeenCalled();
  });
});

describe("V2 settlement route — activated gate", () => {
  beforeEach(() => __setSwapV2ExecutorForTests(SWAP_V2_SEALED_MANIFEST));

  it("verifies a settled swap and reports the actual amounts and fee", async () => {
    const fixture = minedFixture();
    wire(fixture);
    const r = await POST(request());
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.verified).toBe(true);
    expect(body.code).toBe("SETTLED");
    expect(body.intentId).toBe(fixture.intentId);
    expect(body.entry).toBe("swapExactInput");
    expect(body.amountIn).toBe("1000000");
    expect(body.amountOut).toBe("1000");
    expect(body.feeAmount).toBe("2500");
    expect(body.feeBps).toBe(25);
    expect(body.feeRecipient.toLowerCase()).toBe(V2_FEE_RECIPIENT.toLowerCase());
    expect(body.note).toMatch(/not a settlement proof|Verified from the mined receipt/i);
  });

  it("refuses to verify someone else's transaction", async () => {
    const fixture = minedFixture({ from: TOKEN_A }); // sent by another wallet
    wire(fixture);
    const r = await POST(request());
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe("NOT_YOUR_TRANSACTION");
  });

  it("refuses a transaction that did not target the V2 executor", async () => {
    const fixture = minedFixture({ to: TOKEN_B });
    wire(fixture);
    const r = await POST(request());
    expect(r.status).toBe(422);
    expect((await r.json()).code).toBe("NOT_V2_EXECUTOR");
  });

  it("reports a reverted swap as reverted, never as verified", async () => {
    const fixture = minedFixture({ status: "reverted" });
    wire(fixture);
    const r = await POST(request());
    expect(r.status).toBe(422);
    const body = await r.json();
    expect(body.code).toBe("TRANSACTION_REVERTED");
    expect(body.verified).toBe(false);
  });

  it("rejects a receipt whose output fell below the committed minimum", async () => {
    const fixture = minedFixture({ eventOverrides: { amountOut: 989n } });
    wire(fixture);
    const r = await POST(request());
    expect(r.status).toBe(422);
    const body = await r.json();
    expect(body.code).toBe("SETTLEMENT_UNVERIFIED");
    expect(body.verified).toBe(false);
    expect(body.error).toMatch(/minimum/i);
  });

  it("rejects a receipt whose fee was redirected or skipped", async () => {
    const redirected = minedFixture({ eventOverrides: { feeRecipient: TOKEN_A } });
    wire(redirected);
    expect((await POST(request())).status).toBe(422);

    vi.clearAllMocks();
    __setSwapV2ExecutorForTests(SWAP_V2_SEALED_MANIFEST);
    const skipped = minedFixture({ eventOverrides: { feeAmount: 0n, swapAmountIn: 1_000_000n } });
    wire(skipped);
    const r = await POST(request());
    expect(r.status).toBe(422);
    expect((await r.json()).error).toMatch(/fee/i);
  });

  it("fails closed when the executor was paused or its fee drifted", async () => {
    const fixture = minedFixture();
    wire(fixture, { paused: true });
    const paused = await POST(request());
    expect(paused.status).toBe(503);
    expect((await paused.json()).code).toBe("EXECUTOR_PAUSED");

    vi.clearAllMocks();
    __setSwapV2ExecutorForTests(SWAP_V2_SEALED_MANIFEST);
    wire(fixture, { feeBps: 30 });
    const drifted = await POST(request());
    expect(drifted.status).toBe(422);
    expect((await drifted.json()).code).toBe("FEE_POLICY_INVALID");
  });

  it("reports an RPC outage as retryable rather than as a failed swap", async () => {
    const fixture = minedFixture();
    wire(fixture);
    mocks.client.getTransaction.mockRejectedValue(new Error("429 over rate limit"));
    const r = await POST(request());
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body.code).toBe("PROVIDER_ERROR");
    expect(body.verified).toBe(false);
    expect(body.error).toMatch(/do not resubmit/i);
  });

  it("rejects a malformed hash before touching the chain", async () => {
    const fixture = minedFixture();
    wire(fixture);
    expect((await POST(request("0x1234"))).status).toBe(400);
    // null, not undefined: an explicit undefined would hit the helper's default.
    expect((await POST(request(null))).status).toBe(400);
    expect((await POST(request(`${HASH}ff`))).status).toBe(400);
    // One hex character short. (Uppercase hex IS accepted: the route's pattern is
    // case-insensitive, and a real hash may arrive in either case.)
    expect((await POST(request("0x" + "aa".repeat(31) + "a"))).status).toBe(400);
    expect((await POST(request("not-a-hash"))).status).toBe(400);
    expect(mocks.client.getTransaction).not.toHaveBeenCalled();
  });

  it("requires an authenticated wallet", async () => {
    mocks.signedIn = false;
    const r = await POST(request());
    expect(r.status).toBe(401);
    expect((await r.json()).code).toBe("AUTH_REQUIRED");
    expect(mocks.client.getTransaction).not.toHaveBeenCalled();
  });
});
