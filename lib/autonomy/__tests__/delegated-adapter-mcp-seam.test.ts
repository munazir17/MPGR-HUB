// lib/autonomy/__tests__/delegated-adapter-mcp-seam.test.ts
//
// PHASE 3 SEAM REGRESSION: DelegatedExecutionAdapter -> REAL McpTradeGateway
// -> REAL delegateSwap (parse + fee gate + encodeFunctionData) -> stubbed
// broadcaster. The adapter's own unit tests mock the gateway and the service
// tests hand-build their inputs, so this seam had zero coverage until the
// live run caught a real serialization mismatch there (deadline number vs
// digit-string wire format). This test makes that seam permanent.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { DelegatedExecutionAdapter } from "@/lib/autonomy/delegated-execution-adapter";
import { allowAutonomousEmergencySwitchForTests } from "@/lib/autonomy/emergency-switch";
import { InMemoryDelegatedAuthorizationStore } from "@/lib/autonomy/delegated-authorization";
import { McpTradeGateway } from "@/lib/autonomy/mcp-gateway";
import type { AutonomyPolicy, DelegatedSwapRequest } from "@/lib/autonomy/types";
import {
  CANONICAL_PERMIT2,
  DELEGATED_EXECUTOR_ABI,
  DELEGATED_WITNESS_TYPE_STRING,
  delegatedActionId,
  delegatedPermitNonce,
  delegatedPermitTypedData,
  delegatedPolicyHash,
} from "@/lib/executor/delegated-executor";
import { newFakeState, TEST_SECRET, testDeps } from "@/lib/mcp/__tests__/fixtures";

const USER = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;
const SELL = privateKeyToAccount(generatePrivateKey()).address as Address; // arbitrary test token
const BUY = privateKeyToAccount(generatePrivateKey()).address as Address;
const GOAL = "seam-goal-1";
const AMOUNT = "100000000"; // 100 x 6dp

function makePolicy(): AutonomyPolicy {
  return {
    id: "seam-policy",
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
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    authorizedAt: new Date().toISOString(),
    authorizationRef: "seam-test",
  };
}

async function signSlot(store: InMemoryDelegatedAuthorizationStore, policy: AutonomyPolicy) {
  const deadline = Math.floor(Date.now() / 1000) + 1800;
  const permit = { token: SELL, amount: AMOUNT, nonce: delegatedPermitNonce(GOAL, 0), deadline };
  const witness = {
    owner: USER,
    buyToken: BUY,
    minAmountOut: "1",
    deadline,
    actionId: delegatedActionId(GOAL),
    policyHash: delegatedPolicyHash({
      id: policy.id,
      wallet: policy.wallet,
      chainId: policy.chainId,
      sellToken: policy.sellToken,
      buyToken: policy.buyToken,
      maxPerTradeRaw: policy.maxPerTradeRaw,
      maxSlippageBps: policy.maxSlippageBps,
      expiresAt: policy.expiresAt,
    }),
  };
  const user = privateKeyToAccount(generatePrivateKey());
  // NOTE: the signature itself is verified ON-CHAIN by the executor; the seam
  // under test is the adapter->gateway->service serialization, so a locally
  // consistent wallet signature over the SAME typed data keeps the evidence real.
  const typed = delegatedPermitTypedData({ permit, witness }, 84532, USER);
  const signature = await privateKeyToAccount(generatePrivateKey()).signTypedData({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
  } as Parameters<ReturnType<typeof privateKeyToAccount>["signTypedData"]>[0]);
  await store.saveSlots([
    {
      id: `slot-${GOAL}-0`,
      wallet: USER,
      chainId: 84532,
      policyId: policy.id,
      goalId: GOAL,
      slotIndex: 0,
      permit,
      witness,
      signature,
      createdAt: new Date().toISOString(),
    },
  ]);
  return { permit, witness };
}

describe("adapter -> MCP delegateSwap seam (REAL gateway, stubbed broadcaster)", () => {
  let savedFlag: string | undefined;
  let savedEmergency: string | undefined;

  beforeEach(() => {
    savedFlag = process.env.MPGR_AUTONOMOUS_AGENT_ENABLED;
    savedEmergency = process.env.MPGR_AUTONOMOUS_EMERGENCY_DISABLE;
    process.env.MPGR_AUTONOMOUS_AGENT_ENABLED = "true";
    delete process.env.MPGR_AUTONOMOUS_EMERGENCY_DISABLE;
    allowAutonomousEmergencySwitchForTests();
  });
  afterEach(() => {
    if (savedFlag === undefined) delete process.env.MPGR_AUTONOMOUS_AGENT_ENABLED;
    else process.env.MPGR_AUTONOMOUS_AGENT_ENABLED = savedFlag;
    if (savedEmergency === undefined) delete process.env.MPGR_AUTONOMOUS_EMERGENCY_DISABLE;
    else process.env.MPGR_AUTONOMOUS_EMERGENCY_DISABLE = savedEmergency;
  });

  it("broadcasts a correctly-encoded swapOnBehalfOfUniswapV3 from an adapter-produced authorization", async () => {
    const policy = makePolicy();
    const slots = new InMemoryDelegatedAuthorizationStore();
    const { permit } = await signSlot(slots, policy);

    const broadcasts: { to: Address; data: Hex; chainId: number }[] = [];
    const gateway = new McpTradeGateway(
      testDeps(newFakeState(), {
        quoteSecret: TEST_SECRET,
        delegatedBroadcaster: async (tx) => {
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
      // The adapter's operational posture requires a broadcaster to exist;
      // the ACTUAL broadcast still flows through gateway.delegateSwap's
      // delegatedBroadcaster (stubbed above) — same as production.
      broadcast: async () => ("0x" + "cd".repeat(32)) as `0x${string}`,
    });

    const request: DelegatedSwapRequest = {
      goalId: GOAL,
      policyId: policy.id,
      wallet: USER,
      chainId: 84532,
      quoteId: "seam-quote",
      sellToken: SELL,
      buyToken: BUY,
      sellAmountRaw: AMOUNT,
      expectedBuyAmountRaw: "2",
      minBuyAmountRaw: "1",
      slippageBps: 100,
      idempotencyKey: `${GOAL}-exec`,
      steps: [],
      transactionRequest: null,
    };

    const result = await adapter.executeSwap(request);
    expect(result.ok, `executeSwap failed: ${result.ok ? "" : result.message}`).toBe(true);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]!.to).toBe("0xa9568499D7e58854F2590a56B6D32788DbfA58F9");
    expect(broadcasts[0]!.chainId).toBe(84532);

    // Strict decode: the wire format carries the EXACT slot values.
    const { args } = decodeFunctionData({
      abi: DELEGATED_EXECUTOR_ABI,
      data: broadcasts[0]!.data,
    }) as unknown as { args: [Record<string, unknown>, number, { permit: { nonce: bigint; deadline: bigint }; witness: Record<string, unknown> }] };
    const params = args[0]!;
    const auth = args[2]!;
    expect(args[1]).toBe(3000); // the delegated registry's pool fee
    expect(params.grossAmountIn).toBe(BigInt(AMOUNT));
    expect(params.expectedFeeAmount).toBe((BigInt(AMOUNT) * 25n) / 10000n); // exact 25 bps, integer math
    expect(params.deadline).toBe(BigInt(permit.deadline));
    expect(auth.permit.deadline).toBe(BigInt(permit.deadline));
    expect(auth.permit.nonce).toBe(BigInt(permit.nonce));
  });
});
