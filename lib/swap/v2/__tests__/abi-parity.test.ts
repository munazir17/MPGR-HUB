// ABI drift guard. `./abi.ts` is a generated artifact and `./posture-abi.ts` is
// hand-written, so the union must be proven against the deployed source: every
// name the app reads or decodes must exist in the contract, and every entry we
// declare must be real. This runs without solc, so it also protects CI where
// Foundry is unavailable.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SWAP_V2_ABI } from "../abi";
import { SWAP_V2_ABI_COVERED_NAMES, SWAP_V2_POSTURE_ABI, SWAP_V2_POSTURE_NAMES } from "../posture-abi";

const source = readFileSync("contracts/swap/MPGRSwapExecutorV2.sol", "utf8");
const abiNames = (abi: readonly { name: string }[]) => new Set(abi.map((e) => e.name));
const generated = abiNames(SWAP_V2_ABI as unknown as readonly { name: string }[]);
const posture = abiNames(SWAP_V2_POSTURE_ABI as unknown as readonly { name: string }[]);
const union = new Set([...generated, ...posture]);

/** Names the V2 execution surface actually reads or decodes. */
const REQUIRED = [
  // posture (preflight.ts)
  "feeBps", "MAX_FEE_BPS", "feeRecipient", "owner", "paused", "pendingFeeBps",
  "pendingFeeRecipient", "pendingEffectiveAt", "FEE_TIMELOCK_SECONDS",
  "PINNED_FEE_RECIPIENT", "GOVERNANCE_SAFE", "V4_POOL_MANAGER",
  // venue registration (preflight.ts)
  "routerKind", "routerFactory",
  // entry points (transaction.ts / intent.ts)
  "swapExactInput", "swapExactInputSplit",
  // settlement (settlement.ts)
  "SwapExecuted", "SwapPathExecuted",
] as const;

/** Names solc emits into the ABI because MPGRSwapExecutorV2.sol inherits them
 * (`is Ownable2Step, Pausable, ReentrancyGuard`) and uses SafeERC20, even though
 * the local source never declares them. Each entry names the OZ module that must
 * be imported for that name to be legitimately present, so this allowlist cannot
 * silently absorb a typo in a hand-written ABI entry: if the contract stops
 * inheriting Pausable, or someone invents a name, the assertion below fails. */
const OZ_INHERITED: Record<string, string> = {
  owner: "access/Ownable.sol",
  paused: "utils/Pausable.sol",
  pendingOwner: "access/Ownable2Step.sol",
  EnforcedPause: "utils/Pausable.sol",
  ExpectedPause: "utils/Pausable.sol",
  OwnableInvalidOwner: "access/Ownable.sol",
  OwnableUnauthorizedAccount: "access/Ownable.sol",
  ReentrancyGuardReentrantCall: "utils/ReentrancyGuard.sol",
  SafeERC20FailedOperation: "token/ERC20/utils/SafeERC20.sol",
};

const declaredLocally = (name: string) =>
  new RegExp(`\\bfunction\\s+${name}\\s*\\(`).test(source) ||
  new RegExp(`\\bevent\\s+${name}\\s*\\(`).test(source) ||
  new RegExp(`\\berror\\s+${name}\\s*\\(`).test(source) ||
  new RegExp(`public\\s+(constant\\s+)?[A-Za-z0-9_\\[\\]\\s]*\\b${name}\\b\\s*(=|;)`).test(source);

describe("v2 ABI coverage", () => {
  it("covers every name the execution surface uses", () => {
    for (const name of REQUIRED) expect(union.has(name), `${name} missing from the V2 ABI union`).toBe(true);
  });

  it("keeps the generated swap ABI and the posture ABI disjoint", () => {
    for (const name of SWAP_V2_POSTURE_NAMES) expect(generated.has(name), `${name} duplicated in both ABIs`).toBe(false);
    for (const name of SWAP_V2_ABI_COVERED_NAMES) expect(generated.has(name), `${name} claimed covered but absent`).toBe(true);
  });

  it("declares nothing that the deployed source does not contain", () => {
    for (const name of union) {
      const inheritedFrom = OZ_INHERITED[name];
      if (inheritedFrom) {
        // Allowed only while the source really does import that OZ module.
        expect(source.includes(inheritedFrom), `${name} is allowed as OZ-inherited but ${inheritedFrom} is not imported`).toBe(true);
        continue;
      }
      expect(declaredLocally(name), `${name} is not declared by MPGRSwapExecutorV2.sol and is not an allowed OZ-inherited name`).toBe(true);
    }
  });

  it("encodes the swap entry points with the exact deployed tuple shapes", () => {
    const single = (SWAP_V2_ABI as unknown as { name: string; type: string; inputs: { name: string; type: string; components?: { name: string }[] }[] }[])
      .find((e) => e.type === "function" && e.name === "swapExactInput")!;
    expect(single.inputs.map((i) => i.name)).toEqual(["p", "path", "auth"]);
    expect(single.inputs[0].components?.map((c) => c.name)).toEqual([
      "router", "tokenIn", "tokenOut", "grossAmountIn", "expectedFeeAmount",
      "amountOutMinimum", "recipient", "deadline", "intentId", "unwrapNativeOut",
    ]);
    expect(single.inputs[1].components?.map((c) => c.name)).toEqual([
      "router", "tokenOut", "kind", "poolFee", "tickSpacing", "stable", "pool", "v4Key", "hookData",
    ]);
    const split = (SWAP_V2_ABI as unknown as { name: string; type: string; inputs: { name: string }[] }[])
      .find((e) => e.type === "function" && e.name === "swapExactInputSplit")!;
    expect(split.inputs.map((i) => i.name)).toEqual(["p", "paths", "amounts", "auth"]);
  });

  it("decodes SwapExecuted with the exact deployed field order", () => {
    const event = (SWAP_V2_ABI as unknown as { name: string; type: string; inputs: { name: string; indexed?: boolean }[] }[])
      .find((e) => e.type === "event" && e.name === "SwapExecuted")!;
    expect(event.inputs.map((i) => i.name)).toEqual([
      "taker", "router", "intentId", "tokenIn", "tokenOut", "grossAmountIn",
      "feeAmount", "swapAmountIn", "amountOut", "feeRecipient", "feeBps", "routerKind", "flags",
    ]);
    expect(event.inputs.slice(0, 3).every((i) => i.indexed === true)).toBe(true);
  });

  it("declares SwapPathExecuted with intentId and pathHash indexed", () => {
    const event = (SWAP_V2_POSTURE_ABI as unknown as { name: string; type: string; inputs: { name: string; indexed?: boolean }[] }[])
      .find((e) => e.type === "event" && e.name === "SwapPathExecuted")!;
    expect(event.inputs.map((i) => i.name)).toEqual(["intentId", "pathHash", "hops"]);
    expect(event.inputs[0].indexed).toBe(true);
    expect(event.inputs[1].indexed).toBe(true);
    expect(event.inputs[2].indexed).toBe(false);
  });
});
