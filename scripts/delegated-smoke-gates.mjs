#!/usr/bin/env node
// scripts/delegated-smoke-gates.mjs
//
// PURE SAFETY GATES for the dedicated MPGRExecutorDelegated Base Mainnet
// smoke/canary (script/smoke-delegated-executor-base-mainnet.mjs).
//
// Why a separate module: every decision that can lead to a signed
// transaction lives here, as a pure function over injected facts. No file
// system, no network, no clock, no key material. That makes the whole gate
// table exhaustively testable OFFLINE (scripts/delegated-smoke-gates.test.ts)
// and keeps the runner a thin "read facts -> ask the gates -> act" loop.
//
// Scope (deliberately narrow):
//   * target: MPGRExecutorDelegated on Base Mainnet — NEVER MPGRExecutor v1;
//   * route:  USDC -> WETH on the official Base Uniswap V3 SwapRouter02,
//             exactly the route pinned by the repository configuration
//             (deployments/base-mainnet/delegated-deploy-config.json and the
//             8453 entry of lib/executor/executor-config.ts);
//   * auth:   the DELEGATED path — a user-signed Permit2 witness permit
//             (permitWitnessTransferFrom) redeemed by swapOnBehalfOfUniswapV3.
//             No ERC-20 approval is taken, requested or tolerated;
//   * amount: the smallest amount that is still safe to settle (see
//             GROSS_AMOUNT_IN below);
//   * one-shot: a deterministic single-use Permit2 nonce + an on-chain
//             SwapExecuted scan + an exclusively-created local ledger.
//
// Nothing in this file deploys, approves, signs or broadcasts anything.

import { encodeAbiParameters, getAddress, isAddress, keccak256, toHex } from "viem";

// ---------------------------------------------------------------------------
// Deployment facts — the verified Base Mainnet MPGRExecutorDelegated.
//
// Source of truth: the latest deployment report of
// .github/workflows/deploy-delegated-base-mainnet.yml (run 37472605485,
// "MPGRExecutorDelegated Base Mainnet deployment report"), whose predicted
// CREATE address is pinned in scripts/delegated-mainnet-deployment-guard.mjs
// as EXPECTED_EXECUTOR and was confirmed by the mined receipt. The same facts
// are re-derived here from the committed reviewed config and are re-checked
// LIVE at runtime by the runner (fail-closed); nothing is ever guessed.
// ---------------------------------------------------------------------------

export const CHAIN_ID = 8453;
export const NETWORK_LABEL = "Base Mainnet";
export const EXPLORER = "https://basescan.org";

/** The verified deployment: CREATE(0x954B…, 0) == 0x39B1…32Bb. */
export const DELEGATED_EXECUTOR = getAddress("0x39B1C6Ea88A01e70cbF4899BF3cEfB2c43cD32Bb");
export const DELEGATED_DEPLOYER = getAddress("0x954BFdf0b3A262D537c825a40F7ba960830be88A");
export const DELEGATED_DEPLOY_TX = "0xef46dc42e5513bb7aab3b79b55d79efc2fdca0c77e3db47220186801a094511b";
export const DELEGATED_DEPLOY_BLOCK = 52252520n;
export const DEPLOYMENT_RECORD_PATH = "deployments/base-mainnet/mpgr-executor-delegated.json";
export const REVIEWED_CONFIG_PATH = "deployments/base-mainnet/delegated-deploy-config.json";

/** The EVM null address (used for the pending-owner and swap-module posture). */
export const ZERO_ADDRESS = getAddress("0x0000000000000000000000000000000000000000");

/** Governance/role pins shared with the reviewed config. */
export const OWNER = getAddress("0xE0e0d239853c5F2Fe0a524d544eC9eB71fef486e");
export const FEE_RECIPIENT = getAddress("0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4");
export const FEE_BPS = 25n;
export const MAX_FEE_BPS = 100n;
export const BPS_DENOMINATOR = 10_000n;

/** Canonical Base infrastructure. */
export const CANONICAL_WETH = getAddress("0x4200000000000000000000000000000000000006");
export const CANONICAL_PERMIT2 = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
export const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
export const USDC_DECIMALS = 6;
export const WETH_DECIMALS = 18;

/** The intended venue for USDC <-> WETH: official Base Uniswap V3 (kind 2). */
export const UNISWAP_V3_ROUTER = getAddress("0x2626664c2603336E57B271c5C0b26F421741e481");
export const UNISWAP_V3_QUOTER = getAddress("0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a");
export const UNISWAP_V3_FACTORY = getAddress("0x33128a8fC17869897dcE68Ed026d694621f6FDfD");
export const UNISWAP_V3_POOL = getAddress("0x6c561B446416E1A00E8E93E221854d6eA4171372");
export const UNISWAP_V3_POOL_FEE = 3000;
/** MPGRExecutorDelegated.RouterKind.UNISWAP_V3_ROUTER02 */
export const ROUTER_KIND_UNISWAP_V3 = 2;
/** MPGRExecutorDelegated.RouterKind.AERODROME_SLIPSTREAM (the venue we must NOT use). */
export const ROUTER_KIND_SLIPSTREAM = 1;

/** Mirrors MPGRExecutorDelegated.WITNESS_TYPE_STRING / ACTION_WITNESS_*. */
export const WITNESS_TYPE_STRING =
  "ActionWitness witness)ActionWitness(address owner,address buyToken,uint256 minAmountOut,uint256 deadline,bytes32 actionId,bytes32 policyHash)TokenPermissions(address token,uint256 amount)";
export const ACTION_WITNESS_STRUCT_TYPE_STRING =
  "ActionWitness(address owner,address buyToken,uint256 minAmountOut,uint256 deadline,bytes32 actionId,bytes32 policyHash)";
export const ACTION_WITNESS_TYPEHASH = keccak256(toHex(ACTION_WITNESS_STRUCT_TYPE_STRING));
/** Permit2's cached EIP-712 domain ("Permit2", chainId, verifyingContract). */
export const PERMIT2_DOMAIN_NAME = "Permit2";

/** The delegated entrypoint this canary must exercise (selector of the real signature). */
export const SWAP_ON_BEHALF_OF_UNISWAP_V3_SELECTOR = "0x9d5fea22";
export const SWAP_ON_BEHALF_OF_SLIPSTREAM_SELECTOR = "0x710a9231";
export const SWAP_ON_BEHALF_OF_TYPED_MODULE_SELECTOR = "0x1360cb87";

// ---------------------------------------------------------------------------
// The one thing this script does: a single BUY of the smallest safe amount.
// ---------------------------------------------------------------------------

/**
 * GROSS_AMOUNT_IN = 0.50 USDC (500 000 raw, 6 decimals) — the SMALLEST SAFE
 * canary size, chosen deterministically rather than copied from the v1 smoke
 * test (1.00 USDC). "Safe" here means every one of these holds:
 *   1. the exact 25 bps fee must not round to zero — MPGRExecutorDelegated
 *      reverts `FeeRoundsToZero` when feeBps != 0 and floor(gross * 25/10000)
 *      == 0, so gross >= 400 raw; 500 000 gives an exact, unambiguous
 *      1 250 raw fee (0.00125 USDC) that is large enough to verify from
 *      Transfer logs at block precision;
 *   2. the output must be well above dust so the minOut floor is meaningful
 *      (~1.8e14 wei of WETH at current prices, i.e. 5 orders of magnitude
 *      above the 1 wei rounding floor);
 *   3. exposure stays far below the v1 canary (0.50 USDC ≈ $0.50) while still
 *      moving real value through the real 0.30% pool;
 *   4. gas cost stays a small fraction of the traded value so a revert is
 *      still a cheap, informative canary signal.
 * It is a constant on purpose: a knob an operator can turn is a knob that
 * gets turned. A different size is a different campaign, in review.
 */
export const GROSS_AMOUNT_IN = 500_000n;
export const EXPECTED_FEE_AMOUNT = (GROSS_AMOUNT_IN * FEE_BPS) / BPS_DENOMINATOR; // 1 250
export const SWAP_AMOUNT_IN = GROSS_AMOUNT_IN - EXPECTED_FEE_AMOUNT; // 498 750

/** Slippage floor applied to a FRESH quote, in bps (1.00%). */
export const SLIPPAGE_BPS = 100n;
/** How long a signed authorization stays valid (short on purpose). */
export const DEADLINE_SECONDS = 300n;
/** A live step needs at least this much time left before the deadline. */
export const MIN_DEADLINE_MARGIN_SECONDS = 90n;

/**
 * Quote sanity band for SWAP_AMOUNT_IN (0.49875 USDC) of WETH, expressed as
 * the implied ETH price it tolerates: $500 .. $20 000. Catches an inverted
 * pair, a wrong pool, a wrong token or a broken quoter without ever rejecting
 * a legitimate market move.
 */
export const QUOTE_MIN_WEI = 24_937_500_000_000n; // 0.49875 / 20000 ETH
export const QUOTE_MAX_WEI = 997_500_000_000_000n; // 0.49875 / 500 ETH

/** Gas guards (Base normally runs at ~0.005–0.05 gwei). */
export const MAX_FEE_PER_GAS_CAP = 1_000_000_000n; // 1 gwei hard cap on what we sign
export const PRIORITY_FEE_CAP = 50_000_000n; // 0.05 gwei tip cap
export const EXPECTED_GAS_LIMIT = 900_000n; // generous upper bound for one delegated swap
export const MAX_L2_COST_PER_TX_WEI = 300_000_000_000_000n; // 0.0003 ETH
export const L1_FEE_MARGIN_WEI = 5_000_000_000_000n; // L1 data-cost allowance

// ---------------------------------------------------------------------------
// Wallet identity: a FRESH dedicated smoke wallet, and everything it may
// never be. The denylist is data-driven so a new deployment/role can only ever
// be added, never silently dropped.
// ---------------------------------------------------------------------------

/** The v1 smoke/test wallet — reuse of it is a hard failure, by policy. */
export const V1_SMOKE_WALLET = getAddress("0xB54900f2c355CB0A61c62f8220191D3aAA6f4455");
/** The Phase-5/6 one-shot mainnet canary wallet — also never reusable. */
export const PHASE5_CANARY_WALLET = getAddress("0xBF6c574b9543967f0D528ae49603b0A7574a280b");
/** The v1 (assisted) mainnet executor: structurally incapable of delegated execution. */
export const V1_MAINNET_EXECUTOR = getAddress("0xD982726e28275661F8aB64054E6b17a70a63505A");
/** The Base Sepolia delegated executor (testnet contract, must never be a mainnet target). */
export const SEPOLIA_DELEGATED_EXECUTOR = getAddress("0xa9568499D7e58854F2590a56B6D32788DbfA58F9");
export const SEPOLIA_V1_EXECUTOR = getAddress("0xDFcB00fB1Fe83A6333302E55E23feCF6884376C4");

/**
 * Addresses the smoke wallet may never be, with the reason reported on a hit.
 * Keyed lowercase. Includes every role address and every infrastructure
 * address involved in the trade (an address that is also a router/token/permit2
 * is a configuration error by definition).
 */
export const FORBIDDEN_SIGNERS = Object.freeze({
  [V1_SMOKE_WALLET.toLowerCase()]: "the v1 smoke-test wallet (reuse is forbidden — a fresh dedicated wallet is required)",
  [PHASE5_CANARY_WALLET.toLowerCase()]: "the Phase-5/6 mainnet canary wallet (already spent; one-shot by design)",
  [DELEGATED_DEPLOYER.toLowerCase()]: "the delegated deployment key (deployment-only, never a trader)",
  [OWNER.toLowerCase()]: "the executor owner (governance key, never a broadcaster)",
  [FEE_RECIPIENT.toLowerCase()]: "the fee recipient (must receive the fee, never pay it)",
  [DELEGATED_EXECUTOR.toLowerCase()]: "the delegated executor itself (a contract cannot be the signer)",
  [V1_MAINNET_EXECUTOR.toLowerCase()]: "the v1 executor",
  [SEPOLIA_DELEGATED_EXECUTOR.toLowerCase()]: "the Base Sepolia delegated executor",
  [SEPOLIA_V1_EXECUTOR.toLowerCase()]: "the Base Sepolia v1 executor",
  [CANONICAL_PERMIT2.toLowerCase()]: "Permit2",
  [UNISWAP_V3_ROUTER.toLowerCase()]: "the Uniswap V3 SwapRouter02",
  [UNISWAP_V3_QUOTER.toLowerCase()]: "the Uniswap V3 QuoterV2",
  [UNISWAP_V3_FACTORY.toLowerCase()]: "the Uniswap V3 factory",
  [UNISWAP_V3_POOL.toLowerCase()]: "the Uniswap V3 USDC/WETH pool",
  [USDC.toLowerCase()]: "USDC",
  [CANONICAL_WETH.toLowerCase()]: "WETH",
  [ZERO_ADDRESS.toLowerCase()]: "the zero address",
});

/** Environment variable names (secrets are only ever read from the environment). */
export const KEY_ENV = "SMOKE_DELEGATED_PRIVATE_KEY";
export const WALLET_PIN_ENV = "SMOKE_DELEGATED_WALLET_ADDRESS";
export const RPC_ENV = "SMOKE_DELEGATED_RPC_URL";
export const MODE_ENV = "SMOKE_DELEGATED_MODE";
export const CODE_HASH_PIN_ENV = "SMOKE_DELEGATED_EXPECTED_CODE_HASH";
export const LEDGER_DIR_ENV = "SMOKE_DELEGATED_LEDGER_DIR";
export const LEDGER_ACK_ENV = "SMOKE_DELEGATED_LEDGER_ACK";
export const EMERGENCY_ENV = "MPGR_AUTONOMOUS_EMERGENCY_DISABLE";
/** The exact phrase a live dispatch must echo (mirrors the v1/deploy conventions). */
export const LIVE_CONFIRM_PHRASE = "smoke-delegated-base-mainnet";

export const MODES = Object.freeze({ REHEARSAL: "rehearsal", PREFLIGHT: "preflight", LIVE: "live" });

/** One-shot ledger identity: one file per (campaign, chain, wallet). */
export const CAMPAIGN = "mpgr-delegated-smoke-8453-v1";
export const LEDGER_VERSION = 1;
export const LEDGER_DIR = ".mpgr-delegated-smoke";

/** Log-scan chunk size for the historical SwapExecuted scan. */
export const LOG_CHUNK = 2_000n;

/**
 * Rehearsal-only bound for the historical SwapExecuted scan.
 *
 * `live`/`preflight` certify the one-shot guard against the REAL chain, so they
 * scan every block from the deployment to the observed head. `rehearsal` runs
 * against a LOCAL anvil fork whose pre-fork history is not local: a full scan
 * would push hundreds of chunked eth_getLogs calls at the fork's upstream, and
 * public Base endpoints cap how many blocks one eth_getLogs call may span
 * (Alchemy's Base free tier caps it at 10). The fork-only principals are
 * derived from public labels and cannot have real history, and the fork's own
 * broadcasts can only live in its most recent blocks — so the rehearsal scans
 * the last 10 blocks of the fork, which any upstream serves in one call.
 */
export const REHEARSAL_LOG_WINDOW = 10n;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : value;
}

/** Address equality that never throws on garbage input. */
export function sameAddress(a, b) {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    isAddress(a) &&
    isAddress(b) &&
    a.toLowerCase() === b.toLowerCase()
  );
}

/** Accepts only a checksum-parseable address; returns { ok, address, detail }. */
export function normalizeAddress(value, label = "address") {
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, address: null, detail: `${label} is missing or empty` };
  }
  const trimmed = value.trim();
  if (!isAddress(trimmed)) {
    return { ok: false, address: null, detail: `${label} is not a valid address` };
  }
  return { ok: true, address: getAddress(trimmed), detail: getAddress(trimmed) };
}

/** A 32-byte hex private key and nothing else (never logged, never returned in detail). */
export function isPrivateKeyShape(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value.trim());
}

export function isBytes32(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

/** Removes every secret substring from any text before it can be reported. */
export function redact(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 8) continue;
    out = out.split(secret).join("<redacted>");
  }
  return out;
}

/** True only for a loopback RPC (the fork/practice endpoint). */
export function isLocalRpc(url) {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

function bigintOf(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

/**
 * The inclusive block window the historical SwapExecuted scan must cover.
 *
 * `live`/`preflight`: the deployment block -> observed head, i.e. the full
 * one-shot certification. `rehearsal`: the last `window` blocks of the local
 * fork (never reaching back before the deployment block), so the fork never
 * pulls pre-fork history from its upstream — see REHEARSAL_LOG_WINDOW.
 */
export function priorSwapScanWindow({ head, deployBlock = DELEGATED_DEPLOY_BLOCK, rehearsal = false, window = REHEARSAL_LOG_WINDOW }) {
  const start = rehearsal ? head - window + 1n : deployBlock;
  return { from: start > deployBlock ? start : deployBlock, to: head };
}

// ---------------------------------------------------------------------------
// Deterministic canary identity (actionId / policyHash / single-use nonce)
// ---------------------------------------------------------------------------

/**
 * Deterministic identity for the one canary trade of ONE wallet.
 *
 * The Permit2 nonce is derived from the wallet and the campaign tag, so the
 * SAME wallet can only ever redeem THIS authorization once: after the first
 * successful swap the Permit2 unordered-nonce bit is set and a replay reverts
 * on-chain. Re-running the canary therefore requires a NEW wallet (or a
 * reviewed NEW campaign tag) — never a re-sign of the same one.
 */
export function canaryIdentityFor(wallet) {
  const pin = normalizeAddress(wallet, "smoke wallet");
  if (!pin.ok) throw new Error(`canaryIdentityFor: ${pin.detail}`);
  const w = pin.address.toLowerCase();
  const actionId = keccak256(toHex(`mpgr-delegated-action:${CAMPAIGN}:${w}`));
  const policyHash = keccak256(toHex(`mpgr-delegated-smoke-policy:${CAMPAIGN}:${w}`));
  const permitNonce = BigInt(keccak256(toHex(`mpgr-delegated-nonce:${CAMPAIGN}:${w}`))).toString();
  return { actionId, intentId: actionId, policyHash, permitNonce };
}

/** The Permit2 bitmap word index and bit for a nonce. */
export function nonceBitPosition(permitNonce) {
  const nonce = bigintOf(permitNonce);
  if (nonce === null || nonce < 0n) return null;
  return { wordIndex: nonce >> 8n, bit: 1n << (nonce & 0xffn) };
}

/** Does `bitmapWord` (a uint256) mark the nonce as already used? */
export function nonceBitmapWordMarks(bitmapWord, permitNonce) {
  const pos = nonceBitPosition(permitNonce);
  const word = bigintOf(bitmapWord);
  if (!pos || word === null) return null;
  return (word & pos.bit) !== 0n;
}

// ---------------------------------------------------------------------------
// Fee / quote / authorization math (integer only)
// ---------------------------------------------------------------------------

/** floor(gross * feeBps / 10000) split, exactly as MPGRExecutorDelegated computes it. */
export function feeSplit(gross, feeBps = FEE_BPS) {
  const g = bigintOf(gross);
  const bps = bigintOf(feeBps);
  if (g === null || bps === null || g <= 0n || bps < 0n) return null;
  const fee = (g * bps) / BPS_DENOMINATOR;
  return { fee, swapAmount: g - fee };
}

/** The signed slippage floor for a fresh quote. */
export function minOutFromQuote(quote, slippageBps = SLIPPAGE_BPS) {
  const q = bigintOf(quote);
  const s = bigintOf(slippageBps);
  if (q === null || s === null || s >= BPS_DENOMINATOR) return null;
  return (q * (BPS_DENOMINATOR - s)) / BPS_DENOMINATOR;
}

export function quoteWithinSanityBand(quote) {
  const q = bigintOf(quote);
  if (q === null) return { ok: false, detail: "no quote" };
  return {
    ok: q >= QUOTE_MIN_WEI && q <= QUOTE_MAX_WEI,
    detail: `${q} wei (band ${QUOTE_MIN_WEI}..${QUOTE_MAX_WEI}; implied ETH $500..$20000)`,
  };
}

/**
 * The `witnessHashOf` preimage the deployed contract hashes: keccak256(
 * abi.encode(ACTION_WITNESS_TYPEHASH, owner, buyToken, minAmountOut,
 * deadline, actionId, policyHash)). Proven against the LIVE contract in the
 * runner — a mismatch means the local EIP-712 encoding diverges from the
 * deployed one and nothing may be signed.
 */
export function actionWitnessHash(witness) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        ACTION_WITNESS_TYPEHASH,
        witness.owner,
        witness.buyToken,
        bigintOf(witness.minAmountOut),
        bigintOf(witness.deadline),
        witness.actionId,
        witness.policyHash,
      ],
    ),
  );
}

/** Builds the exact ActionWitness for this campaign. */
export function buildActionWitness({ owner, minAmountOut, deadline, actionId, policyHash }) {
  return {
    owner: getAddress(owner),
    buyToken: CANONICAL_WETH,
    minAmountOut: String(minAmountOut),
    deadline: Number(bigintOf(deadline)),
    actionId,
    policyHash,
  };
}

/** The client-side EIP-712 payload the smoke wallet signs (standard wallet form). */
export function buildPermitTypedData({ permit, witness }, chainId = CHAIN_ID, spender = DELEGATED_EXECUTOR) {
  if (chainId !== CHAIN_ID) {
    // The delegated permit is chain-bound; a foreign chain id can only be a
    // misconfiguration, and signing it would be signing something unusable.
    throw new Error(`buildPermitTypedData: refusing chain ${chainId} (only ${CHAIN_ID} is in scope)`);
  }
  return {
    domain: { name: PERMIT2_DOMAIN_NAME, chainId, verifyingContract: CANONICAL_PERMIT2 },
    primaryType: "PermitWitnessTransferFrom",
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      PermitWitnessTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "witness", type: "ActionWitness" },
      ],
      ActionWitness: [
        { name: "owner", type: "address" },
        { name: "buyToken", type: "address" },
        { name: "minAmountOut", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "actionId", type: "bytes32" },
        { name: "policyHash", type: "bytes32" },
      ],
    },
    message: {
      permitted: { token: permit.token, amount: BigInt(permit.amount) },
      spender,
      nonce: BigInt(permit.nonce),
      deadline: BigInt(permit.deadline),
      witness: {
        owner: witness.owner,
        buyToken: witness.buyToken,
        minAmountOut: BigInt(witness.minAmountOut),
        deadline: BigInt(witness.deadline),
        actionId: witness.actionId,
        policyHash: witness.policyHash,
      },
    },
  };
}

/** The SwapParams tuple for swapOnBehalfOfUniswapV3 (recipient == owner). */
export function buildSwapParams({ owner, quoteMinOut, deadline, actionId }) {
  const split = feeSplit(GROSS_AMOUNT_IN);
  if (!split || split.fee !== EXPECTED_FEE_AMOUNT || split.swapAmount !== SWAP_AMOUNT_IN) {
    throw new Error("buildSwapParams: fee split diverges from the pinned campaign constants");
  }
  return {
    router: UNISWAP_V3_ROUTER,
    tokenIn: USDC,
    tokenOut: CANONICAL_WETH,
    grossAmountIn: GROSS_AMOUNT_IN,
    expectedFeeAmount: EXPECTED_FEE_AMOUNT,
    amountOutMinimum: bigintOf(quoteMinOut),
    recipient: getAddress(owner), // MUST equal witness.owner — enforced on-chain
    deadline: bigintOf(deadline),
    intentId: actionId,
    unwrapNativeOut: false, // WETH stays WETH: no native unwrap in the canary
  };
}

/** The `auth` argument: permit + witness + signature (viem-shaped). */
export function buildPermit2Authorization({ owner, permit, witness, signature }) {
  return {
    permit: {
      permitted: { token: permit.token, amount: BigInt(permit.amount) },
      nonce: BigInt(permit.nonce),
      deadline: BigInt(permit.deadline),
    },
    witness: {
      owner: getAddress(owner),
      buyToken: witness.buyToken,
      minAmountOut: BigInt(witness.minAmountOut),
      deadline: BigInt(witness.deadline),
      actionId: witness.actionId,
      policyHash: witness.policyHash,
    },
    signature,
  };
}

/**
 * True when `code` contains a Solidity dispatch entry for `selector`
 * (`PUSH4 <selector> … EQ`). Used only to prove the deployed executor exposes
 * the DELEGATED entrypoint — the authoritative check is the simulation.
 */
export function codeDispatchesSelector(code, selector) {
  if (typeof code !== "string" || !/^0x[0-9a-fA-F]+$/.test(code)) return false;
  const needle = `63${selector.replace(/^0x/, "").toLowerCase()}`;
  const hay = code.slice(2).toLowerCase();
  return hay.includes(needle);
}

// ---------------------------------------------------------------------------
// Mode + environment guards (run before ANY network access)
// ---------------------------------------------------------------------------

/**
 * Decides whether the requested mode is allowed to proceed, and — for live —
 * whether the environment is even eligible. Pure: everything is injected.
 */
export function evaluateModeGuard({ mode, rpcUrls, keyEnvValue, walletPinEnvValue, githubActions, emergencyDisabled }) {
  const urls = Array.isArray(rpcUrls) ? rpcUrls.filter((u) => typeof u === "string" && u.length > 0) : [];
  const checks = [];
  const push = (name, ok, detail = "", fatal = true) => checks.push({ stage: "0. environment", name, ok: Boolean(ok), detail: String(detail), fatal });

  push("SMOKE_DELEGATED_MODE is one of rehearsal|preflight|live", mode === MODES.REHEARSAL || mode === MODES.PREFLIGHT || mode === MODES.LIVE, `got '${mode ?? ""}'`);
  push("at least one RPC endpoint is configured", urls.length > 0, `${urls.length} endpoint(s)`);
  push("the emergency kill switch is not set", emergencyDisabled !== true, emergencyDisabled === true ? `${EMERGENCY_ENV}=true` : "unset");

  if (mode === MODES.REHEARSAL) {
    push("rehearsal uses exactly ONE local anvil RPC", urls.length === 1 && isLocalRpc(urls[0]), urls.join(", ") || "none");
    push("rehearsal needs no private key", keyEnvValue === undefined || keyEnvValue === "", keyEnvValue ? `${KEY_ENV} is set — rehearsal must run keyless` : "keyless");
    push("rehearsal uses synthetic principals only", true, "owner + broadcaster are fork-only derived accounts");
  } else if (mode === MODES.PREFLIGHT) {
    push("preflight RPC is NOT a local fork (it audits real mainnet state)", urls.every((u) => !isLocalRpc(u)), urls.join(", "));
    push("preflight reads no private key", keyEnvValue === undefined || keyEnvValue === "", keyEnvValue ? `${KEY_ENV} is set — preflight ignores it (read-only mode)` : "keyless");
    push(`${WALLET_PIN_ENV} is a valid address`, normalizeAddress(walletPinEnvValue, WALLET_PIN_ENV).ok, normalizeAddress(walletPinEnvValue, WALLET_PIN_ENV).detail);
  } else if (mode === MODES.LIVE) {
    push("live runs only inside GitHub Actions (the environment approval gate)", githubActions === "true", `GITHUB_ACTIONS='${githubActions ?? "unset"}'`);
    push("live RPCs are NOT a local fork", urls.length > 0 && urls.every((u) => !isLocalRpc(u)), urls.join(", "));
    push(`${KEY_ENV} is a 32-byte key`, isPrivateKeyShape(keyEnvValue), keyEnvValue ? "present but malformed (value not shown)" : "missing");
    push(`${WALLET_PIN_ENV} is a valid address`, normalizeAddress(walletPinEnvValue, WALLET_PIN_ENV).ok, normalizeAddress(walletPinEnvValue, WALLET_PIN_ENV).detail);
  }
  return { checks, allowed: checks.every((c) => !c.fatal || c.ok) };
}

/**
 * The signer-identity gate: fresh, dedicated, pinned, and none of the
 * addresses it must never be.
 */
export function evaluateSignerIdentity({ mode, derivedSigner, pinnedWallet, extraForbidden = [] }) {
  const checks = [];
  const push = (name, ok, detail = "") => checks.push({ stage: "1. signer identity", name, ok: Boolean(ok), detail: String(detail), fatal: true });

  const pin = normalizeAddress(pinnedWallet, WALLET_PIN_ENV);
  push(`${WALLET_PIN_ENV} is pinned and valid`, pin.ok, pin.detail);
  const derived = normalizeAddress(derivedSigner, "derived signer");
  push("the key derives a valid address", derived.ok, derived.ok ? derived.address : "malformed");
  push("derived signer == the pinned smoke wallet (the key is never used for any other wallet)", pin.ok && derived.ok && sameAddress(pin.address, derived.address), pin.ok && derived.ok ? `${derived.address}` : "unresolved");
  if (mode === MODES.LIVE) {
    push("live refuses the v1 smoke wallet", derived.ok && !sameAddress(derived.address, V1_SMOKE_WALLET), derived.ok ? derived.address : "unresolved");
    push("live refuses the Phase-5/6 mainnet canary wallet", derived.ok && !sameAddress(derived.address, PHASE5_CANARY_WALLET), derived.ok ? derived.address : "unresolved");
    push("live refuses the delegated deployer key's address", derived.ok && !sameAddress(derived.address, DELEGATED_DEPLOYER), derived.ok ? derived.address : "unresolved");
    push("live refuses the executor owner / fee recipient", derived.ok && !sameAddress(derived.address, OWNER) && !sameAddress(derived.address, FEE_RECIPIENT), derived.ok ? derived.address : "unresolved");
    push("live refuses the v1 executor as target identity", derived.ok && !sameAddress(derived.address, V1_MAINNET_EXECUTOR), derived.ok ? derived.address : "unresolved");
  }
  const forbiddenKeys = new Set([...Object.keys(FORBIDDEN_SIGNERS), ...extraForbidden.map((a) => lower(a)).filter(Boolean)]);
  const hit = derived.ok ? forbiddenKeys.has(derived.address.toLowerCase()) : false;
  const hitReason = derived.ok ? FORBIDDEN_SIGNERS[derived.address.toLowerCase()] : undefined;
  push(
    "signer is not any forbidden role/infrastructure address",
    derived.ok && !hit,
    hit ? `${derived.address} is ${hitReason ?? "on the denylist"}` : derived.ok ? derived.address : "unresolved",
  );
  return { checks, allowed: checks.every((c) => c.ok) };
}

// ---------------------------------------------------------------------------
// Static configuration gate (committed pins vs. this campaign)
// ---------------------------------------------------------------------------

/**
 * Verifies the committed reviewed config (deployments/base-mainnet/
 * delegated-deploy-config.json) and, when present, the deployment record,
 * against the constants this campaign acts on. Any divergence aborts before a
 * single RPC read: the repository configuration IS the source of truth.
 */
export function evaluateConfigPins({ config, record }) {
  const checks = [];
  const push = (name, ok, detail = "", fatal = true) => checks.push({ stage: "2. committed configuration", name, ok: Boolean(ok), detail: String(detail), fatal });

  push("reviewed delegated-deploy-config.json is present", config !== null && typeof config === "object", config ? "loaded" : REVIEWED_CONFIG_PATH);
  if (config && typeof config === "object") {
    push("config.contract is MPGRExecutorDelegated (never the v1 executor)", config.contract === "MPGRExecutorDelegated", String(config.contract));
    push("config.chainId is 8453", Number(config.chainId) === CHAIN_ID, String(config.chainId));
    push("config.owner matches the pinned owner", sameAddress(config.owner, OWNER), String(config.owner));
    push("config.feeRecipient matches the pinned fee recipient", sameAddress(config.feeRecipient, FEE_RECIPIENT), String(config.feeRecipient));
    push("config.feeBps is 25 and maxFeeBps is 100", Number(config.feeBps) === 25 && Number(config.maxFeeBps) === 100, `${config.feeBps}/${config.maxFeeBps}`);
    push("config.weth / config.permit2 are the canonical Base addresses", sameAddress(config.weth, CANONICAL_WETH) && sameAddress(config.permit2, CANONICAL_PERMIT2), `${config.weth} / ${config.permit2}`);

    const routers = Array.isArray(config.routers) ? config.routers : [];
    const univ3 = routers.find((r) => Number(r?.kind) === ROUTER_KIND_UNISWAP_V3);
    push("exactly one UNISWAP_V3_ROUTER02 (kind 2) entry exists in the reviewed config", routers.filter((r) => Number(r?.kind) === ROUTER_KIND_UNISWAP_V3).length === 1, `${routers.length} router entries`);
    push(
      "the config's Uniswap V3 venue matches the route this canary trades (router/factory/quoter/pool/fee)",
      Boolean(
        univ3 &&
          sameAddress(univ3.router, UNISWAP_V3_ROUTER) &&
          sameAddress(univ3.factory, UNISWAP_V3_FACTORY) &&
          sameAddress(univ3.quoterV2, UNISWAP_V3_QUOTER) &&
          sameAddress(univ3.usdcWethPool, UNISWAP_V3_POOL) &&
          Number(univ3.usdcWethPoolFee) === UNISWAP_V3_POOL_FEE,
      ),
      univ3 ? `${univ3.router} pool ${univ3.usdcWethPool} fee ${univ3.usdcWethPoolFee}` : "missing",
    );

    const tokens = Array.isArray(config.tokens) ? config.tokens : [];
    const usdcEntry = tokens.find((t) => sameAddress(t?.address, USDC));
    const wethEntry = tokens.find((t) => sameAddress(t?.address, CANONICAL_WETH));
    push("USDC (6 decimals) and WETH (18 decimals) are in the reviewed allowlist", Boolean(usdcEntry) && Number(usdcEntry?.decimals) === 6 && Boolean(wethEntry) && Number(wethEntry?.decimals) === 18, `${tokens.length} tokens`);
    push(
      "the venue this canary trades is NOT the Slipstream venue (kind 1 stays unused here)",
      routers.some((r) => Number(r?.kind) === ROUTER_KIND_SLIPSTREAM) &&
        routers.filter((r) => Number(r?.kind) === ROUTER_KIND_SLIPSTREAM).every((r) => !sameAddress(r.router, UNISWAP_V3_ROUTER)),
      "Slipstream allowlisted for other routes, not used by this canary",
    );

    const denied = config.denied ?? {};
    push("config.denied.v1MainnetExecutor is the address this canary must never target", sameAddress(denied.v1MainnetExecutor, V1_MAINNET_EXECUTOR), String(denied.v1MainnetExecutor));
    push("config.denied.canaryWallet is the spent Phase-5 canary wallet", sameAddress(denied.canaryWallet, PHASE5_CANARY_WALLET), String(denied.canaryWallet));
    const deniedList = Array.isArray(denied.sepolia) ? denied.sepolia.map(lower) : [];
    push("no Sepolia contract is used as mainnet infrastructure", [UNISWAP_V3_ROUTER, UNISWAP_V3_QUOTER, UNISWAP_V3_FACTORY, DELEGATED_EXECUTOR].every((a) => !deniedList.includes(a.toLowerCase())), `${deniedList.length} denied entries`);
  }

  if (record && typeof record === "object") {
    push("deployment record executor equals the pinned delegated executor", sameAddress(record.executor, DELEGATED_EXECUTOR), String(record.executor), true);
    push("deployment record tx/block equal the verified deployment", lower(record.deployTx) === DELEGATED_DEPLOY_TX && BigInt(record.deployedAtBlock ?? record.deployBlock ?? 0n) === DELEGATED_DEPLOY_BLOCK, `${record.deployTx} @ ${record.deployedAtBlock ?? record.deployBlock}`);
    push("deployment record reports an unpaused, non-proxy posture", record.paused === false && (record.proxy === undefined || record.proxy === "none"), `paused=${record.paused} proxy=${record.proxy}`);
  } else {
    push(
      "deployment record absent — falling back to the pinned deployment-report constants",
      true,
      `${DEPLOYMENT_RECORD_PATH} is not committed; the runner pins and re-verifies live posture instead`,
      false,
    );
  }
  return { checks, allowed: checks.every((c) => !c.fatal || c.ok) };
}

// ---------------------------------------------------------------------------
// The single live gate: every precondition that must hold before signing
// ---------------------------------------------------------------------------

/**
 * `facts` is a bag of READ results. A missing read is never treated as a pass:
 * the corresponding check fails with "fact unavailable". This is the only place
 * that decides (a) whether the key may be used at all — pass `preSigning: true`,
 * which skips exactly the three proofs that require a signature — and (b)
 * whether the signed transaction may be BROADCAST.
 */
export function evaluateLivePreconditions(facts = {}) {
  const checks = [];
  const push = (name, ok, detail = "", fatal = true) => checks.push({ stage: "3. live preconditions", name, ok: Boolean(ok), detail: String(detail), fatal });
  const skip = (name, detail) => checks.push({ stage: "3. live preconditions", name, ok: true, detail: String(detail), fatal: false, skipped: true });
  const f = (key) => facts[key];
  const unavailable = (key) => `fact unavailable (${key})`;
  // A read-only preflight signs nothing, so the signature-dependent proofs are
  // reported as skipped instead of pretending to pass; every other gate — and
  // therefore the LIVE decision — is evaluated identically. The same skip set is
  // used for the PRE-SIGN pass (`preSigning`): it is the table that decides
  // whether the key may be used at all, so it cannot depend on a signature.
  const skipSignatureProofs = f("mode") === MODES.PREFLIGHT || f("preSigning") === true;

  // -- chain + target contract ------------------------------------------------
  push("RPC chainId is 8453 (Base Mainnet)", Number(f("chainId")) === CHAIN_ID, Number(f("chainId")) || unavailable("chainId"));
  const code = f("executorCode");
  push("the delegated executor has runtime bytecode", typeof code === "string" && code.length > 4, code ? `${(code.length - 2) / 2} bytes` : unavailable("executorCode"));
  if (f("expectedCodeHash")) {
    push("executor runtime code hash equals the operator-pinned hash", lower(f("executorCodeHash")) === lower(f("expectedCodeHash")), `${f("executorCodeHash")} vs ${f("expectedCodeHash")}`);
  } else {
    push("no code-hash pin configured (recorded as a fact instead)", true, `codeHash=${f("executorCodeHash") ?? "unavailable"}`, false);
  }
  push(
    "the executor is MPGRExecutorDelegated (it dispatches swapOnBehalfOfUniswapV3)",
    codeDispatchesSelector(code ?? "", SWAP_ON_BEHALF_OF_UNISWAP_V3_SELECTOR),
    `selector ${SWAP_ON_BEHALF_OF_UNISWAP_V3_SELECTOR}`,
  );
  push(
    "the target is NOT the v1 assisted executor",
    !sameAddress(f("targetExecutor"), V1_MAINNET_EXECUTOR) && sameAddress(f("targetExecutor"), DELEGATED_EXECUTOR),
    String(f("targetExecutor")),
  );

  // -- governance posture -----------------------------------------------------
  push("executor owner() is the pinned owner", sameAddress(f("liveOwner"), OWNER), String(f("liveOwner")));
  push("executor has no pending owner", sameAddress(f("livePendingOwner"), ZERO_ADDRESS), String(f("livePendingOwner")));
  push("executor feeRecipient() is the pinned fee recipient", sameAddress(f("liveFeeRecipient"), FEE_RECIPIENT), String(f("liveFeeRecipient")));
  push("executor feeBps() is exactly 25", bigintOf(f("liveFeeBps")) === FEE_BPS, String(f("liveFeeBps")));
  push("executor MAX_FEE_BPS() is 100", bigintOf(f("liveMaxFeeBps")) === MAX_FEE_BPS, String(f("liveMaxFeeBps")));
  push("executor is not paused", f("livePaused") === false, f("livePaused") === undefined ? unavailable("livePaused") : String(f("livePaused")));
  push("executor WETH() is canonical WETH", sameAddress(f("liveWeth"), CANONICAL_WETH), String(f("liveWeth")));
  push("executor PERMIT2() is canonical Permit2", sameAddress(f("livePermit2"), CANONICAL_PERMIT2), String(f("livePermit2")));

  // -- delegated authorization path ------------------------------------------
  push("executor WITNESS_TYPE_STRING() matches the string we sign over", f("liveWitnessTypeString") === WITNESS_TYPE_STRING, typeof f("liveWitnessTypeString") === "string" ? "match" : unavailable("liveWitnessTypeString"));
  push("executor ACTION_WITNESS_STRUCT_TYPE_STRING() matches", f("liveWitnessStructTypeString") === ACTION_WITNESS_STRUCT_TYPE_STRING, typeof f("liveWitnessStructTypeString") === "string" ? "match" : unavailable("liveWitnessStructTypeString"));
  push("executor ACTION_WITNESS_TYPEHASH() matches keccak256 of that string", lower(f("liveActionWitnessTypehash")) === lower(ACTION_WITNESS_TYPEHASH), String(f("liveActionWitnessTypehash")));
  push(
    "witnessHashOf(local witness) == executor's own witness hash (EIP-712 encoding agrees with the deployment)",
    isBytes32(f("witnessHashOnChain")) && lower(f("witnessHashOnChain")) === lower(f("witnessHashLocal")),
    `${f("witnessHashOnChain")} vs ${f("witnessHashLocal")}`,
  );
  push("the canary never unwraps to native ETH (flags must be 0)", f("unwrapNativeOut") === false, String(f("unwrapNativeOut")));
  push(
    "signer is a valid address and is not the fee recipient (would revert OwnerIsFeeRecipient)",
    normalizeAddress(f("signer"), "signer").ok && sameAddress(f("signer"), FEE_RECIPIENT) === false,
    String(f("signer")),
  );

  // -- route / venue ----------------------------------------------------------
  push("Uniswap V3 router is allowlisted as kind 2 (UNISWAP_V3_ROUTER02)", Number(f("liveRouterKind")) === ROUTER_KIND_UNISWAP_V3, `kind ${f("liveRouterKind")}`);
  push("USDC and WETH are allowlisted on the executor", f("liveUsdcAllowed") === true && f("liveWethAllowed") === true, `USDC ${f("liveUsdcAllowed")}, WETH ${f("liveWethAllowed")}`);
  push("the Uniswap V3 router address has bytecode", typeof f("routerCode") === "string" && f("routerCode").length > 4, f("routerCode") ? "ok" : unavailable("routerCode"));
  push("the Uniswap V3 QuoterV2 address has bytecode", typeof f("quoterCode") === "string" && f("quoterCode").length > 4, f("quoterCode") ? "ok" : unavailable("quoterCode"));
  push("factory.getPool(USDC, WETH, 3000) is the pinned pool", sameAddress(f("poolFromFactory"), UNISWAP_V3_POOL), String(f("poolFromFactory")));
  push("the pinned pool has bytecode", typeof f("poolCode") === "string" && f("poolCode").length > 4, f("poolCode") ? "ok" : unavailable("poolCode"));
  push("USDC decimals() is 6 and WETH decimals() is 18", Number(f("usdcDecimals")) === 6 && Number(f("wethDecimals")) === 18, `${f("usdcDecimals")}/${f("wethDecimals")}`);
  push(
    "no typed swap module is registered for this router (module path stays empty at deployment)",
    sameAddress(f("liveSwapModule"), ZERO_ADDRESS) &&
    (f("liveSwapModuleCodeHash") ?? `0x${"00".repeat(32)}`) === `0x${"00".repeat(32)}`,
    `module=${f("liveSwapModule")} codeHash=${f("liveSwapModuleCodeHash")}`,
  );

  // -- economics --------------------------------------------------------------
  const split = feeSplit(GROSS_AMOUNT_IN);
  push("local fee split is exactly (1250, 498750) for 0.50 USDC gross", split?.fee === EXPECTED_FEE_AMOUNT && split?.swapAmount === SWAP_AMOUNT_IN, `${split?.fee} / ${split?.swapAmount}`);
  push("executor quoteFee(gross) agrees with the local split", bigintOf(f("onChainFee")) === EXPECTED_FEE_AMOUNT && bigintOf(f("onChainSwapAmount")) === SWAP_AMOUNT_IN, `${f("onChainFee")} / ${f("onChainSwapAmount")}`);
  push("fee does not round to zero (contract would revert FeeRoundsToZero)", (bigintOf(f("onChainFee")) ?? -1n) > 0n, String(f("onChainFee")));
  const band = quoteWithinSanityBand(f("quoteAmountOut"));
  push("fresh quote for 498,750 USDC is inside the ETH-price sanity band", band.ok, band.detail);
  const minOut = bigintOf(f("amountOutMinimum"));
  push("amountOutMinimum is positive and <= the quote", minOut !== null && minOut > 0n && minOut <= (bigintOf(f("quoteAmountOut")) ?? -1n), `${minOut} <= ${f("quoteAmountOut")}`);
  push(
    "amountOutMinimum equals quote minus the pinned 100 bps slippage",
    minOut !== null && minOut === minOutFromQuote(f("quoteAmountOut")),
    `${minOut} vs ${minOutFromQuote(f("quoteAmountOut"))}`,
  );

  // -- deadline ---------------------------------------------------------------
  const now = bigintOf(f("latestBlockTimestamp"));
  const deadline = bigintOf(f("deadline"));
  const margin = now !== null && deadline !== null ? deadline - now : null;
  push("deadline is a future timestamp with >= 90s of margin", margin !== null && margin >= MIN_DEADLINE_MARGIN_SECONDS, margin === null ? unavailable("deadline") : `${margin}s left`);
  push("deadline is inside the short signed window (<= 300s)", margin !== null && margin <= DEADLINE_SECONDS, margin === null ? unavailable("deadline") : `${margin}s`);

  // -- wallet funding ---------------------------------------------------------
  push("smoke wallet USDC balance >= 500,000 raw", (bigintOf(f("walletUsdc")) ?? -1n) >= GROSS_AMOUNT_IN, `${f("walletUsdc")} raw`);
  const worstCaseGas = EXPECTED_GAS_LIMIT * (bigintOf(f("maxFeePerGas")) ?? 0n) + L1_FEE_MARGIN_WEI;
  push("smoke wallet ETH covers the worst-case gas for exactly one tx", (bigintOf(f("walletEth")) ?? -1n) >= worstCaseGas, `${f("walletEth")} >= ${worstCaseGas}`);

  // -- allowance / permit state (the delegated path must need NEITHER) --------
  push("ERC-20 allowance wallet->executor is 0 (delegated trades never rely on an approval)", bigintOf(f("walletAllowanceToExecutor")) === 0n, `${f("walletAllowanceToExecutor")}`);
  push("ERC-20 allowance wallet->Permit2 is 0 (signature permit only)", bigintOf(f("walletAllowanceToPermit2")) === 0n, `${f("walletAllowanceToPermit2")}`);
  push("Permit2 standing allowance wallet->executor is 0", bigintOf(f("permit2AllowanceAmount")) === 0n, `${f("permit2AllowanceAmount")}`);
  push("Permit2 nonce for this campaign is UNUSED (single-use replay guard)", f("permit2NonceUsed") === false, `nonce ${f("permit2Nonce")} used=${f("permit2NonceUsed")}`);
  const nonce = bigintOf(f("permit2Nonce"));
  const bitmapWord = bigintOf(f("permit2NonceBitmapWord"));
  push(
    "the read bitmap word does NOT mark the campaign nonce (independent recomputation, not the caller's boolean)",
    nonceBitmapWordMarks(bitmapWord, nonce) === false,
    `word ${f("permit2NonceBitmapWord")} nonce ${nonce} -> used=${String(nonceBitmapWordMarks(bitmapWord, nonce))}`,
  );
  push(
    "the canary nonce resolves to a real Permit2 bitmap slot (guard reads the right owner's word)",
    nonce !== null &&
      nonce >= 0n &&
      bitmapWord !== null &&
      normalizeAddress(f("permit2NonceDerivedFor"), "nonce owner").ok &&
      sameAddress(f("permit2NonceDerivedFor"), f("signer")),
    `word ${f("permit2NonceBitmapWord")} for ${f("permit2NonceDerivedFor")}`,
  );

  // -- executor hygiene -------------------------------------------------------
  push("executor holds no USDC/WETH/ETH before the canary", bigintOf(f("executorUsdc")) === 0n && bigintOf(f("executorWeth")) === 0n && bigintOf(f("executorEth")) === 0n, `USDC ${f("executorUsdc")}, WETH ${f("executorWeth")}, ETH ${f("executorEth")}`);
  push("fee recipient USDC balance is readable (delta will be verified after)", bigintOf(f("feeRecipientUsdc")) !== null, unavailable("feeRecipientUsdc"));

  // -- one-shot guards --------------------------------------------------------
  push("no earlier SwapExecuted exists for this wallet on the delegated executor (one-shot)", Number(f("priorSwapEvents")) === 0, `${f("priorSwapEvents")} event(s) since block ${DELEGATED_DEPLOY_BLOCK}`);
  push("no earlier canary broadcast from this wallet was ever recorded", f("ledgerExists") === false, f("ledgerExists") ? `ledger=${f("ledgerPath")} claim=${f("ledgerClaimId")} tx=${f("ledgerTx") ?? "none"}` : "no ledger");
  push("the executor allowance to the Uniswap router is 0 before the canary", bigintOf(f("executorRouterAllowance")) === 0n, `${f("executorRouterAllowance")}`);

  // -- gas + fees -------------------------------------------------------------
  const maxFee = bigintOf(f("maxFeePerGas"));
  push("maxFeePerGas is within the 1 gwei cap", maxFee !== null && maxFee > 0n && maxFee <= MAX_FEE_PER_GAS_CAP, `${maxFee} wei`);
  const tip = bigintOf(f("maxPriorityFeePerGas"));
  push("maxPriorityFeePerGas is within the 0.05 gwei cap", tip !== null && tip >= 0n && tip <= PRIORITY_FEE_CAP, `${tip} wei`);
  const estGas = bigintOf(f("swapGasEstimate"));
  push(
    "estimated L2 gas cost of the single swap is within the cap",
    estGas !== null && estGas > 0n && maxFee !== null && estGas * maxFee <= MAX_L2_COST_PER_TX_WEI,
    `${f("swapGasEstimate")} gas * ${maxFee}`,
  );

  // -- the decisive read-only proof ------------------------------------------
  push("calldata selector is swapOnBehalfOfUniswapV3 and decodes back to the exact params", f("calldataSelector")?.toLowerCase() === SWAP_ON_BEHALF_OF_UNISWAP_V3_SELECTOR && f("calldataMatchesParams") === true, `${f("calldataSelector")} match=${f("calldataMatchesParams")}`);
  if (skipSignatureProofs) {
    skip("eth_call simulation of the signed delegated swap succeeds", "not attempted before signing (nothing is signed yet)");
    skip("simulation returns amountOut >= the signed amountOutMinimum", "not attempted before signing");
    skip("the authorization signature recovers to the smoke wallet (witness.owner)", "not attempted before signing");
  } else {
    push("eth_call simulation of the signed delegated swap succeeds", f("simulationOk") === true, f("simulationError") ? String(f("simulationError")).slice(0, 240) : f("simulationOk") ? "ok" : unavailable("simulationOk"));
    push("simulation returns amountOut >= the signed amountOutMinimum", minOut !== null && (bigintOf(f("simulationAmountOut")) ?? -1n) >= minOut, `${f("simulationAmountOut")} >= ${minOut}`);
    push(
      "the authorization signature recovers to the smoke wallet (witness.owner)",
      f("signatureRecoversToSigner") === true && sameAddress(f("recoveredSigner"), f("signer")),
      f("recoveredSigner") ? `${f("recoveredSigner")} vs signer ${f("signer")}` : unavailable("signatureRecoversToSigner"),
    );
  }
  if (f("mode") === MODES.LIVE) {
    push(`live requires the exact typed confirmation ('${LIVE_CONFIRM_PHRASE}')`, f("confirmedPhrase") === LIVE_CONFIRM_PHRASE, f("confirmedPhrase") ? "confirmed" : "confirmation missing or mismatched");
  }

  const blockers = checks.filter((c) => c.fatal && !c.ok).map((c) => c.name);
  return { checks, allowed: blockers.length === 0, blockers };
}

// ---------------------------------------------------------------------------
// Post-trade verification (also pure: takes receipt-derived facts)
// ---------------------------------------------------------------------------

export function evaluatePostTradeVerification(facts = {}) {
  const checks = [];
  const push = (name, ok, detail = "") => checks.push({ stage: "5. post-trade verification", name, ok: Boolean(ok), detail: String(detail), fatal: true });
  const f = (key) => facts[key];

  push("swap tx confirmed with status success", f("receiptStatus") === "success", String(f("receiptStatus")));
  push("tx to == the delegated executor", sameAddress(f("txTo"), DELEGATED_EXECUTOR), String(f("txTo")));
  // LIVE is a single-key self-broadcast; the rehearsal deliberately proves the
  // delegated property that a DIFFERENT account may broadcast the owner's permit.
  if (f("mode") === MODES.REHEARSAL) {
    push(
      "tx from == the separate rehearsal broadcaster (NOT the signing owner — anyone may relay a signed permit)",
      sameAddress(f("txFrom"), f("broadcaster")) && !sameAddress(f("broadcaster"), f("signer")),
      `${f("txFrom")} (broadcaster ${f("broadcaster")})`,
    );
  } else {
    push("tx from == the smoke wallet (self-broadcast: owner and broadcaster are the same key)", sameAddress(f("txFrom"), f("signer")), String(f("txFrom")));
  }
  push("tx value == 0 (delegated swaps reject native input)", bigintOf(f("txValue")) === 0n, String(f("txValue")));
  push("tx input selector is swapOnBehalfOfUniswapV3", lower(f("txSelector")) === SWAP_ON_BEHALF_OF_UNISWAP_V3_SELECTOR, String(f("txSelector")));
  push("decoded tx params equal the simulated params byte-for-byte", f("txInputMatchesEncoded") === true, String(f("txInputMatchesEncoded")));
  push("decoded witness.owner == decoded recipient == the smoke wallet", sameAddress(f("decodedWitnessOwner"), f("signer")) && sameAddress(f("decodedRecipient"), f("signer")), `${f("decodedWitnessOwner")} / ${f("decodedRecipient")}`);
  push("decoded intentId equals the deterministic canary actionId", lower(f("decodedIntentId")) === lower(f("expectedActionId")), `${f("decodedIntentId")}`);
  push("decoded permit equals the signed gross and USDC", sameAddress(f("decodedPermitToken"), USDC) && bigintOf(f("decodedPermitAmount")) === GROSS_AMOUNT_IN, `${f("decodedPermitToken")} ${f("decodedPermitAmount")}`);

  push("exactly one SwapExecuted was emitted by the executor", Number(f("swapEventCount")) === 1, `${f("swapEventCount")} event(s)`);
  push("SwapExecuted.taker == the smoke wallet (the signing owner, not the broadcaster)", sameAddress(f("eventTaker"), f("signer")), String(f("eventTaker")));
  push("SwapExecuted.router == the Uniswap V3 SwapRouter02", sameAddress(f("eventRouter"), UNISWAP_V3_ROUTER), String(f("eventRouter")));
  push("SwapExecuted.tokenIn/tokenOut == USDC/WETH", sameAddress(f("eventTokenIn"), USDC) && sameAddress(f("eventTokenOut"), CANONICAL_WETH), `${f("eventTokenIn")} -> ${f("eventTokenOut")}`);
  push("SwapExecuted.grossAmountIn == 500,000", bigintOf(f("eventGrossAmountIn")) === GROSS_AMOUNT_IN, String(f("eventGrossAmountIn")));
  push("SwapExecuted.feeAmount == 1,250 (exact 25 bps)", bigintOf(f("eventFeeAmount")) === EXPECTED_FEE_AMOUNT, String(f("eventFeeAmount")));
  push("SwapExecuted.swapAmountIn == 498,750 and fee + swap == gross", bigintOf(f("eventSwapAmountIn")) === SWAP_AMOUNT_IN && bigintOf(f("eventFeeAmount")) + bigintOf(f("eventSwapAmountIn")) === GROSS_AMOUNT_IN, String(f("eventSwapAmountIn")));
  push("SwapExecuted.feeRecipient/feeBps match the pins", sameAddress(f("eventFeeRecipient"), FEE_RECIPIENT) && bigintOf(f("eventFeeBps")) === FEE_BPS, `${f("eventFeeRecipient")} @ ${f("eventFeeBps")} bps`);
  push("SwapExecuted.routerKind == 2 (UNISWAP_V3_ROUTER02) and flags == 0", Number(f("eventRouterKind")) === ROUTER_KIND_UNISWAP_V3 && Number(f("eventFlags")) === 0, `kind=${f("eventRouterKind")} flags=${f("eventFlags")}`);
  push("SwapExecuted.amountOut >= the signed amountOutMinimum", (bigintOf(f("eventAmountOut")) ?? -1n) >= (bigintOf(f("amountOutMinimum")) ?? Infinity), `${f("eventAmountOut")} >= ${f("amountOutMinimum")}`);

  push("USDC Transfer wallet -> executor of exactly 500,000 (pulled via Permit2)", f("usdcPullVerified") === true, String(f("usdcPullVerified")));
  push("exactly one USDC Transfer executor -> fee recipient of 1,250", Number(f("feeTransferCount")) === 1 && f("feeTransferVerified") === true, `${f("feeTransferCount")} transfer(s)`);
  push("USDC Transfer executor -> pool of exactly 498,750", f("swapLegVerified") === true, String(f("swapLegVerified")));
  push("WETH Transfer(s) to the wallet sum to SwapExecuted.amountOut", f("wethToOwnerVerified") === true, String(f("wethToOwnerVerified")));
  push("no WETH went to the fee recipient or to any non-owner address", f("unexpectedWethRecipient") === false, String(f("unexpectedWethRecipient")));

  push("wallet USDC delta is exactly -500,000", bigintOf(f("walletUsdcBefore")) - bigintOf(f("walletUsdcAfter")) === GROSS_AMOUNT_IN, `${f("walletUsdcBefore")} -> ${f("walletUsdcAfter")}`);
  push("wallet WETH delta equals SwapExecuted.amountOut", bigintOf(f("walletWethAfter")) - bigintOf(f("walletWethBefore")) === bigintOf(f("eventAmountOut")), `${f("walletWethBefore")} -> ${f("walletWethAfter")}`);
  push("wallet WETH delta is at least the signed minimum", bigintOf(f("walletWethAfter")) - bigintOf(f("walletWethBefore")) >= (bigintOf(f("amountOutMinimum")) ?? Infinity), String(f("amountOutMinimum")));
  push("fee recipient USDC delta at the receipt block is exactly 1,250", bigintOf(f("feeRecipientUsdcAfter")) - bigintOf(f("feeRecipientUsdcBefore")) === EXPECTED_FEE_AMOUNT, `${f("feeRecipientUsdcBefore")} -> ${f("feeRecipientUsdcAfter")}`);
  push("executor holds no USDC/WETH/ETH afterwards (nothing trapped)", bigintOf(f("executorUsdcAfter")) === 0n && bigintOf(f("executorWethAfter")) === 0n && bigintOf(f("executorEthAfter")) === 0n, `USDC ${f("executorUsdcAfter")}, WETH ${f("executorWethAfter")}, ETH ${f("executorEthAfter")}`);
  push("executor -> router allowance is 0 afterwards (no standing approval left)", bigintOf(f("executorRouterAllowanceAfter")) === 0n, String(f("executorRouterAllowanceAfter")));
  push("Permit2 nonce is now SPENT (a replay with this wallet is impossible)", f("permit2NonceUsedAfter") === true, `used=${f("permit2NonceUsedAfter")}`);
  push("exactly one broadcast transaction was sent by this run", Number(f("broadcastCount")) === 1, `${f("broadcastCount")} broadcast(s)`);

  const failed = checks.filter((c) => !c.ok);
  return { checks, ok: failed.length === 0, failed: failed.map((c) => c.name) };
}

// ---------------------------------------------------------------------------
// One-shot ledger gate (the local half of the guard)
// ---------------------------------------------------------------------------

export function ledgerFileName({ chainId = CHAIN_ID, wallet, campaign = CAMPAIGN } = {}) {
  const pin = normalizeAddress(wallet, "wallet");
  if (!pin.ok) throw new Error(`ledgerFileName: ${pin.detail}`);
  return `${campaign}-${chainId}-${pin.address.toLowerCase()}.json`;
}

/**
 * Reads a ledger and decides whether a live run may proceed.
 *
 *  - no ledger                          -> may proceed (and must claim it)
 *  - ledger with a broadcast tx         -> REFUSED, always, for this wallet.
 *    A second live canary requires a NEW wallet (the deterministic Permit2
 *    nonce is already spent anyway).
 *  - ledger claimed but never broadcast -> refused unless the operator echoes
 *    the recorded claim id (proves they saw the interrupted run).
 */
export function evaluateLedgerGuard({ mode, ledger, wallet, ack, campaign = CAMPAIGN, chainId = CHAIN_ID }) {
  const checks = [];
  const push = (name, ok, detail = "", fatal = true) => checks.push({ stage: "4. one-shot ledger", name, ok: Boolean(ok), detail: String(detail), fatal });
  const pin = normalizeAddress(wallet, "smoke wallet");
  push("ledger identity address is valid", pin.ok, pin.detail);
  if (mode === MODES.LIVE && ledger && typeof ledger === "object") {
    push("ledger belongs to this campaign and chain", ledger.campaign === campaign && Number(ledger.chainId) === chainId, `${ledger.campaign}/${ledger.chainId}`);
    push("ledger belongs to THIS wallet", sameAddress(ledger.wallet, pin.address), `${ledger.wallet}`);
    const spent = typeof ledger.broadcastTx === "string" && /^0x[0-9a-fA-F]{64}$/.test(ledger.broadcastTx);
    if (spent) {
      push("a live canary broadcast is already recorded for this wallet — REFUSED", false, `tx=${ledger.broadcastTx} status=${ledger.status ?? "unknown"}`);
    } else {
      const acked = typeof ack === "string" && ledger.claimId && ack.trim() === ledger.claimId;
      push(
        "an interrupted claim exists — only an operator ack of the recorded claim id may release it",
        acked,
        acked ? `ack matches claim ${ledger.claimId}` : `claim ${ledger.claimId} unreleased (set ${LEDGER_ACK_ENV} to it deliberately)`,
      );
    }
  } else if (mode === MODES.LIVE) {
    push("no ledger for this wallet yet (this run will claim it exclusively)", true, "clean");
  } else {
    push("read-only modes never claim or release the ledger", true, mode, false);
    if (ledger && typeof ledger === "object") {
      push("a ledger for this wallet already exists (informational)", true, `tx=${ledger.broadcastTx ?? "none"}`, false);
    }
  }
  const blockers = checks.filter((c) => !c.ok).map((c) => c.name);
  return { checks, allowed: blockers.length === 0, blockers };
}

/** The payload a claimed/updated ledger carries (never any key material). */
export function buildLedgerEntry({ wallet, mode, claimId, startedAt, chainId = CHAIN_ID, campaign = CAMPAIGN }) {
  const pin = normalizeAddress(wallet, "smoke wallet");
  if (!pin.ok) throw new Error(`buildLedgerEntry: ${pin.detail}`);
  return {
    version: LEDGER_VERSION,
    campaign,
    chainId,
    mode,
    wallet: pin.address,
    executor: DELEGATED_EXECUTOR,
    grossAmountIn: GROSS_AMOUNT_IN.toString(),
    claimId,
    startedAt,
  };
}

/**
 * The exclusive-claim decision: the runner performs the actual atomic
 * create; this function only decides whether a claim is legitimate.
 */
export function evaluateLedgerClaim({ wallet, ledgerDir = LEDGER_DIR, campaign = CAMPAIGN } = {}) {
  const fileName = ledgerFileName({ wallet, campaign });
  return {
    fileName,
    path: `${String(ledgerDir).replace(/\/+$/, "")}/${fileName}`,
    instruction: "create with O_EXCL (flag 'wx'); if the file already exists, abort without signing",
  };
}

// ---------------------------------------------------------------------------
// Rehearsal principals (fork-only, deterministically derived — NO secret)
// ---------------------------------------------------------------------------

/**
 * Rehearsal needs a wallet that SIGNS (the EIP-712 permit) so the delegated
 * path is exercised for real. These accounts are derived from public labels
 * with keccak256 — no literal key material exists in the repository, and the
 * accounts hold funds on a local anvil fork only, never on Base Mainnet.
 */
export function rehearsalPrincipal(label) {
  if (typeof label !== "string" || label.trim() === "") throw new Error("rehearsalPrincipal: label required");
  const key = keccak256(toHex(`mpgr-delegated-smoke-rehearsal:${label}`));
  return { privateKey: key, label };
}

export function rehearsalPrincipals() {
  return { owner: rehearsalPrincipal("owner"), broadcaster: rehearsalPrincipal("broadcaster") };
}

// ---------------------------------------------------------------------------
// Report rendering (kept here so the offline tests pin the exact wording)
// ---------------------------------------------------------------------------

export function renderTitle(mode) {
  if (mode === MODES.LIVE) return "MPGRExecutorDelegated — Base Mainnet delegated smoke canary (LIVE)";
  if (mode === MODES.PREFLIGHT) return "MPGRExecutorDelegated — Base Mainnet delegated preflight (READ-ONLY, nothing signed)";
  return "MPGRExecutorDelegated — Base Mainnet delegated smoke (LOCAL FORK REHEARSAL, nothing broadcast)";
}

export function summarizeChecks(checks = []) {
  const passed = checks.filter((c) => c.ok).length;
  return { passed, total: checks.length, failed: checks.filter((c) => !c.ok).map((c) => `${c.stage}: ${c.name}`) };
}

/** Trims the noise out of an error before it can reach a report. */
export function safeErrorMessage(err, secrets = []) {
  const raw = err instanceof Error ? (err.shortMessage ?? err.message ?? String(err)) : String(err);
  return redact(String(raw).split("\n")[0].slice(0, 500), secrets);
}
