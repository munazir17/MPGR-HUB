import { beforeEach, describe, expect, it, vi } from "vitest";

// PRODUCTION FIX — chat-draft ACTIVATION flow (hooks/useAgentAutonomy.activateDraft).
//
// Locks the two activation modes required for the fixed autonomous flow:
//
//   1. STANDING DELEGATION — when the wallet already holds a live policy plus
//      an unexpired, unconsumed slot covering the draft's pair, exact amount
//      and daily cap, activating the draft creates the goal and requests NO
//      wallet signature.
//   2. ONE SIGNATURE — when nothing covers the draft, the wallet is asked for
//      EXACTLY ONE delegated-slot signature (draft amount, minimum output
//      from the live quote — never zero), and the goal is active.
//
// No network, no keys: fetch is stubbed, wagmi's signTypedDataAsync is a
// counting stub, and the delegated executor helpers are deterministic stubs.

// Tiny hook host: preserves hook state between renders and collects effects,
// so useAgentAutonomy can be invoked as a plain function (same pattern as
// AgentAutonomyPanel.behavior.test.ts).
const hooks = vi.hoisted(() => {
  const states: unknown[] = [];
  let cursor = 0;
  const refs: Array<{ current: unknown }> = [];
  let refCursor = 0;
  let effects: Array<() => void> = [];

  return {
    beginRender() {
      cursor = 0;
      refCursor = 0;
      effects = [];
    },
    flushEffects() {
      const pending = effects;
      effects = [];
      pending.forEach((effect) => effect());
    },
    reset() {
      states.length = 0;
      refs.length = 0;
      cursor = 0;
      refCursor = 0;
      effects = [];
    },
    useState(initial: unknown) {
      const index = cursor++;
      if (index === states.length) states.push(initial);
      return [
        states[index],
        (next: unknown) => {
          states[index] = typeof next === "function" ? (next as (current: unknown) => unknown)(states[index]) : next;
        },
      ] as const;
    },
    useEffect(effect: () => void) {
      effects.push(effect);
    },
    useMemo<T>(compute: () => T) {
      return compute();
    },
    useRef(initial: unknown) {
      const index = refCursor++;
      if (!refs[index]) refs[index] = { current: initial };
      return refs[index];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: hooks.useEffect,
    useMemo: hooks.useMemo,
    useState: hooks.useState,
    useRef: hooks.useRef,
    // Plain pass-through: outside a renderer there is no hook dispatcher,
    // and identity-stable callbacks are irrelevant to a single render.
    useCallback: (fn: unknown) => fn,
  };
});

const wallet = vi.hoisted(() => {
  const state = {
    address: ("0x" + "ab".repeat(20)) as string,
    chainId: 8453 as number | undefined,
    signCalls: [] as unknown[],
    signError: null as string | null,
  };
  return state;
});

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: wallet.address, chainId: wallet.chainId, isConnected: true }),
  useSignTypedData: () => ({
    signTypedDataAsync: async (args: unknown) => {
      if (wallet.signError) throw new Error(wallet.signError);
      wallet.signCalls.push(args);
      return "0x" + "11".repeat(65);
    },
  }),
}));

vi.mock("@/hooks/useWalletAuth", () => ({
  useWalletAuth: () => ({
    authenticated: true,
    authenticating: false,
    authenticate: async () => true,
  }),
}));

// vi.hoisted so both this mock module and the fixtures share one actionId
// derivation that is DISTINCT per goal id (the real delegatedActionId is a
// goal-bound keccak — two goals never share an actionId).
const mocks = vi.hoisted(() => ({
  actionIdFor: (id: string): `0x${string}` =>
    ("0x" + "ab".repeat(24) + id.split("").reverse().map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("").padEnd(16, "0").slice(0, 16)) as `0x${string}`,
}));

vi.mock("@/lib/executor/delegated-executor", () => ({
  DELEGATED_EXECUTOR_ADDRESS: "0x" + "ee".repeat(20),
  DELEGATED_EXECUTOR_CHAIN_ID: 84532,
  delegatedActionId: (id: string) => mocks.actionIdFor(id),
  delegatedPermitNonce: (_goalId: string, slotIndex: number) => String(1000 + slotIndex),
  delegatedPermitTypedData: () => ({ domain: {}, types: {}, primaryType: "", message: {} }),
  delegatedPolicyHash: () => ("0x" + "cd".repeat(32)) as `0x${string}`,
  delegatedChainLabel: (chainId: number) => (chainId === 8453 ? "Base" : "Base Sepolia"),
  isDelegatedChainId: (chainId: unknown) => chainId === 8453 || chainId === 84532,
  walletSigningSupported: () => true,
}));

// ─── Fetch fixtures ───────────────────────────────────────────────────────

const USDC = { address: "0x1111111111111111111111111111111111111111", symbol: "USDC", decimals: 6 };
const AAPLc = { address: "0x2222222222222222222222222222222222222222", symbol: "AAPLc", decimals: 8 };

const jsonResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: { "Content-Type": "application/json" } });

const CONFIG = {
  enabled: true,
  emergencyDisabled: false,
  productionGate: false,
  executionAvailable: true,
  delegated: { chainId: 8453, executor: "0x" + "ee".repeat(20), walletSigningSupported: true },
  limits: { maxGoalsPerWallet: 5, minCooldownSeconds: 60, maxPolicyTtlDays: 30, maxPerTradeHuman: "100", maxDailyHuman: "500", maxSlippageBps: 100 },
};

interface Fixture {
  policies: unknown[];
  slots: unknown[];
  goalResponses: unknown[];
  policyPostCount: number;
  goalPostCount: number;
  slotPostCount: number;
  quoteMinToAmount: string;
  activationStatus?: number;
  registrationStatus?: number;
}

let fixture: Fixture;

function resetFixture() {
  fixture = { policies: [], slots: [], goalResponses: [], policyPostCount: 0, goalPostCount: 0, slotPostCount: 0, quoteMinToAmount: "0.2855" };
}

function coveringPolicy() {
  return {
    id: "policy_cover",
    chainId: 8453,
    wallet: wallet.address,
    sellToken: USDC.address,
    buyToken: AAPLc.address,
    maxPerTradeRaw: "50000000", // 50 USDC
    maxDailyRaw: "100000000", // 100 USDC
    maxSlippageBps: 100,
    maxActionsPerDay: 20,
    enabled: true,
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    revokedAt: null,
  };
}

function coveringSlot(overrides: Record<string, unknown> = {}) {
  const base = {
    id: "slot_cover_0",
    policyId: "policy_cover",
    goalId: "goal_prev",
    slotIndex: 0,
    chainId: 8453,
    wallet: wallet.address,
    sellToken: USDC.address,
    amountRaw: "50000000", // EXACT 50 USDC — the only redeemable shape
    buyToken: AAPLc.address,
    minAmountOutRaw: "140000000", // > 0
    deadline: Math.floor(Date.now() / 1000) + 3600,
    deadlineIso: new Date(Date.now() + 3600_000).toISOString(),
    status: "active",
    consumedAt: null,
    consumedByTxHash: null,
    revokedAt: null,
    createdAt: new Date().toISOString(),
  };
  // An explicit actionId override wins; otherwise the witness actionId is
  // derived from the goal this slot was signed FOR.
  const { actionId: actionIdOverride, ...rest } = overrides;
  const base2 = { ...base, ...rest };
  return {
    ...base2,
    actionId: (actionIdOverride as string | undefined) ?? mocks.actionIdFor(String(base2.goalId)),
  };
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = typeof input === "string" ? input : String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/api/agent/autonomy/config")) return jsonResponse(CONFIG);
      if (url.includes("/api/agent/autonomy/tokens")) return jsonResponse({ tokens: [USDC, AAPLc] });
      if (url.includes("/api/agent/autonomy/goals") && method === "GET") return jsonResponse({ goals: fixture.goalResponses });
      if (url.includes("/api/agent/autonomy/goals/") && method === "PATCH") {
        return jsonResponse(fixture.activationStatus ? { error: "Activation not confirmed" } : { goal: { id: url.split("/").at(-1), status: "ACTIVE" } }, { status: fixture.activationStatus ?? 200 });
      }
      if (url.includes("/api/agent/autonomy/goals") && method === "POST") {
        fixture.goalPostCount += 1;
        const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
        return jsonResponse({
          goal: {
            id: `goal_${fixture.goalPostCount}`,
            policyId: body.policyId,
            status: "DRAFT",
            condition: body.condition,
            trade: { sellToken: USDC.address, buyToken: AAPLc.address, sellAmountRaw: "50000000", slippageBps: 100 },
            description: "test goal",
          },
        }, { status: 201 });
      }
      if (url.includes("/api/agent/autonomy/policy") && method === "GET") return jsonResponse({ policies: fixture.policies });
      if (url.includes("/api/agent/autonomy/policy") && method === "POST") {
        fixture.policyPostCount += 1;
        return jsonResponse({ policy: { id: `policy_new_${fixture.policyPostCount}`, chainId: 8453, sellToken: USDC.address, buyToken: AAPLc.address, maxPerTradeRaw: "50000000", maxDailyRaw: "100000000", maxSlippageBps: 100, enabled: true, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), revokedAt: null } }, { status: 201 });
      }
      if (url.includes("/api/agent/autonomy/authorization") && method === "GET") {
        return jsonResponse({ slots: fixture.slots, walletSigningSupported: true });
      }
      if (url.includes("/api/agent/autonomy/authorization") && method === "POST") {
        fixture.slotPostCount += 1;
        if (fixture.registrationStatus) return jsonResponse({ error: "Registration unavailable" }, { status: fixture.registrationStatus });
        const posted = JSON.parse(init?.body ?? "{}");
        fixture.slots = [coveringSlot({ policyId: posted.policyId, goalId: posted.goalId })];
        return jsonResponse({ slots: fixture.slots }, { status: 201 });
      }
      if (url.includes("/api/trade/quote")) {
        return jsonResponse({ proposal: { minToAmount: fixture.quoteMinToAmount } });
      }
      return jsonResponse({ error: "not found" }, { status: 404 });
    }),
  );
}

const ACTIVATION_INPUT = {
  sellToken: USDC.address,
  buyToken: AAPLc.address,
  condition: { kind: "price_below" as const, threshold: "343.53" },
  sellAmount: "50",
  maxDaily: "100",
  maxSlippageBps: 100,
  maxActionsPerDay: 20,
  ttlDays: 30,
  cooldownSeconds: 3600,
  maxTrades: 10,
  description: "Buy when price falls below 343.53",
  minAmountOutHuman: "0.2855",
};

/**
 * Boots the hook with TWO renders: the first kicks the async refresh effect
 * (config/tokens/policies/slots load through fetch continuations), the
 * second produces closures that captured the loaded state — exactly what a
 * real React commit sequence provides.
 */
async function bootHook(): Promise<Record<string, unknown>> {
  const { useAgentAutonomy } = await import("@/hooks/useAgentAutonomy");
  hooks.beginRender();
  (useAgentAutonomy as unknown as () => Record<string, unknown>)();
  hooks.flushEffects();
  await new Promise((resolve) => setTimeout(resolve, 0));
  hooks.beginRender();
  return (useAgentAutonomy as unknown as () => Record<string, unknown>)();
}

async function callActivate(): Promise<{ ok: boolean; mode?: string; message?: string }> {
  const api = await bootHook();
  const activateDraft = api.activateDraft as (input: typeof ACTIVATION_INPUT) => Promise<{ ok: boolean; mode?: string; message?: string }>;
  return activateDraft(ACTIVATION_INPUT);
}

beforeEach(() => {
  hooks.reset();
  wallet.signCalls = [];
  wallet.signError = null;
  resetFixture();
  installFetch();
});

describe("useAgentAutonomy.activateDraft — chat draft activation", () => {
  it("a covering slot from a DIFFERENT goal does NOT activate a new goal without a signature", async () => {
    // The pre-existing slot matches pair, EXACT amount, and is live — but it
    // was signed for ANOTHER goal (its witness actionId is bound to that
    // goal, and the executor reverts any broadcast with a different
    // intentId). The new draft goal MUST get its own signature.
    fixture.policies = [coveringPolicy()];
    fixture.slots = [coveringSlot()]; // goalId: "goal_prev" ≠ the new goal

    const result = await callActivate();

    // The one NEW signature path ran: goal created AND wallet asked once.
    expect(result).toMatchObject({ ok: true, mode: "signed" });
    expect(fixture.policyPostCount).toBe(1);
    expect(fixture.goalPostCount).toBe(1);
    expect(wallet.signCalls).toHaveLength(1); // EXACTLY ONE signature
    expect(fixture.slotPostCount).toBe(1);
  });

  it("a live slot already bound to THIS goal is the only no-signature standing path", async () => {
    // The goal POST returns id "goal_1"; a pre-existing live slot bound to
    // THAT id (same actionId derivation) is genuinely this goal's own
    // authorization — activating skips the signature.
    fixture.policies = [coveringPolicy()];
    fixture.slots = [coveringSlot({ policyId: "policy_new_1", goalId: "goal_1", id: "slot_goal1_0" })];

    const result = await callActivate();

    expect(result).toMatchObject({ ok: true, mode: "standing" });
    expect(fixture.goalPostCount).toBe(1);
    expect(wallet.signCalls).toHaveLength(0); // no popup — its OWN live slot
    expect(fixture.slotPostCount).toBe(0);
  });

  it("a slot bound to this goal's id but with a MISMATCHED actionId still signs once", async () => {
    fixture.policies = [coveringPolicy()];
    fixture.slots = [coveringSlot({ policyId: "policy_new_1", goalId: "goal_1", id: "slot_goal1_0", actionId: mocks.actionIdFor("goal_other") })];

    const result = await callActivate();

    expect(result).toMatchObject({ ok: true, mode: "signed" });
    expect(wallet.signCalls).toHaveLength(1);
    expect(fixture.slotPostCount).toBe(1);
  });

  it("a covering slot does NOT cover a different amount — the client signs once instead", async () => {
    fixture.policies = [coveringPolicy()];
    fixture.slots = [coveringSlot({ amountRaw: "1000000" })]; // 1 USDC ≠ 50 USDC

    const result = await callActivate();

    expect(result).toMatchObject({ ok: true, mode: "signed" });
    expect(wallet.signCalls).toHaveLength(1); // EXACTLY ONE signature
    expect(fixture.policyPostCount).toBe(1);
    expect(fixture.goalPostCount).toBe(1);
    expect(fixture.slotPostCount).toBe(1);
  });

  it("WITHOUT a slot: the client is told to sign ONCE and registers exactly one slot", async () => {
    const result = await callActivate();

    expect(result).toMatchObject({ ok: true, mode: "signed" });
    expect(wallet.signCalls).toHaveLength(1);
    expect(fixture.policyPostCount).toBe(1);
    expect(fixture.goalPostCount).toBe(1);
    expect(fixture.slotPostCount).toBe(1);
  });

  it("the ONE signature signs the draft amount with the live-quote floor (never zero)", async () => {
    const result = await callActivate();

    expect(result).toMatchObject({ ok: true, mode: "signed" });
    expect(wallet.signCalls).toHaveLength(1);
    // The registered slot payload carries the exact base-unit amount (50 USDC = 50_000000)
    // and a positive minimum output (0.2855 AAPLc × 1e8).
    expect(fixture.slotPostCount).toBe(1);
    const posted = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => String(c[0]).includes("/api/agent/autonomy/authorization") && (c[1] as { method?: string })?.method === "POST",
    );
    expect(posted).toBeDefined();
    const body = JSON.parse((posted![1] as { body: string }).body) as {
      goalId: string;
      slots: Array<{ permit: { amount: string }; witness: { minAmountOut: string; actionId: string } }>;
    };
    expect(body.slots).toHaveLength(1);
    expect(body.goalId).toBe("goal_1");
    expect(body.slots[0].witness.actionId).toBe(mocks.actionIdFor("goal_1"));
    expect(body.slots[0].witness.actionId).not.toBe(mocks.actionIdFor("goal_prev"));
    expect(body.slots[0].permit.amount).toBe("50000000");
    expect(BigInt(body.slots[0].witness.minAmountOut)).toBe(28550000n); // 0.2855 × 1e8, NOT zero
  });

  it("refuses to sign with an empty minimum output — the quote floor is mandatory", async () => {
    const api = await bootHook();
    const activateDraft = api.activateDraft as (input: typeof ACTIVATION_INPUT) => Promise<{ ok: boolean; mode?: string; message?: string }>;

    const result = await activateDraft({ ...ACTIVATION_INPUT, minAmountOutHuman: "" });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/live quote/i);
    expect(wallet.signCalls).toHaveLength(0);
    expect(fixture.policyPostCount).toBe(0);
  });

  it("a consumed slot bound to this goal does NOT skip the signature", async () => {
    fixture.policies = [coveringPolicy()];
    fixture.slots = [coveringSlot({ consumedAt: new Date().toISOString(), status: "consumed" })];

    const result = await callActivate();

    expect(result).toMatchObject({ ok: true, mode: "signed" });
    expect(wallet.signCalls).toHaveLength(1);
  });

  it("an expired slot bound to this goal does NOT skip the signature", async () => {
    fixture.policies = [coveringPolicy()];
    fixture.slots = [coveringSlot({ deadline: Math.floor(Date.now() / 1000) - 10 })];

    const result = await callActivate();

    expect(result).toMatchObject({ ok: true, mode: "signed" });
    expect(wallet.signCalls).toHaveLength(1);
  });
});


describe("useAgentAutonomy settings reads never retain stale success", () => {
  it.each([503, 401])("clears valid settings after HTTP %s on the same wallet, without signing or writing", async (status) => {
    const api = await bootHook();
    expect(api.config).toEqual(CONFIG);
    expect(api.settingsRead).toMatchObject({ state: "loaded", httpStatus: 200 });
    const calls = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      if (String(input).endsWith("/config")) return jsonResponse(CONFIG, { status });
      return jsonResponse({ code: "AUTH_REQUIRED" }, { status: 401 });
    });
    vi.stubGlobal("fetch", calls);
    await (api.refresh as () => Promise<void>)();
    const { useAgentAutonomy } = await import("@/hooks/useAgentAutonomy");
    hooks.beginRender();
    const next = useAgentAutonomy();
    expect(next.config).toBeNull();
    expect(next.settingsRead).toMatchObject({ state: "http_error", httpStatus: status });
    expect(calls).toHaveBeenCalledTimes(2); // config + goals only, no automatic auth
    expect(wallet.signCalls).toHaveLength(0);
    expect(fixture.policyPostCount + fixture.goalPostCount + fixture.slotPostCount).toBe(0);
  });
});


it("loads public settings independently of a stalled session-scoped goals GET", async () => {
  const network = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    expect(init?.method).toBe("GET");
    if (String(input).endsWith("/config")) return jsonResponse({ ...CONFIG, enabled: false });
    return new Promise(() => {}); // session read never completes
  });
  vi.stubGlobal("fetch", network);
  const api = await bootHook();
  expect(api.config).toEqual({ ...CONFIG, enabled: false });
  expect(api.settingsRead).toMatchObject({ state: "loaded", httpStatus: 200 });
  expect(network).toHaveBeenCalledTimes(2);
  expect(wallet.signCalls).toHaveLength(0);
});

describe("same-goal activation retries", () => {
  it("signature rejection leaves a draft and retry reuses its goal and policy", async () => {
    const api = await bootHook();
    const activate = api.activateDraft as (input: typeof ACTIVATION_INPUT) => Promise<{ ok: boolean }>;
    wallet.signError = "User rejected signature";
    expect((await activate(ACTIVATION_INPUT)).ok).toBe(false);
    expect(fixture.goalPostCount).toBe(1);
    expect(fixture.slotPostCount).toBe(0);
    wallet.signError = null;
    expect((await activate(ACTIVATION_INPUT)).ok).toBe(true);
    expect(fixture.goalPostCount).toBe(1);
    expect(fixture.policyPostCount).toBe(1);
  });
  it("registration failure never confirms active; retry does not duplicate a goal", async () => {
    const api = await bootHook();
    const activate = api.activateDraft as (input: typeof ACTIVATION_INPUT) => Promise<{ ok: boolean }>;
    fixture.registrationStatus = 503;
    expect((await activate(ACTIVATION_INPUT)).ok).toBe(false);
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some((c) => c[1]?.method === "PATCH")).toBe(false);
    fixture.registrationStatus = undefined;
    expect((await activate(ACTIVATION_INPUT)).ok).toBe(true);
    expect(fixture.goalPostCount).toBe(1);
  });
  it("failed activation after persistence retries the saved permission without another signature", async () => {
    const api = await bootHook();
    const activate = api.activateDraft as (input: typeof ACTIVATION_INPUT) => Promise<{ ok: boolean }>;
    fixture.activationStatus = 503;
    expect((await activate(ACTIVATION_INPUT)).ok).toBe(false);
    fixture.activationStatus = undefined;
    expect((await activate(ACTIVATION_INPUT)).ok).toBe(true);
    expect(fixture.goalPostCount).toBe(1);
    expect(fixture.policyPostCount).toBe(1);
    expect(wallet.signCalls).toHaveLength(1);
  });
});

it("a consumed goal slot never reuses its deterministic nonce/index on retry", async () => {
  fixture.slots = [coveringSlot({ policyId: "policy_new_1", goalId: "goal_1", slotIndex: 0, consumedAt: new Date().toISOString() })];
  expect((await callActivate()).ok).toBe(true);
  const posted = (fetch as ReturnType<typeof vi.fn>).mock.calls.find((c) => String(c[0]).includes("/authorization") && c[1]?.method === "POST");
  expect(JSON.parse(posted![1].body).slots[0].slotIndex).toBe(1);
});
it("same-goal retry ignores changed object property order and refreshed quote floor", async () => {
  const api = await bootHook();
  const activate = api.activateDraft as (input: typeof ACTIVATION_INPUT) => Promise<{ ok: boolean }>;
  wallet.signError = "User rejected signature";
  expect((await activate(ACTIVATION_INPUT)).ok).toBe(false);
  wallet.signError = null;
  const reversed = Object.fromEntries(Object.entries(ACTIVATION_INPUT).reverse()) as typeof ACTIVATION_INPUT;
  expect((await activate({ ...reversed, minAmountOutHuman: "0.28" })).ok).toBe(true);
  expect(fixture.goalPostCount).toBe(1); expect(fixture.policyPostCount).toBe(1);
});

it("manual pending-goal recovery uses its valid saved permission without re-entry or another signature", async () => {
  fixture.policies = [coveringPolicy()]; fixture.slots = [coveringSlot({ goalId: "goal_1" })];
  fixture.goalResponses = [{ id: "goal_1", policyId: "policy_cover", status: "DRAFT", trade: { sellToken: USDC.address, buyToken: AAPLc.address, sellAmountRaw: "50000000" } }];
  const api = await bootHook();
  const sign = api.signDelegatedSlots as (input: { policyId: string; goalId: string; count: number; minAmountOutHuman: string; expiresInHours: number }) => Promise<{ ok: boolean }>;
  expect((await sign({ policyId: "policy_cover", goalId: "goal_1", count: 1, minAmountOutHuman: "", expiresInHours: 24 })).ok).toBe(true);
  expect(wallet.signCalls).toHaveLength(0); expect(fixture.slotPostCount).toBe(0);
  expect(fixture.goalPostCount).toBe(0); expect(fixture.policyPostCount).toBe(0);
});

it("exhausted single-use nonce indexes fail closed, not an instruction to recycle revoked permission", async () => {
  fixture.slots = Array.from({ length: 5 }, (_, i) => coveringSlot({ id: `slot_${i}`, policyId: "policy_new_1", goalId: "goal_1", slotIndex: i, consumedAt: new Date().toISOString() }));
  const result = await callActivate();
  expect(result.ok).toBe(false); expect(result.message).toContain("cannot be recycled");
  expect(wallet.signCalls).toHaveLength(0); expect(fixture.slotPostCount).toBe(0);
});
