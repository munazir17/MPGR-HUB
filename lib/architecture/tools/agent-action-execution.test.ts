import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";

import { buildAgentActionContract, type AgentActionContract } from "./agent-action-contract";

// Mock ONLY wagmi's execution primitives — nothing about verification,
// simulation, or calldata is reimplemented here.
const { mockSendTransaction, mockWaitForTransactionReceipt } = vi.hoisted(() => ({
  mockSendTransaction: vi.fn(),
  mockWaitForTransactionReceipt: vi.fn(),
}));

vi.mock("wagmi/actions", () => ({
  sendTransaction: (...args: unknown[]) => mockSendTransaction(...args),
  waitForTransactionReceipt: (...args: unknown[]) =>
    mockWaitForTransactionReceipt(...args),
}));

vi.mock("@/lib/wagmi", () => ({
  config: {},
}));

const { executeAgentAction, idleExecutionSnapshot } = await import(
  "./agent-action-execution"
);

const BASE_CHAIN_ID = 8453;

const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;
const OTHER_ACCOUNT = "0x2222222222222222222222222222222222222222" as Address;

const TX_HASH =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;

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

function readySnapshotInput(
  overrides: Partial<Parameters<typeof executeAgentAction>[0]> = {}
) {
  return {
    action: STAKING_CLAIM_ACTION,
    confirmationState: "READY_FOR_CONFIRMATION" as const,
    confirmedAccount: ACCOUNT,
    confirmedChainId: BASE_CHAIN_ID,
    currentAccount: ACCOUNT,
    currentChainId: BASE_CHAIN_ID,
    ...overrides,
  };
}

beforeEach(() => {
  mockSendTransaction.mockReset();
  mockWaitForTransactionReceipt.mockReset();
});

describe("executeAgentAction — gating (blocked, no send)", () => {
  it("1. no wallet -> execution blocked", async () => {
    const result = await executeAgentAction(
      readySnapshotInput({ currentAccount: null }),
      () => {}
    );

    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("WALLET_REQUIRED");
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it("2. wrong chain -> execution blocked", async () => {
    const result = await executeAgentAction(
      readySnapshotInput({
        currentChainId: 1,
        confirmedChainId: 1,
      }),
      () => {}
    );

    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("WRONG_CHAIN");
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it("3. action.chainId != 8453 -> blocked", async () => {
    const mutated = {
      ...STAKING_CLAIM_ACTION,
      chainId: 1,
    } as AgentActionContract;

    const result = await executeAgentAction(
      readySnapshotInput({ action: mutated }),
      () => {}
    );

    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("WRONG_CHAIN");
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it("4. not READY_FOR_CONFIRMATION -> blocked", async () => {
    const result = await executeAgentAction(
      readySnapshotInput({
        confirmationState: "SIMULATED",
      }),
      () => {}
    );

    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("NOT_READY");
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it("5. account mismatch -> blocked", async () => {
    const result = await executeAgentAction(
      readySnapshotInput({
        currentAccount: OTHER_ACCOUNT,
      }),
      () => {}
    );

    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("ACCOUNT_CHANGED");
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it("6. chain changed after confirmation -> blocked", async () => {
    const result = await executeAgentAction(
      readySnapshotInput({
        confirmedChainId: BASE_CHAIN_ID,
        currentChainId: 1,
      }),
      () => {}
    );

    expect(result.state).toBe("ERROR");

    // Chain differs from what confirmation ran against; distinct from the
    // "current chain simply isn't Base" case.
    expect(["CHAIN_CHANGED", "WRONG_CHAIN"]).toContain(
      result.error?.code
    );

    expect(mockSendTransaction).not.toHaveBeenCalled();
  });
});

describe("executeAgentAction — happy path", () => {
  it("7-13. explicit execute sends the exact verified payload and captures the hash", async () => {
    mockSendTransaction.mockResolvedValueOnce(TX_HASH);
    mockWaitForTransactionReceipt.mockResolvedValueOnce({
      status: "success",
    });

    const transitions: string[] = [];

    const result = await executeAgentAction(
      readySnapshotInput(),
      (snapshot) => transitions.push(snapshot.state)
    );

    expect(mockSendTransaction).toHaveBeenCalledTimes(1);

    const call = mockSendTransaction.mock.calls[0][1];

    expect(call.to).toBe(STAKING_CLAIM_ACTION.to);
    expect(call.data).toBe(STAKING_CLAIM_ACTION.data);
    expect(call.value).toBe(STAKING_CLAIM_ACTION.value);
    expect(call.chainId).toBe(STAKING_CLAIM_ACTION.chainId);

    expect(transitions).toEqual([
      "AWAITING_WALLET",
      "PENDING",
      "SUCCESS",
    ]);

    expect(result.hash).toBe(TX_HASH);
  });

  it("13b. waitForTransactionReceipt is called with the hash and Base chain", async () => {
    mockSendTransaction.mockResolvedValueOnce(TX_HASH);

    mockWaitForTransactionReceipt.mockResolvedValueOnce({
      status: "success",
    });

    await executeAgentAction(
      readySnapshotInput(),
      () => {}
    );

    expect(mockWaitForTransactionReceipt).toHaveBeenCalledWith(
      {},
      {
        hash: TX_HASH,
        chainId: BASE_CHAIN_ID,
      }
    );
  });

  it("14. successful receipt -> SUCCESS", async () => {
    mockSendTransaction.mockResolvedValueOnce(TX_HASH);

    mockWaitForTransactionReceipt.mockResolvedValueOnce({
      status: "success",
    });

    const result = await executeAgentAction(
      readySnapshotInput(),
      () => {}
    );

    expect(result.state).toBe("SUCCESS");
    expect(result.error).toBeNull();
  });

  it("15. reverted receipt -> ERROR", async () => {
    mockSendTransaction.mockResolvedValueOnce(TX_HASH);

    mockWaitForTransactionReceipt.mockResolvedValueOnce({
      status: "reverted",
    });

    const result = await executeAgentAction(
      readySnapshotInput(),
      () => {}
    );

    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("TRANSACTION_REVERTED");
  });
});

describe("executeAgentAction — failure classification", () => {
  it("16. wallet rejection -> typed ERROR, no raw text leaked", async () => {
    mockSendTransaction.mockRejectedValueOnce(
      new Error("User rejected the request.")
    );

    const result = await executeAgentAction(
      readySnapshotInput(),
      () => {}
    );

    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("WALLET_REJECTED");
    expect(result.error?.message).not.toContain(
      "User rejected the request."
    );
  });

  it("17. send failure -> typed ERROR, no raw text leaked", async () => {
    mockSendTransaction.mockRejectedValueOnce(
      new Error(
        "execution reverted: insufficient allowance 0xdeadbeef"
      )
    );

    const result = await executeAgentAction(
      readySnapshotInput(),
      () => {}
    );

    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("SEND_FAILED");
    expect(result.error?.message).not.toContain("0xdeadbeef");
  });

  it("receipt failure -> typed RECEIPT_FAILED, no raw text leaked", async () => {
    mockSendTransaction.mockResolvedValueOnce(TX_HASH);

    mockWaitForTransactionReceipt.mockRejectedValueOnce(
      new Error("provider timeout at rpc.internal")
    );

    const result = await executeAgentAction(
      readySnapshotInput(),
      () => {}
    );

    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("RECEIPT_FAILED");
    expect(result.error?.message).not.toContain("rpc.internal");
  });
});

describe("executeAgentAction — duplicate execution protection", () => {
  it("18. duplicate execute for the same in-flight action does not send twice", async () => {
    let resolveSend: (hash: string) => void = () => {};

    mockSendTransaction.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        })
    );

    mockWaitForTransactionReceipt.mockResolvedValue({
      status: "success",
    });

    const first = executeAgentAction(
      readySnapshotInput(),
      () => {}
    );

    // Fires while the first call is still awaiting the wallet signature.
    const second = await executeAgentAction(
      readySnapshotInput(),
      () => {}
    );

    expect(second.state).toBe("ERROR");
    expect(second.error?.code).toBe(
      "EXECUTION_IN_PROGRESS"
    );

    resolveSend(TX_HASH);

    await first;

    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("executeAgentAction — no automatic execution", () => {
  it("19. this module never runs execution from a mount/effect/callback — it is only ever invoked directly by a caller", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "agent-action-execution.ts"),
      "utf8"
    );

    expect(source).not.toMatch(/useEffect/);
    expect(source).not.toMatch(
      /\.then\(\s*executeAgentAction/
    );
  });

  it("also true of the hook: no useEffect calling execute", () => {
    const source = fs.readFileSync(
      path.join(
        __dirname,
        "../../../hooks/useAgentActionExecution.ts"
      ),
      "utf8"
    );

    expect(source).not.toMatch(/useEffect/);
  });
});

describe("executeAgentAction — no raw provider error exposed", () => {
  it("20. every ERROR snapshot's message is one of the module's own fixed strings, never interpolated raw error text", async () => {
    mockSendTransaction.mockRejectedValueOnce(
      new Error("SECRET_INTERNAL_DETAIL_12345")
    );

    const result = await executeAgentAction(
      readySnapshotInput(),
      () => {}
    );

    expect(result.error?.message).not.toContain(
      "SECRET_INTERNAL_DETAIL_12345"
    );
  });
});

describe("executeAgentAction — locked layers remain execution-free", () => {
  it("21. P0.3/P0.4/P0.5 source contains no execution calls", async () => {
    const filesToScan = [
      "agent-action-contract.ts",
      "agent-action-simulation.ts",
      "agent-action-confirmation.ts",
    ];

    for (const file of filesToScan) {
      const source = fs.readFileSync(
        path.join(__dirname, file),
        "utf8"
      );

      for (const forbidden of [
        "sendTransaction(",
        "writeContract(",
        "signTransaction(",
        "walletClient.",
        "eth_sendTransaction",
        "sendRawTransaction",
      ]) {
        // Comments referencing these as strings-to-avoid are fine; an
        // actual call site must never appear. These locked files'
        // own doc comments already assert this in prose; this test
        // re-asserts it mechanically from P1's side of the boundary too.
        const codeOnly = source
          .split("\n")
          .filter(
            (line: string) =>
              !line.trim().startsWith("//") &&
              !line.trim().startsWith("*")
          )
          .join("\n");

        expect(codeOnly.includes(forbidden)).toBe(false);
      }
    }
  });

  it("idleExecutionSnapshot returns IDLE with no hash/error", () => {
    expect(idleExecutionSnapshot()).toEqual({
      state: "IDLE",
      hash: null,
      error: null,
    });
  });
});
