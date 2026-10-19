// Live-posture verification for the deployed MPGRSwapExecutor: before any
// path quote is prepared, the executor's on-chain fee terms and pause state
// must match the reviewed policy. Mocked reads only — no network access.
import { describe, expect, it } from "vitest";
import { SWAP_FEE_RECIPIENT, SWAP_PATH_EXECUTOR_DEPLOYMENT, type SwapPathExecutorDeployment } from "../swap-executor-config";
import { verifySwapPathFeeTerms } from "../swap-path-search";
import type { SwapRouteReadClient } from "../swap-route-selection";

const deployment = SWAP_PATH_EXECUTOR_DEPLOYMENT as SwapPathExecutorDeployment;

function reader(answers: Record<string, unknown> | Error): SwapRouteReadClient {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (answers instanceof Error) throw answers;
      if (!(functionName in answers)) throw new Error(`unexpected read ${functionName}`);
      return answers[functionName];
    },
  } as unknown as SwapRouteReadClient;
}

describe("verifySwapPathFeeTerms (deployed executor posture)", () => {
  it("passes only on the exact reviewed terms: 25 bps, pinned recipient, unpaused", async () => {
    await expect(verifySwapPathFeeTerms(
      reader({ feeBps: 25, feeRecipient: SWAP_FEE_RECIPIENT, paused: false }),
      deployment,
    )).resolves.toBeUndefined();
  });

  it("fails closed with EXECUTOR_PAUSED when the executor is paused on-chain", async () => {
    await expect(verifySwapPathFeeTerms(
      reader({ feeBps: 25, feeRecipient: SWAP_FEE_RECIPIENT, paused: true }),
      deployment,
    )).rejects.toMatchObject({ reason: "EXECUTOR_PAUSED", status: 503 });
  });

  it("treats a non-false pause read as paused (never assumes unpaused)", async () => {
    await expect(verifySwapPathFeeTerms(
      reader({ feeBps: 25, feeRecipient: SWAP_FEE_RECIPIENT, paused: undefined }),
      deployment,
    )).rejects.toMatchObject({ reason: "EXECUTOR_PAUSED", status: 503 });
  });

  it.each([
    ["fee drift", { feeBps: 26, feeRecipient: SWAP_FEE_RECIPIENT, paused: false }],
    ["zero fee", { feeBps: 0, feeRecipient: SWAP_FEE_RECIPIENT, paused: false }],
    ["recipient drift", { feeBps: 25, feeRecipient: "0x2222222222222222222222222222222222222222", paused: false }],
  ])("rejects %s as FEE_RECIPIENT_CHANGED", async (_label, answers) => {
    await expect(verifySwapPathFeeTerms(reader(answers), deployment))
      .rejects.toMatchObject({ reason: "FEE_RECIPIENT_CHANGED", status: 422 });
  });

  it("maps unreadable posture to a retryable verification failure, never a quote", async () => {
    await expect(verifySwapPathFeeTerms(reader(new Error("RPC down")), deployment))
      .rejects.toMatchObject({ reason: "ROUTE_VERIFICATION_UNAVAILABLE", status: 503 });
  });

  it("reads posture from the deployed executor address only", async () => {
    const seen: string[] = [];
    const spy = {
      readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
        seen.push(`${address.toLowerCase()}:${functionName}`);
        return ({ feeBps: 25, feeRecipient: SWAP_FEE_RECIPIENT, paused: false } as Record<string, unknown>)[functionName];
      },
    } as unknown as SwapRouteReadClient;
    await verifySwapPathFeeTerms(spy, deployment);
    expect(seen).toHaveLength(3);
    expect(seen.every(s => s.startsWith("0xbc4de809b4b72bce8f61c87dac6be12e3f7c6b3e:"))).toBe(true);
    expect(seen.map(s => s.split(":")[1]).sort()).toEqual(["feeBps", "feeRecipient", "paused"]);
  });
});
