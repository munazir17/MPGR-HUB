// lib/delegated/__tests__/broadcast-gate.test.ts
//
// Unit proof for THE BOUNDED HOT WALLET (audit MC-2 remediation).
//
// The gate is what stops the operator's mainnet gas-payer key from being used
// for anything other than a swap the user literally signed for. Each test below
// mutates exactly ONE field of an otherwise-valid, correctly-encoded delegated
// transaction and asserts the gate refuses it with a specific reason — no
// signature, no broadcast.
//
// Pure unit tests: no chain, no network, no keys beyond a fixed test address.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";

import {
  DELEGATED_EXECUTOR_ABI,
  DELEGATED_EXECUTOR_FEE_BPS,
  DELEGATED_SWAP_ON_BEHALF_OF_SLIPSTREAM_SELECTOR,
  DELEGATED_SWAP_ON_BEHALF_OF_UNISWAP_V3_SELECTOR,
  buildDelegatedSwapParams,
  mainnetDelegatedExecutorDeployment,
} from "@/lib/executor/delegated-executor";
import { validateDelegatedTransaction, type GateAuthorization, type GateTransaction } from "@/lib/delegated/broadcast-gate";

const EXECUTOR = getAddress("0x1111111111111111111111111111111111111111");
const OTHER_CONTRACT = getAddress("0xD982726e28275661F8aB64054E6b17a70a63505A"); // the v1 assisted executor
const SLIP_ROUTER = getAddress("0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F");
const USER = getAddress("0x0000000000000000000000000000000000d0e541");
const ATTACKER = getAddress("0x000000000000000000000000000000000000beef");
const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const AAPLC = getAddress("0xb200000000000000000000C2e324d24d7eEcd1fb");
const WETH = getAddress("0x4200000000000000000000000000000000000006");

const GROSS = 20_000_000n; // 20 USDC
const MIN_OUT = 39_500_000n;
const FEE = (GROSS * BigInt(DELEGATED_EXECUTOR_FEE_BPS)) / 10_000n;
const ACTION_ID = ("0x" + "aa".repeat(32)) as Hex;
const POLICY_HASH = ("0x" + "bb".repeat(32)) as Hex;
const NOW = new Date(1_800_000_000_000);
const DEADLINE = Math.floor(NOW.getTime() / 1000) + 1800;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved.MPGR_MAINNET_DELEGATED_EXECUTOR = process.env.MPGR_MAINNET_DELEGATED_EXECUTOR;
  process.env.MPGR_MAINNET_DELEGATED_EXECUTOR = EXECUTOR;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

interface Build {
  tokenIn?: Address;
  tokenOut?: Address;
  grossAmountIn?: bigint;
  amountOutMinimum?: bigint;
  recipient?: Address;
  deadline?: number;
  intentId?: Hex;
  policyHash?: Hex;
  owner?: Address;
  permitAmount?: bigint;
  permitToken?: Address;
  permitDeadline?: number;
  functionName?: "swapOnBehalfOfSlipstream" | "swapOnBehalfOfUniswapV3";
  poolKey?: number;
}

/** Encode a valid delegated mainnet transaction, with any field overridden. */
function buildTx(o: Build = {}): { tx: GateTransaction; auth: GateAuthorization } {
  const tokenIn = o.tokenIn ?? USDC;
  const tokenOut = o.tokenOut ?? AAPLC;
  const grossAmountIn = o.grossAmountIn ?? GROSS;
  const amountOutMinimum = o.amountOutMinimum ?? MIN_OUT;
  const recipient = o.recipient ?? USER;
  const deadline = o.deadline ?? DEADLINE;
  const intentId = o.intentId ?? ACTION_ID;
  const policyHash = o.policyHash ?? POLICY_HASH;
  const owner = o.owner ?? USER;
  const permitToken = o.permitToken ?? tokenIn;
  const permitAmount = o.permitAmount ?? grossAmountIn;
  const permitDeadline = o.permitDeadline ?? deadline;
  const functionName = o.functionName ?? "swapOnBehalfOfSlipstream";

  const params = buildDelegatedSwapParams({
    router: SLIP_ROUTER,
    tokenIn,
    tokenOut,
    grossAmountIn: grossAmountIn.toString(),
    minAmountOut: amountOutMinimum.toString(),
    deadline,
    intentId,
    owner: recipient,
    feeBps: DELEGATED_EXECUTOR_FEE_BPS,
  });

  const authorizationTuple = {
    permit: { permitted: { token: permitToken, amount: permitAmount }, nonce: 7n, deadline: BigInt(permitDeadline) },
    witness: { owner, buyToken: tokenOut, minAmountOut: amountOutMinimum, deadline: BigInt(deadline), actionId: intentId, policyHash },
    signature: ("0x" + "cd".repeat(65)) as Hex,
  };

  const data =
    functionName === "swapOnBehalfOfSlipstream"
      ? encodeFunctionData({ abi: DELEGATED_EXECUTOR_ABI, functionName, args: [params, o.poolKey ?? 10, authorizationTuple] })
      : encodeFunctionData({ abi: DELEGATED_EXECUTOR_ABI, functionName, args: [params, o.poolKey ?? 3000, authorizationTuple] });

  return {
    tx: { to: EXECUTOR, data, chainId: 8453, value: 0n },
    // The STORED authorization the user actually signed (string/base-unit form).
    auth: {
      witness: {
        owner,
        buyToken: tokenOut,
        minAmountOut: amountOutMinimum.toString(),
        deadline,
        actionId: intentId,
        policyHash,
      },
      permit: { token: permitToken, amount: permitAmount.toString(), nonce: "7", deadline: permitDeadline },
      wallet: USER,
    },
  };
}

function refuseReason(tx: GateTransaction, auth: GateAuthorization, now: Date = NOW): string {
  const verdict = validateDelegatedTransaction(tx, auth, now);
  expect(verdict.allowed, `expected refusal but got allowed: ${JSON.stringify(verdict)}`).toBe(false);
  return verdict.allowed ? "" : verdict.reason;
}

describe("broadcast gate — the allowed case", () => {
  it("accepts a correctly-encoded Slipstream swap that matches the user's authorization exactly", () => {
    const { tx, auth } = buildTx();
    const verdict = validateDelegatedTransaction(tx, auth, NOW);
    expect(verdict.allowed, verdict.allowed ? "" : `${verdict.reason} ${verdict.detail ?? ""}`).toBe(true);
    if (verdict.allowed) {
      expect(verdict.selector).toBe(DELEGATED_SWAP_ON_BEHALF_OF_SLIPSTREAM_SELECTOR);
      expect(verdict.functionName).toBe("swapOnBehalfOfSlipstream");
      expect(verdict.params.recipient.toLowerCase()).toBe(USER.toLowerCase());
      expect(verdict.params.grossAmountIn).toBe(GROSS);
      expect(verdict.params.expectedFeeAmount).toBe(FEE);
    }
  });

  it("accepts the Uniswap V3 entrypoint too (USDC<->WETH on mainnet)", () => {
    const { tx, auth } = buildTx({ tokenOut: WETH, functionName: "swapOnBehalfOfUniswapV3", poolKey: 3000 });
    const verdict = validateDelegatedTransaction(tx, auth, NOW);
    expect(verdict.allowed, verdict.allowed ? "" : `${verdict.reason} ${verdict.detail ?? ""}`).toBe(true);
    if (verdict.allowed) expect(verdict.selector).toBe(DELEGATED_SWAP_ON_BEHALF_OF_UNISWAP_V3_SELECTOR);
  });

  it("accepts the same shape on Base Sepolia (84532), its own pinned executor", () => {
    const { tx, auth } = buildTx();
    const sepolia = validateDelegatedTransaction({ ...tx, chainId: 84532 }, auth, NOW);
    // `to` is the MAINNET executor, so on 84532 it must be refused as a
    // mismatch — proving the executor binding is per-chain, not global.
    expect(sepolia.allowed).toBe(false);
    if (!sepolia.allowed) expect(sepolia.reason).toBe("EXECUTOR_MISMATCH");
  });
});

describe("broadcast gate — every mutation is refused before signing", () => {
  it("WRONG CHAIN: an unsupported chain is refused", () => {
    const { tx, auth } = buildTx();
    expect(refuseReason({ ...tx, chainId: 1 }, auth)).toBe("CHAIN_UNSUPPORTED");
    expect(refuseReason({ ...tx, chainId: 31337 }, auth)).toBe("CHAIN_UNSUPPORTED");
  });

  it("WRONG CONTRACT: the operator key cannot be pointed at the assisted v1 executor", () => {
    const { tx, auth } = buildTx();
    expect(refuseReason({ ...tx, to: OTHER_CONTRACT }, auth)).toBe("EXECUTOR_MISMATCH");
  });

  it("UNPINNED EXECUTOR: with no mainnet executor configured the gate refuses", () => {
    delete process.env.MPGR_MAINNET_DELEGATED_EXECUTOR;
    expect(mainnetDelegatedExecutorDeployment()).toBeNull();
    const { tx, auth } = buildTx();
    expect(refuseReason(tx, auth)).toBe("EXECUTOR_NOT_CONFIGURED");
  });

  it("NATIVE VALUE: any msg.value is refused (both entrypoints revert on it anyway)", () => {
    const { tx, auth } = buildTx();
    expect(refuseReason({ ...tx, value: 1n }, auth)).toBe("NATIVE_VALUE_UNSUPPORTED");
    expect(refuseReason({ ...tx, value: 10n ** 18n }, auth)).toBe("NATIVE_VALUE_UNSUPPORTED");
  });

  it("WRONG SELECTOR: any other function is refused", () => {
    const { tx, auth } = buildTx();
    // A plausible-looking but different 4-byte selector.
    const swapped = ("0xdeadbeef" + tx.data.slice(10)) as Hex;
    expect(refuseReason({ ...tx, data: swapped }, auth)).toBe("SELECTOR_NOT_ALLOWED");
  });

  it("MALFORMED CALLDATA is refused, never signed", () => {
    const { auth } = buildTx();
    expect(refuseReason({ to: EXECUTOR, data: "0x" as Hex, chainId: 8453 }, auth)).toBe("DATA_INVALID");
    expect(refuseReason({ to: EXECUTOR, data: "0x1234" as Hex, chainId: 8453 }, auth)).toBe("DATA_INVALID");
    expect(refuseReason({ to: EXECUTOR, data: "not-hex" as unknown as Hex, chainId: 8453 }, auth)).toBe("DATA_INVALID");
  });

  it("REDIRECTED FUNDS: a recipient other than the signing owner is refused", () => {
    // params.recipient is attacker, witness.owner is the user.
    const { tx, auth } = buildTx({ recipient: ATTACKER, owner: USER });
    expect(refuseReason(tx, auth)).toBe("RECIPIENT_NOT_OWNER");
  });

  it("OWNER NOT THE POLICY WALLET: a witness naming someone else is refused", () => {
    const { tx, auth } = buildTx({ recipient: ATTACKER, owner: ATTACKER });
    expect(refuseReason(tx, auth)).toBe("OWNER_NOT_POLICY_WALLET");
  });

  it("AMOUNT ABOVE AUTHORIZATION: a larger gross input than the signed permit is refused", () => {
    // Calldata pulls 40 USDC but the user's stored permit authorized 20.
    const { tx, auth } = buildTx({ grossAmountIn: GROSS, permitAmount: GROSS });
    const inflated = buildTx({ grossAmountIn: GROSS * 2n, permitAmount: GROSS });
    expect(refuseReason(inflated.tx, auth)).toBe("PERMIT_AMOUNT_MISMATCH");
    void tx;
  });

  it("AMOUNT ABOVE AUTHORIZATION (witness floor lowered): a smaller minAmountOut is refused", () => {
    const { tx, auth } = buildTx();
    const lowered = buildTx({ amountOutMinimum: MIN_OUT / 2n });
    expect(refuseReason(lowered.tx, auth)).toBe("WITNESS_MIN_OUT_MISMATCH");
    void tx;
  });

  it("WRONG TOKEN: a different sell token than the signed permit is refused", () => {
    const { auth } = buildTx(); // stored permit is for USDC
    const other = buildTx({ tokenIn: WETH, permitToken: WETH });
    expect(refuseReason(other.tx, auth)).toBe("PERMIT_TOKEN_MISMATCH");
  });

  it("PERMIT/CALLDATA TOKEN DIVERGENCE: calldata pulls a token the permit did not grant", () => {
    // Stored permit authorizes USDC; calldata pulls WETH.
    const stored = buildTx();
    const calldata = buildTx({ tokenIn: WETH, permitToken: USDC, tokenOut: AAPLC });
    expect(refuseReason(calldata.tx, stored.auth)).toBe("PERMIT_TOKEN_MISMATCH");
  });

  it("WRONG BUY TOKEN: a different output token than the witness is refused", () => {
    const { tx, auth } = buildTx();
    const other = buildTx({ tokenOut: WETH });
    expect(refuseReason(other.tx, auth)).toBe("WITNESS_BUY_TOKEN_MISMATCH");
    void tx;
  });

  it("WRONG ACTION: a different intentId/actionId is refused", () => {
    const { tx, auth } = buildTx();
    const other = buildTx({ intentId: ("0x" + "cc".repeat(32)) as Hex });
    expect(refuseReason(other.tx, auth)).toBe("WITNESS_ACTION_ID_MISMATCH");
    void tx;
  });

  it("WRONG POLICY: a different policyHash is refused", () => {
    const { tx, auth } = buildTx();
    const other = buildTx({ policyHash: ("0x" + "dd".repeat(32)) as Hex });
    expect(refuseReason(other.tx, auth)).toBe("WITNESS_POLICY_HASH_MISMATCH");
    void tx;
  });

  it("EXPIRED: a lapsed deadline is refused pre-sign, not broadcast to revert", () => {
    const past = Math.floor(NOW.getTime() / 1000) - 10;
    const { tx, auth } = buildTx({ deadline: past, permitDeadline: past });
    expect(refuseReason(tx, auth)).toBe("DEADLINE_PASSED");
  });

  it("DEADLINE DIVERGENCE: calldata deadline != the signed one is refused", () => {
    const { tx, auth } = buildTx();
    const other = buildTx({ deadline: DEADLINE + 60 });
    expect(refuseReason(other.tx, auth)).toBe("WITNESS_DEADLINE_MISMATCH");
    void tx;
  });

  it("PERMIT DIVERGENCE: calldata permit != the stored permit is refused", () => {
    const stored = buildTx(); // stored permit amount == GROSS
    // Calldata carries a permit for one unit MORE than the user signed, while
    // the swap params still match the stored authorization.
    const other = buildTx({ permitAmount: GROSS + 1n, grossAmountIn: GROSS });
    expect(refuseReason(other.tx, stored.auth)).toBe("CALLDATA_PERMIT_AMOUNT_MISMATCH");
  });

  it("ZERO / NON-POSITIVE amounts are refused", () => {
    // A zero gross input cannot even be ENCODED: buildDelegatedSwapParams
    // refuses it at the canonical fee-math layer, so no calldata exists to
    // gate. That is a stronger guarantee than a gate refusal.
    expect(() => buildTx({ grossAmountIn: 0n, permitAmount: 0n })).toThrow(/ZERO_AMOUNT|fee computation refused/i);

    // A positive gross with a zero output floor encodes, and the gate refuses
    // it: the user must always have a non-zero minimum they are guaranteed.
    const zeroFloor = buildTx({ amountOutMinimum: 0n, permitAmount: GROSS });
    expect(refuseReason(zeroFloor.tx, zeroFloor.auth)).toBe("MIN_AMOUNT_OUT_NON_POSITIVE");
  });

  it("FEE MATH: a committed fee other than floor(gross * 25bps) is refused", () => {
    // Build valid calldata, then rebuild with a tampered expectedFeeAmount by
    // hand-encoding params the gate must reject.
    const params = buildDelegatedSwapParams({
      router: SLIP_ROUTER,
      tokenIn: USDC,
      tokenOut: AAPLC,
      grossAmountIn: GROSS.toString(),
      minAmountOut: MIN_OUT.toString(),
      deadline: DEADLINE,
      intentId: ACTION_ID,
      owner: USER,
      feeBps: DELEGATED_EXECUTOR_FEE_BPS,
    });
    const tampered = { ...params, expectedFeeAmount: params.expectedFeeAmount + 1n };
    const data = encodeFunctionData({
      abi: DELEGATED_EXECUTOR_ABI,
      functionName: "swapOnBehalfOfSlipstream",
      args: [
        tampered,
        10,
        {
          permit: { permitted: { token: USDC, amount: GROSS }, nonce: 7n, deadline: BigInt(DEADLINE) },
          witness: { owner: USER, buyToken: AAPLC, minAmountOut: MIN_OUT, deadline: BigInt(DEADLINE), actionId: ACTION_ID, policyHash: POLICY_HASH },
          signature: ("0x" + "cd".repeat(65)) as Hex,
        },
      ],
    });
    const { auth } = buildTx();
    expect(refuseReason({ to: EXECUTOR, data, chainId: 8453, value: 0n }, auth)).toBe("FEE_MISMATCH");
  });
});

describe("broadcast gate — structural guarantees", () => {
  it("never throws for a rejected transaction (a refusal is a verdict, not a fault)", () => {
    const { tx, auth } = buildTx();
    const cases: GateTransaction[] = [
      { ...tx, chainId: 999 },
      { ...tx, to: ATTACKER },
      { ...tx, data: "0x" as Hex },
      { ...tx, value: 5n },
      { ...tx, data: ("0xdeadbeef" + tx.data.slice(10)) as Hex },
    ];
    for (const c of cases) {
      expect(() => validateDelegatedTransaction(c, auth, NOW)).not.toThrow();
      expect(validateDelegatedTransaction(c, auth, NOW).allowed).toBe(false);
    }
  });

  it("the allowed selector set is derived from the ABI, not hand-written", () => {
    // If either selector were a typo, the allowed case above could not pass.
    expect(DELEGATED_SWAP_ON_BEHALF_OF_SLIPSTREAM_SELECTOR).toMatch(/^0x[0-9a-f]{8}$/);
    expect(DELEGATED_SWAP_ON_BEHALF_OF_UNISWAP_V3_SELECTOR).toMatch(/^0x[0-9a-f]{8}$/);
    expect(DELEGATED_SWAP_ON_BEHALF_OF_SLIPSTREAM_SELECTOR).not.toBe(DELEGATED_SWAP_ON_BEHALF_OF_UNISWAP_V3_SELECTOR);
    const { tx } = buildTx();
    expect(tx.data.slice(0, 10).toLowerCase()).toBe(DELEGATED_SWAP_ON_BEHALF_OF_SLIPSTREAM_SELECTOR);
  });
});
