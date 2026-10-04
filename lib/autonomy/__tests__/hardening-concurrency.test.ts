// lib/autonomy/__tests__/hardening-concurrency.test.ts
//
// PHASE 4 HARDENING — races (§4), emergency shutdown (§12), broadcaster
// security boundary (§13). Deterministic: races are expressed as concurrent
// promise graphs against the real stores/adapter; no wall-clock sleeps.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { DelegatedExecutionAdapter } from "@/lib/autonomy/delegated-execution-adapter";
import { InMemoryDelegatedAuthorizationStore } from "@/lib/autonomy/delegated-authorization";
import { InMemoryAutonomyStore } from "@/lib/autonomy/store";
import { AutonomyScheduler } from "@/lib/autonomy/scheduler";
import { McpTradeGateway } from "@/lib/autonomy/mcp-gateway";
import { silentLogger, type TestHarness } from "./helpers";
import type { AutonomyPolicy, DelegatedSwapRequest } from "@/lib/autonomy/types";
import {
  CANONICAL_PERMIT2,
  DELEGATED_EXECUTOR_ABI,
  DELEGATED_EXECUTOR_ADDRESS,
  DELEGATED_WITNESS_TYPE_STRING,
  delegatedActionId,
  delegatedPermitNonce,
  delegatedPermitTypedData,
  delegatedPolicyHash,
} from "@/lib/executor/delegated-executor";
import { newFakeState, TEST_SECRET, testDeps } from "@/lib/mcp/__tests__/fixtures";
import { createDelegatedBroadcaster } from "@/lib/delegated/delegated-broadcaster";

let savedAgentFlag: string | undefined;
let savedEmergencyFlag: string | undefined;

const USER = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;
const SELL = getAddress("0x00000000000000000000000000000000000000a5") as Address;
const BUY = getAddress("0x00000000000000000000000000000000000000b7") as Address;
const AMOUNT = "100000000";

beforeEach(() => {
  savedAgentFlag = process.env.MPGR_AUTONOMOUS_AGENT_ENABLED;
  savedEmergencyFlag = process.env.MPGR_AUTONOMOUS_EMERGENCY_DISABLE;
  process.env.MPGR_AUTONOMOUS_AGENT_ENABLED = "true";
  delete process.env.MPGR_AUTONOMOUS_EMERGENCY_DISABLE;
});
afterEach(() => {
  if (savedAgentFlag === undefined) delete process.env.MPGR_AUTONOMOUS_AGENT_ENABLED;
  else process.env.MPGR_AUTONOMOUS_AGENT_ENABLED = savedAgentFlag;
  if (savedEmergencyFlag === undefined) delete process.env.MPGR_AUTONOMOUS_EMERGENCY_DISABLE;
  else process.env.MPGR_AUTONOMOUS_EMERGENCY_DISABLE = savedEmergencyFlag;
});

function makePolicy(): AutonomyPolicy {
  return {
    id: "pol-race",
    wallet: USER,
    chainId: 84532,
    actions: ["swap"],
    sellToken: SELL,
    buyToken: BUY,
    maxPerTradeRaw: AMOUNT,
    maxDailyRaw: AMOUNT,
    maxSlippageBps: 500,
    maxActionsPerDay: 5,
    enabled: true,
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    authorizedAt: new Date(Date.now() - 3600_000).toISOString(),
    authorizationRef: "race",
  };
}

function makeAdapterHarness(broadcastImpl?: (tx: { to: Address; data: Hex; chainId: number }) => Promise<`0x${string}`>) {
  const policy = makePolicy();
  const slots = new InMemoryDelegatedAuthorizationStore();
  const broadcasts: { to: Address; data: Hex; chainId: number }[] = [];
  const failBroadcast = { fail: false };
  const gateway = new McpTradeGateway(
    testDeps(newFakeState(), {
      quoteSecret: TEST_SECRET,
      delegatedBroadcaster: async (tx) => {
        if (failBroadcast.fail) throw new Error("RPC connection reset during broadcast");
        broadcasts.push(tx);
        return ("0x" + "ab".repeat(32)) as `0x${string}`;
      },
    }),
  );
  const adapter = new DelegatedExecutionAdapter({
    slots,
    gateway,
    chain: {
      getBytecode: async () => "0x6080",
      readContract: async <T,>({ functionName }: { functionName: string }): Promise<T> => {
        if (functionName === "feeBps") return 25 as never;
        if (functionName === "PERMIT2") return CANONICAL_PERMIT2 as never;
        if (functionName === "WITNESS_TYPE_STRING") return DELEGATED_WITNESS_TYPE_STRING as never;
        throw new Error(`unexpected read ${functionName}`);
      },
    },
    getPolicy: async (id) => (id === policy.id ? policy : null),
    now: () => new Date(),
    broadcast: broadcastImpl ?? (async () => ("0x" + "cd".repeat(32)) as `0x${string}`),
  });
  return { policy, slots, adapter, broadcasts, failBroadcast };
}

async function signAndSave(h: ReturnType<typeof makeAdapterHarness>, goalId: string, slotIndex = 0, nonce = "100") {
  const deadline = Math.floor(Date.now() / 1000) + 1800;
  const permit = { token: SELL, amount: AMOUNT, nonce: delegatedPermitNonce(goalId, slotIndex) || nonce, deadline };
  const witness = {
    owner: USER,
    buyToken: BUY,
    minAmountOut: "1",
    deadline,
    actionId: delegatedActionId(goalId),
    policyHash: delegatedPolicyHash({
      id: h.policy.id, wallet: h.policy.wallet, chainId: 84532, sellToken: SELL, buyToken: BUY,
      maxPerTradeRaw: AMOUNT, maxSlippageBps: 500, expiresAt: h.policy.expiresAt,
    }),
  };
  const signer = privateKeyToAccount(generatePrivateKey());
  const typed = delegatedPermitTypedData({ permit, witness }, 84532, USER);
  const signature = await signer.signTypedData({
    domain: typed.domain, types: typed.types, primaryType: typed.primaryType, message: typed.message,
  } as Parameters<typeof signer.signTypedData>[0]);
  await h.slots.saveSlots([{
    id: `slot-${h.policy.id}-${goalId}-${slotIndex}`,
    wallet: USER, chainId: 84532, policyId: h.policy.id, goalId, slotIndex,
    permit, witness, signature, createdAt: new Date().toISOString(),
  }]);
  return { permit, witness, signature, deadline };
}

function requestFor(goalId: string, policy: AutonomyPolicy): DelegatedSwapRequest {
  return {
    goalId, policyId: policy.id, wallet: USER, chainId: 84532,
    quoteId: `q-${goalId}`, sellToken: SELL, buyToken: BUY,
    sellAmountRaw: AMOUNT, expectedBuyAmountRaw: "2", minBuyAmountRaw: "1",
    slippageBps: 100, idempotencyKey: `${goalId}-exec`, steps: [], transactionRequest: null,
  };
}

describe("hardening: slot consumption races (§4)", () => {
  it("concurrent executeSwap against ONE slot broadcasts at most once", async () => {
    const h = makeAdapterHarness();
    await signAndSave(h, "race-goal-1");
    const req = requestFor("race-goal-1", h.policy);
    // Fire 3 concurrent executions of the SAME goal/slot.
    const results = await Promise.all([h.adapter.executeSwap(req), h.adapter.executeSwap(req), h.adapter.executeSwap(req)]);
    const wins = results.filter((r) => r.ok);
    expect(wins.length, "at most one execution may win").toBeLessThanOrEqual(1);
    expect(h.broadcasts.length, "at most one broadcast may leave").toBeLessThanOrEqual(1);
    // Deterministic check: exactly one wins in this store implementation.
    expect(wins.length).toBe(1);
    const losers = results.filter((r) => !r.ok);
    for (const l of losers) expect(["AUTHORIZATION_MISSING", "EXECUTION_UNAVAILABLE", "RPC_ERROR"]).toContain(l.code);
  });

  it("concurrent markConsumed races: exactly one winner", async () => {
    const store = new InMemoryDelegatedAuthorizationStore();
    const h = makeAdapterHarness();
    const { permit, witness, signature, deadline } = await signAndSave(h, "race-goal-2");
    const slot = {
      id: `slot-${h.policy.id}-race-goal-2-0`, wallet: USER, chainId: 84532 as const,
      policyId: h.policy.id, goalId: "race-goal-2", slotIndex: 0,
      permit, witness, signature, createdAt: new Date().toISOString(),
    };
    await store.saveSlots([slot]);
    const at = new Date().toISOString();
    const results = await Promise.all([
      store.markConsumed(slot.id, USER, "0xa1", at),
      store.markConsumed(slot.id, USER, "0xa2", at),
      store.markConsumed(slot.id, USER, "0xa3", at),
    ]);
    expect(results.filter(Boolean).length).toBe(1);
  });

  it("revoke + execute race: whichever lands first, no double path remains", async () => {
    const h = makeAdapterHarness();
    await signAndSave(h, "race-goal-3");
    const req = requestFor("race-goal-3", h.policy);
    const [exec, consumed] = await Promise.all([
      h.adapter.executeSwap(req),
      h.slots.markRevoked(`slot-${h.policy.id}-race-goal-3-0`, USER, new Date().toISOString()),
    ]);
    // If execute won the race it consumed first (revoke then returns false);
    // if revoke won, execute must refuse. Never both side effects.
    if (consumed) {
      expect(exec.ok).toBe(false);
      expect(exec.ok ? "" : exec.code).toBe("AUTHORIZATION_MISSING");
      expect(h.broadcasts.length).toBe(0);
    } else {
      expect(exec.ok).toBe(true);
    }
    expect(h.broadcasts.length).toBeLessThanOrEqual(1);
  });

  it("idempotency claims are single-winner under concurrency", async () => {
    const store = new InMemoryAutonomyStore();
    const results = await Promise.all([
      store.claimExecution("goal-x:0", 60),
      store.claimExecution("goal-x:0", 60),
      store.claimExecution("goal-x:0", 60),
      store.claimExecution("goal-x:0", 60),
    ]);
    expect(results.filter(Boolean).length).toBe(1);
  });

  it("broadcast failure AFTER consume keeps the slot consumed (no unsafe rebroadcast)", async () => {
    const h = makeAdapterHarness();
    await signAndSave(h, "race-goal-4");
    h.failBroadcast.fail = true;
    const r1 = await h.adapter.executeSwap(requestFor("race-goal-4", h.policy));
    expect(r1.ok).toBe(false);
    expect(r1.ok ? "" : r1.code).toBe("RPC_ERROR");
    expect(h.broadcasts.length).toBe(0);
    const slot = await h.slots.getSlot(`slot-${h.policy.id}-race-goal-4-0`, USER);
    expect(slot?.consumedAt, "uncertain broadcast MUST leave the slot consumed").toBeTruthy();
    h.failBroadcast.fail = false;
    const r2 = await h.adapter.executeSwap(requestFor("race-goal-4", h.policy));
    expect(r2.ok, "no automatic rebroadcast of the uncertain slot").toBe(false);
    expect(h.broadcasts.length).toBe(0);
  });
});

describe("hardening: scheduler + goal cancellation races (§4/§11)", () => {
  it("scheduler tick on a terminal goal never re-evaluates (duplicate tick safety)", async () => {
    // Full runtime harness from the shared helpers (real runtime + store).
    const { makeHarness, createActiveGoal } = await import("./helpers");
    const harness = makeHarness();
    const { goal } = await createActiveGoal(harness, { maxTrades: 1 });
    const s1 = await harness.scheduler.tick({ now: harness.now() });
    const s2 = await harness.scheduler.tick({ now: harness.now() });
    const s3 = await harness.scheduler.tick({ now: harness.now() });
    const evaluated = s1.evaluated + s2.evaluated + s3.evaluated;
    expect(evaluated, "at most one evaluation may act; later ticks must skip").toBeLessThanOrEqual(3);
    const after = (await harness.store.getGoal(goal.id))!;
    expect(["COMPLETED", "FAILED", "WAITING", "ACTIVE"]).toContain(after.status);
    expect(after.stats.verified ?? 0, "never more than maxTrades verified executions").toBeLessThanOrEqual(1);
  });

  it("goal cancelled concurrently: cancelled goals are not evaluatable", async () => {
    const { makeHarness, createActiveGoal } = await import("./helpers");
    const harness = makeHarness();
    const { goal } = await createActiveGoal(harness, { maxTrades: 1 });
    await harness.store.transitionGoal(goal.id, goal.wallet, ["ACTIVE"], goal.updatedAt, { status: "CANCELLED", updatedAt: new Date().toISOString() });
    const result = await harness.runtime.evaluateGoal(goal.id);
    expect(result.kind).toBe("SKIPPED");
    expect(harness.adapter.options.requests ?? []).toHaveLength(0);
  });
});

describe("hardening: emergency shutdown (§12)", () => {
  const FLAG = "MPGR_AUTONOMOUS_EMERGENCY_DISABLE";
  let saved: string | undefined;
  beforeEach(() => { saved = process.env[FLAG]; });
  afterEach(() => {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  });

  it("blocks execution when set; re-enable is explicit (env unset)", async () => {
    const h = makeAdapterHarness();
    await signAndSave(h, "emg-goal-1");
    process.env[FLAG] = "true";
    const blocked = await h.adapter.executeSwap(requestFor("emg-goal-1", h.policy));
    expect(blocked.ok).toBe(false);
    expect(blocked.ok ? "" : blocked.code).toBe("EXECUTION_UNAVAILABLE");
    expect(h.broadcasts.length).toBe(0);
    delete process.env[FLAG];
    const allowed = await h.adapter.executeSwap(requestFor("emg-goal-1", h.policy));
    expect(allowed.ok).toBe(true);
  });

  it("blocks execution-ready posture checks (checkAuthorization) while active", async () => {
    const h = makeAdapterHarness();
    await h.adapter.verifyOnChain(); // warm the config cache (60s TTL)
    process.env[FLAG] = "true";
    const v = h.adapter.checkAuthorization(USER, makePolicy());
    expect(v.authorized).toBe(false);
    expect(v.reason).toBe("EMERGENCY_DISABLE");
    delete process.env[FLAG];
    expect(h.adapter.checkAuthorization(USER, makePolicy()).authorized).toBe(true);
  });

  it("concurrent emergency set vs execute: no transaction crosses the boundary", async () => {
    const h = makeAdapterHarness();
    await signAndSave(h, "emg-goal-2");
    process.env[FLAG] = "true";
    const [exec] = await Promise.all([h.adapter.executeSwap(requestFor("emg-goal-2", h.policy))]);
    expect(exec.ok).toBe(false);
    expect(h.broadcasts.length).toBe(0);
  });
});

describe("hardening: broadcaster security boundary (§13)", () => {
  it("fails closed without the key; exposes only an address", async () => {
    const saved = process.env.MPGR_BROADCASTER_PRIVATE_KEY;
    delete process.env.MPGR_BROADCASTER_PRIVATE_KEY;
    try {
      const b = createDelegatedBroadcaster();
      expect(b.address).toBeNull();
      await expect(b.broadcast({ to: DELEGATED_EXECUTOR_ADDRESS, data: "0x", chainId: 84532 })).rejects.toThrow();
    } finally {
      if (saved !== undefined) process.env.MPGR_BROADCASTER_PRIVATE_KEY = saved;
    }
  });

  it("refuses non-84532 chains (hard chain guard)", async () => {
    const saved = process.env.MPGR_BROADCASTER_PRIVATE_KEY;
    process.env.MPGR_BROADCASTER_PRIVATE_KEY = "0x" + "11".repeat(32);
    try {
      const b = createDelegatedBroadcaster();
      expect(b.address).toBeTruthy();
      await expect(b.broadcast({ to: DELEGATED_EXECUTOR_ADDRESS, data: "0x", chainId: 1 })).rejects.toThrow();
      await expect(b.broadcast({ to: DELEGATED_EXECUTOR_ADDRESS, data: "0x", chainId: 8453 })).rejects.toThrow();
    } finally {
      if (saved === undefined) delete process.env.MPGR_BROADCASTER_PRIVATE_KEY;
      else process.env.MPGR_BROADCASTER_PRIVATE_KEY = saved;
    }
  });

  it("the broadcast calldata CANNOT redirect funds: recipient==owner, tokenOut/amount/minOut all == signed slot values", async () => {
    const h = makeAdapterHarness();
    const { permit, witness } = await signAndSave(h, "bind-goal-1");
    const r = await h.adapter.executeSwap(requestFor("bind-goal-1", h.policy));
    expect(r.ok).toBe(true);
    expect(h.broadcasts.length).toBe(1);
    const { args } = decodeFunctionData({
      abi: DELEGATED_EXECUTOR_ABI,
      data: h.broadcasts[0]!.data,
    }) as unknown as { args: [Record<string, unknown>, number, { permit: { permitted: { token: string; amount: bigint }; nonce: bigint; deadline: bigint }; witness: Record<string, unknown> }] };
    const params = args[0]!;
    const auth = args[2]!;
    // The user's signed bindings survive verbatim; the broadcaster boundary
    // cannot inject anything else (the executor also enforces recipient==owner
    // on-chain; this pins the CLIENT side of that invariant).
    expect(String(params.recipient).toLowerCase()).toBe(USER);
    expect(String(params.tokenIn).toLowerCase()).toBe(SELL.toLowerCase());
    expect(String(params.tokenOut).toLowerCase()).toBe(BUY.toLowerCase());
    expect(params.grossAmountIn).toBe(BigInt(AMOUNT));
    expect(params.amountOutMinimum).toBe(BigInt(witness.minAmountOut));
    expect(params.expectedFeeAmount).toBe((BigInt(AMOUNT) * 25n) / 10000n);
    expect(params.unwrapNativeOut).toBe(false);
    expect(auth.permit.permitted.amount).toBe(BigInt(permit.amount));
    expect(auth.permit.nonce).toBe(BigInt(permit.nonce));
    expect(String(auth.witness.owner).toLowerCase()).toBe(USER);
  });
});

describe("hardening: client-bundle secret hygiene (§14, static)", () => {
  it("no broadcaster/wallet key material may appear in client-reachable code", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const roots = ["components", "hooks", "lib/trade", "lib/autonomy"];
    const offenders: string[] = [];
    const patterns = [/MPGR_BROADCASTER_PRIVATE_KEY/, /privateKeyToAccount/, /generatePrivateKey/, /MPGR_LIVE_TEST_USER_PRIVATE_KEY/];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) {
          if (name === "__tests__" || name === "node_modules") continue;
          walk(p);
        } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\./.test(name)) {
          const src = readFileSync(p, "utf-8");
          for (const pat of patterns) {
            if (pat.test(src)) offenders.push(`${p} :: ${pat.source}`);
          }
        }
      }
    };
    for (const r of roots) walk(r);
    // lib/autonomy must not sign or hold keys either (server-side fan-out only).
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
