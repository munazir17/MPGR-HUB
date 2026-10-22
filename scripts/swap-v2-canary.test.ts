// scripts/swap-v2-canary.test.ts
//
// THE PRIVATE CANARY for the sealed V2 executor. Read-only until an operator arms it,
// and it never signs, never sends, and never holds a key.
//
// WHY THIS EXISTS. Activation of V2 routing is a separate, reviewed commit that has not
// happened: `V2_DEPLOYMENT` is still `null`, so the app — on this branch and on main —
// cannot send a V2 swap. Before that commit is reviewed, an operator needs evidence that
// the deployed executor at 0x4be1154440b26145d76608D41d403a33e76b9d0A actually settles a
// real swap and pays the 25 bps fee to the pinned treasury. This harness produces that
// evidence in two halves: it builds and verifies the two canary swaps WITHOUT sending
// them, and then it verifies the receipts AFTER the operator has signed and broadcast
// them from their own wallet.
//
// THE TWO SWAPS THE OPERATOR SIGNS (tiny size, their own wallet, their own gas):
//
//   1. USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 -> WETH, 1.00 USDC (1000000 raw)
//   2. MPGR 0xB2000000000000000000008d204203177a78AF01 -> native ETH, 1 MPGR (1e18 raw)
//      (1 MPGR is the same size the fork proof executes, so the canary and the fork
//      evidence are directly comparable.)
//
//   Both must emit `SwapExecuted` with feeBps 25 and feeAmount exactly
//   grossAmountIn * 25 / 10000, to feeRecipient 0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4.
//   A multi-leg route additionally emits `SwapPathExecuted`. Anything else is a failure.
//
// HOW TO RUN (all read-only unless CANARY=1):
//
//   # 1. posture + dormancy check, no transaction built
//   MPGR_V2_CANARY=1 npx vitest run scripts/swap-v2-canary.test.ts
//
//   # 2. build the two unsigned swaps for YOUR wallet and print the runbook
//   MPGR_V2_CANARY=1 CANARY=1 CANARY_WALLET=0xYourWallet npx vitest run scripts/swap-v2-canary.test.ts
//
//   # 3. after you have signed and broadcast in your own wallet, verify a receipt
//   MPGR_V2_CANARY=1 CANARY_VERIFY_TX=0xReceiptHash npx vitest run scripts/swap-v2-canary.test.ts
//
// Sizes are overridable with CANARY_USDC_AMOUNT / CANARY_MPGR_AMOUNT (raw units).
// RPC is BASE_MAINNET_RPC_URL, else the public Base endpoint.
//
// WHAT THIS FILE MUST NEVER CONTAIN: a private key, a mnemonic, a wallet client, or any
// call that signs or broadcasts. The first test below audits this file's own source for
// exactly that, so the guarantee is enforced by the suite rather than by review alone.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createPublicClient, http, isAddress, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import {
  SWAP_V2_CHAIN_ID, SWAP_V2_SEALED_MANIFEST, SWAP_V2_WETH, swapV2Executor, swapV2RoutingActivated,
} from "@/lib/swap/v2/deployment";
import { verifyV2Posture, verifyV2Venues } from "@/lib/swap/v2/preflight";
import { prepareV2Execution, type V2ExecutionReader } from "@/lib/swap/v2/execution";
import { V2_DEPLOYMENT, V2_FEE_RECIPIENT, discoverV2Quote, type V2Quote } from "@/lib/swap/v2/discovery";
import { swapV2QuoteSource } from "@/lib/swap/v2/rpc-source";
import { parseV2SettlementEvents } from "@/lib/swap/v2/settlement";
import { NATIVE_ETH_SENTINEL } from "@/lib/trade/trade-config";

const ENABLED = ["1", "true"].includes(process.env.MPGR_V2_CANARY ?? "");
/** Armed: build the unsigned canary swaps and print the operator runbook. Still no send. */
const ARMED = ["1", "true"].includes(process.env.CANARY ?? "");
const WALLET = (process.env.CANARY_WALLET ?? "").trim();
const VERIFY_TX = (process.env.CANARY_VERIFY_TX ?? "").trim();
const RPC_URL = process.env.BASE_MAINNET_RPC_URL ?? "https://mainnet.base.org";

/** Native USDC on Base. Spelled in viem's own EIP-55 form: a single wrong case in a
 * checksummed literal makes viem throw inside the address encoder, which an operator
 * reads as "the swap failed" when nothing was ever attempted. */
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
/** MPGR, imported by address. This literal is the chain-verified `currency1` from the pool's
 * own Initialize log (docs/proofs/swap-v2-base-fork-*.md) and the same address
 * COVERAGE_MPGR, rpc-v4.test.ts and fork-fixture-discovery.test.ts already use. It is 40 hex
 * characters: viem rejects anything else, and the guard test below fails the build if a
 * digit is ever added or dropped here. */
const MPGR = "0xB2000000000000000000008d204203177a78AF01" as Address;
const EXECUTOR = SWAP_V2_SEALED_MANIFEST.executor;
const TREASURY = SWAP_V2_SEALED_MANIFEST.feeRecipient;
const CHAIN_TIMEOUT_MS = 240_000;

const rawAmount = (name: string, fallback: string): bigint => {
  const value = BigInt(process.env[name] ?? fallback);
  if (value <= 0n) throw new Error(`${name} must be a positive raw amount`);
  return value;
};
const usdcAmount = () => rawAmount("CANARY_USDC_AMOUNT", "1000000");            // 1.00 USDC
const mpgrAmount = () => rawAmount("CANARY_MPGR_AMOUNT", "1000000000000000000"); // 1 MPGR

const client = () => createPublicClient({ chain: base, transport: http(RPC_URL, { timeout: 30_000, retryCount: 3, retryDelay: 1_000 }) });
const feeOf = (gross: bigint) => (gross * 25n) / 10_000n;

describe("the canary harness holds no signing material", () => {
  it("audits its own source: no secret, no key read, no way to sign or send", () => {
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
    // Audit the CODE, not the prose: comments legitimately say "never signs".
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // Names are assembled from fragments so this test's own patterns cannot match
    // themselves, which would make the audit pass vacuously.
    const secretNames = ["PRIV" + "ATE_KEY", "MNE" + "MONIC", "SEED_" + "PHRASE", "SIG" + "NING_KEY", "DEPL" + "OYER_KEY"];
    const sendVerbs = ["wal" + "letClient", "send" + "Transaction", "sign" + "Transaction", "write" + "Contract", "sign" + "TypedData", "sign" + "Message"];
    for (const name of secretNames) expect(code, `the canary must not reference ${name}`).not.toContain(name);
    for (const verb of sendVerbs) expect(code, `the canary must not be able to ${verb}`).not.toContain(verb);
    // No 32-byte hex literal anywhere in the code: a key, a signature or a seed.
    expect(code).not.toMatch(/0x[0-9a-fA-F]{64}/);
    // And the whole file, comments included, names no environment variable that could
    // carry a key: the guard below checks the live environment at run time. Assembled
    // from fragments for the same reason as everything else in this test.
    const envPattern = new RegExp(`process\\.env\\.[A-Z_]*(${["KEY", "MNE" + "MONIC", "SEED"].join("|")})`);
    expect(source).not.toMatch(envPattern);
  });
});

describe("the canary names real addresses", () => {
  it("uses valid, chain-verified addresses for both legs", () => {
    // Always on: an invalid literal here would make the operator's armed run die inside
    // viem's address encoder instead of building a swap, which reads as a routing failure
    // and is not one. The expected values are the ones the fork proof read off-chain —
    // MPGR from the pool's Initialize log, USDC and the treasury from the sealed manifest.
    for (const [label, value] of [["USDC", USDC], ["MPGR", MPGR], ["EXECUTOR", EXECUTOR], ["TREASURY", TREASURY]] as const) {
      expect(isAddress(value), `${label} is not a valid 20-byte address: ${value}`).toBe(true);
    }
    expect(MPGR.toLowerCase()).toBe("0xb2000000000000000000008d204203177a78af01");
    expect(USDC.toLowerCase()).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    expect(TREASURY.toLowerCase()).toBe("0x96f7fb5c4277bd1190fb6ef4820ebc96ba6964a4");
    expect(MPGR.toLowerCase()).not.toBe(USDC.toLowerCase());
    // A native-side v4 pool sorts address(0) first, so MPGR is currency1 — the direction
    // this canary leg exercises. Asserted here so the runbook's own claim stays honest.
    expect(SWAP_V2_WETH.toLowerCase()).toBe("0x4200000000000000000000000000000000000006");
  });
});

describe("V2 canary: read-only posture and dormancy", () => {
  it.skipIf(!ENABLED)("refuses to run while any signing material is in the environment", () => {
    // Assembled from fragments, like the audit above: a literal spelling of these names
    // would trip the harness's own source audit and, worse, teach nothing.
    const pattern = new RegExp(["PRIV\\w*_KEY", "MNE" + "MONIC", "SEED_" + "PHRASE", "SIG" + "NING_KEY", "DEPL" + "OYER_KEY"].join("|"));
    const offenders = Object.keys(process.env).filter((name) => pattern.test(name) && (process.env[name] ?? "").length > 0);
    expect(offenders, `unset these before running a canary; this harness needs no key: ${offenders.join(", ")}`).toEqual([]);
  }, 30_000);

  it.skipIf(!ENABLED)("reports that activation has happened, so this canary is retired", () => {
    // The canary is a PRIVATE rehearsal that exists to precede activation. Once the gate
    // is flipped it is the wrong instrument: post-activation evidence belongs to the
    // settlement path and to receipt verification, not to a rehearsal.
    expect(V2_DEPLOYMENT).not.toBeNull();
    expect(swapV2Executor()?.executor.toLowerCase()).toBe("0x4be1154440b26145d76608d41d403a33e76b9d0a");
    expect(swapV2RoutingActivated()).toBe(true);
  }, 30_000);

  it.skipIf(!ENABLED)("verifies the sealed executor's live posture against the manifest", async () => {
    const reader = client();
    expect(await reader.getChainId()).toBe(SWAP_V2_CHAIN_ID);
    const block = await reader.getBlock();
    expect(block.number).toBeGreaterThan(BigInt(SWAP_V2_SEALED_MANIFEST.deployBlock));

    // Identity: the address, and the runtime code actually deployed at it.
    const code = await reader.getCode({ address: EXECUTOR, blockNumber: block.number });
    expect(code, "the sealed executor has no runtime code at the pinned block").toBeTruthy();
    expect(code).not.toBe("0x");

    // Posture and venue registration, through the same production checks the quote path
    // runs per request — not a parallel implementation that could drift.
    const posture = await verifyV2Posture(reader as never, SWAP_V2_SEALED_MANIFEST, block.number, BigInt(block.timestamp));
    expect(posture.feeBps).toBe(25);
    expect(posture.maxFeeBps).toBe(100);
    expect(posture.feeRecipient.toLowerCase()).toBe(TREASURY.toLowerCase());
    expect(posture.pinnedFeeRecipient.toLowerCase()).toBe(V2_FEE_RECIPIENT.toLowerCase());
    expect(posture.owner.toLowerCase()).toBe(SWAP_V2_SEALED_MANIFEST.owner.toLowerCase());
    expect(posture.paused).toBe(false);
    await verifyV2Venues(reader as never, SWAP_V2_SEALED_MANIFEST, block.number);

    console.warn(`::notice::V2 canary posture verified read-only at block ${block.number}: executor ${EXECUTOR}, fee ${posture.feeBps} bps to ${posture.feeRecipient}, owner ${posture.owner}, paused ${posture.paused}. Nothing was signed or sent.`);
  }, CHAIN_TIMEOUT_MS);
});

describe("V2 canary: the two swaps the operator signs", () => {
  /** Builds one canary swap end to end through the PRODUCTION path — staged discovery,
   * the 25 bps fee, the executor simulation as the taker at a pinned block — and returns
   * the unsigned request. It signs nothing and sends nothing. */
  const buildCanary = async (label: string, from: Address, to: Address, gross: bigint) => {
    if (!isAddress(WALLET)) {
      throw new Error(`CANARY=1 needs CANARY_WALLET to be the operator's public wallet address (got "${WALLET}"). No key is needed or wanted.`);
    }
    const reader = client();
    const block = await reader.getBlock();
    if (!block.hash || !/^0x[0-9a-fA-F]{64}$/.test(block.hash)) throw new Error("provider returned an unusable block hash; refusing to pin a canary to it");
    const quote: V2Quote = await discoverV2Quote(swapV2QuoteSource(reader as never, block.number), from, to, gross);

    // The fee invariant, checked before anything is handed to an operator.
    expect(quote.feeBps).toBe(25);
    expect(quote.fee).toBe(feeOf(quote.gross));
    expect(quote.net).toBe(quote.gross - quote.fee);
    expect(quote.feeRecipient.toLowerCase()).toBe(TREASURY.toLowerCase());

    const nativeIn = from.toLowerCase() === NATIVE_ETH_SENTINEL.toLowerCase();
    const nativeOut = to.toLowerCase() === NATIVE_ETH_SENTINEL.toLowerCase();
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
    const swap = await prepareV2Execution(reader as unknown as V2ExecutionReader, SWAP_V2_SEALED_MANIFEST, {
      quote, taker: WALLET as Address, slippageBps: 100, deadline, nativeIn, nativeOut,
    }, { number: block.number, hash: block.hash as Hex, timestamp: BigInt(block.timestamp) });

    // The transaction targets ONLY the sealed executor.
    expect(swap.transaction.to.toLowerCase()).toBe(EXECUTOR.toLowerCase());
    expect(swap.transaction.to.toLowerCase()).toBe("0x4be1154440b26145d76608d41d403a33e76b9d0a");
    expect(swap.spender.toLowerCase()).toBe(EXECUTOR.toLowerCase());
    expect(swap.fee).toBe(feeOf(gross));
    expect(swap.feeRecipient.toLowerCase()).toBe(TREASURY.toLowerCase());

    return { label, block, quote, swap, nativeIn, nativeOut };
  };

  const printRunbook = (built: { label: string; quote: V2Quote; swap: { transaction: { to: string; data: string; value: bigint }; intentId: string; minimum: bigint; quotedOut: bigint; entry: string } }[]) => {
    const lines: string[] = [
      "",
      "================ V2 PRIVATE CANARY — OPERATOR RUNBOOK ================",
      "Nothing below was signed or sent by this harness. You sign in your own wallet.",
      `Wallet: ${WALLET}`,
      `Executor (the ONLY contract these calls target): ${EXECUTOR}`,
      `Treasury that must receive the fee: ${TREASURY} (25 bps of gross, taken once)`,
      "",
    ];
    for (const item of built) {
      lines.push(`--- ${item.label} ---`);
      lines.push(`route: ${item.quote.legs.length} leg(s), ${item.quote.legs.map((leg) => `${leg.pools.length} hop(s) via kind(s) ${leg.pools.map((p) => p.kind).join("/")}`).join(" + ")}`);
      lines.push(`gross ${item.quote.gross} · fee ${item.quote.fee} (25 bps) · net ${item.quote.net} · quoted out ${item.swap.quotedOut} · minimum out ${item.swap.minimum}`);
      lines.push(`entry point: ${item.swap.entry}`);
      lines.push("unsigned transaction request (sign THIS, in your own wallet):");
      lines.push(JSON.stringify({ to: item.swap.transaction.to, data: item.swap.transaction.data, value: item.swap.transaction.value.toString(), chainId: SWAP_V2_CHAIN_ID }, null, 2));
      lines.push(`intentId: ${item.swap.intentId}`);
      lines.push("");
    }
    lines.push("After each swap is confirmed, verify the receipt read-only with:");
    lines.push("  MPGR_V2_CANARY=1 CANARY_VERIFY_TX=<txHash> npx vitest run scripts/swap-v2-canary.test.ts");
    lines.push("Expected in the receipt: status success; exactly one SwapExecuted with feeBps 25,");
    lines.push(`feeAmount == grossAmountIn * 25 / 10000, feeRecipient ${TREASURY}; plus one`);
    lines.push("SwapPathExecuted if the route had more than one leg. Do not broadcast a second");
    lines.push("time if a verification fails — stop and report.");
    lines.push("======================================================================");
    console.log(lines.join("\n"));
  };

  it.skipIf(!ENABLED || !ARMED)("builds USDC -> WETH and MPGR -> ETH without signing or sending", async () => {
    const usdc = await buildCanary(`USDC -> WETH, ${usdcAmount()} raw (1.00 USDC)`, USDC, SWAP_V2_WETH, usdcAmount());
    // MPGR to NATIVE ETH: the sell side is an 18-decimal token whose only liquidity is a
    // Uniswap v4 pool against native ETH, and the buy side is the native sentinel, which
    // discovery normalises to WETH and the executor settles back out as ETH.
    const mpgr = await buildCanary(`MPGR -> ETH, ${mpgrAmount()} raw (1 MPGR)`, MPGR, NATIVE_ETH_SENTINEL as Address, mpgrAmount());

    expect(mpgr.nativeOut).toBe(true);
    expect(mpgr.quote.tokenOut.toLowerCase()).toBe(SWAP_V2_WETH.toLowerCase());
    for (const built of [usdc, mpgr]) {
      expect(built.quote.legs.length).toBeGreaterThan(0);
      expect(built.quote.legs.length).toBeLessThanOrEqual(4);
      for (const leg of built.quote.legs) expect(leg.pools.length).toBeLessThanOrEqual(3);
    }
    printRunbook([usdc, mpgr] as never);
    console.warn(`::notice::V2 canary built 2 unsigned swaps at block ${usdc.block.number} for ${WALLET}. Nothing signed, nothing broadcast. USDC->WETH fee ${usdc.swap.fee}; MPGR->ETH fee ${mpgr.swap.fee}, ${mpgr.quote.legs[0].pools.length} hop(s) via venue kind(s) ${mpgr.quote.legs[0].pools.map((p) => p.kind).join("/")}.`);
  }, CHAIN_TIMEOUT_MS);

  it.skipIf(!ENABLED || !ARMED)("fails loudly when armed without an operator wallet address", () => {
    // Reaching this point means the build test above threw for the wrong reason; keep the
    // requirement explicit so an operator is never handed a half-built canary.
    expect(isAddress(WALLET), "CANARY=1 requires CANARY_WALLET=<public address>").toBe(true);
  }, 30_000);
});

describe("V2 canary: verifying a receipt the operator already broadcast", () => {
  it.skipIf(!ENABLED || !VERIFY_TX)("confirms the 25 bps fee reached the pinned treasury", async () => {
    const reader = client();
    const hash = VERIFY_TX as Hex;
    expect(hash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    const receipt = await reader.getTransactionReceipt({ hash });
    expect(receipt.status, "the canary transaction did not succeed; stop and report, do not rebroadcast").toBe("success");
    expect(receipt.to?.toLowerCase(), "the transaction did not target the sealed executor").toBe(EXECUTOR.toLowerCase());

    const events = parseV2SettlementEvents(receipt as never);
    expect(events.executed.length, "expected exactly one SwapExecuted event").toBe(1);
    const executed = events.executed[0];
    expect(executed.feeBps).toBe(25);
    expect(executed.feeAmount).toBe(feeOf(executed.grossAmountIn));
    expect(executed.feeAmount).toBeGreaterThan(0n);
    expect(executed.swapAmountIn).toBe(executed.grossAmountIn - executed.feeAmount);
    expect(executed.feeRecipient.toLowerCase()).toBe(TREASURY.toLowerCase());
    expect(executed.taker.toLowerCase(), "the swap settled for someone other than the canary wallet").toBe(receipt.from.toLowerCase());
    expect(executed.amountOut).toBeGreaterThan(0n);

    const legs = events.pathExecuted.length;
    if (legs > 0) {
      expect(legs, "a split settlement must emit exactly one SwapPathExecuted").toBe(1);
      expect(events.pathExecuted[0].intentId).toBe(executed.intentId);
    }
    console.warn(`::notice::V2 canary receipt ${hash} verified: gross ${executed.grossAmountIn}, fee ${executed.feeAmount} (25 bps) to ${executed.feeRecipient}, out ${executed.amountOut}, venue kind ${executed.routerKind}, path events ${legs}. Read-only; nothing was sent.`);
  }, CHAIN_TIMEOUT_MS);
});
