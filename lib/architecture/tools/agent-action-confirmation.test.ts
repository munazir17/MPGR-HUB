import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";

import { buildAgentActionContract, type AgentActionContract } from "./agent-action-contract";
import type {
  AgentActionSimulationResult,
  AgentActionVerificationResult,
  DecodedAgentAction,
} from "./agent-action-simulation";
import { MPGR_REWARD_VAULT_CONFIG } from "@/lib/reward-vault/reward-vault-config";

// Mock ONLY P0.4's exported functions.
// P0.4's verification/simulation logic is never reimplemented here.
const { mockVerifyAgentAction, mockSimulateAgentAction } = vi.hoisted(() => ({
  mockVerifyAgentAction: vi.fn(),
  mockSimulateAgentAction: vi.fn(),
}));

vi.mock("./agent-action-simulation", () => ({
  verifyAgentAction: (...args: unknown[]) => mockVerifyAgentAction(...args),
  simulateAgentAction: (...args: unknown[]) => mockSimulateAgentAction(...args),
}));

const { runAgentActionConfirmation, idleConfirmationSnapshot } = await import(
  "./agent-action-confirmation"
);

const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;

function mustBuild(
  input: Parameters<typeof buildAgentActionContract>[0]
): AgentActionContract {
  const result = buildAgentActionContract(input);

  if (!result.ok) {
    throw new Error(
      `test setup failed to build action: ${result.error.code} ${result.error.message}`
    );
  }

  return result.action;
}

const STAKING_CLAIM_ACTION = mustBuild({
  domain: "staking",
  actionType: "claim",
  params: {},
});

const REWARD_VAULT_CLAIM_ACTION = mustBuild({
  domain: "rewardVault",
  actionType: "claim",
  params: { rewardId: 42 },
});

const DECODED_CLAIM: DecodedAgentAction = {
  domain: "staking",
  actionType: "claim",
  functionName: "claimRewards",
  args: [],
  to: STAKING_CLAIM_ACTION.to,
  value: 0n,
  chainId: STAKING_CLAIM_ACTION.chainId,
};

beforeEach(() => {
  mockVerifyAgentAction.mockReset();
  mockSimulateAgentAction.mockReset();
});

describe("runAgentActionConfirmation", () => {
  it("1. missing account -> WALLET_REQUIRED and never calls P0.4", async () => {
    const transitions: string[] = [];

    const result = await runAgentActionConfirmation(
      STAKING_CLAIM_ACTION,
      undefined,
      (snapshot) => transitions.push(snapshot.state)
    );

    expect(result.state).toBe("WALLET_REQUIRED");
    expect(transitions).toEqual(["WALLET_REQUIRED"]);

    expect(mockVerifyAgentAction).not.toHaveBeenCalled();
    expect(mockSimulateAgentAction).not.toHaveBeenCalled();
  });

  it("2. malformed account -> WALLET_REQUIRED and never calls P0.4", async () => {
    const transitions: string[] = [];

    const result = await runAgentActionConfirmation(
      STAKING_CLAIM_ACTION,
      "not-an-address" as Address,
      (snapshot) => transitions.push(snapshot.state)
    );

    expect(result.state).toBe("WALLET_REQUIRED");
    expect(transitions).toEqual(["WALLET_REQUIRED"]);

    expect(mockVerifyAgentAction).not.toHaveBeenCalled();
    expect(mockSimulateAgentAction).not.toHaveBeenCalled();
  });

  it("3. verification starts before simulation", async () => {
    mockVerifyAgentAction.mockReturnValue({
      ok: true,
      decoded: DECODED_CLAIM,
    } satisfies AgentActionVerificationResult);

    mockSimulateAgentAction.mockResolvedValue({
      ok: true,
      decoded: DECODED_CLAIM,
      simulated: true,
      safeToProceed: true,
    } satisfies AgentActionSimulationResult);

    await runAgentActionConfirmation(
      STAKING_CLAIM_ACTION,
      ACCOUNT,
      () => {}
    );

    expect(mockVerifyAgentAction).toHaveBeenCalled();
    expect(mockSimulateAgentAction).toHaveBeenCalled();

    expect(
      mockVerifyAgentAction.mock.invocationCallOrder[0]
    ).toBeLessThan(
      mockSimulateAgentAction.mock.invocationCallOrder[0]
    );
  });

  it("4. verification failure -> VERIFICATION_FAILED and prevents simulation", async () => {
    mockVerifyAgentAction.mockReturnValue({
      ok: false,
      error: {
        code: "INVALID_DESTINATION",
        message: "bad destination",
      },
    } satisfies AgentActionVerificationResult);

    const transitions: string[] = [];

    const result = await runAgentActionConfirmation(
      STAKING_CLAIM_ACTION,
      ACCOUNT,
      (snapshot) => transitions.push(snapshot.state)
    );

    expect(result.state).toBe("VERIFICATION_FAILED");
    expect(result.error).toEqual({
      code: "INVALID_DESTINATION",
      message: "bad destination",
    });

    expect(transitions).toEqual([
      "VERIFYING",
      "VERIFICATION_FAILED",
    ]);

    expect(mockSimulateAgentAction).not.toHaveBeenCalled();
  });

  it("5. successful verification -> VERIFIED -> SIMULATING", async () => {
    mockVerifyAgentAction.mockReturnValue({
      ok: true,
      decoded: DECODED_CLAIM,
    } satisfies AgentActionVerificationResult);

    mockSimulateAgentAction.mockResolvedValue({
      ok: true,
      decoded: DECODED_CLAIM,
      simulated: true,
      safeToProceed: true,
    } satisfies AgentActionSimulationResult);

    const transitions: string[] = [];

    await runAgentActionConfirmation(
      STAKING_CLAIM_ACTION,
      ACCOUNT,
      (snapshot) => transitions.push(snapshot.state)
    );

    expect(transitions).toEqual([
      "VERIFYING",
      "VERIFIED",
      "SIMULATING",
      "SIMULATED",
      "READY_FOR_CONFIRMATION",
    ]);
  });

  it("6. simulation failure -> SIMULATION_FAILED", async () => {
    mockVerifyAgentAction.mockReturnValue({
      ok: true,
      decoded: DECODED_CLAIM,
    } satisfies AgentActionVerificationResult);

    mockSimulateAgentAction.mockResolvedValue({
      ok: false,
      decoded: DECODED_CLAIM,
      error: {
        code: "SIMULATION_FAILED",
        message: "would revert",
      },
    } satisfies AgentActionSimulationResult);

    const result = await runAgentActionConfirmation(
      STAKING_CLAIM_ACTION,
      ACCOUNT,
      () => {}
    );

    expect(result.state).toBe("SIMULATION_FAILED");
    expect(result.error).toEqual({
      code: "SIMULATION_FAILED",
      message: "would revert",
    });
    expect(result.decoded).toEqual(DECODED_CLAIM);
  });

  it("7. simulation success without safeToProceed cannot reach READY_FOR_CONFIRMATION", async () => {
    mockVerifyAgentAction.mockReturnValue({
      ok: true,
      decoded: DECODED_CLAIM,
    } satisfies AgentActionVerificationResult);

    // Deliberately malformed relative to P0.4's literal-true return type.
    // This tests P0.5's defensive runtime gate.
    mockSimulateAgentAction.mockResolvedValue({
      ok: true,
      decoded: DECODED_CLAIM,
      simulated: true,
      safeToProceed: false,
    } as unknown as AgentActionSimulationResult);

    const transitions: string[] = [];

    const result = await runAgentActionConfirmation(
      STAKING_CLAIM_ACTION,
      ACCOUNT,
      (snapshot) => transitions.push(snapshot.state)
    );

    expect(result.state).toBe("SIMULATION_FAILED");
    expect(result.state).not.toBe("READY_FOR_CONFIRMATION");

    expect(transitions).toContain("SIMULATING");
    expect(transitions).toContain("SIMULATION_FAILED");
    expect(transitions).not.toContain("READY_FOR_CONFIRMATION");
  });

  it("8. successful simulation -> SIMULATED", async () => {
    mockVerifyAgentAction.mockReturnValue({
      ok: true,
      decoded: DECODED_CLAIM,
    } satisfies AgentActionVerificationResult);

    mockSimulateAgentAction.mockResolvedValue({
      ok: true,
      decoded: DECODED_CLAIM,
      simulated: true,
      safeToProceed: true,
    } satisfies AgentActionSimulationResult);

    const transitions: string[] = [];

    await runAgentActionConfirmation(
      STAKING_CLAIM_ACTION,
      ACCOUNT,
      (snapshot) => transitions.push(snapshot.state)
    );

    expect(transitions).toContain("SIMULATED");
  });

  it("9. successful simulation -> READY_FOR_CONFIRMATION with decoded P0.4 data", async () => {
    mockVerifyAgentAction.mockReturnValue({
      ok: true,
      decoded: DECODED_CLAIM,
    } satisfies AgentActionVerificationResult);

    mockSimulateAgentAction.mockResolvedValue({
      ok: true,
      decoded: DECODED_CLAIM,
      simulated: true,
      safeToProceed: true,
    } satisfies AgentActionSimulationResult);

    const result = await runAgentActionConfirmation(
      STAKING_CLAIM_ACTION,
      ACCOUNT,
      () => {}
    );

    expect(result.state).toBe("READY_FOR_CONFIRMATION");
    expect(result.decoded).toEqual(DECODED_CLAIM);
    expect(result.error).toBeNull();
  });

  it("10. READY_FOR_CONFIRMATION exposes the exact P0.4 decoded object", async () => {
    mockVerifyAgentAction.mockReturnValue({
      ok: true,
      decoded: DECODED_CLAIM,
    } satisfies AgentActionVerificationResult);

    mockSimulateAgentAction.mockResolvedValue({
      ok: true,
      decoded: DECODED_CLAIM,
      simulated: true,
      safeToProceed: true,
    } satisfies AgentActionSimulationResult);

    const result = await runAgentActionConfirmation(
      STAKING_CLAIM_ACTION,
      ACCOUNT,
      () => {}
    );

    expect(result.decoded).toBe(DECODED_CLAIM);
  });

  it("11. staking claim displays actual on-chain functionName claimRewards", async () => {
    mockVerifyAgentAction.mockReturnValue({
      ok: true,
      decoded: DECODED_CLAIM,
    } satisfies AgentActionVerificationResult);

    mockSimulateAgentAction.mockResolvedValue({
      ok: true,
      decoded: DECODED_CLAIM,
      simulated: true,
      safeToProceed: true,
    } satisfies AgentActionSimulationResult);

    const result = await runAgentActionConfirmation(
      STAKING_CLAIM_ACTION,
      ACCOUNT,
      () => {}
    );

    expect(result.decoded?.actionType).toBe("claim");
    expect(result.decoded?.functionName).toBe("claimRewards");
  });

  it("12. decoded arguments come from P0.4 output unmodified", async () => {
    const decodedWithArgs: DecodedAgentAction = {
      domain: "rewardVault",
      actionType: "claim",
      functionName: "claim",
      args: [42n],
      to: REWARD_VAULT_CLAIM_ACTION.to,
      value: 0n,
      chainId: REWARD_VAULT_CLAIM_ACTION.chainId,
    };

    mockVerifyAgentAction.mockReturnValue({
      ok: true,
      decoded: decodedWithArgs,
    } satisfies AgentActionVerificationResult);

    mockSimulateAgentAction.mockResolvedValue({
      ok: true,
      decoded: decodedWithArgs,
      simulated: true,
      safeToProceed: true,
    } satisfies AgentActionSimulationResult);

    const result = await runAgentActionConfirmation(
      REWARD_VAULT_CLAIM_ACTION,
      ACCOUNT,
      () => {}
    );

    expect(result.decoded).toBe(decodedWithArgs);
    expect(result.decoded?.domain).toBe("rewardVault");
    expect(result.decoded?.actionType).toBe("claim");
    expect(result.decoded?.functionName).toBe("claim");
    expect(result.decoded?.args).toEqual([42n]);
    expect(result.decoded?.to.toLowerCase()).toBe(
      MPGR_REWARD_VAULT_CONFIG.address.toLowerCase()
    );
  });

  it("13. typed simulation errors are preserved without alteration", async () => {
    mockVerifyAgentAction.mockReturnValue({
      ok: true,
      decoded: DECODED_CLAIM,
    } satisfies AgentActionVerificationResult);

    mockSimulateAgentAction.mockResolvedValue({
      ok: false,
      decoded: DECODED_CLAIM,
      error: {
        code: "ACCOUNT_REQUIRED",
        message: "account required",
      },
    } satisfies AgentActionSimulationResult);

    const result = await runAgentActionConfirmation(
      STAKING_CLAIM_ACTION,
      ACCOUNT,
      () => {}
    );

    expect(result.state).toBe("SIMULATION_FAILED");
    expect(result.error).toEqual({
      code: "ACCOUNT_REQUIRED",
      message: "account required",
    });
  });

  it("14. every non-ready transition has no confirmation-ready state", async () => {
    mockVerifyAgentAction.mockReturnValue({
      ok: true,
      decoded: DECODED_CLAIM,
    } satisfies AgentActionVerificationResult);

    mockSimulateAgentAction.mockResolvedValue({
      ok: false,
      decoded: DECODED_CLAIM,
      error: {
        code: "SIMULATION_FAILED",
        message: "would revert",
      },
    } satisfies AgentActionSimulationResult);

    const transitions: string[] = [];

    await runAgentActionConfirmation(
      STAKING_CLAIM_ACTION,
      ACCOUNT,
      (snapshot) => transitions.push(snapshot.state)
    );

    expect(transitions).not.toContain("READY_FOR_CONFIRMATION");
  });

  it("15. reset helper returns IDLE with no decoded/error", () => {
    expect(idleConfirmationSnapshot()).toEqual({
      state: "IDLE",
      decoded: null,
      error: null,
    });
  });

  it("16. module never references execution/broadcast APIs", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");

    const source = fs.readFileSync(
      path.join(__dirname, "agent-action-confirmation.ts"),
      "utf8"
    );

    for (const forbidden of [
      "writeContract(",
      "sendTransaction(",
      "signTransaction(",
      "walletClient.",
      "eth_sendTransaction",
      "sendRawTransaction",
    ]) {
      expect(source.includes(forbidden)).toBe(false);
    }
  });

  it("17. simulation is never attempted when verification fails", async () => {
    mockVerifyAgentAction.mockReturnValue({
      ok: false,
      error: {
        code: "PARAMETER_MISMATCH",
        message: "parameter mismatch",
      },
    } satisfies AgentActionVerificationResult);

    await runAgentActionConfirmation(
      STAKING_CLAIM_ACTION,
      ACCOUNT,
      () => {}
    );

    expect(mockVerifyAgentAction).toHaveBeenCalledTimes(1);
    expect(mockSimulateAgentAction).not.toHaveBeenCalled();
  });

  it("18. malformed account never invokes verification or simulation", async () => {
    const result = await runAgentActionConfirmation(
      STAKING_CLAIM_ACTION,
      "0x123" as Address,
      () => {}
    );

    expect(result.state).toBe("WALLET_REQUIRED");
    expect(mockVerifyAgentAction).not.toHaveBeenCalled();
    expect(mockSimulateAgentAction).not.toHaveBeenCalled();
  });
});
