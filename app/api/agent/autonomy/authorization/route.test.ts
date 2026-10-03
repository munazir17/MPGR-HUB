// Route tests for the delegated-authorization control plane (Phase 2).
// SIWE session, origin guard and rate limiter are mocked; the stores run for
// real against LuaRedis; signatures are GENUINE (signed in-test with a test
// key) so the server-side signature recovery is exercised end to end.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

import { LuaRedis } from "@/lib/__tests__/helpers/lua-redis";
import { RedisAutonomyStore } from "@/lib/autonomy/redis-store";
import { RedisDelegatedAuthorizationStore } from "@/lib/autonomy/delegated-redis-store";
import { delegatedPermitDigest, delegatedPolicyHash, delegatedActionId, DELEGATED_EXECUTOR_ADDRESS, DELEGATED_EXECUTOR_CHAIN_ID } from "@/lib/executor/delegated-executor";

const redis = new LuaRedis();
vi.mock("@/lib/api/redis", () => ({ getRedis: () => redis.client() }));

// -- SIWE session seam: `currentWallet` null == no/broken session (fail-closed)
let currentWallet: Address | null = null;
vi.mock("@/lib/autonomy/api-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/autonomy/api-helpers")>();
  return {
    ...actual,
    requireWallet: async () => (currentWallet ? { wallet: currentWallet, session: { sessionId: "a".repeat(32), wallet: currentWallet, issuedAt: 1, expiresAt: 2 } } : null),
    system: () => systemUnderTest,
  };
});
vi.mock("@/lib/api/request-guard", () => ({
  verifyTrustedOrigin: () => null,
  readJsonBody: async (request: Request) => ({ ok: true as const, value: await request.json().catch(() => null) }),
  requestIdFromRequest: () => "req_test",
  withRequestId: (r: Response) => r,
}));
vi.mock("@/lib/trade/trade-rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  clientIpFromRequest: () => "127.0.0.1",
}));

import { DELETE, GET, POST } from "./route";
import type { AutonomySystem } from "@/lib/autonomy/index";

const USER_KEY = "0x" + "ac".repeat(32);
const USER: Address = privateKeyToAccount(USER_KEY as `0x${string}`).address;
const OTHER_KEY = "0x" + "bd".repeat(32);
const OTHER: Address = privateKeyToAccount(OTHER_KEY as `0x${string}`).address;
const userAccount: PrivateKeyAccount = privateKeyToAccount(USER_KEY as `0x${string}`);
const SELL = "0xcccccccccccccccccccccccccccccccccccccc03" as Address;
const BUY = "0xdddddddddddddddddddddddddddddddddddddd04" as Address;

const systemUnderTest: AutonomySystem = {
  store: new RedisAutonomyStore(),
  slots: new RedisDelegatedAuthorizationStore(),
  gateway: {} as AutonomySystem["gateway"],
  runtime: {} as AutonomySystem["runtime"],
  scheduler: {} as AutonomySystem["scheduler"],
};

const POLICY_ID = "pol_del_test_1";
const GOAL_ID = "goal_del_test_1";

async function seedPolicyAndGoal(wallet: Address = USER, policyId = POLICY_ID, goalId = GOAL_ID) {
  await systemUnderTest.store.createPolicy({
    id: policyId,
    wallet,
    chainId: DELEGATED_EXECUTOR_CHAIN_ID,
    actions: ["swap"],
    sellToken: SELL,
    buyToken: BUY,
    maxPerTradeRaw: "1000000000",
    maxDailyRaw: "10000000000",
    maxSlippageBps: 100,
    maxActionsPerDay: 5,
    enabled: true,
    createdAt: "2026-01-01T00:00:00Z",
    expiresAt: "2099-12-31T00:00:00Z",
    authorizedAt: "2026-01-01T00:00:00Z",
    authorizationRef: "sess:test",
  });
  await systemUnderTest.store.createGoal({
    id: goalId,
    wallet,
    policyId,
    type: "conditional_swap",
    description: "test goal",
    status: "ACTIVE",
    condition: { kind: "price_below", threshold: "2" },
    trade: { sellToken: SELL, buyToken: BUY, sellAmountRaw: "1000000000", slippageBps: 100, sellDecimals: 6, buyDecimals: 18 },
    cooldownSeconds: 60,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    expiresAt: "2099-01-01T00:00:00Z",
    nextEvaluationAt: "2026-01-01T00:00:00Z",
    lastAction: null,
    lastResult: null,
    stats: { evaluations: 0, triggered: 0, verified: 0, consecutiveFailures: 0 },
  });
}

function policyHashForFixture(policyId = POLICY_ID, wallet: Address = USER): Hex {
  return delegatedPolicyHash({ id: policyId, wallet, chainId: 84532, sellToken: SELL, buyToken: BUY, maxPerTradeRaw: "1000000000", maxSlippageBps: 100, expiresAt: "2099-12-31T00:00:00Z" });
}

function signedSlot(opts: { owner?: Address; signer?: PrivateKeyAccount; deadline?: number; nonce?: string; slotIndex?: number; minAmountOut?: string; policyHash?: Hex; actionId?: Hex; amount?: string; policyId?: string; goalId?: string } = {}) {
  const account = opts.signer ?? userAccount;
  const owner = (opts.owner ?? USER).toLowerCase() as Address;
  const goalId = opts.goalId ?? GOAL_ID;
  const deadline = opts.deadline ?? Math.floor(Date.now() / 1000) + 3600;
  const permit = {
    token: SELL,
    amount: opts.amount ?? "1000000000",
    nonce: opts.nonce ?? "12345",
    deadline,
  };
  const witness = {
    owner,
    buyToken: BUY,
    minAmountOut: opts.minAmountOut ?? "900000000",
    deadline,
    actionId: (opts.actionId ?? delegatedActionId(goalId)) as Hex,
    policyHash: (opts.policyHash ?? policyHashForFixture(opts.policyId ?? POLICY_ID, owner)) as Hex,
  };
  // Sign the EXACT digest the deployed MPGRExecutorDelegated verifies
  // (Permit2 hashWithWitness packing). Raw-digest signing is what a
  // browser wallet cannot do for THIS deployment's witness string — see the
  // Phase-2 report — but the cryptographic path under test is identical.
  const digest = delegatedPermitDigest({ permit, witness }, DELEGATED_EXECUTOR_CHAIN_ID, DELEGATED_EXECUTOR_ADDRESS);
  return { slotIndex: opts.slotIndex ?? 0, policyId: opts.policyId ?? POLICY_ID, goalId, permit, witness, signaturePromise: account.sign({ hash: digest }) };
}

async function postSlots(items: ReturnType<typeof signedSlot>[]) {
  const slots = [];
  for (const item of items) slots.push({ slotIndex: item.slotIndex, permit: item.permit, witness: item.witness, signature: await item.signaturePromise });
  return POST(
    new Request("http://localhost/api/agent/autonomy/authorization", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policyId: items[0].policyId, goalId: items[0].goalId, slots }),
    }),
  );
}

function get(params = "") {
  return GET(new Request(`http://localhost/api/agent/autonomy/authorization${params}`, { method: "GET" }));
}

function del(id: string) {
  return DELETE(new Request(`http://localhost/api/agent/autonomy/authorization?id=${encodeURIComponent(id)}`, { method: "DELETE" }));
}

const envSnapshot = { ...process.env };
beforeEach(() => {
  process.env = { ...envSnapshot };
  process.env.MPGR_AUTONOMOUS_AGENT_ENABLED = "true";
  process.env.MPGR_AUTONOMOUS_EMERGENCY_DISABLE = "false";
  delete process.env.MPGR_AUTONOMOUS_EXECUTION_ADAPTER;
  redis.reset();
  currentWallet = USER;
  return seedPolicyAndGoal();
});

// ---- SIWE session failure -------------------------------------------------
describe("SIWE session enforcement", () => {
  it("401 on every verb without a session", async () => {
    currentWallet = null;
    expect((await get()).status).toBe(401);
    expect((await postSlots([signedSlot()])).status).toBe(401);
    expect((await del("slot-x")).status).toBe(401);
  });
});

// ---- create / ownership / signature recovery ------------------------------
describe("create authorization", () => {
  it("registers valid slots bound to the AUTHENTICATED wallet; never returns signature bytes", async () => {
    const res = await postSlots([signedSlot()]);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { slots: Array<Record<string, unknown>> };
    expect(body.slots).toHaveLength(1);
    expect(body.slots[0].wallet).toBe(USER.toLowerCase());
    expect("signature" in body.slots[0]).toBe(false);
    // stored record carries the signature (needed to broadcast) but stays server-side
    const stored = await systemUnderTest.slots.getSlot(body.slots[0].id as string, USER.toLowerCase());
    expect(stored?.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
  });

  it("rejects a slot whose owner is NOT the authenticated wallet (client values are never trusted)", async () => {
    const res = await postSlots([signedSlot({ owner: OTHER })]); // signed by USER, owner claims OTHER
    expect(res.status).toBe(400);
  });

  it("rejects a slot signed by a DIFFERENT key than the session wallet", async () => {
    const res = await postSlots([signedSlot({ signer: privateKeyToAccount(OTHER_KEY as `0x${string}`) })]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("SIGNATURE_INVALID");
  });

  it("400 on expired deadline, malformed body, and unknown policy", async () => {
    const expired = await postSlots([signedSlot({ deadline: Math.floor(Date.now() / 1000) - 10 })]);
    expect(expired.status).toBe(400);
    const malformed = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ policyId: POLICY_ID }), headers: { "Content-Type": "application/json" } }));
    expect(malformed.status).toBe(400);
    currentWallet = OTHER; // someone else's policy reads as not-found
    const foreign = await postSlots([signedSlot()]);
    expect(foreign.status).toBe(404);
  });
});

// ---- cross-wallet access ---------------------------------------------------
describe("cross-wallet access rejection", () => {
  it("another wallet cannot list, inspect, revoke, or extend someone's slots", async () => {
    const created = await postSlots([signedSlot()]);
    const { slots } = (await created.json()) as { slots: Array<{ id: string }> };
    const slotId = slots[0].id;

    currentWallet = OTHER;
    const listed = (await get()) as Response;
    expect(((await listed.json()) as { slots: unknown[] }).slots).toHaveLength(0);
    expect((await get(`?id=${slotId}`)).status).toBe(404);
    expect((await del(slotId)).status).toBe(404);
    await seedPolicyAndGoal(OTHER, "pol_other_1", "goal_other_1");
    const foreignCreate = await postSlots([signedSlot({ policyId: POLICY_ID, signer: privateKeyToAccount(OTHER_KEY as `0x${string}`) })]);
    expect(foreignCreate.status).toBe(404); // USER's policy is invisible to OTHER
  });
});

// ---- revoke ----------------------------------------------------------------
describe("revoke authorization", () => {
  it("revokes own slot; double revoke is 404", async () => {
    const created = await postSlots([signedSlot()]);
    const { slots } = (await created.json()) as { slots: Array<{ id: string }> };
    expect((await del(slots[0].id)).status).toBe(200);
    expect((await del(slots[0].id)).status).toBe(404);
    const view = (await (await get(`?id=${slots[0].id}`)).json()) as { slot: { status: string } };
    expect(view.slot.status).toBe("revoked");
  });
});

// ---- nonce reuse / slot limit ---------------------------------------------
describe("nonce + slot limits", () => {
  it("nonce reuse across requests is refused with 409", async () => {
    const first = await postSlots([signedSlot({ nonce: "424242" })]);
    expect(first.status).toBe(201);
    const second = await postSlots([signedSlot({ nonce: "424242", slotIndex: 1 })]);
    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe("NONCE_REUSED");
  });

  it("max 5 active slots per policy; the 6th is refused", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await postSlots([signedSlot({ slotIndex: i, nonce: `${9000 + i}` })]);
      expect(res.status, `slot ${i}`).toBe(201);
    }
    const sixth = await postSlots([signedSlot({ slotIndex: 5, nonce: "9100" })]);
    expect(sixth.status).toBe(400);
    expect(((await sixth.json()) as { code: string }).code).toBe("SLOT_LIMIT_REACHED");
  });
});

// ---- flag / emergency / failures -------------------------------------------
describe("feature flag + emergency stop + failures", () => {
  it("flag OFF -> every verb 404 (routes disappear)", async () => {
    process.env.MPGR_AUTONOMOUS_AGENT_ENABLED = "false";
    expect((await get()).status).toBe(404);
    expect((await postSlots([signedSlot()])).status).toBe(404);
    expect((await del("slot-x")).status).toBe(404);
  });

  it("emergency stop -> POST 503, but revocation STAYS available (safety control)", async () => {
    process.env.MPGR_AUTONOMOUS_EMERGENCY_DISABLE = "true";
    expect((await postSlots([signedSlot()])).status).toBe(503);
    // a slot created BEFORE the emergency can still be revoked
    process.env.MPGR_AUTONOMOUS_EMERGENCY_DISABLE = "false";
    const ok = await postSlots([signedSlot()]);
    expect(ok.status).toBe(201);
    const { slots } = (await ok.json()) as { slots: Array<{ id: string }> };
    process.env.MPGR_AUTONOMOUS_EMERGENCY_DISABLE = "true";
    expect((await del(slots[0].id)).status).toBe(200);
  });

  it("store failure -> 503 (authorization API failure is never a silent success)", async () => {
    const failing = { ...systemUnderTest, slots: { ...systemUnderTest.slots, saveSlots: async () => { throw new Error("redis down"); } } } as AutonomySystem;
    const helpers = await import("@/lib/autonomy/api-helpers");
    const spy = vi.spyOn(helpers, "system").mockImplementation(() => failing);
    try {
      const res = await postSlots([signedSlot({ nonce: "777001" })]);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { code: string }).code).toBe("AUTONOMY_UNAVAILABLE");
    } finally {
      spy.mockRestore();
    }
  });
});
