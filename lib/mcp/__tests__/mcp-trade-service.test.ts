import { decodeFunctionData, getAddress, parseAbi, recoverTypedDataAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RouterKind } from "@/lib/executor/executor-config";
import { MPGR_EXECUTOR_ABI } from "@/lib/executor/mpgr-executor-abi";
import {
  finalizeTrade,
  getCapabilities,
  getQuote,
  getTradeStatus,
  listTokens,
  prepareTrade,
  verifyTrade,
  type ToolOutcome,
} from "@/lib/mcp/mcp-trade-service";
import { ZERO_EX_ALLOWANCE_HOLDER_BASE } from "@/lib/trade/zero-ex-native-fee";

import {
  EXECUTOR,
  FEE_RECIPIENT,
  PERMIT2,
  ROUTER,
  TSTOCK,
  TUSD,
  WETH,
  newFakeState,
  setAllowance,
  setBalance,
  swapExecutedLog,
  testDeps,
  transferLog,
  type FakeChainState,
} from "./fixtures";

type Data = Record<string, unknown>;
function ok(o: ToolOutcome): Data {
  if (!o.ok) throw new Error(`${o.error.code}: ${o.error.message}`);
  return o.data;
}
function errCode(o: ToolOutcome): string {
  if (o.ok) throw new Error("expected failure");
  return o.error.code;
}

/** Wallets accept decimal strings for uintN in eth_signTypedData_v4; viem's local signer wants bigint. */
function reviveTypedData(td: Data): Parameters<ReturnType<typeof privateKeyToAccount>["signTypedData"]>[0] {
  const types = td.types as Record<string, { name: string; type: string }[]>;
  const revive = (typeName: string, value: Data): Data =>
    Object.fromEntries(
      Object.entries(value).map(([key, v]) => {
        const field = types[typeName]?.find((f) => f.name === key);
        if (field && /^uint\d+$/.test(field.type) && typeof v === "string") return [key, BigInt(v)];
        if (field && types[field.type] && v && typeof v === "object") return [key, revive(field.type, v as Data)];
        return [key, v];
      }),
    );
  return { ...(td as object), message: revive(td.primaryType as string, td.message as Data) } as never;
}

let state: FakeChainState;
let deps: ReturnType<typeof testDeps>;
const account = privateKeyToAccount(generatePrivateKey());
const TAKER = account.address;

beforeEach(() => {
  state = newFakeState();
  deps = testDeps(state);
  setBalance(state, TUSD, TAKER, 50_000_000n);
});

const quoteArgs = { chainId: 84532, taker: TAKER, sellToken: "tUSD", buyToken: TSTOCK, sellAmountHuman: "10", slippageBps: 100 };

describe("discover", () => {
  it("advertises chains, exact fee policy and the non-custodial flow", () => {
    const d = ok(getCapabilities(deps));
    expect(JSON.stringify(d)).toContain("never signs");
    expect(d.fee).toMatchObject({ bps: 25, maxBps: 100, formula: "floor(sellAmount * feeBps / 10000)" });
    const chains = d.chains as Data[];
    expect(chains[0]).toMatchObject({ chainId: 84532, tradingProviders: ["mpgr-executor"], executor: { status: "deployed", address: EXECUTOR } });
    expect(chains[1]).toMatchObject({ chainId: 8453, tradingProviders: [] });
  });

  it("lists allowlisted tokens and pairs", () => {
    const d = ok(listTokens(deps, { chainId: 84532 }));
    expect((d.tokens as Data[]).map((t) => t.symbol)).toEqual(["tUSD", "tSTOCK", "WETH"]);
    expect((d.pairs as Data[])[0]).toMatchObject({ venue: "uniswap-v3", poolFee: 3000 });
    expect(errCode(listTokens(deps, { chainId: 1 }))).toBe("UNSUPPORTED_CHAIN");
    expect(errCode(listTokens(deps, { chainId: 8453 }))).toBe("EXECUTOR_NOT_DEPLOYED_MAINNET");
  });
});

describe("mpgr_get_quote", () => {
  it("quotes with the live on-chain fee, exact floor math and minOut", async () => {
    const d = ok(await getQuote(deps, quoteArgs));
    expect(d).toMatchObject({
      sellAmount: "10000000",
      feeBps: 25,
      feeAmount: "25000",
      feeToken: TUSD,
      feeRecipient: FEE_RECIPIENT,
      swapAmount: "9975000",
      expectedBuyAmount: "19950000", // fake quoter: out = 2 * swapAmount (fee taken BEFORE quoting)
      minBuyAmount: "19750500",
      recipient: TAKER,
      executor: EXECUTOR,
      balanceSufficient: true,
      expiresAt: deps.clock.now + 120,
    });
    expect(String(d.quoteId)).toMatch(/^q1\./);
    expect(state.calls).toContain("read:feeBps");
  });

  it("follows an owner fee change without redeploy (reads feeBps live)", async () => {
    state.feeBps = 50;
    const d = ok(await getQuote(deps, quoteArgs));
    expect(d).toMatchObject({ feeBps: 50, feeAmount: "50000" });
  });

  it("maps ETH to native-in via WETH", async () => {
    state.ethBalance = 10n ** 18n;
    const d = ok(await getQuote(deps, { ...quoteArgs, sellToken: "ETH", buyToken: "tUSD", sellAmount: "1000000000000000", sellAmountHuman: undefined }));
    expect(d).toMatchObject({ sellNative: true, feeToken: "ETH", feeAmount: "2500000000000" });
  });

  it.each([
    [{ taker: "0x123" }, "INVALID_TAKER"],
    [{ chainId: 1 }, "UNSUPPORTED_CHAIN"],
    [{ sellToken: "0x9999999999999999999999999999999999999999" }, "TOKEN_NOT_ALLOWED"],
    [{ sellAmountHuman: "0.0000001" }, "INVALID_AMOUNT"],
    [{ sellAmountHuman: "0.0001" }, "FEE_ROUNDS_TO_ZERO"],
    [{ sellAmountHuman: undefined }, "INVALID_AMOUNT"],
    [{ slippageBps: 1000 }, "INVALID_SLIPPAGE"],
    [{ sellToken: "WETH" }, "NO_ROUTE"],
    [{ taker: FEE_RECIPIENT }, "TAKER_IS_FEE_RECIPIENT"],
  ])("rejects %o with %s", async (over, code) => {
    expect(errCode(await getQuote(deps, { ...quoteArgs, ...over }))).toBe(code);
  });

  it("refuses when the executor is paused or the quoter fails", async () => {
    state.paused = true;
    expect(errCode(await getQuote(deps, quoteArgs))).toBe("EXECUTOR_PAUSED");
    state.paused = false;
    state.quoterFails = true;
    expect(errCode(await getQuote(deps, quoteArgs))).toBe("QUOTE_FAILED");
  });

  it("refuses to quote without a quote-signing secret", async () => {
    const prev = process.env.AUTH_SESSION_SECRET;
    delete process.env.AUTH_SESSION_SECRET;
    try {
      expect(errCode(await getQuote(testDeps(state, { quoteSecret: undefined }), quoteArgs))).toBe("QUOTE_SECRET_MISSING");
    } finally {
      if (prev !== undefined) process.env.AUTH_SESSION_SECRET = prev;
    }
  });

  it("keeps Base mainnet disabled by default", async () => {
    expect(errCode(await getQuote(deps, { ...quoteArgs, chainId: 8453 }))).toBe("BASE_MAINNET_DISABLED");
  });
});

describe("mpgr_prepare_trade", () => {
  async function quoteId(args: Data = quoteArgs): Promise<string> {
    return String(ok(await getQuote(deps, args)).quoteId);
  }

  it("APPROVAL: exact approval step then the executor swap", async () => {
    const d = ok(await prepareTrade(deps, { quoteId: await quoteId(), authorization: "APPROVAL" }));
    const steps = d.steps as Data[];
    expect(steps.map((s) => s.step)).toEqual(["sendApprovalTransaction", "sendSwapTransaction"]);
    const approve = steps[0].transactionRequest as { to: string; data: Hex };
    expect(approve.to).toBe(TUSD);
    expect(decodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), data: approve.data }).args).toEqual([EXECUTOR, 10_000_000n]);
    const tx = d.transactionRequest as { to: string; data: Hex; value: string };
    expect(tx.to).toBe(EXECUTOR);
    expect(tx.value).toBe("0");
    const decoded = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: tx.data });
    expect(decoded.functionName).toBe("swapUniswapV3ExactInputSingle");
    expect(decoded.args?.[0]).toMatchObject({ recipient: TAKER, grossAmountIn: 10_000_000n, expectedFeeAmount: 25_000n, router: ROUTER });
  });

  it("APPROVAL with sufficient allowance: swap only", async () => {
    setAllowance(state, TUSD, TAKER, EXECUTOR, 10_000_000n);
    const d = ok(await prepareTrade(deps, { quoteId: await quoteId() }));
    expect((d.steps as Data[]).map((s) => s.step)).toEqual(["sendSwapTransaction"]);
  });

  it("refuses stale fee config, insufficient balance, pause, tampering and expiry", async () => {
    const q = await quoteId();
    state.feeBps = 30;
    expect(errCode(await prepareTrade(deps, { quoteId: q }))).toBe("QUOTE_STALE");
    state.feeBps = 25;
    state.feeRecipient = getAddress("0x000000000000000000000000000000000000beef");
    expect(errCode(await prepareTrade(deps, { quoteId: q }))).toBe("QUOTE_STALE");
    state.feeRecipient = FEE_RECIPIENT;
    setBalance(state, TUSD, TAKER, 9_999_999n);
    expect(errCode(await prepareTrade(deps, { quoteId: q }))).toBe("INSUFFICIENT_BALANCE");
    setBalance(state, TUSD, TAKER, 10_000_000n);
    state.paused = true;
    expect(errCode(await prepareTrade(deps, { quoteId: q }))).toBe("EXECUTOR_PAUSED");
    state.paused = false;
    expect(errCode(await prepareTrade(deps, { quoteId: q.slice(0, -2) + "AA" }))).toBe("QUOTE_ID_INVALID");
    expect(errCode(await prepareTrade(deps, { quoteId: q, authorization: "YOLO" }))).toBe("INVALID_AUTHORIZATION");
    deps.clock.now += 121;
    expect(errCode(await prepareTrade(deps, { quoteId: q }))).toBe("QUOTE_EXPIRED");
  });

  it("EIP2612 is refused for tokens without permit support", async () => {
    setBalance(state, TSTOCK, TAKER, 10n ** 18n);
    const q = await quoteId({ ...quoteArgs, sellToken: "tSTOCK", buyToken: "tUSD", sellAmountHuman: "1" });
    expect(errCode(await prepareTrade(deps, { quoteId: q, authorization: "EIP2612" }))).toBe("EIP2612_UNSUPPORTED");
  });

  it("native ETH sells need no approval and send value == gross", async () => {
    state.ethBalance = 10n ** 18n;
    const q = await quoteId({ ...quoteArgs, sellToken: "ETH", buyToken: "tUSD", sellAmount: "1000000000000000", sellAmountHuman: undefined });
    const d = ok(await prepareTrade(deps, { quoteId: q }));
    expect((d.steps as Data[]).map((s) => s.step)).toEqual(["sendSwapTransaction"]);
    expect((d.transactionRequest as Data).value).toBe("1000000000000000");
  });
});

describe("end-to-end AI flow (discover → quote → prepare → user signs → finalize → execute → status → verify)", () => {
  async function runPermitFlow(authorization: "EIP2612" | "PERMIT2") {
    ok(getCapabilities(deps));
    const quote = ok(await getQuote(deps, quoteArgs));
    const quoteId = String(quote.quoteId);
    if (authorization === "PERMIT2") setAllowance(state, TUSD, TAKER, PERMIT2, 10_000_000n);
    const prep = ok(await prepareTrade(deps, { quoteId, authorization }));
    expect(prep.transactionRequest).toBeNull(); // nothing to send until the user signs
    const typedData = prep.typedData as Data;
    const permit = prep.permit as { nonce: string; deadline: number };
    expect((typedData.message as Data).spender).toBe(EXECUTOR);

    // --- the USER's wallet signs (simulated with a local viem account; the server never sees the key) ---
    const signature = await account.signTypedData(reviveTypedData(typedData));
    expect(await recoverTypedDataAddress({ ...reviveTypedData(typedData), signature } as never)).toBe(TAKER);

    deps.clock.now += 300; // signing took a while (past the 120s quote TTL, inside the 600s intent deadline)
    const fin = ok(await finalizeTrade(deps, { quoteId, authorization, signature, permitNonce: permit.nonce }));
    const tx = fin.transactionRequest as { to: string; data: Hex; value: string };
    expect(tx.to).toBe(EXECUTOR);
    const decoded = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: tx.data });
    const auth = decoded.args?.[2] as Data;
    expect(auth.kind).toBe(authorization === "EIP2612" ? 1 : 2);
    expect(auth.nonce).toBe(BigInt(permit.nonce));
    expect(auth.deadline).toBe(BigInt(quote.deadline as number));

    // --- the user's wallet sends it; the chain mines a receipt with the executor's event ---
    const txHash = `0x${"ab".repeat(32)}` as Hex;
    const params = decoded.args?.[0] as { intentId: Hex };
    state.receipts.set(txHash, {
      status: "success",
      transactionHash: txHash,
      blockNumber: 42n,
      from: TAKER,
      to: EXECUTOR,
      logs: [
        swapExecutedLog(EXECUTOR, {
          taker: TAKER,
          router: ROUTER,
          intentId: params.intentId,
          tokenIn: TUSD,
          tokenOut: TSTOCK,
          grossAmountIn: 10_000_000n,
          feeAmount: 25_000n,
          swapAmountIn: 9_975_000n,
          amountOut: 19_900_000n,
          feeRecipient: FEE_RECIPIENT,
          feeBps: 25,
          routerKind: RouterKind.UNISWAP_V3_ROUTER02,
          flags: 0,
        }),
      ],
    });
    expect(ok(await getTradeStatus(deps, { chainId: 84532, txHash }))).toMatchObject({ status: "confirmed", blockNumber: "42" });
    const v = ok(await verifyTrade(deps, { quoteId, txHash }));
    expect(v.verified).toBe(true);
    return { quoteId, typedData, permit, signature };
  }

  it("EIP-2612: one swap transaction after a wallet signature", async () => {
    await runPermitFlow("EIP2612");
  });

  it("Permit2: one swap transaction after a wallet signature", async () => {
    await runPermitFlow("PERMIT2");
  });

  it("rejects a signature from anyone other than the taker", async () => {
    const q = String(ok(await getQuote(deps, quoteArgs)).quoteId);
    const prep = ok(await prepareTrade(deps, { quoteId: q, authorization: "EIP2612" }));
    const attacker = privateKeyToAccount(generatePrivateKey());
    const sig = await attacker.signTypedData(reviveTypedData(prep.typedData as Data));
    const nonce = (prep.permit as { nonce: string }).nonce;
    expect(errCode(await finalizeTrade(deps, { quoteId: q, authorization: "EIP2612", signature: sig, permitNonce: nonce }))).toBe("SIGNATURE_MISMATCH");
  });

  it("rejects a stale permit nonce, a malformed signature and a passed intent deadline", async () => {
    const q = String(ok(await getQuote(deps, quoteArgs)).quoteId);
    const prep = ok(await prepareTrade(deps, { quoteId: q, authorization: "EIP2612" }));
    const sig = await account.signTypedData(reviveTypedData(prep.typedData as Data));
    state.permitNonce = 1n;
    expect(errCode(await finalizeTrade(deps, { quoteId: q, authorization: "EIP2612", signature: sig, permitNonce: "0" }))).toBe("PERMIT_NONCE_STALE");
    state.permitNonce = 0n;
    expect(errCode(await finalizeTrade(deps, { quoteId: q, authorization: "EIP2612", signature: "0x1234", permitNonce: "0" }))).toBe("INVALID_SIGNATURE");
    expect(errCode(await finalizeTrade(deps, { quoteId: q, authorization: "APPROVAL", signature: sig, permitNonce: "0" }))).toBe("INVALID_AUTHORIZATION");
    deps.clock.now += 601;
    expect(errCode(await finalizeTrade(deps, { quoteId: q, authorization: "EIP2612", signature: sig, permitNonce: "0" }))).toBe("QUOTE_EXPIRED");
  });

  it("verify flags a receipt whose fee was short or redirected", async () => {
    const q = String(ok(await getQuote(deps, quoteArgs)).quoteId);
    const prep = ok(await prepareTrade(deps, { quoteId: q }));
    const params = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: (prep.transactionRequest as { data: Hex }).data }).args?.[0] as { intentId: Hex };
    const txHash = `0x${"cd".repeat(32)}` as Hex;
    state.receipts.set(txHash, {
      status: "success",
      transactionHash: txHash,
      blockNumber: 1n,
      from: TAKER,
      to: EXECUTOR,
      logs: [
        swapExecutedLog(EXECUTOR, {
          taker: TAKER, router: ROUTER, intentId: params.intentId, tokenIn: TUSD, tokenOut: TSTOCK,
          grossAmountIn: 10_000_000n, feeAmount: 24_999n, swapAmountIn: 9_975_001n, amountOut: 19_900_000n,
          feeRecipient: TAKER, feeBps: 25, routerKind: RouterKind.UNISWAP_V3_ROUTER02, flags: 0,
        }),
      ],
    });
    const v = ok(await verifyTrade(deps, { quoteId: q, txHash }));
    expect(v.verified).toBe(false);
    const failed = (v.checks as { name: string; ok: boolean }[]).filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toEqual(expect.arrayContaining(["feeAmount (exact)", "feeRecipient"]));
  });

  it("status reports unknown hashes as pending and validates input", async () => {
    expect(ok(await getTradeStatus(deps, { txHash: `0x${"ef".repeat(32)}` }))).toMatchObject({ status: "pending_or_unknown" });
    expect(errCode(await getTradeStatus(deps, { txHash: "0x12" }))).toBe("INVALID_TX_HASH");
    expect(errCode(await verifyTrade(deps, { quoteId: "q1.x.y", txHash: `0x${"ef".repeat(32)}` }))).toBe("QUOTE_ID_INVALID");
  });
});

describe("Base mainnet 0x path (explicitly enabled, mocked 0x)", () => {
  const USDC = getAddress("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  const zeroExBody = (sellAmount: string, fee: string, minBuy = "2970000000000000") => ({
    liquidityAvailable: true,
    sellToken: USDC,
    buyToken: WETH,
    sellAmount,
    buyAmount: "3000000000000000",
    minBuyAmount: minBuy,
    fees: { integratorFee: { amount: fee, token: USDC } },
    issues: { allowance: { spender: ZERO_EX_ALLOWANCE_HOLDER_BASE } },
    transaction: { to: ZERO_EX_ALLOWANCE_HOLDER_BASE, data: "0xabcdef", value: "0" },
  });

  it("quotes, prepares with an exact AllowanceHolder approval, and verifies the fee transfer", async () => {
    const prevKey = process.env.ZERO_EX_API_KEY;
    process.env.ZERO_EX_API_KEY = "k";
    try {
      const fetcher = vi.fn(async () => new Response(JSON.stringify(zeroExBody("10000000", "25000")), { status: 200 }));
      const d = testDeps(state, { mainnetEnabled: true, mainnetFeeRecipient: FEE_RECIPIENT, zeroExFetch: fetcher as unknown as typeof fetch });
      const q = ok(await getQuote(d, { chainId: 8453, taker: TAKER, sellToken: USDC, buyToken: WETH, sellAmount: "10000000" }));
      expect(q).toMatchObject({ feeAmount: "25000", feeToken: USDC, spender: ZERO_EX_ALLOWANCE_HOLDER_BASE });
      const p = ok(await prepareTrade(d, { quoteId: q.quoteId }));
      expect((p.steps as Data[]).map((s) => s.step)).toEqual(["sendApprovalTransaction", "sendSwapTransaction"]);
      expect((p.transactionRequest as Data).to).toBe(ZERO_EX_ALLOWANCE_HOLDER_BASE);

      const txHash = `0x${"77".repeat(32)}` as Hex;
      state.receipts.set(txHash, {
        status: "success", transactionHash: txHash, blockNumber: 5n, from: TAKER, to: ZERO_EX_ALLOWANCE_HOLDER_BASE,
        logs: [transferLog(USDC, TAKER, FEE_RECIPIENT, 25_000n)],
      });
      expect(ok(await verifyTrade(d, { quoteId: q.quoteId, txHash })).verified).toBe(true);
      state.receipts.set(txHash, { ...state.receipts.get(txHash)!, logs: [transferLog(USDC, TAKER, FEE_RECIPIENT, 24_999n)] });
      expect(ok(await verifyTrade(d, { quoteId: q.quoteId, txHash })).verified).toBe(false);
    } finally {
      if (prevKey === undefined) delete process.env.ZERO_EX_API_KEY;
      else process.env.ZERO_EX_API_KEY = prevKey;
    }
  });

  it("refuses without a fee wallet, and refuses a 0x quote with a wrong fee", async () => {
    expect(errCode(await getQuote(testDeps(state, { mainnetEnabled: true }), { chainId: 8453, taker: TAKER, sellToken: USDC, buyToken: WETH, sellAmount: "10000000" }))).toBe(
      "FEE_RECIPIENT_NOT_CONFIGURED",
    );
    const prevKey = process.env.ZERO_EX_API_KEY;
    process.env.ZERO_EX_API_KEY = "k";
    try {
      const fetcher = vi.fn(async () => new Response(JSON.stringify(zeroExBody("10000000", "0")), { status: 200 }));
      const d = testDeps(state, { mainnetEnabled: true, mainnetFeeRecipient: FEE_RECIPIENT, zeroExFetch: fetcher as unknown as typeof fetch });
      expect(errCode(await getQuote(d, { chainId: 8453, taker: TAKER, sellToken: USDC, buyToken: WETH, sellAmount: "10000000" }))).toBe("INTEGRATOR_FEE_MISMATCH");
    } finally {
      if (prevKey === undefined) delete process.env.ZERO_EX_API_KEY;
      else process.env.ZERO_EX_API_KEY = prevKey;
    }
  });
});
