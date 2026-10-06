/**
 * Offline tests for the MPGRExecutorDelegated Base Mainnet smoke safety gates
 * (scripts/delegated-smoke-gates.mjs) — the decision layer that
 * script/smoke-delegated-executor-base-mainnet.mjs is allowed to act on.
 *
 * No network, no clock, no key material: the gates are pure functions over
 * injected facts, so every refusal listed here is a real regression test for
 * "the live step must not happen".
 *
 * Covered: the pinned deployment facts (cross-checked against the deployment
 * guard, the committed reviewed config and the production registry), the
 * smallest-safe-amount choice, the deterministic single-use identity, EIP-712
 * agreement with the production signing recipe, and every gate group — mode /
 * environment, signer identity, config pins, live preconditions, post-trade
 * verification and the one-shot ledger.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeFunctionData, getAddress, hashTypedData, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  ACTION_WITNESS_STRUCT_TYPE_STRING,
  ACTION_WITNESS_TYPEHASH,
  BPS_DENOMINATOR,
  CAMPAIGN,
  CANONICAL_PERMIT2,
  CANONICAL_WETH,
  CHAIN_ID,
  CODE_HASH_PIN_ENV,
  DEADLINE_SECONDS,
  DELEGATED_DEPLOYER,
  DELEGATED_DEPLOY_BLOCK,
  DELEGATED_DEPLOY_TX,
  DELEGATED_EXECUTOR,
  DEPLOYMENT_RECORD_PATH,
  EMERGENCY_ENV,
  EXPECTED_FEE_AMOUNT,
  EXPECTED_GAS_LIMIT,
  EXPLORER,
  FEE_BPS,
  FEE_RECIPIENT,
  FORBIDDEN_SIGNERS,
  GROSS_AMOUNT_IN,
  KEY_ENV,
  LEDGER_ACK_ENV,
  LEDGER_DIR_ENV,
  LEDGER_DIR,
  LEDGER_VERSION,
  LIVE_CONFIRM_PHRASE,
  LOG_CHUNK,
  MAX_FEE_BPS,
  MAX_FEE_PER_GAS_CAP,
  MIN_DEADLINE_MARGIN_SECONDS,
  MODES,
  NETWORK_LABEL,
  OWNER,
  PERMIT2_DOMAIN_NAME,
  PHASE5_CANARY_WALLET,
  PRIORITY_FEE_CAP,
  QUOTE_MAX_WEI,
  QUOTE_MIN_WEI,
  REVIEWED_CONFIG_PATH,
  RPC_ENV,
  SEPOLIA_DELEGATED_EXECUTOR,
  SLIPPAGE_BPS,
  SWAP_AMOUNT_IN,
  SWAP_ON_BEHALF_OF_SLIPSTREAM_SELECTOR,
  SWAP_ON_BEHALF_OF_TYPED_MODULE_SELECTOR,
  SWAP_ON_BEHALF_OF_UNISWAP_V3_SELECTOR,
  UNISWAP_V3_FACTORY,
  UNISWAP_V3_POOL,
  UNISWAP_V3_POOL_FEE,
  UNISWAP_V3_QUOTER,
  UNISWAP_V3_ROUTER,
  USDC,
  WITNESS_TYPE_STRING,
  ZERO_ADDRESS,
  V1_MAINNET_EXECUTOR,
  V1_SMOKE_WALLET,
  WALLET_PIN_ENV,
  actionWitnessHash,
  buildActionWitness,
  buildLedgerEntry,
  buildPermit2Authorization,
  buildPermitTypedData,
  buildSwapParams,
  canaryIdentityFor,
  codeDispatchesSelector,
  evaluateConfigPins,
  evaluateLedgerClaim,
  evaluateLedgerGuard,
  evaluateLivePreconditions,
  evaluateModeGuard,
  evaluatePostTradeVerification,
  evaluateSignerIdentity,
  feeSplit,
  isBytes32,
  isLocalRpc,
  isPrivateKeyShape,
  ledgerFileName,
  minOutFromQuote,
  nonceBitmapWordMarks,
  nonceBitPosition,
  normalizeAddress,
  quoteWithinSanityBand,
  redact,
  renderTitle,
  rehearsalPrincipal,
  rehearsalPrincipals,
  safeErrorMessage,
  sameAddress,
  summarizeChecks,
} from "./delegated-smoke-gates.mjs";

// Cross-checked against the production code path, not a copy of it.
import {
  DELEGATED_WITNESS_TYPE_STRING,
  delegatedPermitDigest,
  delegatedWitnessHash,
  mainnetDelegatedExecutorAddress,
  mainnetDelegatedExecutorDeployment,
} from "@/lib/executor/delegated-executor";
import { EXPECTED_EXECUTOR, EXPECTED_OWNER, EXPECTED_FEE_RECIPIENT, CANONICAL_PERMIT2 as GUARD_PERMIT2, CANONICAL_WETH as GUARD_WETH } from "./delegated-mainnet-deployment-guard.mjs";

const committedConfig = JSON.parse(readFileSync("deployments/base-mainnet/delegated-deploy-config.json", "utf8"));
const runnerSource = readFileSync("script/smoke-delegated-executor-base-mainnet.mjs", "utf8");
const v1WorkflowSource = readFileSync(".github/workflows/smoke-executor-base-mainnet.yml", "utf8");

/** A wallet that is none of the forbidden roles — the canary identity under test. */
const SIGNER = getAddress("0x1111111111111111111111111111111111111111");
const BROADCASTER = getAddress("0x2222222222222222222222222222222222222222");
const NOW = 1_800_000_000n;
/** 0.00015 ETH for 0.49875 USDC — a plausible mid-market price, inside the band. */
const QUOTE = 150_000_000_000_000n;
/** Code with a real Solidity dispatch entry for the delegated selector. */
const CODE_WITH_DELEGATED_DISPATCH = `0x6080604052${"63"}${SWAP_ON_BEHALF_OF_UNISWAP_V3_SELECTOR.slice(2)}14601057${"00".repeat(64)}`;

const blockerNames = (result: { blockers: string[] }) => result.blockers;
interface GateRow {
  name: string;
  ok: boolean;
  detail: string;
  fatal?: boolean;
  skipped?: boolean;
}
const checkNamed = (result: { checks: GateRow[] }, needle: string) => result.checks.find((c) => c.name.includes(needle));

// ---------------------------------------------------------------------------
describe("pinned deployment facts", () => {
  it("targets the verified Base Mainnet MPGRExecutorDelegated from the deployment guard", () => {
    expect(CHAIN_ID).toBe(8453);
    expect(NETWORK_LABEL).toBe("Base Mainnet");
    expect(EXPLORER).toBe("https://basescan.org");
    expect(DELEGATED_EXECUTOR).toBe(getAddress(EXPECTED_EXECUTOR));
    expect(OWNER).toBe(getAddress(EXPECTED_OWNER));
    expect(FEE_RECIPIENT).toBe(getAddress(EXPECTED_FEE_RECIPIENT));
    expect(CANONICAL_WETH).toBe(getAddress(GUARD_WETH));
    expect(CANONICAL_PERMIT2).toBe(getAddress(GUARD_PERMIT2));
    expect(DELEGATED_DEPLOY_BLOCK).toBeGreaterThan(0n);
    expect(DELEGATED_DEPLOY_TX).toMatch(/^0x[0-9a-f]{64}$/);
    expect(DELEGATED_DEPLOYER).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(DEPLOYMENT_RECORD_PATH).toBe("deployments/base-mainnet/mpgr-executor-delegated.json");
    expect(REVIEWED_CONFIG_PATH).toBe("deployments/base-mainnet/delegated-deploy-config.json");
  });

  it("is NOT the v1 executor, NOT the Sepolia contracts and never a zero address", () => {
    expect(DELEGATED_EXECUTOR).not.toBe(V1_MAINNET_EXECUTOR);
    expect(DELEGATED_EXECUTOR).not.toBe(SEPOLIA_DELEGATED_EXECUTOR);
    expect(sameAddress(DELEGATED_EXECUTOR, ZERO_ADDRESS)).toBe(false);
    // The v1 smoke workflow keeps its own (unchanged) target.
    expect(v1WorkflowSource).toContain("0xD982726e28275661F8aB64054E6b17a70a63505A");
    expect(v1WorkflowSource).not.toContain(DELEGATED_EXECUTOR);
  });

  it("pins the official Base Uniswap V3 venue the route table uses", () => {
    expect(UNISWAP_V3_ROUTER).toBe(getAddress("0x2626664c2603336E57B271c5C0b26F421741e481"));
    expect(UNISWAP_V3_POOL).toBe(getAddress("0x6c561B446416E1A00E8E93E221854d6eA4171372"));
    expect(UNISWAP_V3_POOL_FEE).toBe(3000);
    expect(UNISWAP_V3_FACTORY).toBe(getAddress("0x33128a8fC17869897dcE68Ed026d694621f6FDfD"));
    expect(USDC).toBe(getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"));
    const entry = committedConfig.routers.find((r: { kind: number }) => r.kind === 2);
    expect(entry.router).toBe(UNISWAP_V3_ROUTER);
    expect(entry.quoterV2).toBe(UNISWAP_V3_QUOTER);
    expect(entry.factory).toBe(UNISWAP_V3_FACTORY);
    expect(entry.usdcWethPool).toBe(UNISWAP_V3_POOL);
    expect(entry.usdcWethPoolFee).toBe(UNISWAP_V3_POOL_FEE);
  });

  it("agrees with the production mainnet delegated registry entry when the operator pins it", () => {
    const previous = process.env.MPGR_MAINNET_DELEGATED_EXECUTOR;
    delete process.env.MPGR_MAINNET_DELEGATED_EXECUTOR;
    // Without the operator pin the repo exposes NO mainnet delegated executor,
    // which is exactly why this canary pins the deployment-report address.
    expect(mainnetDelegatedExecutorAddress()).toBeNull();
    try {
      process.env.MPGR_MAINNET_DELEGATED_EXECUTOR = DELEGATED_EXECUTOR;
      expect(mainnetDelegatedExecutorAddress()?.toLowerCase()).toBe(DELEGATED_EXECUTOR.toLowerCase());
      const deployment = mainnetDelegatedExecutorDeployment();
      expect(deployment).not.toBeNull();
      expect(deployment?.executor.toLowerCase()).toBe(DELEGATED_EXECUTOR.toLowerCase());
      expect(deployment?.owner.toLowerCase()).toBe(OWNER.toLowerCase());
      expect(deployment?.feeRecipient.toLowerCase()).toBe(FEE_RECIPIENT.toLowerCase());
      expect(deployment?.feeBps).toBe(Number(FEE_BPS));
      expect(deployment?.weth.toLowerCase()).toBe(CANONICAL_WETH.toLowerCase());
      expect(deployment?.permit2.toLowerCase()).toBe(CANONICAL_PERMIT2.toLowerCase());
      expect(deployment?.network).toBe("base");
      expect(deployment?.chainId).toBe(CHAIN_ID);
      const routes = (deployment?.routes ?? []) as unknown as Array<{ tokenA: string; tokenB: string; router: string; quoter: string; poolFee?: number; kind?: number }>;
      const route = routes.find(
        (r) =>
          (sameAddress(r.tokenA, USDC) && sameAddress(r.tokenB, CANONICAL_WETH)) ||
          (sameAddress(r.tokenB, USDC) && sameAddress(r.tokenA, CANONICAL_WETH)),
      );
      expect(route).toBeDefined();
      expect(route?.router.toLowerCase()).toBe(UNISWAP_V3_ROUTER.toLowerCase());
      expect(route?.quoter.toLowerCase()).toBe(UNISWAP_V3_QUOTER.toLowerCase());
      expect(route?.poolFee).toBe(UNISWAP_V3_POOL_FEE);
      expect(route?.kind).toBe(2);
    } finally {
      if (previous === undefined) delete process.env.MPGR_MAINNET_DELEGATED_EXECUTOR;
      else process.env.MPGR_MAINNET_DELEGATED_EXECUTOR = previous;
    }
  });

  it("pins the real delegated entrypoint selectors", () => {
    expect(SWAP_ON_BEHALF_OF_UNISWAP_V3_SELECTOR).toBe("0x9d5fea22");
    expect(SWAP_ON_BEHALF_OF_SLIPSTREAM_SELECTOR).toBe("0x710a9231");
    expect(SWAP_ON_BEHALF_OF_TYPED_MODULE_SELECTOR).toBe("0x1360cb87");
    expect(SWAP_ON_BEHALF_OF_UNISWAP_V3_SELECTOR).not.toBe(SWAP_ON_BEHALF_OF_SLIPSTREAM_SELECTOR);
  });

  it("mirrors the contract's EIP-712 witness typing", () => {
    expect(ACTION_WITNESS_TYPEHASH).toBe(keccak256(toHex(ACTION_WITNESS_STRUCT_TYPE_STRING)));
    expect(WITNESS_TYPE_STRING).toBe(DELEGATED_WITNESS_TYPE_STRING);
    expect(ZERO_ADDRESS).toBe("0x0000000000000000000000000000000000000000");
    expect(LEDGER_DIR_ENV).toBe("SMOKE_DELEGATED_LEDGER_DIR");
    expect(ACTION_WITNESS_TYPEHASH).toMatch(/^0x[0-9a-f]{64}$/);
    expect(PERMIT2_DOMAIN_NAME).toBe("Permit2");
    expect(LOG_CHUNK).toBeGreaterThan(0n);
  });

  it("names every env var the runner reads and the confirmation phrase", () => {
    expect(KEY_ENV).toBe("SMOKE_DELEGATED_PRIVATE_KEY");
    expect(WALLET_PIN_ENV).toBe("SMOKE_DELEGATED_WALLET_ADDRESS");
    expect(RPC_ENV).toBe("SMOKE_DELEGATED_RPC_URL");
    expect(CODE_HASH_PIN_ENV).toBe("SMOKE_DELEGATED_EXPECTED_CODE_HASH");
    expect(LEDGER_ACK_ENV).toBe("SMOKE_DELEGATED_LEDGER_ACK");
    expect(EMERGENCY_ENV).toBe("MPGR_AUTONOMOUS_EMERGENCY_DISABLE");
    expect(LIVE_CONFIRM_PHRASE).toBe("smoke-delegated-base-mainnet");
    expect(MODES).toEqual({ REHEARSAL: "rehearsal", PREFLIGHT: "preflight", LIVE: "live" });
  });
});

// ---------------------------------------------------------------------------
describe("smallest safe amount", () => {
  it("is 0.50 USDC with an exact non-zero 25 bps fee", () => {
    expect(GROSS_AMOUNT_IN).toBe(500_000n); // 6 decimals
    expect(EXPECTED_FEE_AMOUNT).toBe(1_250n);
    expect(SWAP_AMOUNT_IN).toBe(498_750n);
    expect(EXPECTED_FEE_AMOUNT + SWAP_AMOUNT_IN).toBe(GROSS_AMOUNT_IN);
    expect(feeSplit(GROSS_AMOUNT_IN)).toEqual({ fee: EXPECTED_FEE_AMOUNT, swapAmount: SWAP_AMOUNT_IN });
  });

  it("sits above the contract's FeeRoundsToZero floor and is the smallest round amount that does", () => {
    // floor(gross * 25 / 10000) must be >= 1, i.e. gross >= 400 raw units.
    expect(feeSplit(399n)?.fee).toBe(0n);
    expect(feeSplit(400n)?.fee).toBe(1n);
    expect(GROSS_AMOUNT_IN).toBeGreaterThanOrEqual(400n);
    // The chosen gross is still 1/2000 of a cent-scale trade: exposure <= $1.
    expect(GROSS_AMOUNT_IN).toBeLessThan(2_000_000n);
  });

  it("keeps the output far above dust and the slippage floor at exactly 1%", () => {
    expect(SLIPPAGE_BPS).toBe(100n);
    expect(BPS_DENOMINATOR).toBe(10_000n);
    const minOut = minOutFromQuote(QUOTE);
    expect(minOut).toBe((QUOTE * 9_900n) / 10_000n);
    expect(minOut as bigint).toBeGreaterThan(QUOTE / 10_000n); // >> dust
    expect(minOutFromQuote(QUOTE, 10_000n)).toBeNull(); // >= 100% slippage is refused
    expect(minOutFromQuote(QUOTE, 10_001n)).toBeNull();
    expect(minOutFromQuote("garbage")).toBeNull();
  });

  it("bounds the quote by an ETH-price sanity band that a wrong pool cannot fit", () => {
    expect(quoteWithinSanityBand(QUOTE)).toEqual({ ok: true, detail: expect.stringContaining("implied ETH") });
    expect(quoteWithinSanityBand(QUOTE_MIN_WEI).ok).toBe(true);
    expect(quoteWithinSanityBand(QUOTE_MAX_WEI).ok).toBe(true);
    expect(quoteWithinSanityBand(QUOTE_MIN_WEI - 1n).ok).toBe(false); // > $20k ETH / inverted pair
    expect(quoteWithinSanityBand(QUOTE_MAX_WEI + 1n).ok).toBe(false); // < $500 ETH
    expect(quoteWithinSanityBand(0n).ok).toBe(false); // the 1-wei dust case
    expect(quoteWithinSanityBand(undefined).ok).toBe(false);
    expect(QUOTE_MAX_WEI / QUOTE_MIN_WEI).toBe(40n); // $500 .. $20 000 implied ETH price
    expect(minOutFromQuote(QUOTE_MAX_WEI)! > QUOTE_MIN_WEI).toBe(true);
  });

  it("keeps gas and fee caps tight enough to be a real limit", () => {
    expect(MAX_FEE_PER_GAS_CAP).toBe(1_000_000_000n); // 1 gwei
    expect(PRIORITY_FEE_CAP).toBe(50_000_000n);
    expect(EXPECTED_GAS_LIMIT).toBe(900_000n);
    expect(MAX_FEE_PER_GAS_CAP * EXPECTED_GAS_LIMIT).toBeGreaterThan(0n);
    expect(DEADLINE_SECONDS).toBe(300n);
    expect(MIN_DEADLINE_MARGIN_SECONDS).toBe(90n);
    expect(DEADLINE_SECONDS > MIN_DEADLINE_MARGIN_SECONDS).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("small helpers", () => {
  it("compares addresses without ever throwing", () => {
    expect(sameAddress(USDC, USDC.toLowerCase())).toBe(true);
    expect(sameAddress(null, USDC)).toBe(false);
    expect(sameAddress("0xnope", USDC)).toBe(false);
    expect(normalizeAddress(" 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 ")).toEqual({ ok: true, address: USDC, detail: USDC });
    expect(normalizeAddress("", "x").ok).toBe(false);
    expect(normalizeAddress("0x123").ok).toBe(false);
    expect(normalizeAddress(undefined).detail).toContain("missing");
  });

  it("accepts only well-formed key and bytes32 shapes", () => {
    expect(isPrivateKeyShape(`0x${"cd".repeat(32)}`)).toBe(true);
    expect(isPrivateKeyShape(`${"cd".repeat(32)}`)).toBe(false); // no 0x
    expect(isPrivateKeyShape(`0x${"cd".repeat(31)}`)).toBe(false);
    expect(isPrivateKeyShape(`0x${"zz".repeat(32)}`)).toBe(false);
    expect(isPrivateKeyShape(null)).toBe(false);
    expect(isBytes32(`0x${"11".repeat(32)}`)).toBe(true);
    expect(isBytes32(`0x${"11".repeat(31)}`)).toBe(false);
  });

  it("classifies loopback RPCs only", () => {
    expect(isLocalRpc("http://127.0.0.1:8545")).toBe(true);
    expect(isLocalRpc("http://localhost:8545")).toBe(true);
    expect(isLocalRpc("http://[::1]:8545")).toBe(true);
    expect(isLocalRpc("https://mainnet.base.org")).toBe(false);
    expect(isLocalRpc("http://127.0.0.1.evil.example")).toBe(false);
    expect(isLocalRpc("not a url")).toBe(false);
    expect(isLocalRpc(undefined)).toBe(false);
  });

  it("redacts every long secret and keeps short noise", () => {
    const secret = `0x${"ab".repeat(32)}`;
    expect(redact(`key=${secret} leaked`, [secret])).toBe("key=<redacted> leaked");
    expect(redact("http://user:pass@host", ["pass"])).toBe("http://user:pass@host"); // < 8 chars: too generic
    expect(redact("clean", [])).toBe("clean");
  });

  it("truncates and redacts error messages", () => {
    const secret = `0x${"ef".repeat(32)}`;
    const err = new Error(`first line ${secret}\nsecond line\n${"x".repeat(2000)}`);
    const msg = safeErrorMessage(err, [secret]);
    expect(msg).toContain("<redacted>");
    expect(msg).not.toContain(secret);
    expect(msg.split("\n").length).toBe(1);
    expect(msg.length).toBeLessThanOrEqual(500);
    expect(safeErrorMessage("plain string")).toBe("plain string");
  });

  it("detects the delegated dispatch entry in runtime bytecode only", () => {
    expect(codeDispatchesSelector(CODE_WITH_DELEGATED_DISPATCH, SWAP_ON_BEHALF_OF_UNISWAP_V3_SELECTOR)).toBe(true);
    expect(codeDispatchesSelector(CODE_WITH_DELEGATED_DISPATCH, SWAP_ON_BEHALF_OF_TYPED_MODULE_SELECTOR)).toBe(false);
    expect(codeDispatchesSelector("0x", SWAP_ON_BEHALF_OF_UNISWAP_V3_SELECTOR)).toBe(false);
    expect(codeDispatchesSelector(undefined, SWAP_ON_BEHALF_OF_UNISWAP_V3_SELECTOR)).toBe(false);
    expect(codeDispatchesSelector("0xzz", SWAP_ON_BEHALF_OF_UNISWAP_V3_SELECTOR)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("deterministic canary identity (the on-chain half of the one-shot guard)", () => {
  it("is a stable function of the wallet alone", () => {
    const a = canaryIdentityFor(SIGNER);
    const b = canaryIdentityFor(SIGNER.toLowerCase());
    expect(a).toEqual(b);
    expect(a.intentId).toBe(a.actionId);
    expect(a.actionId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a.policyHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a.actionId).not.toBe(a.policyHash);
  });

  it("differs for every wallet (no cross-wallet nonce collision)", () => {
    expect(canaryIdentityFor(BROADCASTER).actionId).not.toBe(canaryIdentityFor(SIGNER).actionId);
    expect(canaryIdentityFor(BROADCASTER).permitNonce).not.toBe(canaryIdentityFor(SIGNER).permitNonce);
  });

  it("refuses a malformed wallet instead of inventing an identity", () => {
    expect(() => canaryIdentityFor("0xnope")).toThrow(/smoke wallet/);
  });

  it("produces a Permit2 unordered nonce inside the uint256 range", () => {
    const { permitNonce } = canaryIdentityFor(SIGNER);
    const n = BigInt(permitNonce);
    expect(n).toBeGreaterThan(0n);
    expect(n).toBeLessThan(2n ** 256n); // fits a uint256 nonce
    // Permit2's own decomposition: word = nonce >> 8, bit = nonce & 0xff.
    expect(nonceBitPosition(permitNonce)?.wordIndex).toBe(n >> 8n);
    expect(nonceBitPosition(permitNonce)?.bit).toBe(1n << (n & 0xffn));
  });

  it("maps a nonce onto the right Permit2 bitmap word and bit", () => {
    const { permitNonce } = canaryIdentityFor(SIGNER);
    const pos = nonceBitPosition(permitNonce);
    expect(pos?.wordIndex).toBe(BigInt(permitNonce) >> 8n);
    expect(pos?.bit).toBe(1n << (BigInt(permitNonce) & 0xffn));
    expect(nonceBitPosition(-1n)).toBeNull();
    expect(nonceBitPosition("garbage")).toBeNull();

    const word = 1n << (BigInt(permitNonce) & 0xffn);
    expect(nonceBitmapWordMarks(0n, permitNonce)).toBe(false);
    expect(nonceBitmapWordMarks(word, permitNonce)).toBe(true);
    expect(nonceBitmapWordMarks(word * 2n, permitNonce)).toBe(false); // a neighbouring bit is not this nonce
    expect(nonceBitmapWordMarks(null, permitNonce)).toBeNull();
    expect(nonceBitmapWordMarks(word, "nonsense")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("authorization construction agrees with the deployed contract", () => {
  const identity = canaryIdentityFor(SIGNER);
  const deadline = NOW + DEADLINE_SECONDS;
  const witness = buildActionWitness({
    owner: SIGNER,
    minAmountOut: minOutFromQuote(QUOTE),
    deadline,
    actionId: identity.actionId,
    policyHash: identity.policyHash,
  });
  const permit = { token: USDC, amount: GROSS_AMOUNT_IN.toString(), nonce: identity.permitNonce, deadline: Number(deadline) };

  it("builds the ActionWitness the contract expects", () => {
    expect(witness.owner).toBe(SIGNER);
    expect(witness.buyToken).toBe(CANONICAL_WETH);
    expect(witness.minAmountOut).toBe(String(minOutFromQuote(QUOTE)));
    expect(witness.deadline).toBe(Number(deadline));
    expect(witness.actionId).toBe(identity.actionId);
    expect(witness.policyHash).toBe(identity.policyHash);
  });

  it("hashes the witness exactly like the production recipe (and the contract)", () => {
    const independent = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }],
        [ACTION_WITNESS_TYPEHASH, witness.owner, witness.buyToken, BigInt(witness.minAmountOut), BigInt(witness.deadline), witness.actionId, witness.policyHash],
      ),
    );
    expect(actionWitnessHash(witness)).toBe(independent);
    expect(actionWitnessHash(witness)).toBe(delegatedWitnessHash(witness as never));
  });

  it("changes the witness hash when ANY signed field changes", () => {
    const base = actionWitnessHash(witness);
    expect(actionWitnessHash({ ...witness, minAmountOut: String(BigInt(witness.minAmountOut) + 1n) })).not.toBe(base);
    expect(actionWitnessHash({ ...witness, deadline: witness.deadline + 1 })).not.toBe(base);
    expect(actionWitnessHash({ ...witness, owner: BROADCASTER })).not.toBe(base);
    expect(actionWitnessHash({ ...witness, buyToken: USDC })).not.toBe(base);
    expect(actionWitnessHash({ ...witness, actionId: keccak256(toHex("other")) })).not.toBe(base);
    expect(actionWitnessHash({ ...witness, policyHash: keccak256(toHex("other")) })).not.toBe(base);
  });

  it("signs a Permit2 PermitWitnessTransferFrom bound to this chain and executor", () => {
    const typed = buildPermitTypedData({ permit, witness }, CHAIN_ID, DELEGATED_EXECUTOR);
    expect(typed.domain).toEqual({ name: "Permit2", chainId: 8453, verifyingContract: CANONICAL_PERMIT2 });
    expect(typed.primaryType).toBe("PermitWitnessTransferFrom");
    expect(typed.types.PermitWitnessTransferFrom.map((f: { name: string }) => f.name)).toEqual([
      "permitted",
      "spender",
      "nonce",
      "deadline",
      "witness",
    ]);
    expect(typed.types.ActionWitness.map((f: { type: string }) => f.type)).toEqual(["address", "address", "uint256", "uint256", "bytes32", "bytes32"]);
    expect(typed.message.spender).toBe(DELEGATED_EXECUTOR);
    expect(typed.message.permitted.amount).toBe(GROSS_AMOUNT_IN);
    expect(typed.message.nonce).toBe(BigInt(identity.permitNonce));
    // The digest must equal the production recipe's, or the signature is worthless.
    expect(hashTypedData(typed as never)).toBe(delegatedPermitDigest({ permit, witness } as never, CHAIN_ID, DELEGATED_EXECUTOR as never));
  });

  it("refuses to build typed data for a foreign chain", () => {
    expect(() => buildPermitTypedData({ permit, witness }, 84532, DELEGATED_EXECUTOR)).toThrow(/refusing chain 84532/);
  });

  it("binds the permit signature to the smoke wallet (sign -> recover)", async () => {
    const account = privateKeyToAccount(`0x${"12".repeat(32)}`);
    const typed = buildPermitTypedData({ permit, witness }, CHAIN_ID, DELEGATED_EXECUTOR);
    const signature = await account.signTypedData(typed as never);
    const { verifyTypedData } = await import("viem");
    expect(
      await verifyTypedData({
        address: account.address,
        domain: typed.domain,
        types: typed.types,
        primaryType: typed.primaryType,
        message: typed.message,
        signature,
      } as never),
    ).toBe(true);
    // A tampered witness invalidates the signature.
    expect(
      await verifyTypedData({
        address: account.address,
        domain: typed.domain,
        types: typed.types,
        primaryType: typed.primaryType,
        message: { ...typed.message, witness: { ...witness, minAmountOut: "1" } },
        signature,
      } as never),
    ).toBe(false);
  });

  it("builds SwapParams with recipient == owner and the pinned fee split", () => {
    const params = buildSwapParams({ owner: SIGNER, quoteMinOut: QUOTE, deadline, actionId: identity.actionId });
    expect(params.router).toBe(UNISWAP_V3_ROUTER);
    expect(params.tokenIn).toBe(USDC);
    expect(params.tokenOut).toBe(CANONICAL_WETH);
    expect(params.grossAmountIn).toBe(GROSS_AMOUNT_IN);
    expect(params.expectedFeeAmount).toBe(EXPECTED_FEE_AMOUNT);
    expect(params.amountOutMinimum).toBe(QUOTE);
    expect(params.recipient).toBe(SIGNER); // == witness.owner, enforced on-chain
    expect(params.deadline).toBe(BigInt(deadline));
    expect(params.intentId).toBe(identity.actionId);
    expect(params.unwrapNativeOut).toBe(false); // WETH stays WETH
  });

  it("carries the same values through the real ABI encoder", () => {
    const params = buildSwapParams({ owner: SIGNER, quoteMinOut: QUOTE, deadline, actionId: identity.actionId });
    const auth = buildPermit2Authorization({ owner: SIGNER, permit, witness, signature: `0x${"11".repeat(65)}` });
    expect(auth.permit.permitted.amount).toBe(GROSS_AMOUNT_IN);
    expect(auth.witness.owner).toBe(SIGNER);
    const data = encodeFunctionData({
      abi: [
        {
          type: "function",
          stateMutability: "payable",
          name: "swapOnBehalfOfUniswapV3",
          inputs: [
            {
              name: "p",
              type: "tuple",
              components: [
                { name: "router", type: "address" },
                { name: "tokenIn", type: "address" },
                { name: "tokenOut", type: "address" },
                { name: "grossAmountIn", type: "uint256" },
                { name: "expectedFeeAmount", type: "uint256" },
                { name: "amountOutMinimum", type: "uint256" },
                { name: "recipient", type: "address" },
                { name: "deadline", type: "uint256" },
                { name: "intentId", type: "bytes32" },
                { name: "unwrapNativeOut", type: "bool" },
              ],
            },
            { name: "poolFee", type: "uint24" },
            {
              name: "auth",
              type: "tuple",
              components: [
                {
                  name: "permit",
                  type: "tuple",
                  components: [
                    {
                      name: "permitted",
                      type: "tuple",
                      components: [
                        { name: "token", type: "address" },
                        { name: "amount", type: "uint256" },
                      ],
                    },
                    { name: "nonce", type: "uint256" },
                    { name: "deadline", type: "uint256" },
                  ],
                },
                {
                  name: "witness",
                  type: "tuple",
                  components: [
                    { name: "owner", type: "address" },
                    { name: "buyToken", type: "address" },
                    { name: "minAmountOut", type: "uint256" },
                    { name: "deadline", type: "uint256" },
                    { name: "actionId", type: "bytes32" },
                    { name: "policyHash", type: "bytes32" },
                  ],
                },
                { name: "signature", type: "bytes" },
              ],
            },
          ],
          outputs: [{ name: "amountOut", type: "uint256" }],
        },
      ],
      functionName: "swapOnBehalfOfUniswapV3",
      args: [params, UNISWAP_V3_POOL_FEE, auth],
    });
    expect(data.slice(0, 10)).toBe(SWAP_ON_BEHALF_OF_UNISWAP_V3_SELECTOR);
    expect(data.toLowerCase()).toContain(USDC.slice(2).toLowerCase());
    expect(data.toLowerCase()).toContain(identity.actionId.slice(2).toLowerCase());
  });
});

// ---------------------------------------------------------------------------
describe("mode + environment gate", () => {
  const base = {
    rpcUrls: ["http://127.0.0.1:8545"],
    keyEnvValue: undefined,
    walletPinEnvValue: SIGNER,
    githubActions: "true",
    emergencyDisabled: false,
  };

  it("accepts a keyless rehearsal against exactly one local fork", () => {
    const r = evaluateModeGuard({ ...base, mode: MODES.REHEARSAL });
    expect(r.allowed).toBe(true);
    expect(r.checks.length).toBeGreaterThanOrEqual(6);
  });

  it("accepts a keyless read-only preflight against real mainnet", () => {
    const r = evaluateModeGuard({ ...base, mode: MODES.PREFLIGHT, rpcUrls: ["https://mainnet.base.org"] });
    expect(r.allowed).toBe(true);
    expect(checkNamed(r, "preflight reads no private key")?.ok).toBe(true);
  });

  it("accepts live only in CI with a well-formed key and a valid pin", () => {
    const r = evaluateModeGuard({
      ...base,
      mode: MODES.LIVE,
      rpcUrls: ["https://mainnet.base.org"],
      keyEnvValue: `0x${"cd".repeat(32)}`,
    });
    expect(r.allowed).toBe(true);
  });

  it("refuses an unknown or missing mode", () => {
    for (const mode of ["", "prod", "LIVE ", "rehearsal ", undefined, null]) {
      expect(evaluateModeGuard({ ...base, mode }).allowed, `mode=${String(mode)}`).toBe(false);
    }
  });

  it("refuses to run without an RPC", () => {
    for (const rpcUrls of [[], undefined, null, [""], [null], "http://127.0.0.1:8545"]) {
      expect(evaluateModeGuard({ ...base, mode: MODES.REHEARSAL, rpcUrls }).allowed, `rpc=${String(rpcUrls)}`).toBe(false);
    }
  });

  it("honours the emergency kill switch in every mode", () => {
    for (const mode of [MODES.REHEARSAL, MODES.PREFLIGHT, MODES.LIVE]) {
      const r = evaluateModeGuard({ ...base, mode, emergencyDisabled: true, rpcUrls: mode === MODES.REHEARSAL ? base.rpcUrls : ["https://mainnet.base.org"], keyEnvValue: mode === MODES.LIVE ? `0x${"cd".repeat(32)}` : undefined });
      expect(r.allowed, mode).toBe(false);
      expect(checkNamed(r, "emergency kill switch")?.ok).toBe(false);
    }
  });

  it("refuses a remote or second RPC for the rehearsal (it must be a local fork)", () => {
    expect(evaluateModeGuard({ ...base, mode: MODES.REHEARSAL, rpcUrls: ["https://mainnet.base.org"] }).allowed).toBe(false);
    expect(evaluateModeGuard({ ...base, mode: MODES.REHEARSAL, rpcUrls: ["http://127.0.0.1:8545", "https://mainnet.base.org"] }).allowed).toBe(false);
  });

  it("refuses a key present in the environment for rehearsal and preflight", () => {
    const key = `0x${"cd".repeat(32)}`;
    expect(evaluateModeGuard({ ...base, mode: MODES.REHEARSAL, keyEnvValue: key }).allowed).toBe(false);
    expect(evaluateModeGuard({ ...base, mode: MODES.PREFLIGHT, rpcUrls: ["https://mainnet.base.org"], keyEnvValue: key }).allowed).toBe(false);
  });

  it("refuses to read mainnet state from a local fork during preflight", () => {
    expect(evaluateModeGuard({ ...base, mode: MODES.PREFLIGHT, rpcUrls: ["http://127.0.0.1:8545"] }).allowed).toBe(false);
  });

  it("refuses live outside GitHub Actions (no environment approval possible)", () => {
    const live = { mode: MODES.LIVE, rpcUrls: ["https://mainnet.base.org"], keyEnvValue: `0x${"cd".repeat(32)}`, walletPinEnvValue: SIGNER };
    for (const githubActions of [undefined, "", "false", "1"]) {
      const r = evaluateModeGuard({ ...live, githubActions, emergencyDisabled: false });
      expect(r.allowed, `GITHUB_ACTIONS=${String(githubActions)}`).toBe(false);
      expect(checkNamed(r, "GitHub Actions")?.ok).toBe(false);
    }
  });

  it("refuses live against a local fork RPC", () => {
    expect(
      evaluateModeGuard({
        mode: MODES.LIVE,
        rpcUrls: ["http://127.0.0.1:8545"],
        keyEnvValue: `0x${"cd".repeat(32)}`,
        walletPinEnvValue: SIGNER,
        githubActions: "true",
        emergencyDisabled: false,
      }).allowed,
    ).toBe(false);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["no prefix", `${"cd".repeat(32)}`],
    ["short", "0xdeadbeef"],
    ["long", `0x${"cd".repeat(33)}`],
    ["non-hex", `0x${"zz".repeat(32)}`],
    ["non-string", 12345],
  ])("refuses a %s private key without echoing it", (_label, value) => {
    const r = evaluateModeGuard({
      mode: MODES.LIVE,
      rpcUrls: ["https://mainnet.base.org"],
      keyEnvValue: value as string | undefined,
      walletPinEnvValue: SIGNER,
      githubActions: "true",
      emergencyDisabled: false,
    });
    expect(r.allowed).toBe(false);
    const detail = checkNamed(r, "is a 32-byte key")?.detail ?? "";
    expect(detail === "missing" || detail === "present but malformed (value not shown)").toBe(true);
  });

  it("refuses a malformed wallet pin for preflight and live", () => {
    for (const mode of [MODES.PREFLIGHT, MODES.LIVE]) {
      expect(evaluateModeGuard({ mode, rpcUrls: ["https://mainnet.base.org"], keyEnvValue: mode === MODES.LIVE ? `0x${"cd".repeat(32)}` : undefined, walletPinEnvValue: "0xnope", githubActions: "true", emergencyDisabled: false }).allowed, mode).toBe(false);
      expect(evaluateModeGuard({ mode, rpcUrls: ["https://mainnet.base.org"], keyEnvValue: mode === MODES.LIVE ? `0x${"cd".repeat(32)}` : undefined, walletPinEnvValue: "", githubActions: "true", emergencyDisabled: false }).allowed, `${mode} empty pin`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
describe("signer identity gate (fresh, dedicated, pinned, never a reused wallet)", () => {
  it("refuses the v1 smoke wallet in every mode", () => {
    for (const mode of [MODES.REHEARSAL, MODES.PREFLIGHT, MODES.LIVE]) {
      const r = evaluateSignerIdentity({ mode, derivedSigner: V1_SMOKE_WALLET, pinnedWallet: V1_SMOKE_WALLET });
      expect(r.allowed, mode).toBe(false);
      expect(checkNamed(r, "forbidden")?.detail).toContain("v1 smoke-test wallet");
    }
  });

  it.each([
    ["the Phase-5/6 mainnet canary wallet", PHASE5_CANARY_WALLET, "Phase-5/6"],
    ["the delegated deployer key address", DELEGATED_DEPLOYER, "deployment key"],
    ["the executor owner", OWNER, "executor owner"],
    ["the fee recipient", FEE_RECIPIENT, "fee recipient"],
    ["the delegated executor itself", DELEGATED_EXECUTOR, "contract cannot be the signer"],
    ["the v1 executor", V1_MAINNET_EXECUTOR, "v1 executor"],
    ["the Base Sepolia delegated executor", SEPOLIA_DELEGATED_EXECUTOR, "Sepolia"],
    ["Permit2", CANONICAL_PERMIT2, "Permit2"],
    ["the Uniswap V3 router", UNISWAP_V3_ROUTER, "SwapRouter02"],
    ["the QuoterV2", UNISWAP_V3_QUOTER, "QuoterV2"],
    ["the V3 factory", UNISWAP_V3_FACTORY, "factory"],
    ["the pool", UNISWAP_V3_POOL, "pool"],
    ["USDC", USDC, "USDC"],
    ["WETH", CANONICAL_WETH, "WETH"],
    ["the zero address", ZERO_ADDRESS, "zero address"],
  ])("refuses %s as the smoke signer", (_label, address, reason) => {
    const r = evaluateSignerIdentity({ mode: MODES.LIVE, derivedSigner: address, pinnedWallet: address });
    expect(r.allowed).toBe(false);
    expect(checkNamed(r, "forbidden")?.detail).toContain(reason);
  });

  it("refuses a key whose derived address is not the pinned wallet (never trade someone else's money)", () => {
    const r = evaluateSignerIdentity({ mode: MODES.LIVE, derivedSigner: SIGNER, pinnedWallet: BROADCASTER });
    expect(r.allowed).toBe(false);
    expect(checkNamed(r, "derived signer == the pinned smoke wallet")?.ok).toBe(false);
  });

  it("refuses a missing or malformed pin", () => {
    for (const pinnedWallet of ["", undefined, null, "0x123"]) {
      expect(evaluateSignerIdentity({ mode: MODES.LIVE, derivedSigner: SIGNER, pinnedWallet }).allowed, String(pinnedWallet)).toBe(false);
    }
  });

  it("refuses a malformed derived address rather than trusting it", () => {
    const r = evaluateSignerIdentity({ mode: MODES.LIVE, derivedSigner: "not-an-address", pinnedWallet: SIGNER });
    expect(r.allowed).toBe(false);
    expect(checkNamed(r, "derives a valid address")?.ok).toBe(false);
  });

  it("accepts a fresh dedicated wallet that matches its pin", () => {
    const r = evaluateSignerIdentity({ mode: MODES.LIVE, derivedSigner: SIGNER, pinnedWallet: SIGNER.toLowerCase() });
    expect(r.allowed).toBe(true);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it("honours an operator-supplied extra denylist", () => {
    const r = evaluateSignerIdentity({ mode: MODES.LIVE, derivedSigner: SIGNER, pinnedWallet: SIGNER, extraForbidden: [BROADCASTER, SIGNER] });
    expect(r.allowed).toBe(false);
    expect(evaluateSignerIdentity({ mode: MODES.LIVE, derivedSigner: SIGNER, pinnedWallet: SIGNER, extraForbidden: [BROADCASTER] }).allowed).toBe(true);
  });

  it("keeps the denylist complete so a new role can only be added", () => {
    expect(Object.keys(FORBIDDEN_SIGNERS).length).toBeGreaterThanOrEqual(17);
    for (const key of Object.keys(FORBIDDEN_SIGNERS)) expect(key).toMatch(/^0x[0-9a-f]{40}$/);
  });
});

// ---------------------------------------------------------------------------
describe("committed configuration gate", () => {
  const recordFor = (overrides: Record<string, unknown> = {}) => ({
    executor: DELEGATED_EXECUTOR,
    deployTx: DELEGATED_DEPLOY_TX,
    deployedAtBlock: DELEGATED_DEPLOY_BLOCK.toString(),
    paused: false,
    proxy: "none",
    ...overrides,
  });

  it("passes for the committed config and the verified record", () => {
    expect(evaluateConfigPins({ config: committedConfig, record: recordFor() }).allowed).toBe(true);
  });

  it("passes with no committed record, as a non-fatal note (the deployment report is the pin)", () => {
    const r = evaluateConfigPins({ config: committedConfig, record: null });
    expect(r.allowed).toBe(true);
    const absent = checkNamed(r, "deployment record absent");
    expect(absent?.ok).toBe(true);
    expect(absent?.fatal).toBe(false);
  });

  it("refuses a missing config file entirely", () => {
    expect(evaluateConfigPins({ config: null, record: null }).allowed).toBe(false);
  });

  it.each([
    ["the v1 contract name", { contract: "MPGRExecutor" }],
    ["the wrong chain", { chainId: 84532 }],
    ["a different owner", { owner: SIGNER }],
    ["a different fee recipient", { feeRecipient: SIGNER }],
    ["a higher fee", { feeBps: 100 }],
    ["an uncapped maxFeeBps", { maxFeeBps: 10_000 }],
    ["a non-canonical WETH", { weth: SIGNER }],
    ["a non-canonical Permit2", { permit2: SIGNER }],
    ["a missing router table", { routers: [] }],
    ["no tokens allowlisted", { tokens: [] }],
  ])("refuses %s", (_label, patch) => {
    const r = evaluateConfigPins({ config: { ...committedConfig, ...patch }, record: null });
    expect(r.allowed).toBe(false);
  });

  it("refuses a router table that duplicates or moves the Uniswap V3 venue", () => {
    const routers = committedConfig.routers as Array<Record<string, unknown>>;
    expect(evaluateConfigPins({ config: { ...committedConfig, routers: [...routers, ...routers.filter((x) => x.kind === 2)] }, record: null }).allowed).toBe(false);
    const moved = routers.map((r) => (Number(r.kind) === 2 ? { ...r, usdcWethPool: SIGNER } : r));
    expect(evaluateConfigPins({ config: { ...committedConfig, routers: moved }, record: null }).allowed).toBe(false);
    const slipstreamed = routers.map((r) => (Number(r.kind) === 2 ? { ...r, kind: 1 } : r));
    expect(evaluateConfigPins({ config: { ...committedConfig, routers: slipstreamed }, record: null }).allowed).toBe(false);
  });

  it("refuses a deployment record that disagrees with the pinned deployment", () => {
    for (const patch of [
      { executor: V1_MAINNET_EXECUTOR },
      { executor: SIGNER },
      { deployTx: `0x${"00".repeat(32)}` },
      { deployedAtBlock: "1" },
      { paused: true },
      { proxy: "transparent" },
    ]) {
      const r = evaluateConfigPins({ config: committedConfig, record: recordFor(patch) });
      expect(r.allowed, JSON.stringify(patch)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
/**
 * The committed record is the artifact the repo reads at runtime
 * (`script/smoke-delegated-executor-base-mainnet.mjs`, the preflight
 * `one_time_artifact_guard`, and the deploy script's refuse-to-redeploy check),
 * so it is asserted here against the pinned deployment facts and the reviewed
 * config rather than only against a fixture.
 *
 * `runtimeCodeHash` is keccak256 of the deployed executor runtime code. Rebuilding
 * `contracts/executor/MPGRExecutorDelegated.sol` with the CI build settings
 * (solc 0.8.24+commit.e11b9ed9, evmVersion cancun, optimizer runs 200,
 * `metadata.bytecodeHash = ipfs`, the pinned remappings) reproduces the mined
 * creation bytecode: same length, same head/tail, and the same embedded metadata
 * digest `20b41a1e403632f30f0c5386857f9c42c9b6f76f3c431eeb2f67110e79481b78`, which pins
 * every source and setting. Patching that rebuild's six immutable sites (4x WETH
 * `0x4200…0006`, 2x Permit2 `0x0000…78BA3`, each read back from the live runtime at
 * offsets 527/1403/7291/11611 and 1124/11740) yields the hash asserted below — the
 * same equality the deployment workflow's postflight assertion
 * (`runtimeCodeHash == keccak256(cast code <executor>)`) enforced on the run that
 * mined block 52252520. The optional pre-deployment observation `0xc6114750…a4d6`
 * in docs/DELEGATED-MAINNET-SMOKE-RUNBOOK.md §3 is NOT this value and must not be
 * used as `SMOKE_DELEGATED_EXPECTED_CODE_HASH`.
 */
describe("committed Base Mainnet deployment record", () => {
  const recordPath = resolve(process.cwd(), DEPLOYMENT_RECORD_PATH);

  it("is committed at the guarded path", () => {
    expect(existsSync(recordPath), `${DEPLOYMENT_RECORD_PATH} must be committed after the deployment`).toBe(true);
  });

  const record = JSON.parse(readFileSync(recordPath, "utf8"));

  it("pins the mined deployment exactly as the gates and the guard do", () => {
    expect(evaluateConfigPins({ config: committedConfig, record }).allowed).toBe(true);
    expect(record.artifactSchemaVersion).toBe(1);
    expect(record.contract).toBe("MPGRExecutorDelegated");
    expect(record.network).toBe("base");
    expect(record.chainId).toBe(CHAIN_ID);
    expect(record.executor).toBe(DELEGATED_EXECUTOR);
    expect(record.executor).toBe(EXPECTED_EXECUTOR);
    expect(record.deployer).toBe(DELEGATED_DEPLOYER);
    expect(record.deployTx).toBe(DELEGATED_DEPLOY_TX);
    expect(record.deployedAtBlock).toBe(Number(DELEGATED_DEPLOY_BLOCK));
    expect(record.deploymentReceiptSuccess).toBe(true);
    expect(record.paused).toBe(false);
    expect(record.proxy).toBe("none");
    expect(record.implementation).toBe("none");
    expect(record.upgradeAuthority).toBe("none");
    expect(record.owner).toBe(OWNER);
    expect(record.owner).toBe(EXPECTED_OWNER);
    expect(record.feeRecipient).toBe(FEE_RECIPIENT);
    expect(record.feeRecipient).toBe(EXPECTED_FEE_RECIPIENT);
    expect(record.feeBps).toBe(Number(FEE_BPS));
    expect(record.maxFeeBps).toBe(Number(MAX_FEE_BPS));
    expect(record.weth).toBe(CANONICAL_WETH);
    expect(record.weth).toBe(GUARD_WETH);
    expect(record.permit2).toBe(CANONICAL_PERMIT2);
    expect(record.permit2).toBe(GUARD_PERMIT2);
    expect(record.witnessTypeString).toBe(WITNESS_TYPE_STRING);
  });

  it("carries the reviewed allowlist and the recorder's empty-module schema", () => {
    expect(record.routerAllowlist).toEqual(committedConfig.routers.map((r: { router: string }) => r.router));
    expect(record.routerKinds).toEqual(committedConfig.routers.map((r: { kind: number }) => r.kind));
    expect(record.allowedTokenAddresses).toEqual(committedConfig.tokens.map((t: { address: string }) => t.address));
    expect(record.allowedTokenSymbols).toEqual(committedConfig.tokens.map((t: { symbol: string }) => t.symbol));
    expect(record.allowedTokenAddresses).toHaveLength(50);
    expect(record.moduleRegistrySchemaVersion).toBe(1);
    expect(record.typedModuleRegistryStatus).toBe("EMPTY_AT_DEPLOYMENT");
    expect(record.registeredTypedModules).toEqual([]);
    expect(record.configFile).toBe(REVIEWED_CONFIG_PATH);
  });

  it("records the reproduced runtime code hash and the pending source verification", () => {
    expect(record.runtimeCodeHash).toBe(
      "0xc232d9d36cabcefd5f97029d2b4c1f2d60a1b0cd54d020f12d0b517eb3cf085c",
    );
    expect(record.sourceVerificationStatus).toBe("PENDING_EXTERNAL_VERIFICATION");
    expect(record.sourceVerificationUrl).toBe(`https://basescan.org/address/${DELEGATED_EXECUTOR}`);
  });
});

// ---------------------------------------------------------------------------
/** A complete, self-consistent set of MAINNET READS that should allow a live run. */
function greenFacts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const identity = canaryIdentityFor(SIGNER);
  const deadline = NOW + DEADLINE_SECONDS;
  const witness = buildActionWitness({
    owner: SIGNER,
    minAmountOut: minOutFromQuote(QUOTE),
    deadline,
    actionId: identity.actionId,
    policyHash: identity.policyHash,
  });
  const params = buildSwapParams({ owner: SIGNER, quoteMinOut: QUOTE, deadline, actionId: identity.actionId });
  return {
    mode: MODES.LIVE,
    confirmedPhrase: LIVE_CONFIRM_PHRASE,
    expectedCodeHash: null,
    chainId: CHAIN_ID,
    targetExecutor: DELEGATED_EXECUTOR,
    executorCode: CODE_WITH_DELEGATED_DISPATCH,
    executorCodeHash: keccak256(toHex("executor")),
    livePaused: false,
    liveFeeBps: FEE_BPS,
    liveMaxFeeBps: MAX_FEE_BPS,
    liveOwner: OWNER,
    livePendingOwner: ZERO_ADDRESS,
    liveFeeRecipient: FEE_RECIPIENT,
    liveWeth: CANONICAL_WETH,
    livePermit2: CANONICAL_PERMIT2,
    liveWitnessTypeString: WITNESS_TYPE_STRING,
    liveWitnessStructTypeString: ACTION_WITNESS_STRUCT_TYPE_STRING,
    liveActionWitnessTypehash: ACTION_WITNESS_TYPEHASH,
    liveRouterKind: 2,
    liveUsdcAllowed: true,
    liveWethAllowed: true,
    liveSwapModule: ZERO_ADDRESS,
    liveSwapModuleCodeHash: `0x${"00".repeat(32)}`,
    onChainFee: EXPECTED_FEE_AMOUNT,
    onChainSwapAmount: SWAP_AMOUNT_IN,
    witnessHashOnChain: actionWitnessHash(witness),
    witnessHashLocal: actionWitnessHash(witness),
    unwrapNativeOut: params.unwrapNativeOut,
    signer: SIGNER,
    routerCode: "0x60016002",
    quoterCode: "0x60016002",
    poolCode: "0x60016002",
    poolFromFactory: UNISWAP_V3_POOL,
    usdcDecimals: 6,
    wethDecimals: 18,
    quoteAmountOut: QUOTE,
    amountOutMinimum: minOutFromQuote(QUOTE),
    latestBlockTimestamp: NOW,
    deadline,
    walletUsdc: 10_000_000n,
    walletEth: 50_000_000_000_000_000n,
    executorUsdc: 0n,
    executorWeth: 0n,
    executorEth: 0n,
    feeRecipientUsdc: 0n,
    walletAllowanceToExecutor: 0n,
    walletAllowanceToPermit2: 0n,
    permit2AllowanceAmount: 0n,
    permit2NonceUsed: false,
    permit2Nonce: identity.permitNonce,
    permit2NonceBitmapWord: 0n,
    permit2NonceDerivedFor: SIGNER,
    executorRouterAllowance: 0n,
    priorSwapEvents: 0,
    ledgerExists: false,
    ledgerPath: null,
    ledgerClaimId: null,
    ledgerTx: null,
    maxFeePerGas: 20_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    swapGasEstimate: 350_000n,
    simulationOk: true,
    simulationAmountOut: QUOTE,
    simulationError: null,
    calldataSelector: SWAP_ON_BEHALF_OF_UNISWAP_V3_SELECTOR,
    calldataMatchesParams: true,
    signatureRecoversToSigner: true,
    recoveredSigner: SIGNER,
    ...overrides,
  };
}

describe("live precondition gate — the green path", () => {
  it("allows a fully satisfied live canary", () => {
    const r = evaluateLivePreconditions(greenFacts());
    expect(r.blockers).toEqual([]);
    expect(r.allowed).toBe(true);
    expect(r.checks.length).toBeGreaterThan(45);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it("allows preflight with the signature-dependent proofs reported as skipped", () => {
    const r = evaluateLivePreconditions(greenFacts({ mode: MODES.PREFLIGHT, confirmedPhrase: "", simulationOk: undefined, signatureRecoversToSigner: undefined }));
    expect(r.allowed).toBe(true);
    const skipped = r.checks.filter((c) => c.skipped === true);
    expect(skipped.length).toBe(3);
    expect(skipped.every((c) => c.ok === true && c.fatal === false)).toBe(true);
  });

  it("records an absent code-hash pin as a non-fatal note", () => {
    const r = evaluateLivePreconditions(greenFacts());
    expect(checkNamed(r, "no code-hash pin configured")?.fatal).toBe(false);
  });
});

describe("live precondition gate — every refusal", () => {
  const refuses = (label: string, patch: Record<string, unknown>, needle?: string) => {
    it(label, () => {
      const r = evaluateLivePreconditions(greenFacts(patch));
      expect(r.allowed).toBe(false);
      if (needle) expect(blockerNames(r).join(" | ")).toContain(needle);
    });
  };

  refuses("a different chain (even Base Sepolia)", { chainId: 84532 }, "chainId is 8453");
  refuses("a missing chain id", { chainId: undefined }, "chainId is 8453");
  refuses("the v1 assisted executor as target", { targetExecutor: V1_MAINNET_EXECUTOR }, "NOT the v1 assisted executor");
  refuses("some other executor address", { targetExecutor: SIGNER }, "NOT the v1 assisted executor");
  refuses("an executor with no code", { executorCode: "0x" }, "runtime bytecode");
  refuses("an executor without the delegated dispatch (a v1 build)", { executorCode: "0x6080604052600056" }, "dispatches swapOnBehalfOfUniswapV3");
  refuses("a code hash that is not the operator's pin", { expectedCodeHash: `0x${"77".repeat(32)}` }, "code hash equals the operator-pinned hash");
  refuses("a paused executor", { livePaused: true }, "executor is not paused");
  refuses("an unknown pause state", { livePaused: undefined }, "executor is not paused");
  refuses("a pending ownership handover", { livePendingOwner: SIGNER }, "no pending owner");
  refuses("a rotated owner", { liveOwner: SIGNER }, "owner() is the pinned owner");
  refuses("a rotated fee recipient", { liveFeeRecipient: SIGNER }, "feeRecipient() is the pinned fee recipient");
  refuses("a changed fee", { liveFeeBps: 50n }, "feeBps() is exactly 25");
  refuses("a raised fee cap", { liveMaxFeeBps: 500n }, "MAX_FEE_BPS() is 100");
  refuses("a non-canonical WETH on the contract", { liveWeth: SIGNER }, "WETH() is canonical WETH");
  refuses("a non-canonical Permit2 on the contract", { livePermit2: SIGNER }, "PERMIT2() is canonical Permit2");
  refuses("a witness type string that diverges from what we sign", { liveWitnessTypeString: "ActionWitness witness)Other()" }, "WITNESS_TYPE_STRING");
  refuses("a struct type string that diverges", { liveWitnessStructTypeString: "ActionWitness(address owner)" }, "ACTION_WITNESS_STRUCT_TYPE_STRING");
  refuses("a witness typehash that diverges", { liveActionWitnessTypehash: `0x${"42".repeat(32)}` }, "ACTION_WITNESS_TYPEHASH");
  refuses("a local/contract witness-hash mismatch (encoding drift)", { witnessHashLocal: `0x${"99".repeat(32)}` }, "witnessHashOf");
  refuses("a router that is Slipstream instead of Uniswap V3", { liveRouterKind: 1 }, "kind 2 (UNISWAP_V3_ROUTER02)");
  refuses("a router that is not registered at all", { liveRouterKind: 0 }, "kind 2 (UNISWAP_V3_ROUTER02)");
  refuses("USDC removed from the allowlist", { liveUsdcAllowed: false }, "allowlisted on the executor");
  refuses("WETH removed from the allowlist", { liveWethAllowed: false }, "allowlisted on the executor");
  refuses("a router with no code (a dead venue)", { routerCode: "0x" }, "router address has bytecode");
  refuses("a quoter with no code", { quoterCode: undefined }, "QuoterV2 address has bytecode");
  refuses("a pool the factory does not confirm", { poolFromFactory: SIGNER }, "factory.getPool");
  refuses("a pool with no code", { poolCode: "0x" }, "pinned pool has bytecode");
  refuses("unexpected token decimals", { usdcDecimals: 18, wethDecimals: 6 }, "decimals() is 6");
  refuses("a typed swap module registered for the router", { liveSwapModule: SIGNER }, "no typed swap module is registered");
  refuses("a swap module code hash left over from a reconfiguration", { liveSwapModuleCodeHash: `0x${"55".repeat(32)}` }, "no typed swap module is registered");
  refuses("the contract's own fee split disagreeing with ours", { onChainFee: 1_249n }, "quoteFee(gross) agrees");
  refuses("a fee that would round to zero", { onChainFee: 0n, onChainSwapAmount: GROSS_AMOUNT_IN }, "FeeRoundsToZero");
  refuses("a quote outside the sanity band", { quoteAmountOut: 1_000n }, "sanity band");
  refuses("a quote from an inverted pair", { quoteAmountOut: QUOTE_MAX_WEI * 2n }, "sanity band");
  refuses("a minOut above the quote", { amountOutMinimum: QUOTE + 1n }, "amountOutMinimum is positive and <= the quote");
  refuses("a zero minOut", { amountOutMinimum: 0n }, "positive and <= the quote");
  refuses("a minOut that ignores the pinned slippage", { amountOutMinimum: minOutFromQuote(QUOTE, 5_000n) }, "minus the pinned 100 bps slippage");
  refuses("a deadline that has already passed", { deadline: NOW - 1n }, "future timestamp");
  refuses("a deadline with too little margin", { deadline: NOW + MIN_DEADLINE_MARGIN_SECONDS - 1n }, "90s of margin");
  refuses("an over-long signature validity window", { deadline: NOW + DEADLINE_SECONDS + 60n }, "<= 300s");
  refuses("a wallet that cannot pay for the gross", { walletUsdc: GROSS_AMOUNT_IN - 1n }, "USDC balance >=");
  refuses("a wallet with no ETH for gas", { walletEth: 0n }, "ETH covers the worst-case gas");
  refuses("a maxFeePerGas above the 1 gwei cap", { maxFeePerGas: MAX_FEE_PER_GAS_CAP + 1n }, "within the 1 gwei cap");
  refuses("an excessive priority tip", { maxPriorityFeePerGas: PRIORITY_FEE_CAP + 1n }, "within the 0.05 gwei cap");
  refuses("an estimated L2 cost above the cap", { swapGasEstimate: EXPECTED_GAS_LIMIT, maxFeePerGas: MAX_FEE_PER_GAS_CAP }, "within the cap");
  refuses("a standing ERC-20 approval to the executor", { walletAllowanceToExecutor: 1n }, "allowance wallet->executor is 0");
  refuses("a standing ERC-20 approval to Permit2", { walletAllowanceToPermit2: 1n }, "allowance wallet->Permit2 is 0");
  refuses("a standing Permit2 allowance", { permit2AllowanceAmount: GROSS_AMOUNT_IN }, "Permit2 standing allowance");
  refuses("a campaign nonce that is already spent", { permit2NonceUsed: true }, "nonce for this campaign is UNUSED");
  refuses("a bitmap word that already marks the nonce (recomputed)", { permit2NonceBitmapWord: nonceBitPosition(canaryIdentityFor(SIGNER).permitNonce)?.bit ?? 1n }, "independent recomputation");
  refuses("a nonce word read for the WRONG owner", { permit2NonceDerivedFor: BROADCASTER }, "reads the right owner's word");
  refuses("an executor holding residue before the canary", { executorUsdc: 1n }, "holds no USDC/WETH/ETH before");
  refuses("an executor holding ETH before the canary", { executorEth: 1n }, "holds no USDC/WETH/ETH before");
  refuses("an executor that already approved the router", { executorRouterAllowance: 1n }, "allowance to the Uniswap router is 0");
  refuses("a wallet that already swapped through the delegated executor", { priorSwapEvents: 1 }, "one-shot");
  refuses("a prior canary broadcast recorded in the ledger", { ledgerExists: true, ledgerTx: `0x${"ab".repeat(32)}` }, "no earlier canary broadcast");
  refuses("a simulation that reverts (the decisive read-only proof)", { simulationOk: false, simulationError: "execution reverted: InsufficientOutput" }, "simulation of the signed delegated swap succeeds");
  refuses("a simulation whose output is below the signed minimum", { simulationAmountOut: minOutFromQuote(QUOTE)! - 1n }, "amountOut >=");
  refuses("a signature that does not recover to the signer", { signatureRecoversToSigner: false, recoveredSigner: null }, "recovers to the smoke wallet");
  refuses("a signature recovered to the wrong address", { recoveredSigner: BROADCASTER }, "recovers to the smoke wallet");
  refuses("calldata for the wrong entrypoint", { calldataSelector: SWAP_ON_BEHALF_OF_SLIPSTREAM_SELECTOR }, "selector is swapOnBehalfOfUniswapV3");
  refuses("calldata that does not decode back to the intended params", { calldataMatchesParams: false }, "decodes back to the exact params");
  refuses("an owner that is also the fee recipient", { signer: FEE_RECIPIENT }, "OwnerIsFeeRecipient");
  refuses("a signer that was never resolved", { signer: undefined }, "signer is a valid address");
  refuses("a missing gas estimate (the cap must not default to zero)", { swapGasEstimate: undefined }, "estimated L2 gas cost");
  refuses("an unreadable fee-recipient balance", { feeRecipientUsdc: undefined }, "fee recipient USDC balance is readable");
  refuses("no ledger read at all (an absent read is not a clean ledger)", { ledgerExists: undefined }, "no earlier canary broadcast");
  refuses("a canary that unwraps to native ETH", { unwrapNativeOut: true }, "never unwraps to native ETH");

  it("treats EVERY unavailable fact as a failure, never as a pass", () => {
    const r = evaluateLivePreconditions({});
    expect(r.allowed).toBe(false);
    expect(r.checks.filter((c) => !c.ok).length).toBeGreaterThan(40);
    // The ONLY fatal rows that may pass with no facts at all are the ones derived
    // from campaign constants rather than from a read (there is exactly one).
    const passingFatal = r.checks.filter((c) => c.ok && c.fatal !== false).map((c) => c.name);
    // Only the constant-derived row may pass with no reads at all: it is the
    // campaign's own arithmetic, not a claim about the chain.
    expect(passingFatal).toEqual(["local fee split is exactly (1250, 498750) for 0.50 USDC gross"]);
    expect(r.blockers.length).toBeGreaterThan(40);
  });

  it("supports a pre-sign pass that skips exactly the signature-dependent proofs", () => {
    const r = evaluateLivePreconditions(greenFacts({ preSigning: true }));
    expect(r.allowed).toBe(true);
    expect(r.checks.filter((c) => c.skipped === true)).toHaveLength(3);
    // A paused executor is refused BEFORE the key would ever be used.
    expect(evaluateLivePreconditions(greenFacts({ preSigning: true, livePaused: true })).allowed).toBe(false);
    // The confirmation phrase is already required by the pre-sign pass.
    expect(evaluateLivePreconditions(greenFacts({ preSigning: true, confirmedPhrase: "" })).allowed).toBe(false);
    // A failed simulation cannot be laundered by the pre-sign pass: the full pass still sees it.
    const full = evaluateLivePreconditions(greenFacts({ preSigning: false, simulationOk: false }));
    expect(full.allowed).toBe(false);
    expect(checkNamed(full, "simulation of the signed delegated swap succeeds")?.skipped).toBeFalsy();
  });

  it("requires the exact typed confirmation only for live", () => {
    expect(evaluateLivePreconditions(greenFacts({ confirmedPhrase: "" })).allowed).toBe(false);
    expect(evaluateLivePreconditions(greenFacts({ confirmedPhrase: "SMOKE-DELEGATED-BASE-MAINNET" })).allowed).toBe(false);
    expect(evaluateLivePreconditions(greenFacts({ mode: MODES.PREFLIGHT, confirmedPhrase: "" })).allowed).toBe(true);
  });

  it("keeps rehearsal mode out of the confirmation requirement but still requires a simulation", () => {
    const r = evaluateLivePreconditions(greenFacts({ mode: MODES.REHEARSAL, confirmedPhrase: "" }));
    expect(r.allowed).toBe(true);
    expect(checkNamed(r, "live requires the exact typed confirmation")).toBeUndefined();
    expect(r.checks.filter((c) => c.skipped === true)).toHaveLength(0);
    expect(checkNamed(r, "simulation of the signed delegated swap succeeds")?.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
/** A complete, self-consistent set of POST-TRADE facts for a successful canary. */
function greenPost(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const identity = canaryIdentityFor(SIGNER);
  const amountOut = minOutFromQuote(QUOTE)! + 1_000n;
  return {
    mode: MODES.LIVE,
    broadcaster: SIGNER,
    receiptStatus: "success",
    txTo: DELEGATED_EXECUTOR,
    txFrom: SIGNER,
    signer: SIGNER,
    txValue: 0n,
    txSelector: SWAP_ON_BEHALF_OF_UNISWAP_V3_SELECTOR,
    txInputMatchesEncoded: true,
    decodedWitnessOwner: SIGNER,
    decodedRecipient: SIGNER,
    decodedIntentId: identity.actionId,
    expectedActionId: identity.actionId,
    decodedPermitToken: USDC,
    decodedPermitAmount: GROSS_AMOUNT_IN,
    swapEventCount: 1,
    eventTaker: SIGNER,
    eventRouter: UNISWAP_V3_ROUTER,
    eventTokenIn: USDC,
    eventTokenOut: CANONICAL_WETH,
    eventGrossAmountIn: GROSS_AMOUNT_IN,
    eventFeeAmount: EXPECTED_FEE_AMOUNT,
    eventSwapAmountIn: SWAP_AMOUNT_IN,
    eventAmountOut: amountOut,
    eventFeeRecipient: FEE_RECIPIENT,
    eventFeeBps: FEE_BPS,
    eventRouterKind: 2,
    eventFlags: 0,
    amountOutMinimum: minOutFromQuote(QUOTE),
    usdcPullVerified: true,
    feeTransferCount: 1,
    feeTransferVerified: true,
    swapLegVerified: true,
    wethToOwnerVerified: true,
    unexpectedWethRecipient: false,
    walletUsdcBefore: 10_000_000n,
    walletUsdcAfter: 10_000_000n - GROSS_AMOUNT_IN,
    walletWethBefore: 0n,
    walletWethAfter: amountOut,
    feeRecipientUsdcBefore: 7_000_000n,
    feeRecipientUsdcAfter: 7_000_000n + EXPECTED_FEE_AMOUNT,
    executorUsdcAfter: 0n,
    executorWethAfter: 0n,
    executorEthAfter: 0n,
    executorRouterAllowanceAfter: 0n,
    permit2NonceUsedAfter: true,
    broadcastCount: 1,
    ...overrides,
  };
}

describe("post-trade verification", () => {
  it("passes for the expected settlement", () => {
    const r = evaluatePostTradeVerification(greenPost());
    expect(r.ok).toBe(true);
    expect(r.failed).toEqual([]);
    expect(r.checks.length).toBeGreaterThan(30);
  });

  const refuses = (label: string, patch: Record<string, unknown>, needle: string) =>
    it(label, () => {
      const r = evaluatePostTradeVerification(greenPost(patch));
      expect(r.ok).toBe(false);
      expect(r.failed.join(" | ")).toContain(needle);
    });

  refuses("a reverted receipt", { receiptStatus: "reverted" }, "status success");
  refuses("a tx to the wrong contract", { txTo: V1_MAINNET_EXECUTOR }, "tx to ==");
  refuses("a tx sent by someone else (live)", { txFrom: BROADCASTER }, "tx from ==");
  refuses("native value in the tx", { txValue: 1n }, "tx value == 0");
  refuses("a different entrypoint on the wire", { txSelector: SWAP_ON_BEHALF_OF_TYPED_MODULE_SELECTOR }, "input selector");
  refuses("calldata that is not what was simulated", { txInputMatchesEncoded: false }, "byte-for-byte");
  refuses("a redirected recipient (the output went elsewhere)", { decodedRecipient: BROADCASTER }, "witness.owner == decoded recipient");
  refuses("a redirected witness owner", { decodedWitnessOwner: BROADCASTER }, "witness.owner == decoded recipient");
  refuses("a foreign intentId", { decodedIntentId: keccak256(toHex("other")) }, "deterministic canary actionId");
  refuses("a permit for the wrong token", { decodedPermitToken: CANONICAL_WETH }, "permit equals the signed gross and USDC");
  refuses("a permit for more than the gross", { decodedPermitAmount: GROSS_AMOUNT_IN + 1n }, "permit equals the signed gross");
  refuses("no SwapExecuted at all", { swapEventCount: 0, eventTaker: undefined, eventAmountOut: undefined }, "exactly one SwapExecuted");
  refuses("two SwapExecuted events in one tx", { swapEventCount: 2 }, "exactly one SwapExecuted");
  refuses("an event attributed to someone else", { eventTaker: BROADCASTER }, "SwapExecuted.taker ==");
  refuses("a swap routed somewhere else", { eventRouter: SIGNER }, "SwapExecuted.router ==");
  refuses("the wrong token pair in the event", { eventTokenOut: USDC }, "tokenIn/tokenOut");
  refuses("a gross other than 0.50 USDC", { eventGrossAmountIn: GROSS_AMOUNT_IN + 1n }, "grossAmountIn ==");
  refuses("a wrong fee (not the exact 25 bps)", { eventFeeAmount: 1_249n }, "feeAmount == 1,250");
  refuses("a fee/swap split that does not sum to gross", { eventSwapAmountIn: SWAP_AMOUNT_IN + 25n }, "fee + swap == gross");
  refuses("a fee paid to the wrong recipient", { eventFeeRecipient: SIGNER }, "feeRecipient/feeBps match the pins");
  refuses("a changed fee in the event", { eventFeeBps: 100n }, "feeRecipient/feeBps match");
  refuses("the Slipstream kind in the event", { eventRouterKind: 1 }, "routerKind == 2");
  refuses("a native-unwrap flag that should be 0", { eventFlags: 2 }, "flags == 0");
  refuses("an output below the signed minimum", { eventAmountOut: minOutFromQuote(QUOTE)! - 1n }, ">= the signed amountOutMinimum");
  refuses("a missing USDC pull from the owner", { usdcPullVerified: false }, "pulled via Permit2");
  refuses("two fee transfers", { feeTransferCount: 2 }, "exactly one USDC Transfer executor -> fee recipient");
  refuses("an unverified fee transfer", { feeTransferVerified: false }, "exactly one USDC Transfer executor -> fee recipient");
  refuses("the swap leg amount to the pool is wrong", { swapLegVerified: false }, "executor -> pool of exactly 498,750");
  refuses("WETH that did not arrive at the owner", { wethToOwnerVerified: false }, "WETH Transfer(s) to the wallet");
  refuses("WETH leaked to another address", { unexpectedWethRecipient: true }, "no WETH went to the fee recipient");
  refuses("an unexamined WETH recipient set", { unexpectedWethRecipient: undefined }, "no WETH went to the fee recipient");
  refuses("a wallet USDC delta that is not the gross", { walletUsdcAfter: 10_000_000n - SWAP_AMOUNT_IN }, "USDC delta is exactly -500,000");
  refuses("a wallet WETH delta that differs from the event", { walletWethAfter: amountOutPlus(1n) }, "WETH delta equals SwapExecuted.amountOut");
  refuses("WETH below the signed minimum in the wallet", { walletWethBefore: 2_000n, walletWethAfter: 2_000n }, "at least the signed minimum");
  refuses("the fee recipient got an unexpected amount", { feeRecipientUsdcAfter: 7_000_000n + 1n }, "delta at the receipt block is exactly 1,250");
  refuses("residue left on the executor", { executorUsdcAfter: 1n }, "nothing trapped");
  refuses("a standing allowance left on the executor", { executorRouterAllowanceAfter: GROSS_AMOUNT_IN }, "allowance is 0 afterwards");
  refuses("a Permit2 nonce that is still unused (no state change)", { permit2NonceUsedAfter: false }, "nonce is now SPENT");
  refuses("zero broadcasts (nothing was actually sent)", { broadcastCount: 0 }, "exactly one broadcast");
  refuses("two broadcasts in one run", { broadcastCount: 2 }, "exactly one broadcast");

  it("expects a SEPARATE broadcaster in the rehearsal (that is the point of the delegated path)", () => {
    const r = evaluatePostTradeVerification(greenPost({ mode: MODES.REHEARSAL, broadcaster: BROADCASTER, txFrom: BROADCASTER }));
    expect(r.ok).toBe(true);
    expect(r.failed.join(" | ")).not.toContain("tx from ==");
    // …and it must refuse when the rehearsal accidentally self-broadcast.
    expect(evaluatePostTradeVerification(greenPost({ mode: MODES.REHEARSAL, broadcaster: BROADCASTER, txFrom: SIGNER })).ok).toBe(false);
    expect(evaluatePostTradeVerification(greenPost({ mode: MODES.REHEARSAL, broadcaster: SIGNER, txFrom: SIGNER })).ok).toBe(false);
  });
});

function amountOutPlus(delta: bigint): bigint {
  return minOutFromQuote(QUOTE)! + 1_000n + delta;
}

// ---------------------------------------------------------------------------
describe("one-shot ledger gate", () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    version: LEDGER_VERSION,
    campaign: CAMPAIGN,
    chainId: CHAIN_ID,
    wallet: SIGNER,
    broadcastTx: null,
    claimId: "claim-1",
    ...overrides,
  });

  it("names the ledger by campaign, chain and wallet (never by a secret)", () => {
    expect(ledgerFileName({ wallet: SIGNER })).toBe(`${CAMPAIGN}-8453-${SIGNER.toLowerCase()}.json`);
    expect(ledgerFileName({ wallet: SIGNER, chainId: 84532 })).toContain("84532");
    expect(ledgerFileName({ wallet: SIGNER })).not.toMatch(/[0-9a-f]{64}/);
    expect(() => ledgerFileName({ wallet: "nope" })).toThrow();
  });

  it("lets a live run proceed only when no ledger exists for the wallet", () => {
    const r = evaluateLedgerGuard({ mode: MODES.LIVE, ledger: null, wallet: SIGNER });
    expect(r.allowed).toBe(true);
    expect(checkNamed(r, "no ledger for this wallet yet")?.ok).toBe(true);
  });

  it("refuses a second live run once a broadcast is recorded", () => {
    const r = evaluateLedgerGuard({ mode: MODES.LIVE, ledger: entry({ broadcastTx: `0x${"ab".repeat(32)}`, status: "confirmed-success" }), wallet: SIGNER });
    expect(r.allowed).toBe(false);
    expect(r.blockers.join(" ")).toContain("REFUSED");
    const row = checkNamed(r, "already recorded");
    expect(row?.detail).toContain("0xabababab");
    expect(row?.detail).toContain("confirmed-success");
  });

  it("refuses a broadcast record that only looks like a hash", () => {
    for (const broadcastTx of ["0xdeadbeef", "", null, "not-a-tx", `0x${"ab".repeat(31)}`]) {
      const r = evaluateLedgerGuard({ mode: MODES.LIVE, ledger: entry({ broadcastTx }), wallet: SIGNER });
      expect(r.allowed, JSON.stringify(broadcastTx)).toBe(false); // an interrupted claim still needs an ack
    }
  });

  it("requires the operator to echo the claim id before re-running an interrupted claim", () => {
    const ledger = entry({ claimId: "cafe1234beef5678", broadcastTx: null });
    expect(evaluateLedgerGuard({ mode: MODES.LIVE, ledger, wallet: SIGNER }).allowed).toBe(false);
    expect(evaluateLedgerGuard({ mode: MODES.LIVE, ledger, wallet: SIGNER, ack: "cafe1234beef5678" }).allowed).toBe(true);
    expect(evaluateLedgerGuard({ mode: MODES.LIVE, ledger, wallet: SIGNER, ack: "cafe1234beef5679" }).allowed).toBe(false);
    expect(evaluateLedgerGuard({ mode: MODES.LIVE, ledger, wallet: SIGNER, ack: "" }).allowed).toBe(false);
    expect(evaluateLedgerGuard({ mode: MODES.LIVE, ledger, wallet: SIGNER, ack: "  cafe1234beef5678  " }).allowed).toBe(true);
  });

  it("refuses a ledger from another campaign, chain or wallet", () => {
    for (const patch of [{ campaign: "other" }, { chainId: 84532 }, { wallet: BROADCASTER }]) {
      const r = evaluateLedgerGuard({ mode: MODES.LIVE, ledger: entry(patch), wallet: SIGNER, ack: "cafe1234beef5678" });
      expect(r.allowed, JSON.stringify(patch)).toBe(false);
    }
  });

  it("never claims or releases the ledger in rehearsal/preflight", () => {
    for (const mode of [MODES.REHEARSAL, MODES.PREFLIGHT]) {
      const spent = entry({ broadcastTx: `0x${"ab".repeat(32)}` });
      const r = evaluateLedgerGuard({ mode, ledger: spent, wallet: SIGNER });
      expect(r.allowed, mode).toBe(true);
      expect(checkNamed(r, "read-only modes never claim")?.fatal).toBe(false);
    }
  });

  it("treats a corrupt/unreadable ledger as a claim, not as clean", () => {
    const r = evaluateLedgerGuard({ mode: MODES.LIVE, ledger: { unreadable: true }, wallet: SIGNER });
    expect(r.allowed).toBe(false);
  });

  it("records only public facts in the ledger (never key material)", () => {
    const built = buildLedgerEntry({ wallet: SIGNER, mode: MODES.LIVE, claimId: "claim-1", startedAt: "2026-10-06T00:00:00.000Z" });
    expect(built).toMatchObject({
      version: 1,
      campaign: CAMPAIGN,
      chainId: 8453,
      mode: "live",
      wallet: SIGNER,
      executor: DELEGATED_EXECUTOR,
      grossAmountIn: "500000",
      claimId: "claim-1",
    });
    expect(JSON.stringify(built)).not.toMatch(/0x[0-9a-f]{64}/); // no private key, no signature
    expect(() => buildLedgerEntry({ wallet: "nope", mode: "live", claimId: "x", startedAt: "y" })).toThrow();
  });

  it("instructs the runner to claim the file exclusively", () => {
    const claim = evaluateLedgerClaim({ wallet: SIGNER, ledgerDir: LEDGER_DIR });
    expect(claim.path).toBe(`${LEDGER_DIR}/${CAMPAIGN}-8453-${SIGNER.toLowerCase()}.json`);
    expect(claim.fileName).toBe(ledgerFileName({ wallet: SIGNER }));
    expect(claim.instruction).toContain("O_EXCL");
    expect(claim.instruction).toContain("abort without signing");
    expect(evaluateLedgerClaim({ wallet: SIGNER, ledgerDir: `${LEDGER_DIR}//` }).path).toBe(claim.path);
  });
});

// ---------------------------------------------------------------------------
describe("rehearsal principals", () => {
  it("are derived from public labels with no key literal in the repository", () => {
    const owner = rehearsalPrincipal("owner");
    expect(owner.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(owner.privateKey).toBe(rehearsalPrincipal("owner").privateKey); // deterministic
    expect(rehearsalPrincipal("broadcaster").privateKey).not.toBe(owner.privateKey);
    expect(runnerSource).not.toContain(owner.privateKey);
    expect(runnerSource).not.toMatch(/privateKeyToAccount\(\s*[\n ]*"0x[0-9a-f]{64}"/);
  });

  it("give a signer and a distinct broadcaster, both signable and non-forbidden", () => {
    const { owner, broadcaster } = rehearsalPrincipals();
    const ownerAccount = privateKeyToAccount(owner.privateKey);
    const broadcasterAccount = privateKeyToAccount(broadcaster.privateKey);
    expect(ownerAccount.address).not.toBe(broadcasterAccount.address);
    expect(FORBIDDEN_SIGNERS[ownerAccount.address.toLowerCase()]).toBeUndefined();
    expect(FORBIDDEN_SIGNERS[broadcasterAccount.address.toLowerCase()]).toBeUndefined();
    expect(evaluateSignerIdentity({ mode: MODES.REHEARSAL, derivedSigner: ownerAccount.address, pinnedWallet: ownerAccount.address }).allowed).toBe(true);
  });

  it("refuse an empty label", () => {
    expect(() => rehearsalPrincipal("")).toThrow(/label required/);
    expect(() => rehearsalPrincipal(undefined as never)).toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("report helpers", () => {
  it("titles each mode so a reader knows whether money moved", () => {
    expect(renderTitle(MODES.LIVE)).toContain("(LIVE)");
    expect(renderTitle(MODES.PREFLIGHT)).toContain("READ-ONLY");
    expect(renderTitle(MODES.REHEARSAL)).toContain("LOCAL FORK REHEARSAL");
    expect(renderTitle(MODES.REHEARSAL)).toContain("nothing broadcast");
    expect(renderTitle(undefined)).toContain("LOCAL FORK REHEARSAL");
  });

  it("summarizes checks for the annotations", () => {
    const s = summarizeChecks([
      { stage: "a", name: "ok", ok: true, detail: "" },
      { stage: "a", name: "bad", ok: false, detail: "x" },
      { stage: "b", name: "worse", ok: false, detail: "y" },
    ]);
    expect(s).toEqual({ passed: 1, total: 3, failed: ["a: bad", "b: worse"] });
    expect(summarizeChecks()).toEqual({ passed: 0, total: 0, failed: [] });
  });
});

// ---------------------------------------------------------------------------
describe("the runner script keeps its promises (static invariants)", () => {
  const gate = (re: RegExp, label: string) => expect(runnerSource, label).not.toMatch(re);

  it("never deploys, approves, mints or reconfigures anything", () => {
    gate(/functionName:\s*"(deploy|create|mint|mintTo|burn|approve|increaseAllowance|decreaseAllowance|setFeeBps|setFeeRecipient|setPaused|pause|unpause|setRouterKind|setTokenAllowed|setTokenBlocked|transferOwnership|acceptOwnership|upgradeTo|deployAndConfigure)"/, "state-changing call");
    gate(/forge\s+(script|deploy|create)/, "forge deploy");
    gate(/new MPGRExecutor|DeployMPGRExecutor/, "contract creation");
    gate(/"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"\s*,\s*"approve"/, "an ERC-20 approve call");
  });

  it("signs only after the pre-sign gate and broadcasts only after the full gate", () => {
    expect(runnerSource.indexOf("ownerAccount.signTypedData")).toBeGreaterThan(runnerSource.indexOf("preSigning: true }"));
    expect(runnerSource.indexOf("walletClient.writeContract")).toBeGreaterThan(runnerSource.indexOf("const gate = evaluateLivePreconditions("));
    expect(runnerSource.indexOf("claimLedger(wallet)")).toBeLessThan(runnerSource.indexOf("walletClient.writeContract"));
    expect(runnerSource.indexOf("anvil_setStorageAt")).toBeLessThan(runnerSource.indexOf("const gate = evaluateLivePreconditions("));
  });

  it("reads the key from exactly one env var and deletes it", () => {
    expect(runnerSource).toContain("process.env[KEY_ENV]");
    expect(runnerSource).toContain("delete process.env[KEY_ENV]");
    gate(/process\.env\.(?!SMOKE_DELEGATED_PRIVATE_KEY)[A-Z_]*PRIVATE_KEY/, "another key env var");
    expect(runnerSource).not.toContain("BASE_MAINNET_DEPLOYER_PRIVATE_KEY");
  });

  it("broadcasts at most once and never retries a send", () => {
    const sends = runnerSource.match(/writeContract\(/g) ?? [];
    expect(sends.length).toBe(1);
    expect(runnerSource).not.toMatch(/sendRawTransaction\(\s*[\s\S]{0,40}retry/);
    expect(runnerSource).toContain("report.broadcastCount += 1");
  });

  it("keeps the v1 smoke test's own env contract out of this campaign", () => {
    expect(runnerSource).not.toContain("SMOKE_PRIVATE_KEY=");
    expect(runnerSource).not.toContain("SMOKE_MODE=live");
    expect(runnerSource).toContain("SMOKE_DELEGATED_MODE");
    expect(V1_SMOKE_WALLET).toBe("0xB54900f2c355CB0A61c62f8220191D3aAA6f4455");
    expect(FORBIDDEN_SIGNERS[V1_SMOKE_WALLET.toLowerCase()]).toContain("reuse is forbidden");
  });

  it("writes the report files the workflow annotates and uploads", () => {
    expect(runnerSource).toContain('env("SMOKE_DELEGATED_JSON")');
    expect(runnerSource).toContain('env("SMOKE_DELEGATED_MD")');
    expect(runnerSource).toContain('"smoke-delegated-results.json"');
    expect(runnerSource).toContain('"smoke-delegated-report.md"');
  });
});

