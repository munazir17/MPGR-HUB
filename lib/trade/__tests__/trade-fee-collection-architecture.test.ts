// lib/trade/__tests__/trade-fee-collection-architecture.test.ts
//
// ARCHITECTURE GUARD — the MPGR Agent fee has exactly one collection point:
// the MPGR Executor, inside the swap transaction.
//
// This suite is deliberately static + API-shaped so that a future "quick
// fix" cannot quietly reintroduce a separate fee transaction:
//   - no swap-flow module may build an ERC-20 `transfer` (or a native value
//     send) to a fee wallet;
//   - the fee module must not export a transfer builder;
//   - the execution module must not read a fee settlement step;
//   - the only transaction a confirmation can produce is the swap itself
//     (plus the optional approval), which the execution suites assert.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");

/** Files that participate in the browser swap/confirm/execute flow. */
function swapFlowFiles(): string[] {
  const files: string[] = [];
  for (const file of readdirSync(path.join(ROOT, "lib/trade"))) {
    if (!file.endsWith(".ts")) continue;
    if (file.startsWith("transfer-")) continue; // separate feature (basename transfers)
    files.push(path.join("lib/trade", file));
  }
  for (const file of readdirSync(path.join(ROOT, "hooks"))) {
    if (file.startsWith("useTrade") && file.endsWith(".ts")) files.push(path.join("hooks", file));
  }
  for (const file of readdirSync(path.join(ROOT, "components/features/agent"))) {
    if (file.startsWith("AgentTrade") && file.endsWith(".tsx")) {
      files.push(path.join("components/features/agent", file));
    }
  }
  return files;
}

const SWAP_FLOW_FILES = swapFlowFiles();

describe("MPGR fee collection architecture (static guards)", () => {
  it("covers the swap flow (sanity: the guard scans real files)", () => {
    expect(SWAP_FLOW_FILES).toContain("lib/trade/trade-execution.ts");
    expect(SWAP_FLOW_FILES).toContain("lib/trade/trade-agent-fee.ts");
    expect(SWAP_FLOW_FILES.length).toBeGreaterThan(30);
    // Transfer/basename files are a different feature and stay out of scope.
    expect(SWAP_FLOW_FILES.some((file) => file.includes("transfer-execution"))).toBe(false);
  });

  it("no swap-flow module builds a fee transfer (token transfer or native send)", () => {
    const offenders: string[] = [];
    for (const relative of SWAP_FLOW_FILES) {
      const source = readFileSync(path.join(ROOT, relative), "utf8");
      // The old, removed helper.
      if (/buildAgentFeeTransfer/.test(source)) offenders.push(`${relative}: buildAgentFeeTransfer`);
      // An ERC-20 `transfer(...)` encoding inside the swap flow.
      if (/functionName:\s*"transfer"/.test(source)) offenders.push(`${relative}: transfer calldata`);
      // A "send the fee" step.
      if (/feeTransfer|feeReceipt|sendFee/.test(source)) offenders.push(`${relative}: fee transfer plumbing`);
    }
    expect(offenders).toEqual([]);
  });

  it("the fee module exposes no way to pay the fee outside the swap", async () => {
    const feeModule = await import("../trade-agent-fee");
    for (const forbidden of ["buildAgentFeeTransfer", "resolveExecutionAgentFee", "buildProposalAgentFee"]) {
      expect(Object.keys(feeModule)).not.toContain(forbidden);
    }
    // The fee module must not even own an ERC-20 ABI: nothing to encode a
    // transfer with.
    const source = readFileSync(path.join(ROOT, "lib/trade/trade-agent-fee.ts"), "utf8");
    expect(source).not.toMatch(/erc20Abi|encodeFunctionData/);
  });

  it("execution resolves the fee only through the executor swap invariant", () => {
    const source = readFileSync(path.join(ROOT, "lib/trade/trade-execution.ts"), "utf8");
    expect(source).toContain("verifyAgentFeeInSwapTransaction");
    expect(source).toContain("inspectExecutorSwapTransaction");
    // Exactly one swap send and at most one approval send exist in the flow.
    expect(source.match(/swapHash = await sendTransaction\(/g)).toHaveLength(1);
    expect(source.match(/approvalHash = await sendTransaction\(/g)).toHaveLength(1);
    // No second receipt wait exists that could gate a follow-up transaction.
    expect(source.match(/waitForTransactionReceipt\(config/g)).toHaveLength(2);
  });

  it("the confirmation UI has no fee step, fee link or fee-payment error", () => {
    const source = readFileSync(
      path.join(ROOT, "components/features/agent/AgentTradeConfirmationModal.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/Paid separately|Pay fee|separate fee payment/);
    expect(source).not.toMatch(/feeHash|feeError/);
    // The fee row is the label plus the exact amount, nothing else.
    expect(source).toMatch(/MPGR fee/);
  });
});
