// lib/mcp/__tests__/hardening-quotes-verify.test.ts
//
// PHASE 4 HARDENING — quote/market conditions (§6), transaction/RPC failure
// matrix (§7) and false-success verification attempts (§8). Every case is a
// malformed or adversarial input that must fail CLOSED; nothing may turn a
// partial/forged receipt into a success.

import { describe, expect, it, beforeEach } from "vitest";
import { getAddress, type Address, type Hex, type Log } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { delegateSwap, getQuote, verifyTrade, type McpDeps } from "@/lib/mcp/mcp-trade-service";
import {
  BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT,
  DELEGATED_BASE_SEPOLIA_TSTOCK,
  DELEGATED_BASE_SEPOLIA_TUSD,
  DELEGATED_EXECUTOR_ADDRESS,
  delegatedActionId,
} from "@/lib/executor/delegated-executor";
import { BASE_SEPOLIA_UNISWAP_V3 } from "@/lib/executor/executor-config";
import {
  FEE_RECIPIENT,
  fakeReader,
  newFakeState,
  setBalance,
  swapExecutedLog,
  testDeps,
  type FakeChainState,
} from "./fixtures";

const TAKER = privateKeyToAccount(generatePrivateKey()).address;
const BROADCASTER = getAddress("0x0000000000000000000000000000000000000b22");
const TX = ("0x" + "77".repeat(32)) as Hex;
const ACTION_ID = delegatedActionId("hard-goal");
const GROSS = 100_000_000n;
const FEE = (GROSS * 25n) / 10000n;

function delegatedDeps(state: FakeChainState, extra: Record<string, unknown> = {}) {
  return {
    ...testDeps(state, {}),
    reader: () => fakeReader(state, 84532, DELEGATED_EXECUTOR_ADDRESS),
    delegatedRegistry: { 84532: BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT },
    delegatedBroadcaster: async (tx: { to: Address; data: Hex; chainId: number }) => {
      void tx;
      return ("0x" + "ab".repeat(32)) as `0x${string}`;
    },
    ...extra,
  } as Parameters<typeof getQuote>[0];
}

async function freshDelegatedQuote(state: FakeChainState, deps = delegatedDeps(state)) {
  const out = await getQuote(deps, {
    chainId: 84532,
    taker: TAKER,
    executor: DELEGATED_EXECUTOR_ADDRESS,
    sellToken: DELEGATED_BASE_SEPOLIA_TUSD,
    buyToken: DELEGATED_BASE_SEPOLIA_TSTOCK,
    sellAmount: GROSS.toString(),
    slippageBps: 100,
  });
  if (!out.ok) throw new Error(`${out.error.code}: ${out.error.message}`);
  return out.data as Record<string, unknown>;
}

function validAuth(over: Record<string, unknown> = {}): Record<string, unknown> {
  const deadline = Math.floor(Date.now() / 1000) + 1800;
  return {
    chainId: 84532,
    router: BASE_SEPOLIA_UNISWAP_V3.swapRouter02,
    poolFee: 3000,
    intentId: delegatedActionId("hard-goal"),
    expectedFeeAmount: FEE.toString(),
    deadline: deadline.toString(),
    authorization: {
      permit: {
        permitted: { token: DELEGATED_BASE_SEPOLIA_TUSD, amount: GROSS.toString() },
        nonce: "123456789",
        deadline: deadline.toString(),
      },
      witness: {
        owner: TAKER,
        buyToken: DELEGATED_BASE_SEPOLIA_TSTOCK,
        minAmountOut: "700000000000000000",
        deadline: deadline.toString(),
        actionId: ACTION_ID,
        policyHash: ("0x" + "44".repeat(32)) as Hex,
      },
      signature: ("0x" + "22".repeat(65)) as Hex,
    },
    ...over,
  };
}

function delegatedReceipt(over: {
  emitter?: Address; from?: Address; to?: Address; taker?: Address; router?: Address;
  tokenIn?: Address; tokenOut?: Address; gross?: bigint; fee?: bigint; out?: bigint;
  feeRecipient?: Address; intentId?: Hex; dropEvent?: boolean; emptyLogs?: boolean;
} = {}): Record<string, unknown> {
  if (over.emptyLogs) {
    return { status: "success", transactionHash: TX, blockNumber: 99n, from: BROADCASTER, to: DELEGATED_EXECUTOR_ADDRESS, logs: [] };
  }
  const log: Log = swapExecutedLog(over.emitter ?? DELEGATED_EXECUTOR_ADDRESS, {
    taker: over.taker ?? TAKER,
    router: over.router ?? BASE_SEPOLIA_UNISWAP_V3.swapRouter02,
    intentId: over.intentId ?? ACTION_ID,
    tokenIn: over.tokenIn ?? DELEGATED_BASE_SEPOLIA_TUSD,
    tokenOut: over.tokenOut ?? DELEGATED_BASE_SEPOLIA_TSTOCK,
    grossAmountIn: over.gross ?? GROSS,
    feeAmount: over.fee ?? FEE,
    swapAmountIn: (over.gross ?? GROSS) - (over.fee ?? FEE),
    amountOut: over.out ?? 777_428_258_108_105_694n,
    feeRecipient: over.feeRecipient ?? FEE_RECIPIENT,
    feeBps: 25,
    routerKind: 2,
    flags: 0,
  });
  return {
    status: "success",
    transactionHash: TX,
    blockNumber: 99n,
    from: over.from ?? BROADCASTER,
    to: over.to ?? DELEGATED_EXECUTOR_ADDRESS,
    logs: over.dropEvent ? [] : [log],
  };
}

beforeEach(() => {
  // fresh state per test
});

describe("hardening: quote / market conditions (§6)", () => {
  let state: FakeChainState;
  beforeEach(() => {
    state = newFakeState();
    setBalance(state, DELEGATED_BASE_SEPOLIA_TUSD, TAKER, 10_000_000_000n);
  });

  it("valid delegated quote works (control)", async () => {
    const d = await freshDelegatedQuote(state);
    expect(d.minBuyAmount).not.toBe("0");
  });

  it("zero liquidity / quoter revert fails closed (QUOTE_FAILED)", async () => {
    state.quoterFails = true;
    const out = await getQuote(delegatedDeps(state), {
      chainId: 84532, taker: TAKER, executor: DELEGATED_EXECUTOR_ADDRESS,
      sellToken: DELEGATED_BASE_SEPOLIA_TUSD, buyToken: DELEGATED_BASE_SEPOLIA_TSTOCK,
      sellAmount: GROSS.toString(), slippageBps: 100,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(["QUOTE_FAILED", "RPC_ERROR"]).toContain(out.error.code);
  });

  it("token no longer allowed fails closed (TOKEN_NOT_ALLOWED)", async () => {
    const out = await getQuote(delegatedDeps(state), {
      chainId: 84532, taker: TAKER, executor: DELEGATED_EXECUTOR_ADDRESS,
      sellToken: "0x0000000000000000000000000000000000000001",
      buyToken: DELEGATED_BASE_SEPOLIA_TSTOCK,
      sellAmount: GROSS.toString(), slippageBps: 100,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("TOKEN_NOT_ALLOWED");
  });

  it("executor mismatch fails closed without any chain I/O", async () => {
    const out = await getQuote(delegatedDeps(state), {
      chainId: 84532, taker: TAKER, executor: FEE_RECIPIENT,
      sellToken: DELEGATED_BASE_SEPOLIA_TUSD, buyToken: DELEGATED_BASE_SEPOLIA_TSTOCK,
      sellAmount: GROSS.toString(), slippageBps: 100,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("EXECUTOR_MISMATCH");
  });

  it("wrong chain fails closed", async () => {
    const out = await getQuote(delegatedDeps(state), {
      chainId: 8453, taker: TAKER, executor: DELEGATED_EXECUTOR_ADDRESS,
      sellToken: DELEGATED_BASE_SEPOLIA_TUSD, buyToken: DELEGATED_BASE_SEPOLIA_TSTOCK,
      sellAmount: GROSS.toString(), slippageBps: 100,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("UNSUPPORTED_CHAIN");
  });

  it("malformed amount fails closed", async () => {
    for (const bad of ["-5", "12.5", "abc", "", "0"]) {
      const out = await getQuote(delegatedDeps(state), {
        chainId: 84532, taker: TAKER, executor: DELEGATED_EXECUTOR_ADDRESS,
        sellToken: DELEGATED_BASE_SEPOLIA_TUSD, buyToken: DELEGATED_BASE_SEPOLIA_TSTOCK,
        sellAmount: bad, slippageBps: 100,
      });
      expect(out.ok, bad).toBe(false);
    }
  });
});

describe("hardening: delegateSwap fee/auth tampering (§6/§7)", () => {
  let state: FakeChainState;
  beforeEach(() => {
    state = newFakeState();
  });

  it("tampered expectedFeeAmount -> FEE_MISMATCH before broadcast", async () => {
    const out = await delegateSwap(delegatedDeps(state), validAuth({ expectedFeeAmount: (FEE - 1n).toString() }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("FEE_MISMATCH");
  });

  it("committed amount inconsistent with permit -> parser rejects or fee mismatches (never broadcasts)", async () => {
    const auth = validAuth();
    const a = auth.authorization as Record<string, any>;
    a.permit.permitted.amount = (GROSS * 2n).toString(); // raise amount, keep committed fee
    const out = await delegateSwap(delegatedDeps(state), auth);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("FEE_MISMATCH");
  });

  it("malformed signature -> INVALID_AUTHORIZATION before broadcast", async () => {
    const auth = validAuth();
    (auth.authorization as Record<string, unknown>).signature = "0xshort";
    const out = await delegateSwap(delegatedDeps(state), auth);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("INVALID_AUTHORIZATION");
  });

  it("modified deadline in the permit -> parser rejects (digit-string wire contract)", async () => {
    const auth = validAuth();
    const a = auth.authorization as Record<string, any>;
    a.permit.deadline = 123; // number, not digit string
    const out = await delegateSwap(delegatedDeps(state), auth);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("INVALID_AUTHORIZATION");
  });

  it("modified nonce representation -> parser rejects", async () => {
    const auth = validAuth();
    const a = auth.authorization as Record<string, any>;
    a.permit.nonce = 123456789;
    const out = await delegateSwap(delegatedDeps(state), auth);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("INVALID_AUTHORIZATION");
  });

  it("broadcaster throwing -> RPC_ERROR, no tx hash, fail-closed", async () => {
    const deps = delegatedDeps(state, {
      delegatedBroadcaster: async () => {
        throw new Error("connection reset by peer");
      },
    });
    const out = await delegateSwap(deps, validAuth());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("RPC_ERROR");
  });
});

describe("hardening: false-success verification attempts (§8)", () => {
  let state: FakeChainState;
  beforeEach(() => {
    state = newFakeState();
  });

  /** Fail-closed assertion: a hard refusal (no result) counts, and any result must have verified=false. */
  function expectNotVerified(out: Awaited<ReturnType<typeof verifyTrade>>) {
    if (!out.ok) {
      expect(out.error.code).toBeTruthy();
      return;
    }
    expect((out.data as Record<string, unknown>).verified).toBe(false);
  }

  async function verifyWithReceipt(deps: McpDeps, receipt: Record<string, unknown>, expectedIntentId = ACTION_ID) {
    const quote = await freshDelegatedQuote(state, deps);
    state.receipts.set(TX.toLowerCase(), receipt as never);
    return verifyTrade(deps, {
      quoteId: String(quote.quoteId),
      txHash: TX,
      expectedSender: BROADCASTER,
      expectedIntentId,
    });
  }

  it("control: correct receipt verifies", async () => {
    const out = await verifyWithReceipt(delegatedDeps(state), delegatedReceipt());
    if (!out.ok) throw new Error(`${out.error.code}: ${out.error.message}`);
    expect((out.data as Record<string, unknown>).verified).toBe(true);
  });

  it("wrong executor (event emitted by an impostor) -> verified false", async () => {
    const out = await verifyWithReceipt(delegatedDeps(state), delegatedReceipt({ emitter: FEE_RECIPIENT }));
    expectNotVerified(out);
  });

  it("tx.to != executor -> verified false", async () => {
    const out = await verifyWithReceipt(delegatedDeps(state), delegatedReceipt({ to: FEE_RECIPIENT }));
    expectNotVerified(out);
  });

  it("wrong sender (not the broadcaster) -> verified false", async () => {
    const out = await verifyWithReceipt(delegatedDeps(state), delegatedReceipt({ from: TAKER }));
    expectNotVerified(out);
  });

  it("wrong taker -> verified false", async () => {
    const out = await verifyWithReceipt(delegatedDeps(state), delegatedReceipt({ taker: getAddress("0x0000000000000000000000000000000000000e1f") }));
    expectNotVerified(out);
  });

  it("wrong token pair -> verified false", async () => {
    const out = await verifyWithReceipt(delegatedDeps(state), delegatedReceipt({ tokenOut: DELEGATED_BASE_SEPOLIA_TUSD }));
    expectNotVerified(out);
  });

  it("fee one wei short -> verified false", async () => {
    const out = await verifyWithReceipt(delegatedDeps(state), delegatedReceipt({ fee: FEE - 1n }));
    expectNotVerified(out);
  });

  it("wrong fee recipient -> verified false", async () => {
    const out = await verifyWithReceipt(delegatedDeps(state), delegatedReceipt({ feeRecipient: getAddress("0x0000000000000000000000000000000000000d01") }));
    expectNotVerified(out);
  });

  it("wrong router -> verified false", async () => {
    const out = await verifyWithReceipt(delegatedDeps(state), delegatedReceipt({ router: getAddress("0x0000000000000000000000000000000000000d02") }));
    expectNotVerified(out);
  });

  it("output below signed minOut -> verified false", async () => {
    const out = await verifyWithReceipt(delegatedDeps(state), delegatedReceipt({ out: 1n }));
    expectNotVerified(out);
  });

  it("wrong actionId in the event -> verified false", async () => {
    const out = await verifyWithReceipt(delegatedDeps(state), delegatedReceipt({ intentId: delegatedActionId("other-goal") }));
    expectNotVerified(out);
  });

  it("missing SwapExecuted event -> verified false", async () => {
    const out = await verifyWithReceipt(delegatedDeps(state), delegatedReceipt({ dropEvent: true }));
    expectNotVerified(out);
  });

  it("empty logs (partial RPC response) -> verified false", async () => {
    const out = await verifyWithReceipt(delegatedDeps(state), delegatedReceipt({ emptyLogs: true }));
    expectNotVerified(out);
  });

  it("receipt unavailable -> TX_NOT_FOUND (pending, never success)", async () => {
    const deps = delegatedDeps(state);
    const quote = await freshDelegatedQuote(state, deps);
    const out = await verifyTrade(deps, {
      quoteId: String(quote.quoteId),
      txHash: TX,
      expectedSender: BROADCASTER,
      expectedIntentId: ACTION_ID,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("TX_NOT_FOUND");
  });
});
