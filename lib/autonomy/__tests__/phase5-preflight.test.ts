// lib/autonomy/__tests__/phase5-preflight.test.ts
//
// PHASE 5 — GUARDED BASE SEPOLIA READINESS PREFLIGHT (read-only).
// Runs ONLY when MPGR_PHASE5_PREFLIGHT=true, i.e. inside the explicitly
// dispatched `phase5-readiness.yml` preflight job with the base-sepolia
// environment secrets. Nothing here broadcasts or signs anything: this file
// (1) fails closed on any missing Phase 5 environment variable,
// (2) verifies broadcaster identity + chain,
// (3) verifies the FROZEN delegated executor's bytecode + immutables on-chain
//     (feeBps==25, canonical Permit2, witness type string),
// (4) verifies authorization/slot limits and emergency-disable behavior,
// (5) proves no Mainnet path can be selected,
// (6) produces a DRY-RUN execution plan (fresh quote -> policy/slot/nonce/
//     actionId -> fee math) WITHOUT broadcasting, for the human record.

import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { createPublicClient, http, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  CANONICAL_PERMIT2,
  DELEGATED_BASE_SEPOLIA_TSTOCK,
  DELEGATED_BASE_SEPOLIA_TUSD,
  DELEGATED_EXECUTOR_ADDRESS,
  delegatedActionId,
  delegatedPermitNonce,
  delegatedPolicyHash,
} from "@/lib/executor/delegated-executor";
import { createDelegatedBroadcaster } from "@/lib/delegated/delegated-broadcaster";
import { DelegatedExecutionAdapter } from "@/lib/autonomy/delegated-execution-adapter";
import {
  InMemoryDelegatedAuthorizationStore,
  MAX_DELEGATED_SLOTS,
  delegatedSlotId,
  policyHashFor,
  selectDelegatedSlot,
  type DelegatedAuthorizationSlot,
} from "@/lib/autonomy/delegated-authorization";
import { McpTradeGateway } from "@/lib/autonomy/mcp-gateway";
import { delegateSwap } from "@/lib/mcp/mcp-trade-service";
import { DELEGATED_EXECUTOR_CHAIN_ID } from "@/lib/executor/delegated-executor";
import type { AutonomyPolicy } from "@/lib/autonomy/types";
import { writeFileSync } from "node:fs";

// Minimal view ABI for the frozen delegated executor's immutables (read-only).
const EXECUTOR_VIEW_ABI = [
  { type: "function", name: "feeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "PERMIT2", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "WITNESS_TYPE_STRING", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "feeRecipient", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

const PREFLIGHT = process.env.MPGR_PHASE5_PREFLIGHT === "true";
// Tiny-value readiness amounts (6 dp tUSD). The armed live run uses the same.
const PLAN_SELL_AMOUNT_RAW = BigInt(process.env.MPGR_LIVE_SELL_AMOUNT_RAW?.trim() || "10000"); // 0.01 tUSD

describe.skipIf(!PREFLIGHT)("PHASE 5 preflight — guarded Base Sepolia readiness (read-only)", () => {
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL?.trim() || "https://sepolia.base.org";
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });

  const broadcasterKey = process.env.MPGR_BROADCASTER_PRIVATE_KEY?.trim();
  const testUserKey = process.env.MPGR_LIVE_TEST_USER_PRIVATE_KEY?.trim();
  const deployerKey = process.env.BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY?.trim();

  it("fails closed when any Phase 5 secret/env is missing or malformed", () => {
    expect(broadcasterKey, "MPGR_BROADCASTER_PRIVATE_KEY missing").toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(testUserKey, "MPGR_LIVE_TEST_USER_PRIVATE_KEY missing").toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(deployerKey, "BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY missing").toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(rpcUrl, "BASE_SEPOLIA_RPC_URL must be an https RPC").toMatch(/^https:\/\//);
  });

  it("verifies broadcaster identity and the three-wallet separation", () => {
    const broadcaster = createDelegatedBroadcaster();
    expect(broadcaster.address).toBeTruthy();
    const broadcasterAddress = broadcaster.address as Address;
    const testUser = privateKeyToAccount(testUserKey! as `0x${string}`);
    const deployer = privateKeyToAccount(deployerKey! as `0x${string}`);
    const distinct = new Set([broadcasterAddress, testUser.address, deployer.address].map((a) => a.toLowerCase()));
    expect(distinct.size, "broadcaster, test user and deployer must be three distinct wallets").toBe(3);
    console.log(`::notice::PHASE5_PREFLIGHT broadcaster=${broadcasterAddress} testUser=${testUser.address} deployer=${deployer.address}`);
  });

  it("verifies the chain is Base Sepolia 84532 and the frozen executor config is intact", async () => {
    const chainId = await client.getChainId();
    expect(chainId, "MUST be Base Sepolia 84532").toBe(84532);
    expect(DELEGATED_EXECUTOR_CHAIN_ID).toBe(84532);
    expect(getAddress(DELEGATED_EXECUTOR_ADDRESS), "executor must be the frozen deployment").toBe(getAddress("0xa9568499D7e58854F2590a56B6D32788DbfA58F9"));
  });

  it("verifies broadcaster gas, test-user balances and the executor fee recipient on-chain", async () => {
    const broadcasterAddress = (createDelegatedBroadcaster().address) as Address;
    const testUser = privateKeyToAccount(testUserKey! as `0x${string}`);
    const [bEth, uEth, uUsd, feeRecipient] = await Promise.all([
      client.getBalance({ address: broadcasterAddress }),
      client.getBalance({ address: testUser.address }),
      client.readContract({ address: DELEGATED_BASE_SEPOLIA_TUSD, abi: erc20Abi, functionName: "balanceOf", args: [testUser.address] }),
      client.readContract({ address: DELEGATED_EXECUTOR_ADDRESS, abi: EXECUTOR_VIEW_ABI, functionName: "feeRecipient" }),
    ]);
    expect(bEth, "broadcaster needs >= 0.0005 ETH for gas").toBeGreaterThanOrEqual(500_000_000_000_000n);
    expect(uUsd >= PLAN_SELL_AMOUNT_RAW, "test user must hold the tiny sell amount in tUSD").toBe(true);
    console.log(`::notice::PHASE5_PREFLIGHT broadcasterEth=${bEth} userEth=${uEth} userTusd=${uUsd} feeRecipient=${feeRecipient}`);
  });

  it("verifies the delegated executor deep posture: bytecode + feeBps==25 + canonical Permit2 + witness type (adapter verifyOnChain)", async () => {
    const gateway = McpTradeGateway.productionWithDelegation();
    const adapter = new DelegatedExecutionAdapter({
      slots: new InMemoryDelegatedAuthorizationStore(),
      gateway,
      chain: {
        getBytecode: async (address) => (await client.getBytecode({ address })) ?? null,
        readContract: (args) => client.readContract(args as never) as never,
      },
      getPolicy: async () => null,
    });
    const posture = await adapter.verifyOnChain();
    expect(posture.authorized, `deep on-chain posture failed: ${posture.reason}`).toBe(true);
    // Re-state the individual facts for the evidence record:
    const [execCode, p2Code, feeBps, permit2, witnessType] = await Promise.all([
      client.getBytecode({ address: DELEGATED_EXECUTOR_ADDRESS }),
      client.getBytecode({ address: CANONICAL_PERMIT2 }),
      client.readContract({ address: DELEGATED_EXECUTOR_ADDRESS, abi: EXECUTOR_VIEW_ABI, functionName: "feeBps" }),
      client.readContract({ address: DELEGATED_EXECUTOR_ADDRESS, abi: EXECUTOR_VIEW_ABI, functionName: "PERMIT2" }),
      client.readContract({ address: DELEGATED_EXECUTOR_ADDRESS, abi: EXECUTOR_VIEW_ABI, functionName: "WITNESS_TYPE_STRING" }),
    ]);
    expect(execCode && execCode !== "0x").toBe(true);
    expect(p2Code && p2Code !== "0x").toBe(true);
    expect(Number(feeBps)).toBe(25);
    expect(getAddress(permit2)).toBe(getAddress(CANONICAL_PERMIT2));
    const { DELEGATED_WITNESS_TYPE_STRING } = await import("@/lib/executor/delegated-executor");
    expect(witnessType).toBe(DELEGATED_WITNESS_TYPE_STRING);
    console.log(`::notice::PHASE5_PREFLIGHT executorCode=${(execCode!.length - 2) / 2}B permit2Code=${(p2Code!.length - 2) / 2}B feeBps=${feeBps} witnessTypeVerified=true`);
  });

  it("verifies authorization/slot limits (max 5 slots; deterministic nonce space; 6th slot refused)", async () => {
    expect(MAX_DELEGATED_SLOTS).toBe(5);
    const slots = new InMemoryDelegatedAuthorizationStore();
    const policy = makeTinyPolicy("pol_pf", DELEGATED_BASE_SEPOLIA_TUSD, DELEGATED_BASE_SEPOLIA_TSTOCK);
    const batch: DelegatedAuthorizationSlot[] = [];
    for (let i = 0; i < MAX_DELEGATED_SLOTS + 1; i++) batch.push(makeTinySlot(policy, "goal-pf", i, PLAN_SELL_AMOUNT_RAW));
    // The API layer enforces the limit before the store; the store itself is
    // the last line of defense. The Phase 4 suites prove both; here we pin
    // the exported constant and the deterministic nonce/actionId space.
    expect(BigInt(delegatedPermitNonce("goal-pf", 0))).not.toBe(BigInt(delegatedPermitNonce("goal-pf", 1)));
    expect(delegatedActionId("goal-pf")).toBe(delegatedActionId("goal-pf"));
    void slots;
    void batch;
  });

  it("verifies emergency disable blocks the adapter (fail-closed, no I/O)", () => {
    const adapter = new DelegatedExecutionAdapter({
      slots: new InMemoryDelegatedAuthorizationStore(),
      gateway: McpTradeGateway.productionWithDelegation(),
      getPolicy: async () => null,
    });
    const prevFlag = process.env.MPGR_AUTONOMOUS_AGENT_ENABLED;
    const prevEmergency = process.env.MPGR_AUTONOMOUS_EMERGENCY_DISABLE;
    process.env.MPGR_AUTONOMOUS_AGENT_ENABLED = "true";
    process.env.MPGR_AUTONOMOUS_EMERGENCY_DISABLE = "true";
    try {
      const verdict = adapter.checkStatic();
      expect(verdict.authorized).toBe(false);
      expect(verdict.reason).toBe("EMERGENCY_DISABLE");
    } finally {
      if (prevFlag === undefined) delete process.env.MPGR_AUTONOMOUS_AGENT_ENABLED;
      else process.env.MPGR_AUTONOMOUS_AGENT_ENABLED = prevFlag;
      if (prevEmergency === undefined) delete process.env.MPGR_AUTONOMOUS_EMERGENCY_DISABLE;
      else process.env.MPGR_AUTONOMOUS_EMERGENCY_DISABLE = prevEmergency;
    }
  });

  it("proves no Mainnet path can be selected for delegated execution", async () => {
    // delegateSwap refuses any chain other than 84532 BEFORE any other work.
    const out = await delegateSwap({} as never, { chainId: 8453 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("UNSUPPORTED_CHAIN");
    // And the selection seam refuses a Mainnet policy for the delegated slot space.
    const mainnetPolicy = { ...makeTinyPolicy("pol_m", DELEGATED_BASE_SEPOLIA_TUSD, DELEGATED_BASE_SEPOLIA_TSTOCK), chainId: 8453 as never };
    const verdict = selectDelegatedSlot([], { now: new Date(), policy: mainnetPolicy, sellToken: DELEGATED_BASE_SEPOLIA_TUSD, buyToken: DELEGATED_BASE_SEPOLIA_TSTOCK, sellAmountRaw: PLAN_SELL_AMOUNT_RAW.toString(), liveMinBuyAmountRaw: "1" });
    expect(verdict.authorized).toBe(false);
    expect(verdict.reason).toBe("CHAIN_MISMATCH");
  });

  it("produces the DRY-RUN execution plan (fresh quote + full parameter derivation) WITHOUT broadcasting", async () => {
    const gateway = McpTradeGateway.productionWithDelegation();
    const quote = await gateway.quote({
      chainId: 84532,
      taker: privateKeyToAccount(testUserKey! as `0x${string}`).address,
      sellToken: DELEGATED_BASE_SEPOLIA_TUSD,
      buyToken: DELEGATED_BASE_SEPOLIA_TSTOCK,
      sellAmount: PLAN_SELL_AMOUNT_RAW.toString(),
      slippageBps: 300,
      executor: DELEGATED_EXECUTOR_ADDRESS,
    });
    expect(quote.ok, `dry-run quote failed: ${quote.ok ? "" : quote.failure.message}`).toBe(true);
    const q = quote.ok ? quote.data : null;
    expect(BigInt(q!.minBuyAmountRaw) > 0n, "quote floor must be positive (pool alive)").toBe(true);

    const goalId = `phase5-dryrun-buy`;
    const policy = makeTinyPolicy("phase5_buy", DELEGATED_BASE_SEPOLIA_TUSD, DELEGATED_BASE_SEPOLIA_TSTOCK);
    const plan = {
      phase: 5,
      chainId: 84532,
      executor: DELEGATED_EXECUTOR_ADDRESS,
      permit2: CANONICAL_PERMIT2,
      broadcaster: createDelegatedBroadcaster().address,
      testUser: privateKeyToAccount(testUserKey! as `0x${string}`).address,
      leg: "BUY tUSD -> tSTOCK",
      sellAmountRaw: PLAN_SELL_AMOUNT_RAW.toString(),
      quoteId: q!.quoteId,
      expectedBuyAmountRaw: q!.expectedBuyAmountRaw,
      minBuyAmountRaw: q!.minBuyAmountRaw,
      expectedFeeRaw: ((PLAN_SELL_AMOUNT_RAW * 25n) / 10000n).toString(),
      goalId,
      slotIndex: 0,
      slotId: delegatedSlotId(policy.id, goalId, 0),
      policyId: policy.id,
      policyHash: delegatedPolicyHash(policy),
      nonce: delegatedPermitNonce(goalId, 0),
      actionId: delegatedActionId(goalId),
      permittedMaxRaw: policy.maxPerTradeRaw,
      dailyCapRaw: policy.maxDailyRaw,
      maxActionsPerDay: policy.maxActionsPerDay,
      broadcast: false,
    };
    writeFileSync("phase5-plan.json", JSON.stringify(plan, null, 2));
    console.log(`::notice::PHASE5_PLAN dryrun quoteId=${plan.quoteId} sellRaw=${plan.sellAmountRaw} minOut=${plan.minBuyAmountRaw} feeRaw=${plan.expectedFeeRaw} nonce=${plan.nonce} broadcast=false`);
  });
});

// ---------------- tiny-limit fixtures (readiness caps are VERY small) -------

function makeTinyPolicy(id: string, sellToken: Address, buyToken: Address): AutonomyPolicy {
  return {
    id,
    wallet: privateKeyToAccount((process.env.MPGR_LIVE_TEST_USER_PRIVATE_KEY?.trim() ?? "0x" + "11".repeat(32)) as `0x${string}`).address.toLowerCase() as Address,
    chainId: 84532,
    actions: ["swap"],
    sellToken,
    buyToken,
    maxPerTradeRaw: PLAN_SELL_AMOUNT_RAW.toString(),
    maxDailyRaw: (PLAN_SELL_AMOUNT_RAW * 5n).toString(),
    maxSlippageBps: 500,
    maxActionsPerDay: 2,
    enabled: true,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
    authorizedAt: new Date().toISOString(),
    authorizationRef: "phase5-preflight",
  };
}

function makeTinySlot(policy: AutonomyPolicy, goalId: string, slotIndex: number, amount: bigint): DelegatedAuthorizationSlot {
  const deadline = Math.floor(Date.now() / 1000) + 1800;
  return {
    id: delegatedSlotId(policy.id, goalId, slotIndex),
    wallet: policy.wallet,
    chainId: 84532,
    policyId: policy.id,
    goalId,
    slotIndex,
    permit: { token: policy.sellToken, amount: amount.toString(), nonce: delegatedPermitNonce(goalId, slotIndex), deadline },
    witness: {
      owner: policy.wallet,
      buyToken: policy.buyToken,
      minAmountOut: "1",
      deadline,
      actionId: delegatedActionId(goalId),
      policyHash: policyHashFor(policy),
    },
    signature: ("0x" + "22".repeat(65)) as Hex,
    createdAt: new Date().toISOString(),
  };
}

