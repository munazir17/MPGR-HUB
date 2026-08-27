import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, type Address, type Hex } from "viem";

import { buildAgentActionContract, type AgentActionContract } from "../agent-action-contract";
import { erc20Abi } from "@/lib/erc20-abi";
import { TOKEN_LOCK_ABI } from "@/lib/token-lock/token-lock-abi";
import { MPGR_TOKEN_LOCK_CONFIG } from "@/lib/token-lock/token-lock-config";
import { STAKING_ABI } from "@/lib/staking/staking-abi";
import { MPGR_STAKING_CONFIG } from "@/lib/staking/staking-config";
import { REWARD_VAULT_ABI } from "@/lib/reward-vault/reward-vault-abi";

const mockSimulateContract = vi.fn();
vi.mock("wagmi/actions", () => ({
  simulateContract: (...args: unknown[]) => mockSimulateContract(...args),
}));
vi.mock("@/lib/wagmi", () => ({ config: {} }));

// Imported AFTER the mocks above so the module under test picks them up.
const { verifyAgentAction, simulateAgentAction } = await import("../agent-action-simulation");

const future = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
const SOME_ACCOUNT = "0x1111111111111111111111111111111111111111" as const;
const ATTACKER = "0xBADBEEF0BADBEEF0BADBEEF0BADBEEF0BADBEEF0" as const;

function mustBuild(input: Parameters<typeof buildAgentActionContract>[0]): AgentActionContract {
  const result = buildAgentActionContract(input);
  if (!result.ok) throw new Error(`test setup failed to build action: ${result.error.code} ${result.error.message}`);
  return result.action;
}

beforeEach(() => {
  mockSimulateContract.mockReset();
});

describe("verifyAgentAction — valid decodes (1-11)", () => {
  it("1. tokenLock createLock", () => {
    const action = mustBuild({
      domain: "tokenLock",
      actionType: "createLock",
      params: { amount: "1000000000000000000", unlockTime: String(future) },
    });
    const result = verifyAgentAction(action);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decoded.functionName).toBe("createLock");
    expect(result.decoded.args).toEqual([1000000000000000000n, BigInt(future)]);
  });

  it("2. tokenLock withdraw", () => {
    const action = mustBuild({ domain: "tokenLock", actionType: "withdraw", params: { lockId: 4 } });
    const result = verifyAgentAction(action);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decoded.functionName).toBe("withdraw");
    expect(result.decoded.args).toEqual([4n]);
  });

  it("3. tokenLock earlyUnlock", () => {
    const action = mustBuild({ domain: "tokenLock", actionType: "earlyUnlock", params: { lockId: 4 } });
    const result = verifyAgentAction(action);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decoded.functionName).toBe("earlyUnlock");
  });

  it("4. tokenLock approve", () => {
    const action = mustBuild({ domain: "tokenLock", actionType: "approve", params: { amount: 100 } });
    const result = verifyAgentAction(action);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decoded.functionName).toBe("approve");
    expect((result.decoded.args[0] as string).toLowerCase()).toBe(MPGR_TOKEN_LOCK_CONFIG.address.toLowerCase());
  });

  it("5. staking approve", () => {
    const action = mustBuild({ domain: "staking", actionType: "approve", params: { amount: 100 } });
    const result = verifyAgentAction(action);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.decoded.args[0] as string).toLowerCase()).toBe(MPGR_STAKING_CONFIG.address.toLowerCase());
  });

  it("6. staking stake", () => {
    const action = mustBuild({ domain: "staking", actionType: "stake", params: { amount: 100 } });
    const result = verifyAgentAction(action);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decoded.functionName).toBe("stake");
  });

  it("7. staking unstake", () => {
    const action = mustBuild({ domain: "staking", actionType: "unstake", params: { amount: 100 } });
    const result = verifyAgentAction(action);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decoded.functionName).toBe("unstake");
  });

  it("8. staking claim maps to claimRewards", () => {
    const action = mustBuild({ domain: "staking", actionType: "claim", params: {} });
    const result = verifyAgentAction(action);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decoded.functionName).toBe("claimRewards");
  });

  it("9. staking exit", () => {
    const action = mustBuild({ domain: "staking", actionType: "exit", params: {} });
    const result = verifyAgentAction(action);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decoded.functionName).toBe("exit");
  });

  it("10. rewardVault claim", () => {
    const action = mustBuild({ domain: "rewardVault", actionType: "claim", params: { rewardId: 7 } });
    const result = verifyAgentAction(action);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decoded.functionName).toBe("claim");
    expect(result.decoded.args).toEqual([7n]);
  });

  it("11. rewardVault claimMultiple", () => {
    const action = mustBuild({ domain: "rewardVault", actionType: "claimMultiple", params: { rewardIds: [1, 2, 3] } });
    const result = verifyAgentAction(action);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decoded.functionName).toBe("claimMultiple");
    expect(result.decoded.args).toEqual([[1n, 2n, 3n]]);
  });
});

describe("verifyAgentAction — mutation / regression (12-25)", () => {
  it("12. mutated `to` rejected", () => {
    const action = mustBuild({ domain: "staking", actionType: "stake", params: { amount: 100 } });
    const mutated: AgentActionContract = { ...action, to: ATTACKER as Address };
    const result = verifyAgentAction(mutated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_DESTINATION");
  });

  it("12b. non-string/malformed `to` never throws and returns INVALID_DESTINATION", () => {
    const action = mustBuild({ domain: "staking", actionType: "stake", params: { amount: 100 } });

    const nonString: AgentActionContract = { ...action, to: 12345 as unknown as Address };
    expect(() => verifyAgentAction(nonString)).not.toThrow();
    const nonStringResult = verifyAgentAction(nonString);
    expect(nonStringResult.ok).toBe(false);
    if (!nonStringResult.ok) expect(nonStringResult.error.code).toBe("INVALID_DESTINATION");

    const malformedString: AgentActionContract = { ...action, to: "not-an-address" as Address };
    expect(() => verifyAgentAction(malformedString)).not.toThrow();
    const malformedResult = verifyAgentAction(malformedString);
    expect(malformedResult.ok).toBe(false);
    if (!malformedResult.ok) expect(malformedResult.error.code).toBe("INVALID_DESTINATION");
  });

  it("13. mutated calldata selector (entirely different function) rejected", () => {
    const action = mustBuild({ domain: "staking", actionType: "stake", params: { amount: 100 } });
    const mutatedData = encodeFunctionData({ abi: STAKING_ABI, functionName: "unstake", args: [100n] });
    const mutated: AgentActionContract = { ...action, data: mutatedData };
    const result = verifyAgentAction(mutated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("UNSUPPORTED_FUNCTION");
  });

  it("14. mutated approve spender rejected", () => {
    const action = mustBuild({ domain: "staking", actionType: "approve", params: { amount: 100 } });
    const mutatedData = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ATTACKER as Address, 100n] });
    const mutated: AgentActionContract = { ...action, data: mutatedData };
    const result = verifyAgentAction(mutated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PARAMETER_MISMATCH");
  });

  it("15. mutated amount rejected", () => {
    const action = mustBuild({ domain: "staking", actionType: "stake", params: { amount: 100 } });
    const mutatedData = encodeFunctionData({ abi: STAKING_ABI, functionName: "stake", args: [999n] });
    const mutated: AgentActionContract = { ...action, data: mutatedData };
    const result = verifyAgentAction(mutated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PARAMETER_MISMATCH");
  });

  it("16. mutated lockId rejected", () => {
    const action = mustBuild({ domain: "tokenLock", actionType: "withdraw", params: { lockId: 4 } });
    const mutatedData = encodeFunctionData({ abi: TOKEN_LOCK_ABI, functionName: "withdraw", args: [999n] });
    const mutated: AgentActionContract = { ...action, data: mutatedData };
    const result = verifyAgentAction(mutated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PARAMETER_MISMATCH");
  });

  it("17. mutated unlockTime rejected", () => {
    const action = mustBuild({
      domain: "tokenLock",
      actionType: "createLock",
      params: { amount: "1000000000000000000", unlockTime: String(future) },
    });
    const mutatedData = encodeFunctionData({
      abi: TOKEN_LOCK_ABI,
      functionName: "createLock",
      args: [1000000000000000000n, BigInt(future) + 999999n],
    });
    const mutated: AgentActionContract = { ...action, data: mutatedData };
    const result = verifyAgentAction(mutated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PARAMETER_MISMATCH");
  });

  it("18. mutated rewardId rejected", () => {
    const action = mustBuild({ domain: "rewardVault", actionType: "claim", params: { rewardId: 7 } });
    const mutatedData = encodeFunctionData({ abi: REWARD_VAULT_ABI, functionName: "claim", args: [999n] });
    const mutated: AgentActionContract = { ...action, data: mutatedData };
    const result = verifyAgentAction(mutated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PARAMETER_MISMATCH");
  });

  it("19. mutated rewardIds rejected", () => {
    const action = mustBuild({ domain: "rewardVault", actionType: "claimMultiple", params: { rewardIds: [1, 2, 3] } });
    const mutatedData = encodeFunctionData({ abi: REWARD_VAULT_ABI, functionName: "claimMultiple", args: [[9n, 9n, 9n]] });
    const mutated: AgentActionContract = { ...action, data: mutatedData };
    const result = verifyAgentAction(mutated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PARAMETER_MISMATCH");
  });

  it("20. non-zero value rejected", () => {
    const action = mustBuild({ domain: "staking", actionType: "stake", params: { amount: 100 } });
    const mutated: AgentActionContract = { ...action, value: 1n };
    const result = verifyAgentAction(mutated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_VALUE");
  });

  it("21. unsupported chain rejected", () => {
    const action = mustBuild({ domain: "staking", actionType: "stake", params: { amount: 100 } });
    const mutated: AgentActionContract = { ...action, chainId: 1 };
    const result = verifyAgentAction(mutated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CHAIN");
  });

  it("22. malformed calldata rejected", () => {
    const action = mustBuild({ domain: "staking", actionType: "stake", params: { amount: 100 } });
    const mutated: AgentActionContract = { ...action, data: "0xdeadbeef" as Hex };
    const result = verifyAgentAction(mutated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CALLDATA");
  });

  it("23. unsupported function rejected (already covered structurally by #13, re-asserted against a different domain)", () => {
    const action = mustBuild({ domain: "tokenLock", actionType: "withdraw", params: { lockId: 1 } });
    const mutatedData = encodeFunctionData({ abi: TOKEN_LOCK_ABI, functionName: "earlyUnlock", args: [1n] });
    const mutated: AgentActionContract = { ...action, data: mutatedData };
    const result = verifyAgentAction(mutated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("UNSUPPORTED_FUNCTION");
  });

  it("24. action/domain mismatch rejected", () => {
    const action = mustBuild({ domain: "staking", actionType: "stake", params: { amount: 100 } });
    // Simulate a malformed/tampered object where domain and actionType
    // disagree — something the type system prevents but a raw
    // JSON-round-tripped object could not.
    const malformed = { ...action, domain: "staking", actionType: "createLock", params: { actionType: "createLock" } } as unknown as AgentActionContract;
    const result = verifyAgentAction(malformed);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_ACTION");
  });

  it("24b. envelope actionType diverging from params.actionType rejected, even when both individually look valid", () => {
    // The subtler version of #24: action.actionType claims "earlyUnlock"
    // (what a confirmation UI would display/key off), but params —
    // and the real, untouched calldata — are still the original
    // "withdraw". Neither half is malformed on its own; only comparing
    // them against each other catches this. Must not silently resolve
    // using params.actionType and report success as "earlyUnlock".
    const withdrawAction = mustBuild({ domain: "tokenLock", actionType: "withdraw", params: { lockId: 4 } });
    const malformed = { ...withdrawAction, actionType: "earlyUnlock" } as unknown as AgentActionContract;
    const result = verifyAgentAction(malformed);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PARAMETER_MISMATCH");
  });

  it("25. decoded calldata not matching P0.3 params rejected (amount changed, everything else consistent)", () => {
    const a = mustBuild({ domain: "staking", actionType: "stake", params: { amount: 100 } });
    const b = mustBuild({ domain: "staking", actionType: "stake", params: { amount: 200 } });
    // Take action `a`'s envelope but swap in `b`'s calldata — params still
    // claim amount 100, but the real calldata now says 200.
    const mutated: AgentActionContract = { ...a, data: b.data };
    const result = verifyAgentAction(mutated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PARAMETER_MISMATCH");
  });
});

describe("simulateAgentAction — read-only simulation (26-28)", () => {
  it("26. simulation failure produces a typed failure, not a thrown exception", async () => {
    mockSimulateContract.mockRejectedValueOnce(new Error("execution reverted: some raw provider detail"));
    const action = mustBuild({ domain: "staking", actionType: "stake", params: { amount: 100 } });
    const result = await simulateAgentAction(action, { account: SOME_ACCOUNT });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SIMULATION_FAILED");
    expect(result.error.message).not.toContain("raw provider detail");
  });

  it("27. missing account produces a typed failure and never calls simulateContract", async () => {
    const action = mustBuild({ domain: "staking", actionType: "stake", params: { amount: 100 } });
    const result = await simulateAgentAction(action, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ACCOUNT_REQUIRED");
    expect(mockSimulateContract).not.toHaveBeenCalled();
  });

  it("27b. a verification failure short-circuits before simulation is ever attempted", async () => {
    const action = mustBuild({ domain: "staking", actionType: "stake", params: { amount: 100 } });
    const mutated: AgentActionContract = { ...action, to: ATTACKER as Address };
    const result = await simulateAgentAction(mutated, { account: SOME_ACCOUNT });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_DESTINATION");
    expect(mockSimulateContract).not.toHaveBeenCalled();
  });

  it("28a. successful simulation reports safeToProceed", async () => {
    mockSimulateContract.mockResolvedValueOnce({ request: {}, result: undefined });
    const action = mustBuild({ domain: "staking", actionType: "stake", params: { amount: 100 } });
    const result = await simulateAgentAction(action, { account: SOME_ACCOUNT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.simulated).toBe(true);
    expect(result.safeToProceed).toBe(true);
  });

  it("28b. the P0.4 module source never references an execution/broadcast API", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "agent-action-simulation.ts"), "utf8");
    expect(source).not.toMatch(/writeContract\s*\(/);
    expect(source).not.toMatch(/sendTransaction\s*\(/);
    expect(source).not.toMatch(/signTransaction\s*\(/);
    expect(source).not.toMatch(/walletClient\s*\./);
  });
});

