// app/api/agent/autonomy/activation-route-audit.test.ts
//
// ACTIVATION-FLOW AUDIT (route level).
//
// Question under audit: "Authorize & activate goal" flipped a goal to ACTIVE
// with NO on-chain approval popup. Is that intentional and safe?
//
// This suite drives the REAL production route handlers (policy POST -> goals
// POST, exactly the two calls hooks/useAgentAutonomy.ts#authorizeGoal makes)
// against the REAL RedisAutonomyStore, and proves:
//
//   A1. Activation is TWO off-chain writes and nothing else: one policy row,
//       one goal row, two audit events. No transaction hash, no signature
//       bytes, no approval, no broadcast — the goal is ACTIVE with
//       triggered/verified == 0 and pendingTxHash == null.
//   A2. The SIWE session is the ONLY credential consumed. The policy records
//       a non-secret session digest (`authorizationRef`) as provenance; it is
//       not, and cannot be mistaken for, an ERC-20/Permit2 token approval.
//   A3. `authorized: true` is an explicit opt-in — omitting it is a 400.
//   A4. THE MISSING CAPABILITY: the policy route can only ever mint a Base
//       MAINNET (8453) policy over MAINNET tokens, while the delegated
//       execution control plane is Base Sepolia (84532) only. So even a
//       genuinely user-signed Permit2 witness slot is refused for a
//       UI-activated goal (POLICY_CHAIN_MISMATCH) — delegated capability
//       cannot be attached to it, and `GET /authorization` stays empty.
//
// Nothing here sends a transaction or touches a network.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

import { LuaRedis } from "@/lib/__tests__/helpers/lua-redis";
import { RedisAutonomyStore } from "@/lib/autonomy/redis-store";
import { RedisDelegatedAuthorizationStore } from "@/lib/autonomy/delegated-redis-store";
import { policyHashFor } from "@/lib/autonomy/delegated-authorization";
import {
  DELEGATED_EXECUTOR_ADDRESS,
  DELEGATED_EXECUTOR_CHAIN_ID,
  delegatedActionId,
  delegatedPermitDigest,
} from "@/lib/executor/delegated-executor";
import { AUTONOMY_CHAIN_ID, type AutonomyPolicy } from "@/lib/autonomy/types";

const redis = new LuaRedis();
vi.mock("@/lib/api/redis", () => ({ getRedis: () => redis.client() }));

// -- the ONLY module in the activation path that could ever broadcast -------
// Spied so the audit can assert it is never even constructed during
// "Authorize & activate goal" (it is the operator gas-payer seam used by the
// delegated adapter, which activation does not touch).
const broadcasterSeam = { createCalls: 0, broadcastCalls: [] as unknown[] };
vi.mock("@/lib/delegated/delegated-broadcaster", () => ({
  delegatedBroadcasterAddress: () => null,
  delegatedChainView: () => {
    throw new Error("audit: no chain view may be created during activation");
  },
  createDelegatedBroadcaster: () => {
    broadcasterSeam.createCalls += 1;
    return {
      address: null,
      broadcast: async (tx: unknown) => {
        broadcasterSeam.broadcastCalls.push(tx);
        throw new Error("audit: activation must never broadcast");
      },
    };
  },
}));

// -- SIWE session seam (same convention as the sibling route suites) --------
let currentWallet: Address | null = null;
vi.mock("@/lib/autonomy/api-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/autonomy/api-helpers")>();
  return {
    ...actual,
    requireWallet: async () =>
      currentWallet
        ? { wallet: currentWallet, session: { sessionId: "a".repeat(32), wallet: currentWallet, issuedAt: 1, expiresAt: 2 } }
        : null,
    system: () => systemUnderTest,
  };
});
vi.mock("@/lib/api/request-guard", () => ({
  verifyTrustedOrigin: () => null,
  readJsonBody: async (request: Request) => ({ ok: true as const, value: await request.json().catch(() => null) }),
  requestIdFromRequest: () => "req_audit",
  withRequestId: (r: Response) => r,
}));
vi.mock("@/lib/trade/trade-rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  clientIpFromRequest: () => "127.0.0.1",
}));

import { POST as POLICY_POST } from "./policy/route";
import { POST as GOALS_POST, GET as GOALS_GET } from "./goals/route";
import { POST as AUTHORIZATION_POST, GET as AUTHORIZATION_GET } from "./authorization/route";
import { GET as TOKENS_GET } from "./tokens/route";
import type { AutonomySystem } from "@/lib/autonomy/index";

const USER_KEY = "0x" + "ac".repeat(32);
const USER: Address = privateKeyToAccount(USER_KEY as `0x${string}`).address;
const userAccount: PrivateKeyAccount = privateKeyToAccount(USER_KEY as `0x${string}`);

const systemUnderTest: AutonomySystem = {
  store: new RedisAutonomyStore(),
  slots: new RedisDelegatedAuthorizationStore(),
  gateway: {} as AutonomySystem["gateway"],
  runtime: {} as AutonomySystem["runtime"],
  scheduler: {} as AutonomySystem["scheduler"],
};

function post(url: string, body: unknown) {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The exact request pair hooks/useAgentAutonomy.ts#authorizeGoal issues. */
async function activateGoal(pair: { sell: string; buy: string }, draft: Record<string, unknown> = {}) {
  const policyRes = await POLICY_POST(
    post("/api/agent/autonomy/policy", {
      authorized: true,
      sellToken: pair.sell,
      buyToken: pair.buy,
      maxPerTrade: "50",
      maxDaily: "100",
      maxSlippageBps: 100,
      maxActionsPerDay: 10,
      ttlDays: 30,
      ...draft,
    }),
  );
  const policyBody = (await policyRes.json()) as { policy?: { id: string } };
  if (!policyRes.ok || !policyBody.policy) {
    return { policyRes, policyBody, goalRes: null as Response | null, goalBody: null as unknown, raw: JSON.stringify(policyBody) };
  }
  const goalRes = await GOALS_POST(
    post("/api/agent/autonomy/goals", {
      policyId: policyBody.policy.id,
      condition: { kind: "price_below", threshold: "200" },
      sellAmount: "50",
      cooldownSeconds: 3600,
      maxTrades: 10,
      description: "Audit activation",
    }),
  );
  const goalRaw = await goalRes.text();
  const goalBody = JSON.parse(goalRaw || "null");
  return { policyRes, policyBody, goalRes, goalBody, raw: JSON.stringify(policyBody) + goalRaw };
}

async function allowlistedPair(): Promise<{ sell: string; buy: string }> {
  const tokens = (await (await TOKENS_GET()).json()) as { chainId: number; pairs: Array<{ sell: string; buy: string }> };
  expect(tokens.chainId).toBe(8453); // the UI picker is mainnet-only
  expect(tokens.pairs.length).toBeGreaterThan(0);
  return tokens.pairs[0];
}

beforeEach(async () => {
  vi.stubEnv("MPGR_AUTONOMOUS_AGENT_ENABLED", "true");
  vi.stubEnv("MPGR_AUTONOMOUS_EMERGENCY_DISABLE", "false");
  vi.stubEnv("MPGR_AUTONOMOUS_EXECUTION_ADAPTER", "");
  await redis.reset();
  broadcasterSeam.createCalls = 0;
  broadcasterSeam.broadcastCalls = [];
  currentWallet = USER;
});

describe("A1 — activation is two off-chain writes and nothing else", () => {
  it("creates the policy + goal with NO transaction, NO approval, NO broadcast", async () => {
    const pair = await allowlistedPair();
    const { policyRes, goalRes, goalBody, raw } = await activateGoal(pair);

    expect(policyRes.status).toBe(201);
    expect(goalRes?.status).toBe(201);

    const goal = (goalBody as { goal: Record<string, unknown> }).goal;
    // The UI's exact reported state: ACTIVE, 0 triggered, 0 verified, no tx.
    expect(goal.status).toBe("ACTIVE");
    expect(goal.stats).toEqual({ evaluations: 0, triggered: 0, verified: 0, consecutiveFailures: 0 });
    expect(goal.pendingTxHash).toBeNull();
    expect(goal.lastAction).toBeNull();
    expect(goal.lastResult).toBeNull();

    // No broadcast seam was even constructed, let alone called.
    expect(broadcasterSeam.createCalls).toBe(0);
    expect(broadcasterSeam.broadcastCalls).toHaveLength(0);

    // Neither response carries a tx hash or signature-shaped bytes.
    const dump = raw + JSON.stringify(goalBody);
    expect(dump).not.toMatch(/0x[a-fA-F0-9]{64}/); // no 32-byte tx hash
    expect(dump).not.toMatch(/0x[a-fA-F0-9]{130}/); // no 65-byte signature
    expect(dump).not.toMatch(/approval|allowance|permit2|approve/i);

    // The store holds exactly one policy + one goal for this wallet.
    const policies = await systemUnderTest.store.listPolicies(USER.toLowerCase());
    const goals = await systemUnderTest.store.listGoals(USER.toLowerCase());
    expect(policies).toHaveLength(1);
    expect(goals).toHaveLength(1);
    // No delegated authorization slot exists — nothing can be broadcast.
    expect(await systemUnderTest.slots.listSlots(USER.toLowerCase())).toHaveLength(0);
  });

  it("the goal list endpoint reports the same inert state (no execution artifacts)", async () => {
    const pair = await allowlistedPair();
    await activateGoal(pair);
    const listed = (await (await GOALS_GET(new Request("http://localhost/api/agent/autonomy/goals"))).json()) as {
      goals: Array<{ status: string; pendingTxHash: string | null; stats: Record<string, number>; recentActions: unknown[] }>;
    };
    expect(listed.goals).toHaveLength(1);
    expect(listed.goals[0].status).toBe("ACTIVE");
    expect(listed.goals[0].pendingTxHash).toBeNull();
    expect(listed.goals[0].stats.triggered).toBe(0);
    expect(listed.goals[0].stats.verified).toBe(0);
    expect(listed.goals[0].recentActions).toHaveLength(0); // no execution history at all
  });
});

describe("A2 — SIWE is the credential; it is not a token approval", () => {
  it("records only a non-secret session digest as authorization provenance", async () => {
    const pair = await allowlistedPair();
    await activateGoal(pair);
    const [policy] = await systemUnderTest.store.listPolicies(USER.toLowerCase());
    // Shape: `${sessionId}:${sha256(sessionId:wallet)[:16]}` — provenance only.
    expect(policy.authorizationRef).toMatch(/^a{32}:[0-9a-f]{16}$/);
    expect(policy.authorizationRef).not.toContain(USER_KEY);
    // The PUBLIC projection never echoes it (no credential leaks to the client).
    const goalBody = await activateGoal(pair);
    expect(JSON.stringify(goalBody.policyBody)).not.toContain(policy.authorizationRef);
    // And it is not an on-chain allowance: no spender, no amount, no nonce.
    expect(policy).not.toHaveProperty("spender");
    expect(policy).not.toHaveProperty("nonce");
    expect(policy).not.toHaveProperty("signature");
  });

  it("fails closed without a session on both activation calls (401, nothing written)", async () => {
    currentWallet = null;
    const pair = await allowlistedPair().catch(() => ({ sell: "", buy: "" }));
    const policyRes = await POLICY_POST(post("/api/agent/autonomy/policy", { authorized: true, sellToken: pair.sell, buyToken: pair.buy }));
    expect(policyRes.status).toBe(401);
    const goalRes = await GOALS_POST(post("/api/agent/autonomy/goals", { policyId: "pol_x", condition: { kind: "price_below", threshold: "1" }, sellAmount: "1" }));
    expect(goalRes.status).toBe(401);
    expect(await systemUnderTest.store.listPolicies(USER.toLowerCase())).toHaveLength(0);
  });

  it("binds the policy to the SESSION wallet, ignoring a client-supplied wallet field", async () => {
    const pair = await allowlistedPair();
    const other = "0x" + "11".repeat(20);
    const { policyRes } = await activateGoal(pair, { wallet: other });
    expect(policyRes.status).toBe(201);
    expect(await systemUnderTest.store.listPolicies(USER.toLowerCase())).toHaveLength(1);
    expect(await systemUnderTest.store.listPolicies(other.toLowerCase())).toHaveLength(0);
  });
});

describe("A3 — authorization is explicit, never implied", () => {
  it("400 AUTHORIZATION_NOT_GRANTED when `authorized: true` is absent", async () => {
    const pair = await allowlistedPair();
    const res = await POLICY_POST(
      post("/api/agent/autonomy/policy", {
        sellToken: pair.sell,
        buyToken: pair.buy,
        maxPerTrade: "50",
        maxDaily: "100",
        maxSlippageBps: 100,
        maxActionsPerDay: 10,
        ttlDays: 30,
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("AUTHORIZATION_NOT_GRANTED");
    expect(await systemUnderTest.store.listPolicies(USER.toLowerCase())).toHaveLength(0);
  });

  it("a goal cannot be created without an authorized policy (no policy -> no ACTIVE goal)", async () => {
    const res = await GOALS_POST(
      post("/api/agent/autonomy/goals", { condition: { kind: "price_below", threshold: "200" }, sellAmount: "50" }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("POLICY_REQUIRED");
  });
});

describe("A4 — the missing capability: delegated execution cannot attach to a UI-activated goal", () => {
  it("the policy route always mints a Base MAINNET (8453) policy over mainnet tokens", async () => {
    const pair = await allowlistedPair();
    const { policyRes } = await activateGoal(pair);
    expect(policyRes.status).toBe(201);
    const [policy] = await systemUnderTest.store.listPolicies(USER.toLowerCase());
    expect(policy.chainId).toBe(8453);
    expect(policy.chainId).not.toBe(DELEGATED_EXECUTOR_CHAIN_ID);
    // Token resolution is mainnet-allowlist only, so the pair can never be a
    // delegated (Base Sepolia) pair.
    expect(policy.sellToken.toLowerCase()).toBe(pair.sell.toLowerCase());
    expect(policy.buyToken.toLowerCase()).toBe(pair.buy.toLowerCase());
  });

  /**
   * A4 — UPDATED BY THE MC-1 REMEDIATION (this test previously PINNED THE GAP).
   *
   * The audit found a genuinely user-signed witness slot for a UI-activated
   * (8453) goal was refused `POLICY_CHAIN_MISMATCH`, because no 84532 policy
   * could ever be minted and the authorization route only accepted 84532. That
   * was the missing capability, not a safety property.
   *
   * It is now fixed, so this test asserts BOTH halves of the new contract:
   *   (a) DEFAULT (no mainnet executor pinned): still refused — but with the
   *       honest reason DELEGATED_EXECUTOR_NOT_CONFIGURED, because the user
   *       must never sign an authorization for a contract that does not exist.
   *       Fail-closed, nothing stored, nothing broadcast.
   *   (b) PINNED (operator set MPGR_MAINNET_DELEGATED_EXECUTOR): the same
   *       genuinely user-signed 8453 slot IS accepted and stored. The chain
   *       mismatch is gone; every other check (owner binding, actionId,
   *       policyHash, deadline, signature recovery against the 8453 domain with
   *       the 8453 executor as spender) still applies.
   */
  async function signedMainnetSlot(policy: AutonomyPolicy, goalId: string, executor: Address) {
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const permit = { token: policy.sellToken, amount: "50000000", nonce: "987654321", deadline };
    const witness = {
      owner: USER.toLowerCase() as Address,
      buyToken: policy.buyToken,
      minAmountOut: "1",
      deadline,
      actionId: delegatedActionId(goalId),
      policyHash: policyHashFor(policy),
    };
    // Digest over THIS chain's Permit2 domain with THIS chain's executor as
    // spender — so the recovered signer is bound to (wallet, chain, executor).
    const digest = delegatedPermitDigest({ permit, witness }, AUTONOMY_CHAIN_ID, executor);
    const signature: Hex = await userAccount.sign({ hash: digest });
    return { permit, witness, signature };
  }

  it("refuses the slot while no mainnet delegated executor is pinned (fail-closed)", async () => {
    vi.stubEnv("MPGR_MAINNET_DELEGATED_EXECUTOR", "");
    const pair = await allowlistedPair();
    const { policyBody, goalBody } = await activateGoal(pair);
    const policyId = policyBody.policy!.id;
    const goalId = (goalBody as { goal: { id: string } }).goal.id;
    const [policy] = await systemUnderTest.store.listPolicies(USER.toLowerCase());
    expect(policy.chainId).toBe(AUTONOMY_CHAIN_ID);

    const slot = await signedMainnetSlot(policy, goalId, DELEGATED_EXECUTOR_ADDRESS);
    const res = await AUTHORIZATION_POST(
      post("/api/agent/autonomy/authorization", { policyId, goalId, slots: [{ slotIndex: 0, ...slot }] }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("DELEGATED_EXECUTOR_NOT_CONFIGURED");
    expect(body.error).toMatch(/watch-only/i);
    // Nothing was stored and nothing was broadcast.
    expect(await systemUnderTest.slots.listSlots(USER.toLowerCase(), policyId)).toHaveLength(0);
    expect(broadcasterSeam.broadcastCalls).toHaveLength(0);
  });

  it("ACCEPTS the same genuinely user-signed slot once a mainnet executor is pinned (MC-1 fixed)", async () => {
    // A test address that is deliberately NOT the forbidden canary account.
    const MAINNET_EXECUTOR = "0x1111111111111111111111111111111111111111" as Address;
    vi.stubEnv("MPGR_MAINNET_DELEGATED_EXECUTOR", MAINNET_EXECUTOR);
    const pair = await allowlistedPair();
    const { policyBody, goalBody } = await activateGoal(pair);
    const policyId = policyBody.policy!.id;
    const goalId = (goalBody as { goal: { id: string } }).goal.id;
    const [policy] = await systemUnderTest.store.listPolicies(USER.toLowerCase());
    expect(policy.chainId).toBe(AUTONOMY_CHAIN_ID);

    const slot = await signedMainnetSlot(policy, goalId, MAINNET_EXECUTOR);
    const res = await AUTHORIZATION_POST(
      post("/api/agent/autonomy/authorization", { policyId, goalId, slots: [{ slotIndex: 0, ...slot }] }),
    );
    const raw = await res.text();
    expect(res.status, raw).toBe(201);
    const stored = await systemUnderTest.slots.listSlots(USER.toLowerCase(), policyId);
    expect(stored).toHaveLength(1);
    // The stored slot is CHAIN-BOUND to mainnet, not to Sepolia.
    expect(stored[0]!.chainId).toBe(AUTONOMY_CHAIN_ID);
    expect(stored[0]!.chainId).not.toBe(DELEGATED_EXECUTOR_CHAIN_ID);
    // Accepting an authorization is still an off-chain control-plane write:
    // storing a slot must never broadcast anything.
    expect(broadcasterSeam.broadcastCalls).toHaveLength(0);
  });

  it("refuses a slot signed for the WRONG chain's executor (cross-chain binding holds)", async () => {
    const MAINNET_EXECUTOR = "0x1111111111111111111111111111111111111111" as Address;
    vi.stubEnv("MPGR_MAINNET_DELEGATED_EXECUTOR", MAINNET_EXECUTOR);
    const pair = await allowlistedPair();
    const { policyBody, goalBody } = await activateGoal(pair);
    const policyId = policyBody.policy!.id;
    const goalId = (goalBody as { goal: { id: string } }).goal.id;
    const [policy] = await systemUnderTest.store.listPolicies(USER.toLowerCase());

    // Signed over the SEPOLIA domain/spender, presented to a MAINNET policy:
    // the signature cannot recover to the session wallet, so it is refused.
    const slot = await signedMainnetSlot(policy, goalId, DELEGATED_EXECUTOR_ADDRESS);
    const res = await AUTHORIZATION_POST(
      post("/api/agent/autonomy/authorization", { policyId, goalId, slots: [{ slotIndex: 0, ...slot }] }),
    );
    expect(res.status).toBe(400);
    expect(await systemUnderTest.slots.listSlots(USER.toLowerCase(), policyId)).toHaveLength(0);
    expect(broadcasterSeam.broadcastCalls).toHaveLength(0);
  });

  it("GET /authorization reports zero slots for the activated goal", async () => {
    const pair = await allowlistedPair();
    await activateGoal(pair);
    const res = await AUTHORIZATION_GET(new Request("http://localhost/api/agent/autonomy/authorization"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slots: unknown[] };
    expect(body.slots).toHaveLength(0);
  });
});
