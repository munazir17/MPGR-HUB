// Settlement verification: a receipt must prove exactly one fee-bearing swap to
// the pinned treasury, measured against the COMMITTED minimum. Offline only —
// fabricated event objects, never fabricated on-chain state.
import { describe, expect, it } from "vitest";
import { verifyV2Settlement, verifyV2Receipt, parseV2SettlementEvents, type V2SettlementEvents } from "../settlement";
import { inspectV2SwapTransaction, v2FeeFloor } from "../intent";
import { deployment, encodeSingle, encodeSplit, hop, intentContext, params, TAKER, TOKEN_A, TOKEN_B, POOL_AB, POOL_AB_2, INTENT_ID } from "./helpers";
import { V2_FEE_RECIPIENT } from "../discovery";

const GROSS = 1_000_000n;
const FEE = v2FeeFloor(GROSS);
const NET = GROSS - FEE;

const intent = () => {
  const r = inspectV2SwapTransaction({ to: deployment.executor, data: encodeSingle(params(GROSS), [hop()]), value: 0n }, intentContext());
  if (!r.ok) throw new Error(`fixture intent rejected: ${r.reason}`);
  return r.value;
};
const splitIntent = () => {
  const r = inspectV2SwapTransaction({ to: deployment.executor, data: encodeSplit(params(GROSS), [[hop({ pool: POOL_AB })], [hop({ pool: POOL_AB_2 })]], [500_000n, NET - 500_000n]), value: 0n }, intentContext());
  if (!r.ok) throw new Error(`fixture split intent rejected: ${r.reason}`);
  return r.value;
};
/** A truthful SwapExecuted event for the given output. */
const executed = (amountOut: bigint, overrides: Partial<Record<string, unknown>> = {}) => ({
  taker: TAKER, router: overrides.router ?? "0x2626664c2603336e57b271c5c0b26f421741e481", intentId: INTENT_ID,
  tokenIn: TOKEN_A, tokenOut: TOKEN_B, grossAmountIn: GROSS, feeAmount: FEE, swapAmountIn: NET,
  amountOut, feeRecipient: V2_FEE_RECIPIENT, feeBps: 25, routerKind: 2, flags: 0, ...overrides,
});
const events = (executedList: unknown[], pathExecuted: unknown[] = []): V2SettlementEvents =>
  ({ executed: executedList as never, pathExecuted: pathExecuted as never });
const ok = { status: "success" as const };

describe("v2 settlement — accepted", () => {
  it("verifies a single swap paying exactly 25 bps to the pinned treasury", () => {
    const s = verifyV2Settlement(intent(), events([executed(1000n)]), ok, { deployment });
    expect(s.verified).toBe(true);
    expect(s.amountIn).toBe(GROSS.toString());
    expect(s.amountOut).toBe("1000");
    expect(s.feeAmount).toBe(FEE.toString());
    expect(s.feeBps).toBe(25);
    expect(s.feeRecipient?.toLowerCase()).toBe(V2_FEE_RECIPIENT.toLowerCase());
    expect(s.entry).toBe("swapExactInput");
    expect(s.reason).toBeNull();
  });

  it("accepts an output above the committed minimum", () => {
    expect(verifyV2Settlement(intent(), events([executed(5000n)]), ok, { deployment }).verified).toBe(true);
  });

  it("accepts the measured treasury delta as an extra fee proof", () => {
    expect(verifyV2Settlement(intent(), events([executed(1000n)]), ok, { deployment, feeRecipientDelta: FEE }).verified).toBe(true);
  });

  it("verifies a split settlement with one fee and one SwapPathExecuted leg count", () => {
    const s = verifyV2Settlement(splitIntent(), events([executed(1000n)], [{ intentId: INTENT_ID, pathHash: `0x${"cd".repeat(32)}`, hops: 2 }]), ok, { deployment });
    expect(s.verified).toBe(true);
    expect(s.entry).toBe("swapExactInputSplit");
    expect(s.feeAmount).toBe(FEE.toString());
  });
});

describe("v2 settlement — rejected", () => {
  it("rejects a reverted transaction", () => {
    const s = verifyV2Settlement(intent(), events([executed(1000n)]), { status: "reverted" }, { deployment });
    expect(s.verified).toBe(false);
    expect(s.reason).toMatch(/did not succeed/i);
  });

  it("rejects a receipt with no event for this intent", () => {
    expect(verifyV2Settlement(intent(), events([]), ok, { deployment }).verified).toBe(false);
    expect(verifyV2Settlement(intent(), events([executed(1000n, { intentId: `0x${"ff".repeat(32)}` })]), ok, { deployment }).verified).toBe(false);
  });

  it("rejects a duplicated settlement for one intent (double spend / double fee)", () => {
    const s = verifyV2Settlement(intent(), events([executed(1000n), executed(1000n)]), ok, { deployment });
    expect(s.verified).toBe(false);
    expect(s.reason).toMatch(/more than one/i);
  });

  it("rejects a fee-less swap and a fee paid to any other recipient", () => {
    expect(verifyV2Settlement(intent(), events([executed(1000n, { feeAmount: 0n, swapAmountIn: GROSS })]), ok, { deployment }).verified).toBe(false);
    expect(verifyV2Settlement(intent(), events([executed(1000n, { feeRecipient: TOKEN_A })]), ok, { deployment }).verified).toBe(false);
  });

  it("rejects a fee that is not floor(gross*feeBps/10000) and a wrong bps", () => {
    expect(verifyV2Settlement(intent(), events([executed(1000n, { feeAmount: FEE - 1n })]), ok, { deployment }).verified).toBe(false);
    expect(verifyV2Settlement(intent(), events([executed(1000n, { feeBps: 26, feeAmount: (GROSS * 26n) / 10_000n })]), ok, { deployment }).verified).toBe(false);
  });

  it("rejects a treasury delta that does not equal the settled fee", () => {
    const s = verifyV2Settlement(intent(), events([executed(1000n)]), ok, { deployment, feeRecipientDelta: FEE - 1n });
    expect(s.verified).toBe(false);
    expect(s.reason).toMatch(/balance delta/i);
  });

  it("rejects an output below the committed minimum", () => {
    const s = verifyV2Settlement(intent(), events([executed(100n)]), ok, { deployment });
    expect(s.verified).toBe(false);
    expect(s.reason).toMatch(/below the committed minimum/i);
  });

  it("rejects a substituted token, router, kind or taker", () => {
    expect(verifyV2Settlement(intent(), events([executed(1000n, { tokenOut: TOKEN_A })]), ok, { deployment }).verified).toBe(false);
    expect(verifyV2Settlement(intent(), events([executed(1000n, { router: POOL_AB })]), ok, { deployment }).verified).toBe(false);
    expect(verifyV2Settlement(intent(), events([executed(1000n, { routerKind: 1 })]), ok, { deployment }).verified).toBe(false);
    expect(verifyV2Settlement(intent(), events([executed(1000n, { taker: TOKEN_A })]), ok, { deployment }).verified).toBe(false);
  });

  it("rejects a settled gross that differs from the committed sell amount", () => {
    expect(verifyV2Settlement(intent(), events([executed(1000n, { grossAmountIn: GROSS + 1n })]), ok, { deployment }).verified).toBe(false);
    expect(verifyV2Settlement(intent(), events([executed(1000n, { swapAmountIn: NET + 1n })]), ok, { deployment }).verified).toBe(false);
  });

  it("rejects native flags that disagree with the reviewed transaction", () => {
    expect(verifyV2Settlement(intent(), events([executed(1000n, { flags: 1 })]), ok, { deployment }).verified).toBe(false);
    expect(verifyV2Settlement(intent(), events([executed(1000n, { flags: 2 })]), ok, { deployment }).verified).toBe(false);
  });

  it("rejects a split whose settled leg count differs, or with no path event", () => {
    expect(verifyV2Settlement(splitIntent(), events([executed(1000n)], [{ intentId: INTENT_ID, pathHash: `0x${"cd".repeat(32)}`, hops: 3 }]), ok, { deployment }).verified).toBe(false);
    expect(verifyV2Settlement(splitIntent(), events([executed(1000n)]), ok, { deployment }).verified).toBe(false);
  });

  it("refuses to attribute settlement without a sealed deployment", () => {
    // Both shapes must degrade honestly: options omitted entirely, and an
    // explicit null. Neither may fabricate a verification.
    expect(verifyV2Settlement(intent(), events([executed(1000n)]), ok).verified).toBe(false);
    const s = verifyV2Settlement(intent(), events([executed(1000n)]), ok, { deployment: null });
    expect(s.verified).toBe(false);
    expect(s.reason).toMatch(/no sealed v2 deployment/i);
  });
});

describe("v2 settlement — receipt parsing", () => {
  it("never reports a decoding failure as 'no swap happened'", () => {
    // A garbage log set decodes to no events; the wrapper must say evidence
    // could not be decoded OR that no event matched — never verified.
    const s = verifyV2Receipt(intent(), { status: "success", logs: [{ address: deployment.executor, topics: [], data: "0x" as `0x${string}` }] }, deployment);
    expect(s.verified).toBe(false);
  });

  it("parses an empty log list without throwing", () => {
    expect(parseV2SettlementEvents({ status: "success", logs: [] })).toEqual({ executed: [], pathExecuted: [] });
  });
});
