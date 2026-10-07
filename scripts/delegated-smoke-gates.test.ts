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
import { createPublicClient, custom, encodeAbiParameters, encodeFunctionData, getAddress, getEventSelector, hashTypedData, keccak256, pad, toHex } from "viem";
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
  LOG_CHUNK_PROBE_LADDER,
  MAX_LOG_CHUNK_ENV,
  MAX_LOG_SCAN_BLOCKS,
  MAX_SAFE_LOG_CHUNK,
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
  REHEARSAL_LOG_WINDOW,
  REQUIRED_PERMIT2_TOKEN_ALLOWANCE,
  REVIEWED_CONFIG_PATH,
  RATE_LIMIT_MAX_ATTEMPTS,
  RATE_LIMIT_BACKOFF_BASE_MS,
  RATE_LIMIT_BACKOFF_MAX_MS,
  RETRY_AFTER_MAX_MS,
  RPC_ENV,
  RPC_MISSING_MESSAGE,
  RPC_RATE_LIMITED_MESSAGE,
  SEPOLIA_DELEGATED_EXECUTOR,
  SLIPPAGE_BPS,
  SWAP_AMOUNT_IN,
  SWAP_EXECUTED_EVENT_SIGNATURE,
  SWAP_EXECUTED_TOPIC,
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
  blockingFailures,
  buildSwapParams,
  canaryIdentityFor,
  clampChunkSize,
  classifyRpcError,
  codeDispatchesSelector,
  decodeRevertData,
  describeContractError,
  evaluateConfigPins,
  evaluateLedgerClaim,
  evaluateLedgerGuard,
  evaluateLivePreconditions,
  evaluateModeGuard,
  evaluatePostTradeVerification,
  evaluateRpcReadiness,
  evaluateSignerIdentity,
  feeSplit,
  isHttpsRpc,
  isPrivateOrLocalRpc,
  isBytes32,
  isInformational,
  isLocalRpc,
  isPrivateKeyShape,
  KNOWN_REVERT_SELECTORS,
  ledgerFileName,
  minOutFromQuote,
  nonceBitmapWordMarks,
  nonceBitPosition,
  normalizeAddress,
  parseRetryAfter,
  planLogScan,
  priorSwapScanWindow,
  probeLogChunkSize,
  probeWidthsAbove,
  quoteWithinSanityBand,
  redact,
  renderTitle,
  rehearsalPrincipal,
  rehearsalPrincipals,
  runAdaptiveLogScan,
  runLogScan,
  safeErrorMessage,
  sameAddress,
  shouldRetryRateLimit,
  shrinkChunkSize,
  summarizeChecks,
  swapExecutedLogFilter,
  takerTopicFor,
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
const gatesSource = readFileSync("scripts/delegated-smoke-gates.mjs", "utf8");
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
    // Conservative bounded chunk: restrictive Base RPC providers reject wide
    // eth_getLogs ranges ("limited to 0 - 50 blocks range"; some cap at 10).
    expect(LOG_CHUNK).toBe(10n);
    expect(LOG_CHUNK).toBeLessThanOrEqual(50n);
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
  // The ONE endpoint each mode is allowed to use. `configuredRpcUrl` is what the
  // runner passes as SMOKE_DELEGATED_RPC_URL; preflight/live must use exactly it.
  const MAINNET_RPC = "https://base-mainnet.example/abcdef";
  const base = {
    rpcUrls: ["http://127.0.0.1:8545"],
    configuredRpcUrl: "http://127.0.0.1:8545",
    keyEnvValue: undefined,
    walletPinEnvValue: SIGNER,
    githubActions: "true",
    emergencyDisabled: false,
  };
  const mainnetRpc = { rpcUrls: [MAINNET_RPC], configuredRpcUrl: MAINNET_RPC };

  it("accepts a keyless rehearsal against exactly one local fork", () => {
    const r = evaluateModeGuard({ ...base, mode: MODES.REHEARSAL });
    expect(r.allowed).toBe(true);
    expect(r.checks.length).toBeGreaterThanOrEqual(6);
  });

  it("accepts a keyless read-only preflight against real mainnet", () => {
    const r = evaluateModeGuard({ ...base, ...mainnetRpc, mode: MODES.PREFLIGHT });
    expect(r.allowed).toBe(true);
    expect(checkNamed(r, "preflight reads no private key")?.ok).toBe(true);
  });

  it("accepts live only in CI with a well-formed key and a valid pin", () => {
    const r = evaluateModeGuard({
      ...base,
      ...mainnetRpc,
      mode: MODES.LIVE,
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
      const r = evaluateModeGuard({ ...base, mode, emergencyDisabled: true, ...(mode === MODES.REHEARSAL ? {} : mainnetRpc), keyEnvValue: mode === MODES.LIVE ? `0x${"cd".repeat(32)}` : undefined });
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
    expect(evaluateModeGuard({ ...base, ...mainnetRpc, mode: MODES.PREFLIGHT, keyEnvValue: key }).allowed).toBe(false);
  });

  it("refuses to read mainnet state from a local fork during preflight", () => {
    expect(evaluateModeGuard({ ...base, mode: MODES.PREFLIGHT, rpcUrls: ["http://127.0.0.1:8545"] }).allowed).toBe(false);
  });

  it("refuses live outside GitHub Actions (no environment approval possible)", () => {
    const live = { mode: MODES.LIVE, ...mainnetRpc, keyEnvValue: `0x${"cd".repeat(32)}`, walletPinEnvValue: SIGNER };
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
      ...mainnetRpc,
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
      expect(evaluateModeGuard({ mode, ...mainnetRpc, keyEnvValue: mode === MODES.LIVE ? `0x${"cd".repeat(32)}` : undefined, walletPinEnvValue: "0xnope", githubActions: "true", emergencyDisabled: false }).allowed, mode).toBe(false);
      expect(evaluateModeGuard({ mode, ...mainnetRpc, keyEnvValue: mode === MODES.LIVE ? `0x${"cd".repeat(32)}` : undefined, walletPinEnvValue: "", githubActions: "true", emergencyDisabled: false }).allowed, `${mode} empty pin`).toBe(false);
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
    walletAllowanceToPermit2: REQUIRED_PERMIT2_TOKEN_ALLOWANCE,
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
  // Permit2's SignatureTransfer pulls with `transferFrom` FROM the Permit2
  // contract, so a MISSING (or short) one-time token approval is the refusal —
  // it is the state that makes the delegated eth_call revert
  // Error("TRANSFER_FROM_FAILED") (regression: the rehearsal's fork principal).
  refuses("a wallet that never granted the one-time Permit2 token approval", { walletAllowanceToPermit2: 0n }, "allowance wallet->Permit2 covers the gross");
  refuses("a Permit2 token approval that is short of the gross", { walletAllowanceToPermit2: GROSS_AMOUNT_IN - 1n }, "allowance wallet->Permit2 covers the gross");
  refuses("an unreadable Permit2 token approval", { walletAllowanceToPermit2: undefined }, "allowance wallet->Permit2 covers the gross");
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
  // Regression: a reverted simulation must NEVER leave the minOut proof green
  // on a fallback value (the quoter's number). Both rows have to go red.
  refuses(
    "a reverted simulation even when a stale amountOut is still carried",
    { simulationOk: false, simulationRevert: 'Error("TRANSFER_FROM_FAILED")', simulationAmountOut: QUOTE },
    "amountOut >=",
  );
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
    expect(s).toEqual({ passed: 1, total: 3, failed: ["a: bad", "b: worse"], informational: 0 });
    expect(summarizeChecks()).toEqual({ passed: 0, total: 0, failed: [], informational: 0 });
  });

  it("keeps informational notes out of the pass/fail tally entirely", () => {
    const s = summarizeChecks([
      { stage: "a", name: "ok", ok: true, detail: "" },
      { stage: "3. live posture reads (read-only)", name: "note", ok: false, detail: "0 USDC on mainnet", informational: true },
    ]);
    // 1/1 — not 1/2, and certainly not a failure.
    expect(s).toEqual({ passed: 1, total: 1, failed: [], informational: 1 });
  });
});

// ---------------------------------------------------------------------------
// Regression: a LOCAL FORK rehearsal must not be failed by REAL MAINNET facts
// it cannot possibly satisfy.
//
// The rehearsal principals are derived fresh from public labels, so on real
// mainnet they hold 0 USDC and have approved Permit2 nothing — by
// construction, forever. Both observations are recorded (the report stays
// honest) but they are INFORMATIONAL: they can never decide the exit code.
// `preflight` and `live` read the same two preconditions from the real pinned
// wallet, where they remain FATAL.
// ---------------------------------------------------------------------------
describe("rehearsal 'real mainnet readiness' notes cannot fail the fork rehearsal", () => {
  // The exact names the runner emits, so renaming one without revisiting this
  // guarantee breaks the suite.
  const MAINNET_USDC_NOTE = "rehearsal principal holds 0.50 USDC on real mainnet (informational: a fork top-up follows)";
  const MAINNET_APPROVAL_NOTE =
    "rehearsal principal already holds the one-time USDC->Permit2 approval on real mainnet (informational: a fork-only approval follows)";

  /** Exactly how the runner records them: observed-false, flagged informational. */
  const mainnetNotes = () => [
    { stage: "3. live posture reads (read-only)", name: MAINNET_USDC_NOTE, ok: false, detail: "holds 0.000000 USDC (0 raw)", informational: true },
    { stage: "3. live posture reads (read-only)", name: MAINNET_APPROVAL_NOTE, ok: false, detail: "allowance 0 raw < 500000", informational: true },
  ];

  it("emits both notes through rehearsalNote(), which refuses to run outside rehearsal", () => {
    expect(runnerSource).toContain(`rehearsalNote(\n      ${JSON.stringify(MAINNET_USDC_NOTE)}`);
    expect(runnerSource).toContain(`rehearsalNote(\n      ${JSON.stringify(MAINNET_APPROVAL_NOTE)}`);
    // The helper is the ONLY way to mark a check informational, and it aborts
    // in any other mode — a live/preflight gate can never be downgraded.
    expect(runnerSource).toMatch(/function rehearsalNote\([\s\S]{0,400}?if \(!REHEARSAL\) \{\s*\n\s*throw new Abort\(/);
    expect(runnerSource).toMatch(/rehearsal-only — \$\{MODE\} must enforce this precondition/);
    // Nothing else in the runner may set the flag by hand.
    expect(runnerSource.match(/informational: true/g)?.length).toBe(2); // the check() record + the rehearsalNote() call
    expect(runnerSource).not.toMatch(/must\([^)]*informational/);
  });

  it("derives the exit code from blockingFailures(), not from a raw !ok filter", () => {
    expect(runnerSource).toContain("const failed = blockingFailures(report.checks);");
    expect(runnerSource).toContain("exitCode = failed.length === 0 ? 0 : 1;");
    expect(runnerSource).not.toContain("report.checks.filter((c) => !c.ok)");
  });

  it("PROOF: a rehearsal whose every real check passes exits 0 despite both notes", () => {
    const rehearsalChecks = [
      { stage: "0. environment", name: "rehearsal uses exactly ONE local anvil RPC", ok: true, detail: "" },
      ...mainnetNotes(),
      { stage: "3. live posture reads (read-only)", name: "fork-only USDC top-up applied for exactly the campaign gross (local anvil state only)", ok: true, detail: "" },
      { stage: "3. live posture reads (read-only)", name: "fork-only one-time USDC->Permit2 approval applied for exactly the gross (local anvil state only)", ok: true, detail: "" },
      { stage: "3. live preconditions", name: "eth_call simulation of the signed delegated swap succeeds", ok: true, detail: "ok" },
      { stage: "7. post-trade", name: "all post-trade conditions hold", ok: true, detail: "" },
    ];
    expect(blockingFailures(rehearsalChecks)).toEqual([]);
    // This is literally the runner's exit expression.
    expect(blockingFailures(rehearsalChecks).length === 0 ? 0 : 1).toBe(0);
    const s = summarizeChecks(rehearsalChecks);
    expect(s.failed).toEqual([]);
    expect(s).toMatchObject({ passed: 5, total: 5, informational: 2 });
  });

  it("is not a blanket amnesty: any NON-informational failure still exits 1", () => {
    const withRealFailure = [
      ...mainnetNotes(),
      { stage: "3. live preconditions", name: "eth_call simulation of the signed delegated swap succeeds", ok: false, detail: 'Error("TRANSFER_FROM_FAILED")' },
    ];
    expect(blockingFailures(withRealFailure).map((c) => c.name)).toEqual(["eth_call simulation of the signed delegated swap succeeds"]);
    expect(blockingFailures(withRealFailure).length === 0 ? 0 : 1).toBe(1);
    // A fork-state assertion failing is equally fatal.
    expect(
      blockingFailures([
        ...mainnetNotes(),
        { stage: "3. live posture reads (read-only)", name: "fork-only USDC top-up applied for exactly the campaign gross (local anvil state only)", ok: false, detail: "" },
      ]),
    ).toHaveLength(1);
  });

  it("only the two mainnet-readiness rows are informational — never a fork-state or gate row", () => {
    expect(isInformational({ ok: false, informational: true })).toBe(true);
    expect(isInformational({ ok: false })).toBe(false);
    expect(isInformational({ ok: false, informational: false })).toBe(false);
    expect(isInformational(undefined)).toBe(false);
    // `skipped` is a different concept and must not be swallowed by it.
    expect(isInformational({ ok: true, skipped: true })).toBe(false);
    // No gate in the pure module ever emits an informational row: the gates are
    // verdicts, and the rehearsal notes are produced by the runner alone.
    for (const result of [
      evaluateLivePreconditions(greenFacts()),
      evaluateLivePreconditions(greenFacts({ walletUsdc: 0n, walletAllowanceToPermit2: 0n })),
      evaluateModeGuard({
        mode: MODES.REHEARSAL,
        rpcUrls: ["http://127.0.0.1:8545"],
        keyEnvValue: undefined,
        walletPinEnvValue: undefined,
        githubActions: undefined,
        emergencyDisabled: false,
      }),
    ]) {
      expect(result.checks.some((c: { informational?: boolean }) => c.informational === true)).toBe(false);
    }
  });

  it("PREFLIGHT and LIVE still REFUSE the very state the rehearsal only notes", () => {
    // Zero mainnet USDC and zero mainnet Permit2 approval: a note on the fork,
    // a hard refusal for a real wallet.
    for (const mode of [MODES.PREFLIGHT, MODES.LIVE]) {
      const r = evaluateLivePreconditions(greenFacts({ mode, walletUsdc: 0n, walletAllowanceToPermit2: 0n }));
      expect(r.allowed).toBe(false);
      const blockers = blockerNames(r).join(" | ");
      expect(blockers).toContain("smoke wallet USDC balance >= 500,000 raw");
      expect(blockers).toContain("allowance wallet->Permit2 covers the gross");
      // Both are fatal verdicts, not notes and not non-fatal advisories.
      for (const name of ["smoke wallet USDC balance >= 500,000 raw", "allowance wallet->Permit2 covers the gross"]) {
        const c = checkNamed(r, name);
        expect(c?.ok).toBe(false);
        expect(c?.fatal).not.toBe(false);
        expect((c as { informational?: boolean } | undefined)?.informational).toBeUndefined();
      }
    }
  });

  it("REHEARSAL's own gate still judges the provisioned FORK state, unweakened", () => {
    // The notes describe mainnet; the gate runs against post-provisioning fork
    // state, where the same two preconditions must hold exactly.
    const forkReady = greenFacts({ mode: MODES.REHEARSAL, walletUsdc: GROSS_AMOUNT_IN, walletAllowanceToPermit2: GROSS_AMOUNT_IN });
    expect(evaluateLivePreconditions(forkReady).allowed).toBe(true);
    for (const broken of [
      { walletUsdc: GROSS_AMOUNT_IN - 1n },
      { walletAllowanceToPermit2: GROSS_AMOUNT_IN - 1n },
      { walletAllowanceToExecutor: 1n },
      { permit2AllowanceAmount: 1n },
    ]) {
      expect(evaluateLivePreconditions({ ...forkReady, ...broken }).allowed).toBe(false);
    }
  });

  it("provisions the fork with EXACTLY the gross — balance and approval — and nothing for the executor", () => {
    expect(runnerSource).toContain("const target = GROSS_AMOUNT_IN;");
    expect(runnerSource).not.toContain("GROSS_AMOUNT_IN * 3n");
    // Exact-equality must() assertions, so a drifting top-up aborts the run.
    expect(runnerSource).toMatch(/must\(\s*\n\s*"fork-only USDC top-up applied for exactly the campaign gross \(local anvil state only\)",\s*\n\s*topped === GROSS_AMOUNT_IN,/);
    expect(runnerSource).toMatch(/must\(\s*\n\s*"fork-only one-time USDC->Permit2 approval applied for exactly the gross \(local anvil state only\)",\s*\n\s*approved === REQUIRED_PERMIT2_TOKEN_ALLOWANCE,/);
    expect(runnerSource).toMatch(/must\(\s*\n\s*"the fork-only approval went to Permit2 ONLY — the executor is still not approved",\s*\n\s*\(await allowance\(USDC, wallet, DELEGATED_EXECUTOR\)\) === 0n,/);
    expect(REQUIRED_PERMIT2_TOKEN_ALLOWANCE).toBe(500_000n);
    expect(GROSS_AMOUNT_IN).toBe(500_000n);
  });
});

// ---------------------------------------------------------------------------
// Regression: the delegated swap's eth_call reverted with
// Error("TRANSFER_FROM_FAILED") because the signing wallet had never granted
// the canonical one-time ERC-20 approval to the PERMIT2 CONTRACT. Permit2's
// SignatureTransfer pulls with `ERC20.transferFrom(owner, executor, gross)`
// from inside Permit2 (permit2 src/SignatureTransfer.sol -> solmate
// SafeTransferLib), so a zero token allowance makes _pullFromOwner revert
// before any executor logic runs — and the old gate actively REQUIRED that
// impossible state while reporting the revert without its reason.
// ---------------------------------------------------------------------------
describe("Permit2 token allowance — the precondition every SignatureTransfer pull needs", () => {
  it("requires exactly the campaign gross as the minimum", () => {
    expect(REQUIRED_PERMIT2_TOKEN_ALLOWANCE).toBe(GROSS_AMOUNT_IN);
    expect(REQUIRED_PERMIT2_TOKEN_ALLOWANCE).toBe(500_000n);
  });

  it("accepts the least-privilege approval of exactly the gross with no notes", () => {
    const r = evaluateLivePreconditions(greenFacts({ walletAllowanceToPermit2: GROSS_AMOUNT_IN }));
    expect(r.allowed).toBe(true);
    expect(checkNamed(r, "allowance wallet->Permit2 covers the gross")?.ok).toBe(true);
    expect(checkNamed(r, "allowance wallet->Permit2 is exactly the campaign gross")?.ok).toBe(true);
  });

  it("accepts an unbounded approval but reports it as a NON-FATAL note", () => {
    const unlimited = 2n ** 256n - 1n;
    const r = evaluateLivePreconditions(greenFacts({ walletAllowanceToPermit2: unlimited }));
    expect(r.allowed).toBe(true);
    const note = checkNamed(r, "allowance wallet->Permit2 is exactly the campaign gross");
    expect(note?.ok).toBe(false);
    expect(note?.fatal).toBe(false);
    expect(blockerNames(r)).toEqual([]);
  });

  it("still refuses any allowance to the EXECUTOR and any standing Permit2 allowance", () => {
    expect(evaluateLivePreconditions(greenFacts({ walletAllowanceToExecutor: 1n })).allowed).toBe(false);
    expect(evaluateLivePreconditions(greenFacts({ permit2AllowanceAmount: 1n })).allowed).toBe(false);
    // ...even when the (correct) Permit2 token approval is in place.
    const r = evaluateLivePreconditions(greenFacts({ walletAllowanceToExecutor: GROSS_AMOUNT_IN, permit2AllowanceAmount: GROSS_AMOUNT_IN }));
    expect(blockerNames(r).join(" | ")).toContain("allowance wallet->executor is 0");
    expect(blockerNames(r).join(" | ")).toContain("Permit2 standing allowance");
  });
});

describe("revert decoding — a failing eth_call must name its cause", () => {
  // Captured from a local EVM reproduction that runs the REAL Permit2
  // deployment source (Uniswap/permit2 @ cc56ad0f, solc 0.8.17 + via-ir)
  // against MPGRExecutorDelegated with allowance(owner -> Permit2) == 0.
  const TRANSFER_FROM_FAILED =
    "0x08c379a0" +
    "0000000000000000000000000000000000000000000000000000000000000020" +
    "0000000000000000000000000000000000000000000000000000000000000014" +
    "5452414e534645525f46524f4d5f4641494c4544000000000000000000000000";

  it("decodes the exact Permit2 pull failure of the rehearsal", () => {
    const d = decodeRevertData(TRANSFER_FROM_FAILED);
    expect(d.kind).toBe("Error(string)");
    expect(d.reason).toBe("TRANSFER_FROM_FAILED");
    expect(d.text).toBe('Error("TRANSFER_FROM_FAILED")');
  });

  it("decodes the executor's own custom errors by selector", () => {
    const insufficientOutput = keccak256(toHex("InsufficientOutput(uint256,uint256)")).slice(0, 10);
    const d = decodeRevertData(`${insufficientOutput}${"00".repeat(64)}`);
    expect(d.name).toBe("InsufficientOutput");
    expect(d.kind).toBe("custom");
    expect(KNOWN_REVERT_SELECTORS[insufficientOutput]).toBe("InsufficientOutput(uint256,uint256)");
  });

  it("decodes Permit2's own custom errors (nonce / deadline / signer)", () => {
    for (const sig of ["InvalidNonce()", "SignatureExpired(uint256)", "InvalidSigner()", "InvalidAmount(uint256)"]) {
      const selector = keccak256(toHex(sig)).slice(0, 10);
      expect(decodeRevertData(`${selector}${"00".repeat(32)}`).name).toBe(sig.slice(0, sig.indexOf("(")));
    }
  });

  it("reports empty and unknown revert data instead of pretending to know", () => {
    expect(decodeRevertData("0x").kind).toBe("empty");
    expect(decodeRevertData("0x").text).toContain("EMPTY return data");
    expect(decodeRevertData(undefined).kind).toBe("none");
    const unknown = decodeRevertData(`0xdeadbeef${"11".repeat(32)}`);
    expect(unknown.kind).toBe("unknown");
    expect(unknown.text).toContain("0xdeadbeef");
  });

  it("keeps the reason viem puts on the SECOND line, which safeErrorMessage drops", () => {
    const viemLike = Object.assign(
      new Error('The contract function "swapOnBehalfOfUniswapV3" reverted with the following reason:\nTRANSFER_FROM_FAILED'),
      {
        shortMessage: 'The contract function "swapOnBehalfOfUniswapV3" reverted with the following reason:\nTRANSFER_FROM_FAILED',
        cause: { data: TRANSFER_FROM_FAILED },
      },
    );
    // The old helper silently lost the cause; the new one must not.
    expect(safeErrorMessage(viemLike)).not.toContain("TRANSFER_FROM_FAILED");
    const described = describeContractError(viemLike);
    expect(described.detail).toContain('Error("TRANSFER_FROM_FAILED")');
    expect(described.decoded?.reason).toBe("TRANSFER_FROM_FAILED");
    expect(described.detail.split("\n").length).toBe(1);
  });

  it("redacts secrets out of a decoded revert description", () => {
    const secret = `0x${"cd".repeat(32)}`;
    const err = Object.assign(new Error(`boom ${secret}`), { shortMessage: `boom ${secret}` });
    const described = describeContractError(err, [secret]);
    expect(described.detail).toContain("<redacted>");
    expect(described.detail).not.toContain(secret);
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

  it("provisions the one-time Permit2 token approval in FORK STATE ONLY, never by a transaction", () => {
    // The fork principal must get the approval a real user grants once; it is
    // written with anvil_setStorageAt (local state), guarded by REHEARSAL, and
    // capped at exactly the campaign gross — never an approve() broadcast and
    // never an approval of the executor.
    expect(runnerSource).toContain("REQUIRED_PERMIT2_TOKEN_ALLOWANCE");
    expect(runnerSource).toMatch(/if \(REHEARSAL && walletAllowanceToPermit2 < REQUIRED_PERMIT2_TOKEN_ALLOWANCE\)/);
    expect(runnerSource).toContain("fork-only one-time USDC->Permit2 approval applied for exactly the gross");
    expect(runnerSource).toContain("the fork-only approval went to Permit2 ONLY — the executor is still not approved");
    gate(/functionName:\s*"approve"/, "an approve() call");
    // The gate must judge the post-provisioning state, not a stale read.
    expect(runnerSource).toContain("walletAllowanceToPermit2: walletAllowanceToPermit2Now");
    expect(runnerSource.indexOf("forkPermit2ApprovalUnits")).toBeLessThan(runnerSource.indexOf("const walletAllowanceToPermit2Now"));
  });

  it("decodes the simulation revert instead of dropping it, and keeps no stale amountOut", () => {
    expect(runnerSource).toContain("describeContractError(err, SECRETS)");
    expect(runnerSource).toContain("simulationRevert");
    expect(runnerSource).toContain('fact("simulationFailure"');
    // A reverted simulation must not leave the quoter's number behind.
    expect(runnerSource).toMatch(/simulationOk = false;[\s\S]{0,320}simulationAmountOut = null;/);
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


// ---------------------------------------------------------------------------
/**
 * The historical SwapExecuted scan is the one-shot guard's on-chain leg. On a
 * LOCAL anvil fork its pre-fork history is not local, so a scan anchored at the
 * deployment block pushes hundreds of chunked eth_getLogs calls at the fork's
 * upstream — and public Base endpoints cap how many blocks one such call may
 * span (regression: the fork rehearsal died on that scan). The rehearsal is
 * therefore bounded to the last REHEARSAL_LOG_WINDOW blocks of the fork, while
 * `live`/`preflight` keep the full deployment-block-anchored certification.
 */
describe("historical SwapExecuted scan window", () => {
  const HEAD = 52_800_000n;

  it("certifies the full range from the deployment block outside rehearsal", () => {
    expect(priorSwapScanWindow({ head: HEAD })).toEqual({ from: DELEGATED_DEPLOY_BLOCK, to: HEAD });
    expect(priorSwapScanWindow({ head: HEAD, rehearsal: false })).toEqual({ from: DELEGATED_DEPLOY_BLOCK, to: HEAD });
  });

  it("bounds a rehearsal to the last 10 blocks of the local fork", () => {
    expect(REHEARSAL_LOG_WINDOW).toBe(10n);
    const { from, to } = priorSwapScanWindow({ head: HEAD, rehearsal: true });
    expect(to).toBe(HEAD);
    expect(from).toBe(HEAD - REHEARSAL_LOG_WINDOW + 1n);
    expect(to - from + 1n).toBe(REHEARSAL_LOG_WINDOW);
  });

  it("never reaches back before the deployment block", () => {
    const head = DELEGATED_DEPLOY_BLOCK + 3n;
    expect(priorSwapScanWindow({ head, rehearsal: true })).toEqual({ from: DELEGATED_DEPLOY_BLOCK, to: head });
  });

  it("keeps the rehearsal scan to a single upstream-friendly eth_getLogs call", () => {
    const { from, to } = priorSwapScanWindow({ head: HEAD, rehearsal: true });
    // The bounded window is narrower than one chunk, so the rehearsal issues
    // exactly one eth_getLogs call — a range a public endpoint will serve.
    expect(to - from + 1n).toBeLessThanOrEqual(LOG_CHUNK);
    expect((to - from + LOG_CHUNK) / LOG_CHUNK).toBe(1n);
  });

  it("is what the runner actually scans (not a copy of it)", () => {
    const call = runnerSource.match(/priorSwapScanWindow\(\{\s*head,\s*rehearsal:\s*REHEARSAL\s*\}\)/);
    expect(call, "the runner must derive its scan window from priorSwapScanWindow").not.toBeNull();
    // The runner delegates the chunked requests to the shared bounded scanner
    // (runAdaptiveLogScan in the gates module) — no inline chunk loop may remain
    // to drift from the tested implementation.
    expect(runnerSource.match(/await runAdaptiveLogScan\(\{/g)?.length).toBe(1);
    expect(runnerSource).not.toMatch(/await runLogScan\(\{/);
    expect(runnerSource).not.toMatch(/from \+= LOG_CHUNK/);
    // No unconditional scan anchored at the deployment block may remain.
    expect(runnerSource).not.toMatch(/for \(let from = DELEGATED_DEPLOY_BLOCK/);
  });
});

// ---------------------------------------------------------------------------
/**
 * Regression suite for the bounded historical log scan itself. Run #5 died in
 * preflight because a 2 000-block eth_getLogs request was rejected by public
 * Base RPCs ("eth_getLogs is limited to 0 - 50 blocks range"); the scan must
 * walk the SAME complete deployment->head window in small bounded chunks, with
 * zero gaps, zero overlaps, both boundary blocks included, a correct final
 * partial chunk, deterministic ordering, no request wider than LOG_CHUNK, and
 * a provider failure that FAILS CLOSED instead of certifying a partial scan.
 * The scanner takes its eth_getLogs request as an injected `fetchChunk`, so
 * these tests exercise the exact production loop with a mock provider.
 */
describe("bounded historical log scanning (restrictive Base eth_getLogs caps)", () => {
  const HEAD = 52_800_000n;

  /** Mock provider: events at chosen blocks + a recording of every request. */
  const mockProvider = (blocks: bigint[] = []) => {
    const calls: Array<{ from: bigint; to: bigint }> = [];
    return {
      calls,
      fetchChunk: (from: bigint, to: bigint) => {
        calls.push({ from, to });
        return Promise.resolve(blocks.filter((b) => b >= from && b <= to).map((b) => ({ blockNumber: b })));
      },
    };
  };

  it("scans a single block as exactly one single-block request", async () => {
    expect(planLogScan({ from: 7n, to: 7n })).toEqual([{ from: 7n, to: 7n }]);
    const { calls, fetchChunk } = mockProvider([7n]);
    const r = await runLogScan({ fetchChunk, from: 7n, to: 7n });
    expect(calls).toEqual([{ from: 7n, to: 7n }]);
    expect(r.logs).toEqual([{ blockNumber: 7n }]);
    expect(r.chunks).toBe(1n);
    expect(r.from).toBe(7n);
    expect(r.to).toBe(7n);
  });

  it("keeps a range smaller than one chunk in a single request", () => {
    const plan = planLogScan({ from: 100n, to: 100n + LOG_CHUNK - 2n }); // 9 blocks < one chunk
    expect(plan).toEqual([{ from: 100n, to: 100n + LOG_CHUNK - 2n }]);
    expect(plan[0].to - plan[0].from + 1n).toBe(LOG_CHUNK - 1n);
  });

  it("splits an exact chunk multiple into whole chunks (no phantom partial)", () => {
    const plan = planLogScan({ from: 100n, to: 100n + 2n * LOG_CHUNK - 1n });
    expect(plan).toEqual([
      { from: 100n, to: 100n + LOG_CHUNK - 1n },
      { from: 100n + LOG_CHUNK, to: 100n + 2n * LOG_CHUNK - 1n },
    ]);
    for (const c of plan) expect(c.to - c.from + 1n).toBe(LOG_CHUNK);
    expect(planLogScan({ from: 0n, to: 3n * LOG_CHUNK - 1n })).toHaveLength(3);
  });

  it("handles the final partial chunk without widening, padding or dropping it", () => {
    const plan = planLogScan({ from: 100n, to: 100n + 2n * LOG_CHUNK + 4n }); // 25 blocks: 10+10+5
    expect(plan).toHaveLength(3);
    expect(plan.map((c) => c.to - c.from + 1n)).toEqual([LOG_CHUNK, LOG_CHUNK, 5n]);
    expect(plan[2]).toEqual({ from: 100n + 2n * LOG_CHUNK, to: 100n + 2n * LOG_CHUNK + 4n });
  });

  it("includes boundary events exactly once (first block, chunk seam, last block)", async () => {
    const first = 100n;
    const seamLeft = 100n + LOG_CHUNK - 1n; // last block of chunk 1
    const seamRight = 100n + LOG_CHUNK; // first block of chunk 2
    const last = 100n + 2n * LOG_CHUNK + 4n; // last block of the final partial chunk
    const { calls, fetchChunk } = mockProvider([first, seamLeft, seamRight, last]);
    const r = await runLogScan({ fetchChunk, from: first, to: last });
    expect(r.logs.map((l) => l.blockNumber)).toEqual([first, seamLeft, seamRight, last]);
    expect(calls).toEqual([
      { from: first, to: seamLeft },
      { from: seamRight, to: seamRight + LOG_CHUNK - 1n },
      { from: seamRight + LOG_CHUNK, to: last }, // final partial chunk (5 blocks)
    ]);
    expect(r.chunks).toBe(3n);
  });

  it("covers the complete deployment->head range with zero gaps and zero overlaps", () => {
    // preflight/live window: deployment block -> captured head, in full.
    const { from, to } = priorSwapScanWindow({ head: HEAD });
    expect(from).toBe(DELEGATED_DEPLOY_BLOCK);
    expect(to).toBe(HEAD);
    const plan = planLogScan({ from, to });
    expect(plan[0].from).toBe(from); // first block included
    expect(plan[plan.length - 1].to).toBe(to); // last block included
    let covered = 0n;
    for (let i = 0; i < plan.length; i++) {
      covered += plan[i].to - plan[i].from + 1n;
      if (i > 0) {
        expect(plan[i].from).toBeGreaterThan(plan[i - 1].to); // no overlaps
        expect(plan[i].from).toBe(plan[i - 1].to + 1n); // no gaps
      }
    }
    expect(covered).toBe(to - from + 1n); // every block exactly once
    expect(planLogScan({ from, to })).toEqual(plan); // deterministic ordering
  });

  it("never issues an eth_getLogs request wider than the configured chunk size", async () => {
    // Every block of the range carries an event, so every request is exercised.
    const blocks = Array.from({ length: 25 }, (_, i) => 100n + BigInt(i));
    const { calls, fetchChunk } = mockProvider(blocks);
    const r = await runLogScan({ fetchChunk, from: 100n, to: 124n });
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c.to - c.from + 1n).toBeLessThanOrEqual(LOG_CHUNK);
    // Ascending deterministic order, complete coverage of the events.
    expect(r.logs.map((l) => l.blockNumber)).toEqual(blocks);
    // The full deployment->head plan is uniformly bounded too.
    for (const c of planLogScan({ from: DELEGATED_DEPLOY_BLOCK, to: HEAD })) {
      expect(c.to - c.from + 1n).toBeLessThanOrEqual(LOG_CHUNK);
    }
  });

  it("fails closed when any chunk cannot be read — never a partial certification", async () => {
    const blocks = [100n, 105n, 110n, 115n, 120n, 124n];
    for (const failAtChunk of [1, 2, 3]) {
      // First, middle and last chunk: every failure rejects the whole scan.
      let n = 0;
      const calls: Array<{ from: bigint; to: bigint }> = [];
      const fetchChunk = (from: bigint, to: bigint) => {
        calls.push({ from, to });
        n += 1;
        if (n === failAtChunk) return Promise.reject(new Error("upstream unavailable"));
        return Promise.resolve(blocks.filter((b) => b >= from && b <= to).map((b) => ({ blockNumber: b })));
      };
      const err = await runLogScan({ fetchChunk, from: 100n, to: 124n }).then(
        () => null,
        (e: Error) => e,
      );
      expect(err, `chunk ${failAtChunk} failing must reject the scan`).not.toBeNull();
      expect(err?.message).toMatch(/could not be read/);
      expect(err?.message).toMatch(/refusing to certify a one-shot from a partial scan/);
      expect((err as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
      // The scan stops at the failing chunk: later chunks are never requested.
      expect(calls).toHaveLength(failAtChunk);
    }
  });

  it("refuses an oversized scan before the first request (the MAX_LOG_CHUNKS-style cap)", async () => {
    const { calls, fetchChunk } = mockProvider();
    await expect(
      runLogScan({ fetchChunk, from: 100n, to: 100n + 3n * LOG_CHUNK, maxChunks: 2n }), // 4 chunks > 2
    ).rejects.toThrow(/refusing to certify a one-shot from a partial scan/);
    expect(calls).toEqual([]); // fail closed BEFORE any eth_getLogs
  });

  it("preflight and live certify the full window through the shared bounded scanner", () => {
    // One scan call site, driven by the mode flag alone: preflight and live
    // take the identical bounded path over the deployment->head window.
    expect(runnerSource.match(/await runAdaptiveLogScan\(\{/g)?.length).toBe(1);
    expect(runnerSource).not.toMatch(/await runLogScan\(\{/);
    expect(runnerSource.match(/priorSwapScanWindow\(\{\s*head,\s*rehearsal:\s*REHEARSAL\s*\}\)/)).not.toBeNull();
    expect(runnerSource).toContain("maxChunks: MAX_LOG_CHUNKS");
    // The fail-closed chunk-budget cap remains in force in the runner...
    expect(runnerSource).toContain("if (chunks > MAX_LOG_CHUNKS)");
    expect(runnerSource).toMatch(/use a full-node RPC/);
    // ...and still budgets the documented ~4M blocks (~3 months of Base 2s
    // blocks) at whatever chunk size is configured.
    const cap = runnerSource.match(/const MAX_LOG_CHUNKS = ([0-9_]+)n;/);
    expect(cap, "MAX_LOG_CHUNKS must remain a bigint constant").not.toBeNull();
    const maxChunks = BigInt((cap as RegExpMatchArray)[1].replace(/_/g, ""));
    expect(maxChunks * LOG_CHUNK).toBeGreaterThanOrEqual(4_000_000n);
    // The full deployment->head window fits inside that fail-closed budget.
    const needed = (HEAD - DELEGATED_DEPLOY_BLOCK + LOG_CHUNK) / LOG_CHUNK;
    expect(needed).toBeLessThanOrEqual(maxChunks);
  });

  it("rehearsal keeps its bounded window and scans it in one bounded request", async () => {
    const { from, to } = priorSwapScanWindow({ head: HEAD, rehearsal: true });
    const plan = planLogScan({ from, to });
    expect(plan).toHaveLength(1); // REHEARSAL_LOG_WINDOW (10) == one chunk
    expect(plan[0].to - plan[0].from + 1n).toBeLessThanOrEqual(LOG_CHUNK);
    const { calls, fetchChunk } = mockProvider([from]);
    await runLogScan({ fetchChunk, from, to });
    expect(calls).toEqual([{ from, to }]);
  });

  it("reads no private key in preflight (and none anywhere in the scan path)", () => {
    // The key is read ONLY in the live branch, from the single env var.
    expect(runnerSource).toMatch(/if \(LIVE\) \{\s*\n\s*ownerAccount = readLiveKey\(\);/);
    expect(runnerSource.match(/readLiveKey\(\)/g)?.length).toBe(2); // definition + the live-only call
    // Preflight builds its identity from the non-secret pin alone.
    expect(runnerSource).toContain("ownerAccount = { address: pin.address }; // read-only: no signer, no key");
  });

  it("introduces no broadcast capability with this fix", () => {
    // The scanner's only side effect is the injected fetchChunk — the shared
    // gates module must not know how to send anything.
    expect(gatesSource.match(/eth_sendRawTransaction|eth_sendTransaction|sendTransaction\(|writeContract\(/g)).toBeNull();
    expect(runnerSource).toContain("fetchChunk: (fromBlock, toBlock) =>");
    // The runner still broadcasts at most once (the pre-existing live step).
    expect(runnerSource.match(/writeContract\(/g)?.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
/**
 * Run #6 regression: PR #93 bounded every eth_getLogs to 10 blocks, which fixed
 * the per-request RANGE limit but turned the deployment->head certification into
 * tens of thousands of requests. Those requests went out across a public/free
 * fallback list until every endpoint answered 429 ("1rpc usage limit exceeded",
 * compute-unit/sec caps), and preflight died after ~13 minutes.
 *
 * The architecture that replaces it, asserted here:
 *   ONE dedicated configured RPC per mode, no public fallback list;
 *   a readiness gate that proves the endpoint can serve the scan BEFORE it runs;
 *   a bounded, Retry-After-aware quota policy that FAILS CLOSED;
 *   an endpoint-VERIFIED eth_getLogs width (never assumed) over the SAME
 *   complete, gap-free deployment->head window.
 */
describe("RPC roles: one dedicated endpoint per mode, never a public fallback grind", () => {
  const DEDICATED = "https://base-mainnet.example/abcdef0123456789";
  const LOCAL = "http://127.0.0.1:8545";
  const base = {
    keyEnvValue: undefined,
    walletPinEnvValue: SIGNER,
    githubActions: "true",
    emergencyDisabled: false,
  };
  const preflight = (rpcUrls: unknown, configuredRpcUrl: unknown = DEDICATED) =>
    evaluateModeGuard({ ...base, mode: MODES.PREFLIGHT, rpcUrls, configuredRpcUrl });
  const live = (rpcUrls: unknown, configuredRpcUrl: unknown = DEDICATED) =>
    evaluateModeGuard({ ...base, mode: MODES.LIVE, rpcUrls, configuredRpcUrl, keyEnvValue: `0x${"cd".repeat(32)}` });

  it("requires the configured smoke RPC for preflight and live, with an operator message", () => {
    for (const r of [preflight([]), preflight(undefined, undefined), live([]), live([""], "")]) {
      expect(r.allowed).toBe(false);
      const detail = r.checks.map((c) => c.detail).join(" | ");
      expect(detail).toContain(RPC_MISSING_MESSAGE);
    }
    expect(preflight([DEDICATED]).allowed).toBe(true);
    expect(live([DEDICATED]).allowed).toBe(true);
    expect(RPC_ENV).toBe("SMOKE_DELEGATED_RPC_URL");
  });

  it("refuses a second endpoint or a mismatched endpoint: rotation is not resilience here", () => {
    expect(preflight([DEDICATED, "https://mainnet.base.org"]).allowed).toBe(false);
    expect(live([DEDICATED, "https://base-rpc.publicnode.com"]).allowed).toBe(false);
    // The list may not silently stand in for the configured endpoint either.
    expect(preflight(["https://mainnet.base.org"], DEDICATED).allowed).toBe(false);
    expect(live(["https://mainnet.base.org"], DEDICATED).allowed).toBe(false);
  });

  it("rehearsal still reads ONLY the local anvil fork", () => {
    expect(evaluateModeGuard({ ...base, mode: MODES.REHEARSAL, rpcUrls: [LOCAL], configuredRpcUrl: LOCAL }).allowed).toBe(true);
    // A real remote endpoint is refused for rehearsal, exactly as before.
    expect(evaluateModeGuard({ ...base, mode: MODES.REHEARSAL, rpcUrls: [DEDICATED], configuredRpcUrl: DEDICATED }).allowed).toBe(false);
    expect(isLocalRpc(LOCAL)).toBe(true);
    expect(isLocalRpc(DEDICATED)).toBe(false);
  });

  it("preflight and live refuse a local, private or fork-shaped endpoint", () => {
    for (const url of [LOCAL, "http://localhost:8545", "http://10.0.0.5:8545", "http://192.168.1.20:8545", "http://172.16.4.4:8545", "http://169.254.1.1:8545", "http://node.local:8545"]) {
      expect(isPrivateOrLocalRpc(url), url).toBe(true);
      expect(preflight([url], url).allowed, `preflight ${url}`).toBe(false);
      expect(live([url], url).allowed, `live ${url}`).toBe(false);
      expect(isHttpsRpc(url), url).toBe(false);
    }
    expect(isPrivateOrLocalRpc(DEDICATED)).toBe(false);
    expect(isHttpsRpc(DEDICATED)).toBe(true);
  });

  it("the runner has no public fallback list left to grind", () => {
    expect(runnerSource).not.toContain("PUBLIC_BASE_RPCS");
    for (const host of ["mainnet.base.org", "base-rpc.publicnode.com", "base.drpc.org", "base.llamarpc.com", "1rpc.io"]) {
      expect(runnerSource, host).not.toContain(host);
    }
    // Exactly one endpoint per run, taken from the configured env var.
    expect(runnerSource).toContain("const RPC_URLS = RPC_URL.length > 0 ? [RPC_URL] : [];");
    expect(runnerSource).toContain("configuredRpcUrl: RPC_URL");
  });

  it("the workflow supplies that endpoint as a secret and fails clearly when it is absent", () => {
    const workflowSource = readFileSync(".github/workflows/smoke-delegated-executor-base-mainnet.yml", "utf8");
    for (const job of ["preflight", "live"]) {
      expect(workflowSource, job).toContain("SMOKE_DELEGATED_RPC_URL: ${{ secrets.BASE_MAINNET_RPC_URL }}");
    }
    expect(workflowSource).toContain("Refuse to run without a dedicated Base Mainnet smoke RPC");
    expect(workflowSource).toContain("Refuse to run without the dedicated smoke RPC preflight certified with");
    // The rehearsal still forks from a local anvil; only its upstream may be public.
    expect(workflowSource).toContain("SMOKE_DELEGATED_MODE=rehearsal SMOKE_DELEGATED_RPC_URL=http://127.0.0.1:8545");
    // No hardcoded private endpoint is introduced anywhere.
    expect(workflowSource).not.toMatch(/https:\/\/[a-z0-9.-]*(alchemy|infura|quicknode|ankr|getblock|tenderly)\.[a-z.]+\//i);
    expect(gatesSource).not.toMatch(/https:\/\/[a-z0-9.-]*(alchemy|infura|quicknode|ankr|getblock|tenderly)\.[a-z.]+\//i);
    expect(runnerSource).not.toMatch(/https:\/\/[a-z0-9.-]*(alchemy|infura|quicknode|ankr|getblock|tenderly)\.[a-z.]+\//i);
  });
});

// ---------------------------------------------------------------------------
describe("RPC readiness gate (runs BEFORE the historical certification)", () => {
  const DEDICATED = "https://base-mainnet.example/abcdef0123456789";
  const HEAD = 52_900_000n;
  const ok = {
    mode: MODES.PREFLIGHT,
    rpcUrl: DEDICATED,
    chainId: CHAIN_ID,
    headBlock: HEAD,
    probe: { ok: true, width: "1000", logs: 0 },
    rateLimited: false,
    chunkSize: "1000",
    requestedChunkSize: "1000",
  };
  const named = (r: { checks: { name: string; ok: boolean; detail: string }[] }, needle: string) =>
    r.checks.find((c) => c.name.includes(needle));

  it("accepts a provisioned Base Mainnet endpoint", () => {
    const r = evaluateRpcReadiness(ok);
    expect(r.allowed).toBe(true);
    expect(r.checks.length).toBeGreaterThanOrEqual(6);
    for (const c of r.checks) expect(c.fatal, c.name).toBe(true);
  });

  it("refuses an endpoint that is not Base Mainnet (chainId validation)", () => {
    for (const chainId of [1, 11155111, 84532, 0, undefined, null]) {
      const r = evaluateRpcReadiness({ ...ok, chainId });
      expect(r.allowed, `chainId=${String(chainId)}`).toBe(false);
      expect(named(r, `chainId ${CHAIN_ID}`)?.ok).toBe(false);
    }
  });

  it("refuses an unreadable head, or a head before the deployment block", () => {
    for (const headBlock of [undefined, null, "nope", DELEGATED_DEPLOY_BLOCK - 1n]) {
      expect(evaluateRpcReadiness({ ...ok, headBlock }).allowed, String(headBlock)).toBe(false);
    }
    expect(evaluateRpcReadiness({ ...ok, headBlock: DELEGATED_DEPLOY_BLOCK }).allowed).toBe(true);
  });

  it("requires a small known eth_getLogs probe to have succeeded", () => {
    const failing = evaluateRpcReadiness({ ...ok, probe: { ok: false, detail: "eth_getLogs refused" } });
    expect(failing.allowed).toBe(false);
    const detail = named(failing, "small known eth_getLogs")?.detail ?? "";
    expect(detail).toContain("the historical certification cannot proceed");
    expect(evaluateRpcReadiness({ ...ok, probe: undefined }).allowed).toBe(false);
  });

  it("fails closed with the operator message when the endpoint is rate-limited", () => {
    const r = evaluateRpcReadiness({ ...ok, rateLimited: true, retryAfterMs: 5_000 });
    expect(r.allowed).toBe(false);
    const detail = named(r, "HTTP 429")?.detail ?? "";
    expect(detail).toContain(RPC_RATE_LIMITED_MESSAGE);
    expect(detail).toContain("Retry-After 5000ms");
    expect(RPC_RATE_LIMITED_MESSAGE).toContain("Configure a properly provisioned Base Mainnet RPC");
  });

  it("refuses a local/fork endpoint for preflight and live, and demands https", () => {
    for (const mode of [MODES.PREFLIGHT, MODES.LIVE]) {
      const local = evaluateRpcReadiness({ ...ok, mode, rpcUrl: "http://127.0.0.1:8545" });
      expect(local.allowed, mode).toBe(false);
      expect(named(local, "REAL Base Mainnet endpoint")?.ok).toBe(false);
      const insecure = evaluateRpcReadiness({ ...ok, mode, rpcUrl: "http://base-mainnet.example/abc" });
      expect(insecure.allowed, `${mode} http`).toBe(false);
      expect(named(insecure, "https")?.ok).toBe(false);
      const missing = evaluateRpcReadiness({ ...ok, mode, rpcUrl: "" });
      expect(missing.allowed, `${mode} missing`).toBe(false);
      expect(missing.checks[0].detail).toContain(RPC_MISSING_MESSAGE);
    }
  });

  it("rehearsal requires the LOCAL fork and skips the width probe", () => {
    const rehearsal = evaluateRpcReadiness({
      mode: MODES.REHEARSAL,
      rpcUrl: "http://127.0.0.1:8545",
      chainId: CHAIN_ID,
      headBlock: HEAD,
      probe: { ok: true, width: "10", logs: 0 },
      chunkSize: LOG_CHUNK,
    });
    expect(rehearsal.allowed).toBe(true);
    expect(named(rehearsal, "LOCAL anvil fork")?.ok).toBe(true);
    // A remote endpoint is NOT an acceptable rehearsal source.
    expect(evaluateRpcReadiness({ mode: MODES.REHEARSAL, rpcUrl: DEDICATED, chainId: CHAIN_ID, headBlock: HEAD, probe: { ok: true } }).allowed).toBe(false);
  });

  it("only accepts a scan width inside the reviewed floor/ceiling", () => {
    expect(evaluateRpcReadiness({ ...ok, chunkSize: "5" }).allowed).toBe(false);
    expect(evaluateRpcReadiness({ ...ok, chunkSize: String(MAX_SAFE_LOG_CHUNK + 1n) }).allowed).toBe(false);
    // A width wider than what the operator allowed is refused too.
    expect(evaluateRpcReadiness({ ...ok, chunkSize: "1000", requestedChunkSize: "200" }).allowed).toBe(false);
    expect(evaluateRpcReadiness({ ...ok, chunkSize: "200", requestedChunkSize: "1000" }).allowed).toBe(true);
  });

  it("runs before the scan in the runner, and its rows decide the run", () => {
    const readinessAt = runnerSource.indexOf('stage("2b. RPC readiness');
    const readsAt = runnerSource.indexOf('stage("3. live posture reads');
    expect(readinessAt).toBeGreaterThan(-1);
    // Stage order: the endpoint is proven BEFORE the mainnet reads that include
    // the historical scan.
    expect(readinessAt).toBeLessThan(readsAt);
    // The single scan call site lives in countPriorSwapEvents, which the stage-3
    // read set invokes — so the readiness gate necessarily precedes it.
    const scanAt = runnerSource.indexOf("await runAdaptiveLogScan({");
    const scanFn = runnerSource.indexOf("async function countPriorSwapEvents(pub, wallet) {");
    expect(scanAt).toBeGreaterThan(scanFn);
    expect(runnerSource.indexOf("countPriorSwapEvents(pub, wallet)").toString().length).toBeGreaterThan(0);
    expect(runnerSource.lastIndexOf("countPriorSwapEvents(pub, wallet)")).toBeGreaterThan(readsAt);
    expect(runnerSource).toContain("applyGate(\n    evaluateRpcReadiness({");
    expect(runnerSource).toContain("if (RPC_URLS.length === 0) {\n    throw new Abort(RPC_MISSING_MESSAGE);");
    // Every readiness row is fatal, so a red gate can never be a note.
    expect(gatesSource).toMatch(/stage, name, ok: Boolean\(ok\), detail: String\(detail\), fatal: true/);
  });
});

// ---------------------------------------------------------------------------
describe("HTTP 429 / quota handling: bounded, Retry-After-aware, fail closed", () => {
  it("classifies provider quota responses as rate limits, distinctly from range limits", () => {
    const quotas = [
      Object.assign(new Error("Too Many Requests"), { status: 429 }),
      new Error("HTTP request failed. Status: 429"),
      new Error("1rpc usage limit exceeded, visit https://www.1rpc.io"),
      new Error("Exceeded your current plan's compute units per second capacity"),
      new Error("rate limit reached, please slow down"),
      new Error("over your current quota, please try again in 30 seconds"),
      Object.assign(new Error("limit exceeded"), { code: -32005 }),
    ];
    for (const err of quotas) expect(classifyRpcError(err).kind, String(err)).toBe("rate-limit");

    const ranges = [
      new Error("eth_getLogs is limited to 0 - 50 blocks range"),
      new Error("exceed maximum block range: 500"),
      new Error("query returned more than 10000 results"),
      new Error("Log response size exceeded, you can request a smaller range"),
      new Error("query timeout exceeded"),
    ];
    for (const err of ranges) expect(classifyRpcError(err).kind, String(err)).toBe("range-limit");

    // A revert is neither, and must stay non-retryable.
    expect(classifyRpcError(Object.assign(new Error("execution reverted"), { code: 3 })).kind).toBe("revert");
    expect(classifyRpcError(Object.assign(new Error("boom"), { status: 503 })).kind).toBe("transient");
    // A nested viem error chain is still classified.
    const nested = Object.assign(new Error("request failed"), { cause: Object.assign(new Error("Too Many Requests"), { status: 429 }) });
    expect(classifyRpcError(nested).kind).toBe("rate-limit");
  });

  it("parses Retry-After as delta-seconds and as an HTTP-date", () => {
    expect(parseRetryAfter("120")).toBe(120_000);
    expect(parseRetryAfter(3)).toBe(3_000);
    const now = Date.parse("Wed, 07 Oct 2026 05:00:00 GMT");
    expect(parseRetryAfter("Wed, 07 Oct 2026 05:00:45 GMT", { nowMs: now })).toBe(45_000);
    expect(parseRetryAfter("Wed, 07 Oct 2026 04:59:00 GMT", { nowMs: now })).toBe(0);
    for (const junk of [undefined, null, "", "soon", "0", "-5"]) expect(parseRetryAfter(junk), String(junk)).toBeNull();
  });

  it("backs off exponentially, respects a longer Retry-After, and stays capped", () => {
    expect(RATE_LIMIT_BACKOFF_BASE_MS).toBe(1_000);
    const waits = [1, 2, 3, 4, 5, 6, 7].map((attempt) => shouldRetryRateLimit({ attempt }).waitMs);
    expect(waits[0]).toBe(RATE_LIMIT_BACKOFF_BASE_MS);
    // Attempts inside the budget grow exponentially and stay capped; the attempt
    // that exhausts the budget is not waited at all (waitMs 0, retry false).
    for (let i = 1; i < RATE_LIMIT_MAX_ATTEMPTS - 1; i++) {
      expect(waits[i], `attempt ${i + 1}`).toBeGreaterThan(waits[i - 1]);
    }
    for (const w of waits.slice(0, RATE_LIMIT_MAX_ATTEMPTS - 1)) expect(w).toBeLessThanOrEqual(RATE_LIMIT_BACKOFF_MAX_MS);
    expect(waits[RATE_LIMIT_MAX_ATTEMPTS - 1]).toBe(0);
    // The provider's own Retry-After wins when it is longer than the backoff...
    expect(shouldRetryRateLimit({ attempt: 1, retryAfterMs: 9_000 }).waitMs).toBe(9_000);
    expect(shouldRetryRateLimit({ attempt: 1, retryAfterMs: 9_000 }).source).toBe("retry-after");
    // ...but an unaffordable one is not slept through: it fails closed instead.
    const long = shouldRetryRateLimit({ attempt: 1, retryAfterMs: RETRY_AFTER_MAX_MS + 1 });
    expect(long.retry).toBe(false);
    expect(long.reason).toContain("budget");
  });

  it("has a finite retry budget and never loops", () => {
    expect(RATE_LIMIT_MAX_ATTEMPTS).toBe(4);
    for (let attempt = 1; attempt < RATE_LIMIT_MAX_ATTEMPTS; attempt++) {
      expect(shouldRetryRateLimit({ attempt }).retry, `attempt ${attempt}`).toBe(true);
    }
    for (const attempt of [RATE_LIMIT_MAX_ATTEMPTS, RATE_LIMIT_MAX_ATTEMPTS + 1, 99]) {
      const decision = shouldRetryRateLimit({ attempt });
      expect(decision.retry, `attempt ${attempt}`).toBe(false);
      expect(decision.waitMs).toBe(0);
      expect(decision.reason).toContain("budget exhausted");
    }
    // The budget is also honoured when every response carries a Retry-After.
    let attempt = 0;
    for (;;) {
      attempt += 1;
      if (!shouldRetryRateLimit({ attempt, retryAfterMs: 2_000 }).retry) break;
      expect(attempt).toBeLessThanOrEqual(RATE_LIMIT_MAX_ATTEMPTS);
    }
    expect(attempt).toBe(RATE_LIMIT_MAX_ATTEMPTS);
  });

  it("the runner spends that budget and then fails closed with the operator message", () => {
    expect(runnerSource).toContain("class RpcRateLimited extends Abort");
    expect(runnerSource).toContain("if (cls.kind === \"rate-limit\")");
    expect(runnerSource).toContain("this.quotaAttempts += 1");
    expect(runnerSource).toContain("shouldRetryRateLimit({");
    expect(runnerSource).toContain("if (!decision.retry) throw new RpcRateLimited(");
    // The operator message is defined once (in the gates module) and thrown by
    // the runner through the imported constant — never re-worded locally.
    expect(RPC_RATE_LIMITED_MESSAGE).toContain("Dedicated smoke RPC is rate-limited");
    expect(runnerSource).toContain("RPC_RATE_LIMITED_MESSAGE");
    expect(runnerSource).toContain("super(`${RPC_RATE_LIMITED_MESSAGE}${detail ? ` Last response: ${detail}` : \"\"}`);");
    // Retry-After is read off the RAW response, so a 429 that carries a JSON-RPC
    // body (which viem does not turn into an HttpRequestError) is still honoured.
    expect(runnerSource).toContain("onFetchResponse: (response) =>");
    expect(runnerSource).toContain("parseRetryAfter(response.headers?.get?.(\"retry-after\")");
    // No unbounded loop: the quota counter is initialised exactly once (in the
    // constructor) and never reset per request, and there is no infinite loop.
    expect(runnerSource.match(/quotaAttempts = 0/g)?.length).toBe(1);
    expect(runnerSource.match(/quotaAttempts \+= 1/g)?.length).toBe(1);
    expect(runnerSource).not.toMatch(/while \(true\)/);
  });
});

// ---------------------------------------------------------------------------
describe("adaptive eth_getLogs chunking: verified width, identical coverage", () => {
  const HEAD = 52_900_000n;
  const mock = (blocks: bigint[] = [], opts: { rangeErrorAt?: number; floorErrors?: boolean } = {}) => {
    const calls: Array<{ from: bigint; to: bigint }> = [];
    let n = 0;
    return {
      calls,
      fetchChunk: (from: bigint, to: bigint) => {
        calls.push({ from, to });
        n += 1;
        if (opts.rangeErrorAt === n) return Promise.reject(new Error("exceed maximum block range: 500"));
        if (opts.floorErrors) return Promise.reject(new Error("exceed maximum block range: 1"));
        return Promise.resolve(blocks.filter((b) => b >= from && b <= to).map((b) => ({ blockNumber: b })));
      },
    };
  };

  it("keeps the reviewed floor and an explicit ceiling, and never assumes the ceiling", () => {
    expect(LOG_CHUNK).toBe(10n);
    expect(MAX_SAFE_LOG_CHUNK).toBe(1_000n);
    expect(MAX_SAFE_LOG_CHUNK).toBeGreaterThan(LOG_CHUNK);
    // The ladder is explicit, ascending and inside the reviewed window.
    expect(LOG_CHUNK_PROBE_LADDER[0]).toBe(LOG_CHUNK);
    expect(LOG_CHUNK_PROBE_LADDER[LOG_CHUNK_PROBE_LADDER.length - 1]).toBe(MAX_SAFE_LOG_CHUNK);
    for (let i = 1; i < LOG_CHUNK_PROBE_LADDER.length; i++) {
      expect(LOG_CHUNK_PROBE_LADDER[i]).toBeGreaterThan(LOG_CHUNK_PROBE_LADDER[i - 1]);
    }
    expect(probeWidthsAbove(0n).map(String)).toEqual(LOG_CHUNK_PROBE_LADDER.map(String));
    expect(probeWidthsAbove(50n).map(String)).toEqual(["200", "1000"]);
    // A lower operator ceiling shortens the ladder instead of exceeding it.
    expect(probeWidthsAbove(0n, { max: 50n }).map(String)).toEqual(["10", "50"]);
    expect(MAX_LOG_CHUNK_ENV).toBe("SMOKE_DELEGATED_MAX_LOG_CHUNK");
  });

  it("clamps a requested width into [floor, ceiling] and only ever shrinks", () => {
    expect(clampChunkSize(5n)).toBe(LOG_CHUNK);
    expect(clampChunkSize(50_000n)).toBe(MAX_SAFE_LOG_CHUNK);
    expect(clampChunkSize("500")).toBe(500n);
    for (const junk of [0n, -1n, "abc", null, {}, undefined]) expect(() => clampChunkSize(junk as never)).toThrow();
    // The runner's own expression: an unset operator knob falls back to the ceiling.
    const envOrCeiling = (value: string) => (value.length > 0 ? value : MAX_SAFE_LOG_CHUNK);
    expect(clampChunkSize(envOrCeiling(""), { min: LOG_CHUNK, max: MAX_SAFE_LOG_CHUNK })).toBe(MAX_SAFE_LOG_CHUNK);
    expect(clampChunkSize(envOrCeiling("50"), { min: LOG_CHUNK, max: MAX_SAFE_LOG_CHUNK })).toBe(50n);
    expect(clampChunkSize(envOrCeiling("999999"), { min: LOG_CHUNK, max: MAX_SAFE_LOG_CHUNK })).toBe(MAX_SAFE_LOG_CHUNK);
    expect(shrinkChunkSize(1_000n)).toBe(500n);
    expect(shrinkChunkSize(50n)).toBe(25n);
    expect(shrinkChunkSize(20n)).toBe(LOG_CHUNK);
    expect(shrinkChunkSize(10n)).toBe(LOG_CHUNK); // never below the floor
    // The runner clamps the operator knob with exactly these bounds.
    expect(runnerSource).toContain("clampChunkSize(env(MAX_LOG_CHUNK_ENV) || MAX_SAFE_LOG_CHUNK");
  });

  it("grows only where the endpoint explicitly served the width, and stops at the first refusal", async () => {
    const served: bigint[] = [];
    const probe = await probeLogChunkSize({
      requestChunk: async (width) => {
        if (width > 200n) throw new Error("eth_getLogs is limited to 0 - 200 blocks range");
        served.push(width);
        return 0;
      },
    });
    expect(probe.chunkSize).toBe(200n);
    expect(served).toEqual([10n, 50n, 200n]);
    expect(probe.refused?.chunkSize).toBe(1_000n);
    expect(probe.accepted.map(String)).toEqual(["10", "50", "200"]);
    // The refused width is never retried: exactly one request per width.
    expect(served.filter((w) => w === 200n)).toHaveLength(1);
  });

  it("never requests a width above the configured ceiling", async () => {
    const seen: bigint[] = [];
    await probeLogChunkSize({ requestChunk: async (width) => { seen.push(width); return 0; }, maxChunk: 50n });
    expect(seen.map(String)).toEqual(["10", "50"]);
    for (const w of seen) expect(w).toBeLessThanOrEqual(50n);
  });

  it("stops probing a rate-limited endpoint instead of hammering it, and throws if even the floor fails", async () => {
    let requests = 0;
    const probe = await probeLogChunkSize({
      requestChunk: async (width) => {
        requests += 1;
        if (width > 50n) throw Object.assign(new Error("Too Many Requests"), { status: 429 });
        return 0;
      },
    });
    expect(probe.chunkSize).toBe(50n);
    expect(requests).toBe(3); // 10, 50 accepted, then ONE 429 — no retry storm
    expect(probe.unavailable?.detail).toContain(RPC_RATE_LIMITED_MESSAGE);

    await expect(
      probeLogChunkSize({ requestChunk: async () => { throw Object.assign(new Error("Too Many Requests"), { status: 429 }); } }),
    ).rejects.toThrow(/could not serve a probe eth_getLogs/);
  });

  it("covers the FULL deployment->head window with zero gaps and zero overlaps at a verified width", async () => {
    const { from, to } = priorSwapScanWindow({ head: HEAD });
    expect(from).toBe(DELEGATED_DEPLOY_BLOCK);
    const blocks = [from, from + 999n, from + 1_000n, to - 1n, to];
    const { calls, fetchChunk } = mock(blocks);
    const r = await runAdaptiveLogScan({ fetchChunk, from, to, chunkSize: 1_000n, maxChunks: 400_000n, maxBlocks: MAX_LOG_SCAN_BLOCKS });
    expect(r.from).toBe(from);
    expect(r.to).toBe(to);
    expect(calls[0].from).toBe(from); // first block included
    expect(calls[calls.length - 1].to).toBe(to); // last block included
    let covered = 0n;
    for (let i = 0; i < calls.length; i++) {
      const span = calls[i].to - calls[i].from + 1n;
      expect(span).toBeGreaterThan(0n);
      expect(span).toBeLessThanOrEqual(1_000n); // never wider than the verified width
      covered += span;
      if (i > 0) {
        expect(calls[i].from).toBe(calls[i - 1].to + 1n); // no gaps, no overlaps
      }
    }
    expect(covered).toBe(to - from + 1n); // every block exactly once
    // The same coverage the 10-block floor gives, in ~1/100th of the requests.
    const floorChunks = planLogScan({ from, to }).length;
    expect(calls.length).toBeLessThan(floorChunks / 50);
    expect(r.logs.map((l) => l.blockNumber)).toEqual(blocks); // boundary events intact
  });

  it("shrinks on a range refusal WITHOUT skipping or re-requesting a block", async () => {
    const blocks = [100n, 1_005n, 1_999n];
    const { calls, fetchChunk } = mock(blocks, { rangeErrorAt: 1 });
    const shrinks: Array<{ from: bigint; to: bigint }> = [];
    const r = await runAdaptiveLogScan({
      fetchChunk,
      from: 100n,
      to: 1_999n,
      chunkSize: 1_000n,
      onShrink: (s) => shrinks.push({ from: s.from, to: s.to }),
    });
    expect(shrinks).toEqual([{ from: 1_000n, to: 500n }]);
    // The retried chunk restarts at the SAME block, so nothing is skipped.
    expect(calls[0]).toEqual({ from: 100n, to: 1_099n });
    expect(calls[1]).toEqual({ from: 100n, to: 599n });
    expect(calls[1].from).toBe(calls[0].from);
    let covered = 0n;
    const served = calls.slice(1); // the refused request returned nothing
    for (let i = 0; i < served.length; i++) {
      covered += served[i].to - served[i].from + 1n;
      if (i > 0) expect(served[i].from).toBe(served[i - 1].to + 1n);
    }
    expect(covered).toBe(1_900n); // complete coverage of 100..1999
    expect(r.logs.map((l) => l.blockNumber)).toEqual(blocks);
    expect(r.chunks).toBe(BigInt(served.length));
    expect(r.shrinks).toHaveLength(1);
  });

  it("never retries the same oversized width indefinitely", async () => {
    const { calls, fetchChunk } = mock([], { floorErrors: true });
    const err = await runAdaptiveLogScan({ fetchChunk, from: 100n, to: 10_000n, chunkSize: 1_000n }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/refusing to certify a one-shot from a partial scan/);
    // 1000 -> 500 -> 250 -> 125 -> 62 -> 31 -> 15 -> 10, then fail closed.
    expect(calls.length).toBeLessThanOrEqual(9);
    const widths = calls.map((c) => c.to - c.from + 1n);
    expect(new Set(widths.map(String)).size).toBe(widths.length); // no width requested twice
    expect(calls.every((c) => c.from === 100n)).toBe(true); // it never advanced on a refusal
  });

  it("fails closed on a non-range error and on a non-array result", async () => {
    const rejecting = () => Promise.reject(Object.assign(new Error("Too Many Requests"), { status: 429 }));
    await expect(runAdaptiveLogScan({ fetchChunk: rejecting, from: 100n, to: 200n })).rejects.toThrow(/refusing to certify a one-shot from a partial scan/);
    await expect(
      runAdaptiveLogScan({ fetchChunk: () => Promise.resolve({ nope: true } as never), from: 100n, to: 200n }),
    ).rejects.toThrow(/non-array result/);
  });

  it("enforces the chunk and block budgets BEFORE the first request", async () => {
    const { calls, fetchChunk } = mock();
    await expect(runAdaptiveLogScan({ fetchChunk, from: 100n, to: 10_000n, maxChunks: 5n })).rejects.toThrow(/refusing to certify a one-shot from a partial scan/);
    expect(calls).toEqual([]);
    await expect(
      runAdaptiveLogScan({ fetchChunk, from: 100n, to: 100n + MAX_LOG_SCAN_BLOCKS, chunkSize: 1_000n, maxBlocks: MAX_LOG_SCAN_BLOCKS }),
    ).rejects.toThrow(/refusing to certify a one-shot from a partial scan/);
    expect(calls).toEqual([]);
    // The block budget is unchanged by adaptive chunking: 400 000 x the floor.
    expect(MAX_LOG_SCAN_BLOCKS).toBe(4_000_000n);
    expect(MAX_LOG_SCAN_BLOCKS).toBe(400_000n * LOG_CHUNK);
    expect(runnerSource).toContain("maxBlocks: MAX_LOG_SCAN_BLOCKS");
    expect(runnerSource).toContain("maxChunks: MAX_LOG_CHUNKS");
    expect(runnerSource).toContain("if (chunks > MAX_LOG_CHUNKS)");
  });
});

// ---------------------------------------------------------------------------
describe("the historical scan filters the pinned wallet as an indexed topic", () => {
  // The event exactly as deployed (contracts/executor/MPGRExecutorDelegated.sol,
  // RouterKind is a uint8 enum) — independently re-hashed here so a drift in the
  // pinned signature fails the suite instead of silently narrowing the scan.
  const SWAP_EXECUTED_ABI = {
    type: "event",
    name: "SwapExecuted",
    inputs: [
      { name: "taker", type: "address", indexed: true },
      { name: "router", type: "address", indexed: true },
      { name: "intentId", type: "bytes32", indexed: true },
      { name: "tokenIn", type: "address", indexed: false },
      { name: "tokenOut", type: "address", indexed: false },
      { name: "grossAmountIn", type: "uint256", indexed: false },
      { name: "feeAmount", type: "uint256", indexed: false },
      { name: "swapAmountIn", type: "uint256", indexed: false },
      { name: "amountOut", type: "uint256", indexed: false },
      { name: "feeRecipient", type: "address", indexed: false },
      { name: "feeBps", type: "uint16", indexed: false },
      { name: "routerKind", type: "uint8", indexed: false },
      { name: "flags", type: "uint8", indexed: false },
    ],
  } as const;

  it("pins topic0 to the deployed event signature", () => {
    expect(SWAP_EXECUTED_EVENT_SIGNATURE).toBe(
      "SwapExecuted(address,address,bytes32,address,address,uint256,uint256,uint256,uint256,address,uint16,uint8,uint8)",
    );
    expect(SWAP_EXECUTED_TOPIC).toBe(keccak256(toHex(SWAP_EXECUTED_EVENT_SIGNATURE)));
    expect(SWAP_EXECUTED_TOPIC).toBe(getEventSelector(SWAP_EXECUTED_ABI));
  });

  it("left-pads the pinned wallet into topic1", () => {
    expect(takerTopicFor(SIGNER)).toBe(pad(SIGNER.toLowerCase() as `0x${string}`, { size: 32 }));
    expect(takerTopicFor(SIGNER.toLowerCase())).toBe(takerTopicFor(SIGNER));
    expect(() => takerTopicFor("0xnope")).toThrow();
  });

  it("builds the RPC filter: executor + event topic + indexed taker, and nothing narrower", () => {
    const f = swapExecutedLogFilter({ wallet: SIGNER, fromBlock: 100n, toBlock: 109n });
    expect(f.address).toBe(DELEGATED_EXECUTOR);
    expect(f.topics).toEqual([SWAP_EXECUTED_TOPIC, takerTopicFor(SIGNER)]);
    // Wire-ready: exactly the JSON-RPC params an eth_getLogs call takes.
    expect(Object.keys(f).sort()).toEqual(["address", "fromBlock", "toBlock", "topics"]);
    expect(f.fromBlock).toBe("0x64");
    expect(f.toBlock).toBe("0x6d");
    // router and intentId are deliberately NOT filtered: a prior swap through any
    // venue or under any intent must still refuse the run.
    expect(f.topics).toHaveLength(2);
    expect(() => swapExecutedLogFilter({ wallet: SIGNER, fromBlock: 100n, toBlock: 99n })).toThrow();
    expect(() => swapExecutedLogFilter({ wallet: SIGNER, fromBlock: 0n, toBlock: MAX_SAFE_LOG_CHUNK })).toThrow(/verified/);
    expect(swapExecutedLogFilter({ wallet: SIGNER, fromBlock: 0n, toBlock: MAX_SAFE_LOG_CHUNK - 1n }).topics).toHaveLength(2);
  });

  it("puts those topics on the wire in the actual eth_getLogs request", async () => {
    const seen: unknown[] = [];
    const transport = custom({
      request: async (args: { method: string; params?: unknown }) => {
        seen.push(args);
        if (args.method === "eth_getLogs") return [];
        return null;
      },
    });
    const pub = createPublicClient({ transport });
    // Exactly what the runner does: the filter is the eth_getLogs parameter object.
    await pub.request({ method: "eth_getLogs", params: [swapExecutedLogFilter({ wallet: SIGNER, fromBlock: 100n, toBlock: 109n })] });
    expect(seen).toHaveLength(1);
    const [req] = seen as Array<{ method: string; params: Array<Record<string, unknown>> }>;
    expect(req.method).toBe("eth_getLogs");
    expect(req.params[0].address).toBe(DELEGATED_EXECUTOR);
    expect(req.params[0].topics).toEqual([SWAP_EXECUTED_TOPIC, takerTopicFor(SIGNER)]);
    expect(req.params[0].fromBlock).toBe("0x64");
    expect(req.params[0].toBlock).toBe("0x6d");
  });

  it("is what the runner sends, and the runner still re-checks the taker locally", () => {
    expect(runnerSource).toContain("params: [swapExecutedLogFilter({ wallet, fromBlock, toBlock, maxChunk: MAX_LOG_CHUNK })],");
    expect(runnerSource).toContain('method: "eth_getLogs",');
    expect(runnerSource).toContain("const decoded = parseEventLogs({ abi: DELEGATED_ABI, logs });");
    expect(runnerSource).toContain("if (!sameAddress(log.args?.taker, wallet))");
    expect(runnerSource).toMatch(/refusing to certify a one-shot from an endpoint that ignores its log filter/);
    // The pinned wallet is a topic of the readiness probe too.
    expect(runnerSource).toContain("params: [swapExecutedLogFilter({ wallet, fromBlock, toBlock })],");
  });
});

// ---------------------------------------------------------------------------
describe("what this fix must NOT change", () => {
  it("reads no private key in preflight, and none anywhere in the RPC/scan path", () => {
    // The key is read only in the live branch, from the single env var.
    expect(runnerSource.match(/readLiveKey\(\)/g)?.length).toBe(2);
    expect(runnerSource).toContain("ownerAccount = { address: pin.address }; // read-only: no signer, no key");
    // The readiness gate and the scan take a public client and an address only.
    expect(runnerSource).toContain("async function probeRpcReadiness(pub, wallet) {");
    expect(runnerSource).toContain("async function countPriorSwapEvents(pub, wallet) {");
    expect(gatesSource).not.toMatch(/process\.env/);
    expect(gatesSource).not.toMatch(/privateKeyToAccount|signTypedData|signMessage/);
  });

  it("introduces no broadcast, approval or write capability", () => {
    expect(gatesSource.match(/eth_sendRawTransaction|eth_sendTransaction|sendTransaction\(|writeContract\(|approve\(/g)).toBeNull();
    expect(runnerSource.match(/writeContract\(/g)?.length).toBe(1);
    expect(runnerSource.match(/eth_sendRawTransaction/g)?.length).toBe(1); // the pre-existing idempotency guard
    // The runner never *calls* an approval; it only ever READS allowances. The
    // one-time USDC->Permit2 approval stays a separate manual operator action.
    expect(runnerSource).not.toMatch(/functionName:\s*"approve"/);
    expect(runnerSource).not.toMatch(/encodeFunctionData\(\{[^}]*"approve"/);
    expect(runnerSource).toContain("report.broadcastCount += 1");
  });

  it("leaves the LIVE gate exactly as it was", () => {
    // Every live row is still evaluated, and still blocking.
    const live = evaluateLivePreconditions({ chainId: CHAIN_ID });
    expect(live.checks.length).toBeGreaterThan(20);
    expect(live.blockers.length).toBeGreaterThan(0);
    expect(runnerSource).toContain("applyGate(evaluateLivePreconditions(");
    expect(runnerSource).toContain("const failed = blockingFailures(report.checks);");
    // The confirmation phrase, the one-shot ledger and the exact amount pins.
    expect(LIVE_CONFIRM_PHRASE).toBe("smoke-delegated-base-mainnet");
    expect(runnerSource).toContain('const CONFIRM_PHRASE = env("SMOKE_DELEGATED_CONFIRM");');
    expect(runnerSource).toContain("confirmedPhrase: CONFIRM_PHRASE");
    expect(GROSS_AMOUNT_IN).toBe(500_000n);
    expect(EXPECTED_FEE_AMOUNT).toBe(1_250n);
    expect(SWAP_AMOUNT_IN).toBe(498_750n);
    expect(REQUIRED_PERMIT2_TOKEN_ALLOWANCE).toBe(500_000n);
    // The rehearsal-only note mechanism is untouched and still rehearsal-only.
    expect(runnerSource).toMatch(/if \(!REHEARSAL\) \{\s*\n\s*throw new Abort\(`internal: rehearsalNote/);
  });
});
