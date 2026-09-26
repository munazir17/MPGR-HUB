// lib/trade/__tests__/trade-executor-quote.test.ts
//
// REGRESSION SUITE — MPGR Executor fee architecture (browser swap flow).
//
// Proves, offline and with no wallet:
//   1. a supported swap's final transaction targets the MPGR Executor;
//   2. the gross sell amount is FEE-AWARE: fee = floor(gross * 25 / 10_000),
//      the pool is quoted for (gross - fee), and the calldata commits to
//      `expectedFeeAmount` so the contract reverts on any drift;
//   3. 2 USDC gross → 0.005 USDC fee, 1.995 USDC swap amount;
//   4. the fee recipient is the EXECUTOR's configured feeRecipient — never
//      the connected (owner) wallet, never a browser-supplied address;
//   5. approval is a separate transaction only when the allowance is short
//      and is always for the GROSS amount; nothing else is ever sent;
//   6. native ETH in/out stays correct (msg.value == gross, WETH legs,
//      unwrap for native out);
//   7. quote, slippage and min-out behave exactly as before.

import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, getAddress, keccak256, stringToHex, type Address } from "viem";

import { BASE_MAINNET_EXECUTOR_DEPLOYMENT, BASE_MAINNET_USDC, CANONICAL_WETH } from "@/lib/executor/executor-config";
import { applySlippage } from "@/lib/executor/executor-fee";
import { MPGR_EXECUTOR_ABI } from "@/lib/executor/mpgr-executor-abi";
import type { ChainReader } from "@/lib/executor/executor-chain";
import { buildExecutorSwapProposal, isExecutorRoutablePair } from "../trade-executor-quote";
import { tradeProposalId } from "../trade-proposal";
import { MPGR_AGENT_FEE_BPS } from "../trade-agent-fee";
import { NATIVE_ETH_SENTINEL, TRADE_CHAIN_ID } from "../trade-config";
import type { TradeTokenRef } from "../trade-types";

const TAKER = "0x2222222222222222222222222222222222222222" as Address;
/** The connected owner wallet used by the live deployment. Not a recipient. */
const OWNER_WALLET = "0xE0e0d239853c5F2Fe0a524d544eC9eB71fef486e" as Address;
const EXECUTOR = getAddress(BASE_MAINNET_EXECUTOR_DEPLOYMENT.executor);
const ROUTER = getAddress("0x2626664c2603336E57B271c5C0b26F421741e481");
const FEE_RECIPIENT = getAddress(BASE_MAINNET_EXECUTOR_DEPLOYMENT.feeRecipient);
const NOW = 1_760_000_000_000;

const usdc: TradeTokenRef = {
  address: BASE_MAINNET_USDC,
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
  kind: "erc20",
  verified: true,
};
const weth: TradeTokenRef = {
  address: CANONICAL_WETH,
  symbol: "WETH",
  name: "Wrapped Ether",
  decimals: 18,
  kind: "erc20",
  verified: true,
};
const eth: TradeTokenRef = {
  address: NATIVE_ETH_SENTINEL,
  symbol: "ETH",
  name: "Ether",
  decimals: 18,
  kind: "native",
  verified: true,
};

interface FakeReaderOptions {
  feeBps?: number;
  feeRecipient?: Address;
  paused?: boolean;
  allowance?: bigint;
  tokenBalance?: bigint;
  nativeBalance?: bigint;
  quoterOut?: bigint;
  failLiveConfig?: boolean;
  failQuote?: boolean;
}

function fakeReader(options: FakeReaderOptions = {}) {
  const calls: { quoterAmountIn?: bigint } = {};
  const reader: ChainReader = {
    chainId: TRADE_CHAIN_ID,
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (options.failLiveConfig) throw new Error("rpc down");
      switch (functionName) {
        case "feeBps":
          return BigInt(options.feeBps ?? MPGR_AGENT_FEE_BPS);
        case "feeRecipient":
          return options.feeRecipient ?? FEE_RECIPIENT;
        case "paused":
          return options.paused ?? false;
        case "MAX_FEE_BPS":
          return 100n;
        case "owner":
          return OWNER_WALLET;
        case "allowance":
          return options.allowance ?? 0n;
        case "balanceOf":
          return options.tokenBalance ?? 100_000_000n;
        default:
          throw new Error(`unexpected read: ${functionName}`);
      }
    }),
    simulateContract: vi.fn(async ({ args }: { args?: readonly unknown[] }) => {
      if (options.failQuote) throw new Error("quoter reverted");
      const params = args?.[0] as { amountIn: bigint };
      calls.quoterAmountIn = params.amountIn;
      return { result: [options.quoterOut ?? 800_000_000_000_000n, 0n, 0n, 100_000n] as unknown };
    }),
    getBalance: vi.fn(async () => options.nativeBalance ?? 10n ** 18n),
    getTransactionReceipt: vi.fn(async () => {
      throw new Error("not used");
    }),
  };
  return { reader, calls };
}

type BuildOverrides = Partial<Parameters<typeof buildExecutorSwapProposal>[0]> & { readerOptions?: FakeReaderOptions };

function build(overrides: BuildOverrides = {}) {
  const { readerOptions, ...input } = overrides;
  const { reader, calls } = fakeReader(readerOptions);
  return {
    calls,
    run: buildExecutorSwapProposal({
      from: usdc,
      to: weth,
      fromAmount: "2000000",
      taker: TAKER,
      slippageBps: 100,
      quotedAt: new Date(NOW),
      nowSeconds: Math.floor(NOW / 1000),
      reader,
      ...input,
    }),
  };
}

describe("MPGR Executor quote — routing and fee-aware gross amounts", () => {
  it("1. routes a supported pair to the MPGR Executor (never a router, never a fee wallet)", async () => {
    const { run } = build();
    const result = await run;
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.proposal.provider).toBe("mpgr-executor");
    expect(result.proposal.chainId).toBe(8453);
    expect(result.proposal.executionAvailable).toBe(true);
    expect(getAddress(result.proposal.transaction!.to)).toBe(EXECUTOR);
    // The wallet signs EXACTLY ONE transaction, and it is not an ERC-20
    // transfer to anyone (there is no separate fee transfer to construct).
    expect(result.proposal.transaction!.to.toLowerCase()).not.toBe(FEE_RECIPIENT.toLowerCase());
    expect(result.proposal.transaction!.to.toLowerCase()).not.toBe(TAKER.toLowerCase());
    expect(result.proposal.transaction!.to.toLowerCase()).not.toBe(ROUTER.toLowerCase());
  });

  it("2. 2 USDC gross → 0.005 USDC fee and a 1.995 USDC swap amount, committed in calldata", async () => {
    const { run, calls } = build();
    const result = await run;
    if (!result.ok) throw new Error("expected an executor proposal");

    // Displayed fee: exactly floor(2_000_000 * 25 / 10_000).
    expect(result.proposal.agentFee).toMatchObject({
      status: "applied",
      bps: 25,
      collection: "mpgr-executor",
      amountAtomic: "5000",
      displayAmount: "0.005 USDC",
      reason: null,
    });
    expect(result.proposal.fromAmount).toBe("2000000");

    // The pool is quoted for the POST-fee amount only.
    expect(calls.quoterAmountIn).toBe(1_995_000n);

    const decoded = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: result.proposal.transaction!.data });
    expect(decoded.functionName).toBe("swapUniswapV3ExactInputSingle");
    const [params, poolFee] = decoded.args as unknown as readonly [Record<string, unknown>, number];
    expect(params.grossAmountIn).toBe(2_000_000n);
    expect(params.expectedFeeAmount).toBe(5_000n);
    expect((params.grossAmountIn as bigint) - (params.expectedFeeAmount as bigint)).toBe(1_995_000n);
    expect(poolFee).toBe(3000);
    expect(getAddress(params.router as string)).toBe(ROUTER);
    expect(getAddress(params.tokenIn as string)).toBe(getAddress(BASE_MAINNET_USDC));
    expect(getAddress(params.tokenOut as string)).toBe(getAddress(CANONICAL_WETH));
    expect(getAddress(params.recipient as string)).toBe(getAddress(TAKER));
    expect(params.unwrapNativeOut).toBe(false);
    expect(params.amountOutMinimum).toBe(applySlippage(800_000_000_000_000n, 100));
    expect(result.proposal.minToAmount).toBe(applySlippage(800_000_000_000_000n, 100).toString());
    expect(result.proposal.toAmount).toBe("800000000000000");
    expect(params.deadline).toBe(BigInt(Math.floor(NOW / 1000) + 600));
    expect(result.proposal.transaction!.value).toBe("0");
  });

  it("3. fee recipient is the EXECUTOR's configured feeRecipient — never the connected wallet", async () => {
    for (const taker of [TAKER, OWNER_WALLET]) {
      const { run } = build({ taker });
      const result = await run;
      if (!result.ok) throw new Error("expected an executor proposal");
      expect(result.proposal.agentFee!.recipient).toBe(FEE_RECIPIENT);
      expect(result.proposal.agentFee!.recipient!.toLowerCase()).not.toBe(taker.toLowerCase());
      // The only address the swap pays out to is the taker (recipient), and
      // the fee recipient is never a transfer target in the calldata.
      const decoded = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: result.proposal.transaction!.data });
      const [params] = decoded.args as unknown as readonly [Record<string, unknown>, number];
      expect(getAddress(params.recipient as string)).toBe(getAddress(taker));
      expect(String(params.recipient).toLowerCase()).not.toBe(FEE_RECIPIENT.toLowerCase());
    }
  });

  it("4. follows the live feeRecipient and feeBps (the executor is the source of truth)", async () => {
    const { reader } = fakeReader({ feeRecipient: OWNER_WALLET, feeBps: 50 });
    const result = await buildExecutorSwapProposal({
      from: usdc,
      to: weth,
      fromAmount: "2000000",
      taker: TAKER,
      slippageBps: 100,
      reader,
      nowSeconds: Math.floor(NOW / 1000),
    });
    if (!result.ok) throw new Error("expected an executor proposal");
    // Quoted from the LIVE recipient — not a browser-supplied or hard-coded one.
    expect(result.proposal.agentFee!.recipient).toBe(OWNER_WALLET);
    expect(result.proposal.agentFee!.amountAtomic).toBe("10000");
    const decoded = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: result.proposal.transaction!.data });
    const [params] = decoded.args as unknown as readonly [Record<string, unknown>, number];
    expect(params.expectedFeeAmount).toBe(10_000n);
  });

  it("5. quotes the executor's alternate fee without changing the 25 bps default", async () => {
    expect(MPGR_AGENT_FEE_BPS).toBe(25);
    const { reader } = fakeReader({ feeBps: 50, feeRecipient: FEE_RECIPIENT });
    const result = await buildExecutorSwapProposal({
      from: usdc,
      to: weth,
      fromAmount: "2000000",
      taker: TAKER,
      slippageBps: 100,
      reader,
      nowSeconds: Math.floor(NOW / 1000),
    });
    if (!result.ok) throw new Error("expected an executor proposal");
    expect(result.proposal.agentFee!.amountAtomic).toBe("10000"); // 0.50% of 2 USDC
    const decoded = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: result.proposal.transaction!.data });
    const [params] = decoded.args as unknown as readonly [Record<string, unknown>, number];
    expect(params.expectedFeeAmount).toBe(10_000n);
  });

  it("6. approval is separate and always for the GROSS amount (ERC-20 first-time flow)", async () => {
    const short = await build({ readerOptions: { allowance: 0n } }).run;
    if (!short.ok) throw new Error("expected an executor proposal");
    expect(short.proposal.needsPermit2Approval).toBe(true);
    expect(getAddress(short.proposal.permit2Spender!)).toBe(EXECUTOR);
    expect(short.proposal.issues.allowance).toMatchObject({ currentAllowance: "0", spender: EXECUTOR });

    const covering = await build({ readerOptions: { allowance: 2_000_000n } }).run;
    if (!covering.ok) throw new Error("expected an executor proposal");
    // Sufficient allowance → swap only, no second transaction.
    expect(covering.proposal.needsPermit2Approval).toBe(false);
    expect(covering.proposal.issues.allowance).toBeNull();

    const shortByOne = await build({ readerOptions: { allowance: 1_999_999n } }).run;
    if (!shortByOne.ok) throw new Error("expected an executor proposal");
    expect(shortByOne.proposal.needsPermit2Approval).toBe(true);
  });

  it("7. native ETH sell: value == gross, WETH leg, fee in ETH, no approval", async () => {
    const { run } = build({
      from: eth,
      to: usdc,
      fromAmount: "2000000000000000000",
      readerOptions: { allowance: 0n, nativeBalance: 5n * 10n ** 18n, quoterOut: 4_000_000_000n },
    });
    const result = await run;
    if (!result.ok) throw new Error("expected an executor proposal");

    expect(result.proposal.transaction!.value).toBe("2000000000000000000");
    expect(result.proposal.needsPermit2Approval).toBe(false);
    expect(result.proposal.issues.allowance).toBeNull();
    expect(result.proposal.agentFee).toMatchObject({ amountAtomic: "5000000000000000", displayAmount: "0.005 ETH" });

    const decoded = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: result.proposal.transaction!.data });
    const [params] = decoded.args as unknown as readonly [Record<string, unknown>, number];
    expect(getAddress(params.tokenIn as string)).toBe(getAddress(CANONICAL_WETH));
    expect(params.grossAmountIn).toBe(2_000_000_000_000_000_000n);
    expect(params.expectedFeeAmount).toBe(5_000_000_000_000_000n);
  });

  it("8. native ETH out: WETH buy leg with unwrap, no msg.value", async () => {
    const { run, calls } = build({
      from: usdc,
      to: eth,
      fromAmount: "2000000",
      readerOptions: { quoterOut: 800_000_000_000_000n },
    });
    const result = await run;
    if (!result.ok) throw new Error("expected an executor proposal");

    expect(result.proposal.transaction!.value).toBe("0");
    expect(calls.quoterAmountIn).toBe(1_995_000n);
    const decoded = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: result.proposal.transaction!.data });
    const [params] = decoded.args as unknown as readonly [Record<string, unknown>, number];
    expect(getAddress(params.tokenOut as string)).toBe(getAddress(CANONICAL_WETH));
    expect(params.unwrapNativeOut).toBe(true);
  });

  it("9. intentId is deterministic per identical quote (no invented id)", async () => {
    const { run } = build();
    const result = await run;
    if (!result.ok) throw new Error("expected an executor proposal");
    const expected = keccak256(
      stringToHex(
        `mpgr-executor-intent:${tradeProposalId({
          from: usdc.address,
          to: weth.address,
          fromAmount: "2000000",
          taker: TAKER,
          slippageBps: 100,
        })}`,
      ),
    );
    const decoded = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: result.proposal.transaction!.data });
    const [params] = decoded.args as unknown as readonly [Record<string, unknown>, number];
    expect(params.intentId).toBe(expected);
  });

  it("10. non-executor pairs are not supported (existing providers stay in charge)", async () => {
    expect(isExecutorRoutablePair(BASE_MAINNET_USDC, CANONICAL_WETH)).toBe(true);
    // Native ETH (sentinel) maps onto the WETH leg in both directions.
    expect(isExecutorRoutablePair(NATIVE_ETH_SENTINEL, BASE_MAINNET_USDC)).toBe(true);
    expect(isExecutorRoutablePair(BASE_MAINNET_USDC, NATIVE_ETH_SENTINEL)).toBe(true);
    // ETH ↔ WETH is the same asset: never quoted as a swap at all.
    expect(isExecutorRoutablePair(NATIVE_ETH_SENTINEL, CANONICAL_WETH)).toBe(false);
    expect(isExecutorRoutablePair(BASE_MAINNET_USDC, "0x1111111111111111111111111111111111111111")).toBe(false);

    const { reader } = fakeReader();
    const result = await buildExecutorSwapProposal({
      from: usdc,
      to: { address: "0x1111111111111111111111111111111111111111", symbol: "X", name: "X", decimals: 18, kind: "erc20", verified: false },
      fromAmount: "2000000",
      taker: TAKER,
      slippageBps: 100,
      reader,
    });
    expect(result).toEqual({ ok: false, supported: false });
    expect(reader.readContract).not.toHaveBeenCalled();
  });

  it("11. a fee that cannot be taken inside the swap is never quoted as executable", async () => {
    // Dust: floor(399 * 25 / 10_000) == 0 → the contract reverts FeeRoundsToZero.
    const dust = await build({ fromAmount: "399" }).run;
    expect(dust).toMatchObject({ ok: false, supported: true, error: { code: "INVALID_INPUT" } });

    // Live feeRecipient == taker → the contract reverts TakerIsFeeRecipient.
    const selfFee = await build({ readerOptions: { feeRecipient: TAKER } }).run;
    expect(selfFee).toMatchObject({ ok: false, supported: true, error: { code: "EXECUTION_UNAVAILABLE" } });

    // Paused executor: nothing is quoted.
    const paused = await build({ readerOptions: { paused: true } }).run;
    expect(paused).toMatchObject({ ok: false, supported: true, error: { code: "EXECUTION_UNAVAILABLE" } });

    // Unreadable chain state: an error, never a silent fallback route.
    const offline = await build({ readerOptions: { failLiveConfig: true } }).run;
    expect(offline).toMatchObject({ ok: false, supported: true, error: { code: "PROVIDER_ERROR" } });

    const noPool = await build({ readerOptions: { failQuote: true } }).run;
    expect(noPool).toMatchObject({ ok: false, supported: true, error: { code: "PROVIDER_ERROR" } });
  });

  it("11b. an owner-configured 0 bps executor quotes the swap with no fee (never a refusal)", async () => {
    const { run } = build({ readerOptions: { feeBps: 0, allowance: 5_000_000n } });
    const result = await run;
    if (!result.ok) throw new Error("expected an executor proposal");
    expect(result.proposal.agentFee).toMatchObject({ status: "skipped", bps: null, amountAtomic: "0" });
    const decoded = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: result.proposal.transaction!.data });
    const [params] = decoded.args as unknown as readonly [Record<string, unknown>, number];
    expect(params.expectedFeeAmount).toBe(0n);
    expect(params.grossAmountIn).toBe(2_000_000n);
  });

  it("12. reports an under-funded wallet before any wallet prompt", async () => {
    const { run } = build({ readerOptions: { tokenBalance: 1_000_000n, allowance: 1_000_000n } });
    const result = await run;
    if (!result.ok) throw new Error("expected an executor proposal");
    expect(result.proposal.issues.balance).toMatchObject({
      token: BASE_MAINNET_USDC,
      currentBalance: "1000000",
      requiredBalance: "2000000",
    });
  });

  it("13. keeps slippage, min-out and quote-shape behaviour byte-for-byte", async () => {
    const { run } = build({
      slippageBps: 250,
      readerOptions: { allowance: 5_000_000n, quoterOut: 1_234_567_890_123_456n },
    });
    const result = await run;
    if (!result.ok) throw new Error("expected an executor proposal");
    expect(result.proposal.slippageBps).toBe(250);
    expect(result.proposal.toAmount).toBe("1234567890123456");
    expect(result.proposal.minToAmount).toBe(applySlippage(1_234_567_890_123_456n, 250).toString());
    expect(result.proposal.displayFromAmount).toBe("2 USDC");
    expect(applySlippage(1_234_567_890_123_456n, 250)).toBe(1_203_703_692_870_369n);
    expect(result.proposal.displayMinToAmount).toBe("0.001203 WETH");
    expect(result.proposal.permit2).toBeNull();
    expect(result.proposal.requiresConfirmation).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B20 tokenized stocks — the SAME executor fee architecture, on the live
// allowlisted Aerodrome Slipstream route (tickSpacing 10). The app's executed
// USDC -> AAPLc swap (tx 0x0f52a3b3a13e8fabf79f9185bc3198e60275223ceb4225b24c84782aa43551de)
// used exactly this router/pool key; it now runs through the executor instead of
// paying the 0.25% fee with a separate post-swap transfer.
// ---------------------------------------------------------------------------

/** AAPLc — allowlisted on the deployed executor, 8 decimals on chain. */
const aaplc: TradeTokenRef = {
  address: getAddress("0xb200000000000000000000C2e324d24d7eEcd1fb"),
  symbol: "AAPLc",
  name: "Apple Tokenized Stock (Coinbase)",
  decimals: 8,
  kind: "b20-tokenized-stock",
  verified: true,
};
const SLIP_ROUTER = getAddress("0x698Cb2b6dd822994581fEa6Ea4Fc755d1363A92F");
const SLIP_QUOTER = getAddress("0x514c8B5f54112481E28028F1166Bd78501089259");

describe("MPGR Executor quote — B20 tokenized stocks go through the executor too", () => {
  it("14. a B20 buy is ONE executor transaction on the live Slipstream route (fee inside the swap)", async () => {
    const { run, calls } = build({ to: aaplc, fromAmount: "2000000" });
    const result = await run;
    if (!result.ok) throw new Error("expected an executor proposal");

    expect(isExecutorRoutablePair(BASE_MAINNET_USDC, aaplc.address)).toBe(true);
    expect(result.proposal.provider).toBe("mpgr-executor");
    expect(getAddress(result.proposal.transaction!.to)).toBe(EXECUTOR);
    expect(result.proposal.transaction!.to.toLowerCase()).not.toBe(SLIP_ROUTER.toLowerCase());
    expect(result.proposal.transaction!.to.toLowerCase()).not.toBe(FEE_RECIPIENT.toLowerCase());

    // 2 USDC gross → 0.005 USDC fee → 1.995 USDC swapped.
    expect(result.proposal.agentFee).toMatchObject({
      status: "applied",
      bps: 25,
      collection: "mpgr-executor",
      amountAtomic: "5000",
      displayAmount: "0.005 USDC",
      recipient: FEE_RECIPIENT,
    });
    expect(result.proposal.fromAmount).toBe("2000000");
    expect(calls.quoterAmountIn).toBe(1_995_000n); // post-fee amount only

    const decoded = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: result.proposal.transaction!.data });
    expect(decoded.functionName).toBe("swapSlipstreamExactInputSingle");
    if (decoded.functionName !== "swapSlipstreamExactInputSingle") throw new Error("wrong entrypoint");
    const [params, tickSpacing] = decoded.args as unknown as readonly [Record<string, unknown>, number];
    expect(tickSpacing).toBe(10); // the live B20/USDC pool key
    expect(getAddress(params.router as string)).toBe(SLIP_ROUTER);
    expect(getAddress(params.tokenIn as string)).toBe(getAddress(BASE_MAINNET_USDC));
    expect(getAddress(params.tokenOut as string)).toBe(aaplc.address);
    expect(params.grossAmountIn).toBe(2_000_000n);
    expect(params.expectedFeeAmount).toBe(5_000n);
    expect(params.recipient).toBe(getAddress(TAKER));
    expect(params.unwrapNativeOut).toBe(false);
    expect(result.proposal.transaction!.value).toBe("0"); // ERC-20 sell: no msg.value
    expect(result.proposal.permit2).toBeNull(); // never a fee/permit signature
    // No step after the swap, fee or otherwise.
    const steps = result.proposal.postConfirmationSteps ?? [];
    expect(steps.some((step: string) => /after the swap settles|pay .*fee .*separately/i.test(step))).toBe(false);
  });

  it("15. a B20 sell takes the fee in the SELL token at its own decimals", async () => {
    // 5 AAPLc (8 decimals) = 500,000,000 atomic → fee 1,250,000 → swap 498,750,000.
    const { run, calls } = build({ from: aaplc, to: usdc, fromAmount: "500000000" });
    const result = await run;
    if (!result.ok) throw new Error("expected an executor proposal");

    expect(result.proposal.agentFee).toMatchObject({
      status: "applied",
      bps: 25,
      amountAtomic: "1250000",
      displayAmount: "0.0125 AAPLc",
      recipient: FEE_RECIPIENT,
    });
    expect(calls.quoterAmountIn).toBe(498_750_000n);
    const decoded = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: result.proposal.transaction!.data });
    if (decoded.functionName !== "swapSlipstreamExactInputSingle") throw new Error("wrong entrypoint");
    const [params] = decoded.args as unknown as readonly [Record<string, unknown>, number];
    expect(params.tokenIn).toBe(aaplc.address);
    expect(params.tokenOut).toBe(getAddress(BASE_MAINNET_USDC));
    expect(params.grossAmountIn).toBe(500_000_000n);
    expect(params.expectedFeeAmount).toBe(1_250_000n);
    expect((params.grossAmountIn as bigint) - (params.expectedFeeAmount as bigint)).toBe(498_750_000n);
  });

  it("16. approval is for the GROSS amount to the executor, and only when the allowance is short", async () => {
    const short = await build({ to: aaplc, fromAmount: "2000000", readerOptions: { allowance: 0n } }).run;
    if (!short.ok) throw new Error("expected an executor proposal");
    expect(short.proposal.needsPermit2Approval).toBe(true);
    expect(getAddress(short.proposal.permit2Spender!)).toBe(EXECUTOR);
    expect(short.proposal.issues.allowance).toMatchObject({ spender: EXECUTOR, currentAllowance: "0" });
    // One unit short of the GROSS amount still needs the approval — it is for the gross, never
    // the post-fee amount, and never for anything but the executor.
    const shortByOne = await build({ to: aaplc, fromAmount: "2000000", readerOptions: { allowance: 1_999_999n } }).run;
    if (!shortByOne.ok) throw new Error("expected an executor proposal");
    expect(shortByOne.proposal.needsPermit2Approval).toBe(true);

    const covered = await build({ to: aaplc, fromAmount: "2000000", readerOptions: { allowance: 2_000_000n } }).run;
    if (!covered.ok) throw new Error("expected an executor proposal");
    expect(covered.proposal.needsPermit2Approval).toBe(false);
    expect(covered.proposal.issues.allowance).toBeNull(); // swap only, no approval tx
  });

  it("17. slippage and min-out are computed on the POST-fee output", async () => {
    const { run } = build({
      to: aaplc,
      fromAmount: "2000000",
      slippageBps: 100,
      readerOptions: { allowance: 5_000_000n, quoterOut: 587_536n },
    });
    const result = await run;
    if (!result.ok) throw new Error("expected an executor proposal");
    expect(result.proposal.toAmount).toBe("587536");
    expect(result.proposal.minToAmount).toBe(applySlippage(587_536n, 100).toString());
    expect(applySlippage(587_536n, 100)).toBe(581_660n); // exactly the on-chain amountOutMinimum
    const decoded = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: result.proposal.transaction!.data });
    const [params] = decoded.args as unknown as readonly [Record<string, unknown>, number];
    expect(params.amountOutMinimum).toBe(581_660n);
  });

  it("18. a B20 pair keeps the executor fee even when the pool quote fails (never a fee-less fallback)", async () => {
    const { run } = build({ to: aaplc, fromAmount: "2000000", readerOptions: { failQuote: true } });
    const result = await run;
    expect(result.ok).toBe(false);
    if (result.ok || !("error" in result)) throw new Error("expected a supported-pair refusal");
    expect(result.supported).toBe(true); // supported pair, refused instead of re-routed
    expect(result.error.code).toBe("PROVIDER_ERROR");
  });

  it("19. pairs with no registered route stay non-executor (a fee-less route is never invented)", async () => {
    const { run } = build({ from: weth, to: aaplc, fromAmount: "1000000000000000" });
    const result = await run;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.supported).toBe(false); // WETH <-> B20 is not an app-supported executor pair
    expect(isExecutorRoutablePair(CANONICAL_WETH, aaplc.address)).toBe(false);
  });
});
