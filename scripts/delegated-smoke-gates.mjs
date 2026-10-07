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

import { encodeAbiParameters, getAddress, isAddress, keccak256, numberToHex, pad, toHex } from "viem";

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

/**
 * The ERC-20 allowance the signing wallet MUST have granted to the CANONICAL
 * PERMIT2 CONTRACT before any delegated swap can be redeemed.
 *
 * This is NOT an approval of the executor and NOT a standing spend authority.
 * Permit2's `SignatureTransfer` moves the user's tokens by calling
 * `ERC20(token).transferFrom(owner, spender, amount)` **from the Permit2
 * contract itself** (permit2 `src/SignatureTransfer.sol::_permitTransferFrom`,
 * via solmate `SafeTransferLib`), so without this one-time token allowance the
 * pull inside `MPGRExecutorDelegated._pullFromOwner` reverts
 * `Error("TRANSFER_FROM_FAILED")` before the executor can do anything at all.
 *
 * The delegated safety property is untouched by it: Permit2 can only move the
 * allowance against a live, single-use, witness-bound EIP-712 signature whose
 * spender is this executor and whose output recipient is the signer. The
 * properties the gate still enforces are the ones that matter — zero ERC-20
 * allowance to the EXECUTOR, and zero standing Permit2 *AllowanceTransfer*
 * approval (`PERMIT2.allowance(wallet, USDC, executor)`).
 *
 * Least privilege: the canary asks for EXACTLY the campaign gross, mirroring
 * `lib/mcp/mcp-trade-service.ts` ("Approve Permit2 to spend exactly …", never
 * unlimited). A larger (e.g. unbounded) approval is accepted but reported as a
 * non-fatal note so it stays visible.
 */
export const REQUIRED_PERMIT2_TOKEN_ALLOWANCE = GROSS_AMOUNT_IN;

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

/**
 * The CONSERVATIVE STARTING chunk for the historical SwapExecuted scan.
 *
 * Public Base RPC providers reject wide `eth_getLogs` requests ("eth_getLogs is
 * limited to 0 - 50 blocks range" on the public Base endpoints; Alchemy's Base
 * free tier caps one request at 10 blocks), so a scan that has proven nothing
 * about its endpoint starts here. 10 is the strictest published cap — the value
 * REHEARSAL_LOG_WINDOW already assumed — so it is also the FLOOR: adaptive
 * chunking (see MAX_SAFE_LOG_CHUNK / probeLogChunkSize / runAdaptiveLogScan)
 * may grow a request only after the endpoint has explicitly served one, and may
 * always fall back to this width.
 *
 * Why not simply stay at 10: the one-shot certification scans deployment -> head.
 * At 10 blocks per request that is (head - DELEGATED_DEPLOY_BLOCK) / 10 separate
 * eth_getLogs calls — tens of thousands of requests within hours of the
 * deployment, which is exactly what exhausted every public/free Base endpoint
 * (HTTP 429, "1rpc usage limit exceeded", compute-unit/sec caps) and failed
 * smoke run #6's preflight. The fix is NOT a smaller chunk, more retries or more
 * public fallbacks: it is one properly provisioned endpoint (see RPC_ENV and
 * evaluateRpcReadiness) plus a chunk width that endpoint has been PROBED to
 * accept, capped by MAX_SAFE_LOG_CHUNK.
 */
export const LOG_CHUNK = 10n;

/**
 * The HARD CEILING for one eth_getLogs request in the historical scan.
 *
 * It is a ceiling, never an assumption: nothing in this repository or the
 * workflow may assume an endpoint serves a range this wide. A width is used
 * only after `probeLogChunkSize` has watched THIS endpoint answer a real
 * `eth_getLogs` of exactly that width with the real scan filter, and every
 * request the scan issues stays at or below the widest width it accepted.
 *
 * 1 000 blocks is deliberately well below the widest range the well-known
 * providers document (5 000 – 10 000 on paid tiers) so a "properly provisioned"
 * endpoint is not asked for anything exotic, while still cutting the request
 * count of the deployment -> head certification by two orders of magnitude
 * against the 10-block floor. Operators may lower it per endpoint with
 * `SMOKE_DELEGATED_MAX_LOG_CHUNK` (clamped to [LOG_CHUNK, MAX_SAFE_LOG_CHUNK]);
 * raising it means editing this constant in review, with a test.
 */
export const MAX_SAFE_LOG_CHUNK = 1_000n;

/**
 * The explicit, ascending widths the readiness probe offers an endpoint, widest
 * last. Every entry is inside [LOG_CHUNK, MAX_SAFE_LOG_CHUNK]; the probe stops
 * at the first width the endpoint refuses (or at the first quota error) and the
 * scan then uses the widest width that was actually SERVED.
 */
export const LOG_CHUNK_PROBE_LADDER = Object.freeze([10n, 50n, 200n, 1_000n]);

/**
 * Optional, non-secret operator override for MAX_SAFE_LOG_CHUNK (an environment
 * VARIABLE, never a secret: it names no endpoint and grants nothing). Values
 * are clamped to [LOG_CHUNK, MAX_SAFE_LOG_CHUNK] by `clampChunkSize`, so the
 * knob can only ever make the scan MORE conservative, never wider than the
 * reviewed ceiling.
 */
export const MAX_LOG_CHUNK_ENV = "SMOKE_DELEGATED_MAX_LOG_CHUNK";

/**
 * Block budget for the historical certification — the number of blocks one run
 * may certify. Unchanged by adaptive chunking: 400 000 chunks × the 10-block
 * floor is the same 4 000 000 blocks (~3 months of Base blocks) the scan has
 * always been allowed, and both this and MAX_LOG_CHUNKS stay fail-closed. A
 * wider chunk makes the same coverage CHEAPER; it never widens what is
 * certified, and an uncovered range still refuses to certify a one-shot.
 */
export const MAX_LOG_SCAN_BLOCKS = 4_000_000n;

/**
 * Bounded rate-limit policy for the scan (HTTP 429 / provider quota).
 *
 * A rate-limited endpoint is a PROVISIONING failure, not something to grind
 * through: the retry budget is small and finite, `Retry-After` is respected
 * when the provider sends it, backoff is exponential and capped, and when the
 * budget is exhausted the run FAILS CLOSED with RPC_RATE_LIMITED_MESSAGE. There
 * is no public-endpoint fallback to rotate into — see evaluateModeGuard's
 * "exactly ONE dedicated configured RPC endpoint" check.
 */
export const RATE_LIMIT_MAX_ATTEMPTS = 4; // 1 request + 3 retries, then fail closed
export const RATE_LIMIT_BACKOFF_BASE_MS = 1_000;
export const RATE_LIMIT_BACKOFF_MAX_MS = 30_000;
/** A `Retry-After` longer than this cannot be honoured inside the job budget. */
export const RETRY_AFTER_MAX_MS = 30_000;

/** The exact operator-facing message for a rate-limited dedicated smoke RPC. */
export const RPC_RATE_LIMITED_MESSAGE =
  "Dedicated smoke RPC is rate-limited; historical preflight certification cannot proceed. Configure a properly provisioned Base Mainnet RPC and rerun.";
/** The exact operator-facing message for a missing dedicated smoke RPC. */
export const RPC_MISSING_MESSAGE =
  "No dedicated smoke RPC is configured: set the SMOKE_DELEGATED_RPC_URL secret (BASE_MAINNET_RPC_URL) to a properly provisioned Base Mainnet RPC. Public/free endpoints are not sufficient for the deployment-to-head certification.";

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

/**
 * True for any endpoint that is NOT a real remote Base Mainnet node: loopback,
 * RFC-1918 / link-local addresses, IPv6 unique-local, or a `.local`/`.internal`
 * name. Preflight/live must audit REAL mainnet state, so a private or
 * fork-style host is refused there even when it is not literally `localhost`.
 * Never throws on garbage input.
 */
export function isPrivateOrLocalRpc(url) {
  if (isLocalRpc(url)) return true;
  let host;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return true; // an unparseable endpoint is not a provably public mainnet node
  }
  if (host === "") return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) return true;
  if (host === "0.0.0.0" || host === "::") return true;
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return true; // IPv6 ULA / link-local
  const parts = host.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) {
    const [a, b] = [Number(parts[0]), Number(parts[1])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

/** True only for a TLS endpoint — required for preflight/live. */
export function isHttpsRpc(url) {
  try {
    return new URL(url).protocol === "https:";
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

/**
 * The exact inclusive [from, to] chunk plan for a bounded eth_getLogs scan.
 *
 * Guarantees: ascending deterministic order, zero gaps, zero overlaps, the
 * first block included, the last block included, every chunk at most
 * `chunkSize` blocks, and the final partial chunk kept intact (never padded
 * into a neighbour and never widened). A range that cannot be planned
 * (inverted/empty range, non-positive chunk) throws — a scan that cannot be
 * planned must never run.
 */
export function planLogScan({ from, to, chunkSize = LOG_CHUNK } = {}) {
  const start = bigintOf(from);
  const end = bigintOf(to);
  const size = bigintOf(chunkSize);
  if (start === null || end === null) throw new Error("planLogScan: from/to must be integers");
  if (size === null || size <= 0n) throw new Error("planLogScan: chunkSize must be a positive integer");
  if (start > end) throw new Error(`planLogScan: empty/inverted range (${start} > ${end})`);
  const chunks = [];
  for (let lo = start; lo <= end; lo += size) {
    const hi = lo + size - 1n > end ? end : lo + size - 1n;
    chunks.push({ from: lo, to: hi });
  }
  return chunks;
}

/**
 * Runs a bounded historical log scan over planLogScan's chunks, in order.
 *
 * `fetchChunk(from, to)` is the ONLY side effect (the caller injects the
 * eth_getLogs request); this function never issues a request wider than
 * `chunkSize` blocks, never reorders chunks, and never overlaps them.
 *
 * FAILS CLOSED: any chunk that cannot be read rejects with a wrapped error
 * (the underlying cause is preserved) and NO partial result — a one-shot must
 * never be certified from a partial scan. An optional `maxChunks` budget
 * refuses oversized scans BEFORE the first request, mirroring the runner's
 * MAX_LOG_CHUNKS safety cap.
 */
export async function runLogScan({ fetchChunk, from, to, chunkSize = LOG_CHUNK, maxChunks = null } = {}) {
  if (typeof fetchChunk !== "function") throw new Error("runLogScan: fetchChunk must be a function");
  const plan = planLogScan({ from, to, chunkSize });
  if (maxChunks !== null) {
    const budget = bigintOf(maxChunks);
    if (budget === null || budget <= 0n) throw new Error("runLogScan: maxChunks must be a positive integer");
    if (BigInt(plan.length) > budget) {
      throw new Error(
        `log scan would need ${plan.length} chunks (> ${budget}): refusing to certify a one-shot from a partial scan`,
      );
    }
  }
  const logs = [];
  for (const chunk of plan) {
    let part;
    try {
      part = await fetchChunk(chunk.from, chunk.to);
    } catch (err) {
      throw new Error(
        `log-scan chunk ${chunk.from}-${chunk.to} could not be read: refusing to certify a one-shot from a partial scan`,
        { cause: err },
      );
    }
    if (!Array.isArray(part)) {
      throw new Error(
        `log-scan chunk ${chunk.from}-${chunk.to} returned a non-array result: refusing to certify a one-shot from a partial scan`,
      );
    }
    for (const item of part) logs.push(item);
  }
  return { logs, from: plan[0].from, to: plan[plan.length - 1].to, chunks: BigInt(plan.length) };
}

// ---------------------------------------------------------------------------
// Adaptive chunking — same complete coverage, far fewer requests
// ---------------------------------------------------------------------------

/**
 * Clamps a requested chunk width into [min, max] and rejects garbage.
 *
 * `min` defaults to LOG_CHUNK (the reviewed floor) and `max` to
 * MAX_SAFE_LOG_CHUNK (the reviewed ceiling), so an operator-supplied
 * SMOKE_DELEGATED_MAX_LOG_CHUNK can only ever make the scan MORE conservative:
 * a value above the ceiling is capped at it and a value below the floor is
 * raised to it. Nothing here may widen a request past MAX_SAFE_LOG_CHUNK.
 */
export function clampChunkSize(value, { min = LOG_CHUNK, max = MAX_SAFE_LOG_CHUNK } = {}) {
  const lo = bigintOf(min);
  const hi = bigintOf(max);
  if (lo === null || hi === null || lo <= 0n || hi < lo) {
    throw new Error(`clampChunkSize: bounds must satisfy 0 < min <= max (got ${String(min)} .. ${String(max)})`);
  }
  const size = bigintOf(value);
  if (size === null || size <= 0n) throw new Error(`clampChunkSize: chunk size must be a positive integer (got ${String(value)})`);
  if (size < lo) return lo;
  if (size > hi) return hi;
  return size;
}

/**
 * The next width a shrink may fall back to: halved, never below `min`.
 * Deterministic and strictly decreasing, so a scan can only shrink a finite
 * number of times before it either succeeds or fails closed.
 */
export function shrinkChunkSize(size, min = LOG_CHUNK) {
  const floor = bigintOf(min) ?? LOG_CHUNK;
  const current = bigintOf(size);
  if (current === null || current <= 0n) throw new Error(`shrinkChunkSize: chunk size must be a positive integer (got ${String(size)})`);
  if (current <= floor) return floor;
  const halved = current / 2n;
  return halved < floor ? floor : halved;
}

/**
 * Validates an ascending probe ladder inside [min, max] and returns the widths
 * strictly above `current`. A malformed ladder throws: the probe must never run
 * on widths nobody reviewed.
 */
export function probeWidthsAbove(current, { ladder = LOG_CHUNK_PROBE_LADDER, min = LOG_CHUNK, max = MAX_SAFE_LOG_CHUNK } = {}) {
  if (!Array.isArray(ladder) || ladder.length === 0) throw new Error("probeWidthsAbove: ladder must be a non-empty array");
  const widths = ladder.map((w) => bigintOf(w));
  if (widths.some((w) => w === null || w <= 0n)) throw new Error("probeWidthsAbove: every ladder entry must be a positive integer");
  for (let i = 1; i < widths.length; i++) {
    if (widths[i] <= widths[i - 1]) throw new Error("probeWidthsAbove: ladder must be strictly ascending");
  }
  const lo = clampChunkSize(min, { min, max });
  const hi = clampChunkSize(max, { min, max });
  // Rungs outside the reviewed window are dropped, not an error: an operator
  // who lowers the ceiling simply gets a shorter ladder.
  const usable = widths.filter((w) => w >= lo && w <= hi);
  if (usable.length === 0) throw new Error(`probeWidthsAbove: ladder has no width inside [${lo}, ${hi}]`);
  const from = bigintOf(current) ?? lo;
  return usable.filter((w) => w > from);
}

/**
 * Discovers the widest eth_getLogs width THIS endpoint actually serves, by
 * asking it — one request per width, ascending, with the real scan filter.
 *
 * `requestChunk(width)` must issue a real `eth_getLogs` of exactly `width`
 * blocks against the endpoint under test and resolve with the (possibly empty)
 * log array. Rules, all of them deliberate:
 *   * a width is only ever accepted after the endpoint SERVED it — nothing is
 *     assumed from a provider's marketing page, and no width above `maxChunk`
 *     is ever requested;
 *   * the first refusal (a range/size error) stops the probe: the widest
 *     previously served width is the answer, and the refused width is recorded
 *     so it is never retried;
 *   * a quota/429 or any other error also stops the probe instead of hammering
 *     the endpoint — a rate-limited endpoint is a provisioning problem the
 *     caller must fail closed on, not something to keep poking;
 *   * if the CONSERVATIVE floor width itself cannot be served, this throws: a
 *     scan that cannot read even 10 blocks must not run at all.
 */
export async function probeLogChunkSize({
  requestChunk,
  ladder = LOG_CHUNK_PROBE_LADDER,
  maxChunk = MAX_SAFE_LOG_CHUNK,
  isRangeError = (err) => classifyRpcError(err).kind === "range-limit",
  isQuotaError = (err) => classifyRpcError(err).kind === "rate-limit",
} = {}) {
  if (typeof requestChunk !== "function") throw new Error("probeLogChunkSize: requestChunk must be a function");
  const widths = probeWidthsAbove(0n, { ladder, max: maxChunk });
  const accepted = [];
  let refused = null;
  let unavailable = null;
  for (const width of widths) {
    try {
      await requestChunk(width);
      accepted.push(width);
    } catch (err) {
      if (isRangeError(err)) refused = { chunkSize: width, detail: safeErrorMessage(err) };
      else unavailable = { chunkSize: width, detail: isQuotaError(err) ? RPC_RATE_LIMITED_MESSAGE : safeErrorMessage(err) };
      break; // never retry the same width, never keep probing a refusing endpoint
    }
  }
  const floor = clampChunkSize(LOG_CHUNK, { max: maxChunk });
  if (accepted.length === 0) {
    // Not even the conservative floor was served: there is nothing to certify with.
    throw new Error(
      `${refused ? `the endpoint refuses even a ${floor}-block eth_getLogs range` : "the endpoint could not serve a probe eth_getLogs"}: ${
        (refused ?? unavailable).detail
      }`,
    );
  }
  return { chunkSize: accepted[accepted.length - 1], accepted, refused, unavailable };
}

/**
 * The adaptive superset of `runLogScan`: the same complete, ordered, gap-free
 * certification, but allowed to fall back to narrower requests when THIS
 * endpoint rejects a range.
 *
 * Guarantees (identical to runLogScan, and asserted by the tests):
 *   * ascending deterministic order, zero gaps, zero overlaps, first and last
 *     block included, final partial chunk intact;
 *   * no request wider than the width in force, which starts at `chunkSize`
 *     (already clamped to [minChunk, maxChunk]) and only ever DECREASES;
 *   * a width is refused at most once per scan — an oversized range is never
 *     retried indefinitely;
 *   * FAILS CLOSED on any chunk that cannot be read for any other reason, on a
 *     non-array result, and on a range error that arrives at the floor width;
 *   * the chunk and block budgets are enforced BEFORE the first request, using
 *     the WORST case (the floor width), so shrinking can never push the scan
 *     past its budget unnoticed.
 *
 * It never widens: growth happens only in `probeLogChunkSize`, before the scan.
 */
export async function runAdaptiveLogScan({
  fetchChunk,
  from,
  to,
  chunkSize = LOG_CHUNK,
  maxChunk = MAX_SAFE_LOG_CHUNK,
  minChunk = LOG_CHUNK,
  maxChunks = null,
  maxBlocks = null,
  isRangeError = (err) => classifyRpcError(err).kind === "range-limit",
  onShrink = null,
} = {}) {
  if (typeof fetchChunk !== "function") throw new Error("runAdaptiveLogScan: fetchChunk must be a function");
  const start = bigintOf(from);
  const end = bigintOf(to);
  if (start === null || end === null) throw new Error("runAdaptiveLogScan: from/to must be integers");
  if (start > end) throw new Error(`runAdaptiveLogScan: empty/inverted range (${start} > ${end})`);
  const floor = clampChunkSize(minChunk, { min: 1n, max: maxChunk });
  const ceiling = clampChunkSize(maxChunk, { min: floor, max: MAX_SAFE_LOG_CHUNK });
  let size = clampChunkSize(chunkSize, { min: floor, max: ceiling });

  const span = end - start + 1n;
  if (maxBlocks !== null) {
    const budget = bigintOf(maxBlocks);
    if (budget === null || budget <= 0n) throw new Error("runAdaptiveLogScan: maxBlocks must be a positive integer");
    if (span > budget) {
      throw new Error(
        `log scan covers ${span} blocks (> ${budget}): refusing to certify a one-shot from a partial scan`,
      );
    }
  }
  if (maxChunks !== null) {
    const budget = bigintOf(maxChunks);
    if (budget === null || budget <= 0n) throw new Error("runAdaptiveLogScan: maxChunks must be a positive integer");
    // Worst case: every request at the floor width.
    const worstCase = (span + floor - 1n) / floor;
    if (worstCase > budget) {
      throw new Error(
        `log scan would need ${worstCase} chunks (> ${budget}): refusing to certify a one-shot from a partial scan`,
      );
    }
  }

  const logs = [];
  const shrinks = [];
  const refusedWidths = new Set();
  let requests = 0n;
  let cursor = start;
  while (cursor <= end) {
    const hi = cursor + size - 1n > end ? end : cursor + size - 1n;
    let part;
    try {
      part = await fetchChunk(cursor, hi);
    } catch (err) {
      const canShrink = isRangeError(err) && size > floor && !refusedWidths.has(size);
      if (!canShrink) {
        throw new Error(
          `log-scan chunk ${cursor}-${hi} could not be read: refusing to certify a one-shot from a partial scan`,
          { cause: err },
        );
      }
      refusedWidths.add(size);
      const next = shrinkChunkSize(size, floor);
      shrinks.push({ from: size, to: next, at: cursor });
      if (typeof onShrink === "function") onShrink({ from: size, to: next, at: cursor, detail: safeErrorMessage(err) });
      size = next; // retry the SAME block from a narrower width — coverage is never skipped
      continue;
    }
    if (!Array.isArray(part)) {
      throw new Error(
        `log-scan chunk ${cursor}-${hi} returned a non-array result: refusing to certify a one-shot from a partial scan`,
      );
    }
    for (const item of part) logs.push(item);
    requests += 1n;
    cursor = hi + 1n;
  }
  return {
    logs,
    from: start,
    to: end,
    chunks: requests,
    chunkSize: size,
    requestedChunkSize: clampChunkSize(chunkSize, { min: floor, max: ceiling }),
    shrinks,
  };
}

// ---------------------------------------------------------------------------
// RPC failure classification — 429/quota is NOT the same thing as a bad range
// ---------------------------------------------------------------------------

/** HTTP statuses that mean "you have exceeded your quota", not "bad request". */
export const RATE_LIMIT_HTTP_STATUSES = Object.freeze([402, 403, 429]);
/** JSON-RPC codes providers use for quota/limit exhaustion. */
export const RATE_LIMIT_RPC_CODES = Object.freeze([-32005, -32029, -32429]);

const RATE_LIMIT_TEXT = [
  /too many requests/i,
  /rate ?limit/i,
  /usage limit/i,
  /request limit/i,
  /quota/i,
  /compute[- ]units? per second/i,
  /\bcu\/s\b/i,
  /exceeded your (current )?(plan|quota|usage)/i,
  /daily (request|usage) limit/i,
  /monthly (request|usage) limit/i,
  /over your current quota/i,
  /please (slow down|retry later|try again later)/i,
  /\b1rpc\b.*\b(usage|limit)\b/i,
  /\b429\b/,
  /try again in \d/i,
];

const RANGE_LIMIT_TEXT = [
  /eth_getlogs is limited to/i,
  /exceed(s|ed)? (the )?maximum block range/i,
  /exceed(s|ed)? maximum block range/i,
  /maximum block range/i,
  /block range (is )?too (large|wide|long)/i,
  /exceeds the (maximum|allowed|configured) (block )?range/i,
  /limited to \d+ blocks/i,
  /at most \d+ blocks/i,
  /range (is )?(too large|limited)/i,
  /query returned more than \d+ results/i,
  /response size should not (be )?greater than/i,
  /log response size exceeded/i,
  /result on the backend was too large/i,
  /query timeout exceeded/i, // geth: the range is too expensive to scan — narrow it
  /eth_getlogs and target block range should/i,
  /block range too large/i,
  /exceeds the range/i,
];

/** Collects every human-readable fragment of a (possibly nested) error. */
function errorTextOf(err) {
  const parts = [];
  const seen = new Set();
  let node = err;
  for (let depth = 0; node && depth < 8; depth++) {
    if (typeof node !== "object" || seen.has(node)) break;
    seen.add(node);
    for (const key of ["shortMessage", "details", "message", "body"]) {
      const value = node[key];
      if (typeof value === "string" && value.length > 0) parts.push(value);
    }
    node = node.cause;
  }
  if (parts.length === 0 && err) parts.push(String(err));
  return parts.join(" | ");
}

/** The HTTP status carried anywhere in an error chain, or null. */
function httpStatusOf(err) {
  const seen = new Set();
  let node = err;
  for (let depth = 0; node && typeof node === "object" && depth < 8; depth++) {
    if (seen.has(node)) break;
    seen.add(node);
    const status = node.status ?? node.statusCode ?? node.httpStatus;
    if (typeof status === "number" && Number.isFinite(status)) return status;
    node = node.cause;
  }
  return null;
}

/** The JSON-RPC error code carried anywhere in an error chain, or null. */
function rpcCodeOf(err) {
  const seen = new Set();
  let node = err;
  for (let depth = 0; node && typeof node === "object" && depth < 8; depth++) {
    if (seen.has(node)) break;
    seen.add(node);
    const code = node.code;
    if (typeof code === "number" && Number.isInteger(code)) return code;
    node = node.cause;
  }
  return null;
}

/**
 * Reads a `Retry-After` header value: either delta-seconds ("120") or an
 * HTTP-date ("Wed, 21 Oct 2015 07:28:00 GMT"). Returns milliseconds to wait
 * (never negative), or null when the value is absent/unparseable.
 */
export function parseRetryAfter(value, { nowMs = Date.now() } = {}) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : null;
  const text = String(value).trim();
  if (text === "") return null;
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return seconds > 0 ? seconds * 1000 : null;
  }
  // Only an HTTP-date shape is parsed; anything else is junk, not a date.
  if (!/^[A-Za-z]{3}, \d{1,2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) return null;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  const delta = at - (typeof nowMs === "number" ? nowMs : Date.now());
  return delta > 0 ? delta : 0;
}

/**
 * Classifies an RPC failure into the four kinds this campaign must treat
 * differently:
 *   `rate-limit`  HTTP 429 / quota / compute-unit cap — a PROVISIONING failure:
 *                 bounded backoff that honours Retry-After, then FAIL CLOSED.
 *   `range-limit` the endpoint refuses a range this wide — shrink the chunk.
 *   `revert`      a deterministic eth_call revert — never retried, never masked.
 *   `transient`   network/5xx/timeout — the transport's ordinary bounded retry.
 * Never throws; unknown failures are `unknown` (retried like `transient`).
 */
export function classifyRpcError(err, { nowMs = Date.now() } = {}) {
  const text = errorTextOf(err);
  const status = httpStatusOf(err);
  const code = rpcCodeOf(err);
  const retryAfterMs = parseRetryAfter(
    err?.headers?.get?.("retry-after") ?? err?.retryAfter ?? err?.cause?.headers?.get?.("retry-after"),
    { nowMs },
  );
  if (status !== null && RATE_LIMIT_HTTP_STATUSES.includes(status)) {
    return { kind: "rate-limit", status, code, retryAfterMs, reason: `HTTP ${status}` };
  }
  if (/revert/i.test(text) || code === 3) {
    return { kind: "revert", status, code, retryAfterMs: null, reason: "contract revert" };
  }
  if ((code !== null && RATE_LIMIT_RPC_CODES.includes(code)) || RATE_LIMIT_TEXT.some((re) => re.test(text))) {
    return { kind: "rate-limit", status, code, retryAfterMs, reason: "provider quota / rate limit" };
  }
  if (RANGE_LIMIT_TEXT.some((re) => re.test(text))) {
    return { kind: "range-limit", status, code, retryAfterMs: null, reason: "eth_getLogs range limit" };
  }
  if (status !== null && status >= 500) {
    return { kind: "transient", status, code, retryAfterMs, reason: `HTTP ${status}` };
  }
  return { kind: "unknown", status, code, retryAfterMs, reason: text.slice(0, 160) || "unclassified" };
}

/**
 * The bounded wait before the next attempt after a rate-limit response:
 * exponential from `baseMs`, capped at `maxMs`, and never shorter than the
 * provider's own `Retry-After`. A `Retry-After` longer than `retryAfterCapMs`
 * is reported as `exceedsBudget` — the caller must fail closed rather than
 * sleep the whole job away. Deterministic unless `jitterMs` is given.
 */
export function rateLimitBackoffMs({
  attempt,
  retryAfterMs = null,
  baseMs = RATE_LIMIT_BACKOFF_BASE_MS,
  maxMs = RATE_LIMIT_BACKOFF_MAX_MS,
  retryAfterCapMs = RETRY_AFTER_MAX_MS,
  jitterMs = 0,
} = {}) {
  const n = typeof attempt === "number" ? attempt : Number(attempt);
  if (!Number.isInteger(n) || n < 1) throw new Error(`rateLimitBackoffMs: attempt must be an integer >= 1 (got ${String(attempt)})`);
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.min(n - 1, 10)) + (jitterMs > 0 ? jitterMs : 0);
  const retryAfter = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : null;
  if (retryAfter === null) return { waitMs: exponential, source: "exponential", exceedsBudget: false };
  if (retryAfter > retryAfterCapMs) return { waitMs: retryAfter, source: "retry-after", exceedsBudget: true };
  return { waitMs: Math.max(exponential, retryAfter), source: "retry-after", exceedsBudget: false };
}

/**
 * The single rate-limit retry decision. BUDGETED: after `maxAttempts` attempts
 * (RATE_LIMIT_MAX_ATTEMPTS = 4 by default) it stops, and it stops early when
 * the provider's own `Retry-After` is longer than the budget can absorb. The
 * caller FAILS CLOSED on `retry: false` — there is no public endpoint to
 * rotate into and no unbounded loop.
 */
export function shouldRetryRateLimit({
  attempt,
  maxAttempts = RATE_LIMIT_MAX_ATTEMPTS,
  retryAfterMs = null,
  baseMs = RATE_LIMIT_BACKOFF_BASE_MS,
  maxMs = RATE_LIMIT_BACKOFF_MAX_MS,
  retryAfterCapMs = RETRY_AFTER_MAX_MS,
  jitterMs = 0,
} = {}) {
  const n = typeof attempt === "number" ? attempt : Number(attempt);
  const cap = typeof maxAttempts === "number" ? maxAttempts : Number(maxAttempts);
  if (!Number.isInteger(n) || n < 1) throw new Error(`shouldRetryRateLimit: attempt must be an integer >= 1 (got ${String(attempt)})`);
  if (!Number.isInteger(cap) || cap < 1) throw new Error(`shouldRetryRateLimit: maxAttempts must be an integer >= 1 (got ${String(maxAttempts)})`);
  const backoff = rateLimitBackoffMs({ attempt: n, retryAfterMs, baseMs, maxMs, retryAfterCapMs, jitterMs });
  if (n >= cap) {
    return { retry: false, waitMs: 0, source: backoff.source, reason: `rate-limit retry budget exhausted after ${n} attempt(s)` };
  }
  if (backoff.exceedsBudget) {
    return { retry: false, waitMs: backoff.waitMs, source: "retry-after", reason: `provider asked to wait ${backoff.waitMs}ms (> ${retryAfterCapMs}ms budget)` };
  }
  return { retry: true, waitMs: backoff.waitMs, source: backoff.source, reason: null };
}

// ---------------------------------------------------------------------------
// The historical scan's RPC filter — executor + event topic + indexed taker
// ---------------------------------------------------------------------------

/**
 * The canonical signature of the delegated executor's one event, taken from
 * contracts/executor/MPGRExecutorDelegated.sol (`RouterKind` is a uint8 enum):
 *
 *   event SwapExecuted(
 *     address indexed taker, address indexed router, bytes32 indexed intentId,
 *     address tokenIn, address tokenOut, uint256 grossAmountIn,
 *     uint256 feeAmount, uint256 swapAmountIn, uint256 amountOut,
 *     address feeRecipient, uint16 feeBps, RouterKind routerKind, uint8 flags);
 */
export const SWAP_EXECUTED_EVENT_SIGNATURE =
  "SwapExecuted(address,address,bytes32,address,address,uint256,uint256,uint256,uint256,address,uint16,uint8,uint8)";
/** topic0 of every SwapExecuted log. */
export const SWAP_EXECUTED_TOPIC = keccak256(toHex(SWAP_EXECUTED_EVENT_SIGNATURE));

/**
 * An address as an indexed topic: left-padded to 32 bytes, lowercase.
 * This is what makes the pinned wallet a TOPIC of the RPC filter instead of a
 * JavaScript filter over every executor event.
 */
export function takerTopicFor(wallet) {
  const pin = normalizeAddress(wallet, "smoke wallet");
  if (!pin.ok) throw new Error(`takerTopicFor: ${pin.detail}`);
  return pad(pin.address.toLowerCase(), { size: 32 });
}

/**
 * The exact `eth_getLogs` filter for the historical one-shot scan.
 *
 * Filtering on the indexed `taker` (the pinned smoke wallet) is REQUIRED for
 * feasibility — it is the difference between the node's index answering "any
 * SwapExecuted by this wallet in these blocks?" and shipping every executor
 * event to CI to be filtered in JavaScript. It is safe because `taker` is
 * `indexed` in the event, so the filter can only ever REMOVE logs whose
 * indexed field differs — and the scan's predicate is exactly `taker == wallet`.
 *
 * The other two indexed fields are deliberately NOT filtered, because doing so
 * would NARROW the certification:
 *   * `router`   — a prior swap through any venue must still refuse this run;
 *   * `intentId` — a prior swap under any campaign/intent must still refuse it.
 * Full block coverage (deployment -> head) stays mandatory either way; a
 * narrower filter is never a licence to skip blocks.
 *
 * `maxChunk` is the width the selected endpoint was verified to serve, so the
 * builder itself refuses an oversized request rather than trusting its caller.
 *
 * It returns the exact JSON-RPC `eth_getLogs` parameter object (hex block
 * numbers), not a viem filter: the topics this scan depends on are a safety
 * property, so they are written down here and asserted in the tests instead of
 * being left to a client library's argument handling.
 */
export function swapExecutedLogFilter({
  executor = DELEGATED_EXECUTOR,
  wallet,
  fromBlock,
  toBlock,
  maxChunk = MAX_SAFE_LOG_CHUNK,
} = {}) {
  const target = normalizeAddress(executor, "executor");
  if (!target.ok) throw new Error(`swapExecutedLogFilter: ${target.detail}`);
  const from = bigintOf(fromBlock);
  const to = bigintOf(toBlock);
  if (from === null || to === null) throw new Error("swapExecutedLogFilter: fromBlock/toBlock must be integers");
  if (from > to) throw new Error(`swapExecutedLogFilter: empty/inverted range (${from} > ${to})`);
  const ceiling = clampChunkSize(maxChunk, { min: LOG_CHUNK, max: MAX_SAFE_LOG_CHUNK });
  const span = to - from + 1n;
  if (span > ceiling) {
    throw new Error(`swapExecutedLogFilter: a ${span}-block request exceeds the endpoint's verified ${ceiling}-block limit`);
  }
  return {
    address: target.address,
    topics: [SWAP_EXECUTED_TOPIC, takerTopicFor(wallet)],
    fromBlock: numberToHex(from),
    toBlock: numberToHex(to),
  };
}

// ---------------------------------------------------------------------------
// RPC readiness gate — the historical certification's precondition
// ---------------------------------------------------------------------------

/**
 * Readiness of the ONE endpoint that will certify the historical one-shot scan.
 *
 * This gate exists so a missing, foreign, fork-shaped or rate-limited RPC fails
 * in seconds with an operator-actionable message instead of after ~13 minutes
 * of grinding tens of thousands of tiny eth_getLogs calls through public
 * endpoints (smoke run #6). It runs BEFORE the scan, in every mode:
 *   * rehearsal — the endpoint must BE the local anvil fork (a fork is the
 *     correct and only allowed source there);
 *   * preflight/live — the endpoint must be the configured dedicated mainnet
 *     RPC over https, must not be loopback/private/fork-shaped, must serve
 *     chain 8453, must have a readable head at or after the deployment block,
 *     must have served a small known eth_getLogs with the real scan filter, and
 *     must not be answering with 429/quota errors.
 * Every row is fatal: a run that cannot read the chain completely may not
 * certify a one-shot, and may not broadcast.
 */
export function evaluateRpcReadiness({
  mode,
  rpcUrl,
  chainId,
  headBlock,
  probe,
  rateLimited = false,
  retryAfterMs = null,
  chunkSize = LOG_CHUNK,
  requestedChunkSize = LOG_CHUNK,
  deployBlock = DELEGATED_DEPLOY_BLOCK,
}) {
  const checks = [];
  const stage = "2b. RPC readiness";
  const push = (name, ok, detail = "") => checks.push({ stage, name, ok: Boolean(ok), detail: String(detail), fatal: true });

  const url = typeof rpcUrl === "string" ? rpcUrl.trim() : "";
  const configured = url.length > 0;
  push(
    `a dedicated smoke RPC is configured (${RPC_ENV})`,
    configured,
    configured ? `${url.replace(/\/\/[^@/]*@/, "//<redacted>@")} (endpoint may be a secret)` : RPC_MISSING_MESSAGE,
  );

  const mainnetMode = mode === MODES.PREFLIGHT || mode === MODES.LIVE;
  if (mode === MODES.REHEARSAL) {
    push("rehearsal reads only the LOCAL anvil fork", configured && isLocalRpc(url), configured ? url : "none");
  } else if (mainnetMode) {
    push(
      `${mode} reads a REAL Base Mainnet endpoint (no local/fork RPC)`,
      configured && !isPrivateOrLocalRpc(url),
      configured ? (isPrivateOrLocalRpc(url) ? `${url} is a local/private/fork endpoint — ${mode} audits real mainnet state` : url) : "none",
    );
    push(`${mode} RPC is served over https`, configured && isHttpsRpc(url), configured ? url.replace(/^(\w+):.*/, "$1") : "none");
  }

  push(
    `the smoke RPC serves ${NETWORK_LABEL} (chainId ${CHAIN_ID})`,
    Number(chainId) === CHAIN_ID,
    chainId === undefined || chainId === null ? "chainId could not be read" : `chainId ${Number(chainId)}`,
  );

  const head = bigintOf(headBlock);
  const deploy = bigintOf(deployBlock);
  push(
    "the smoke RPC reports a readable head block at or after the deployment block",
    head !== null && deploy !== null && head >= deploy,
    head === null ? "head block could not be read" : `head ${head}, deployment ${deploy}`,
  );

  const probeOk = probe?.ok === true;
  push(
    "the smoke RPC served a small known eth_getLogs (executor + SwapExecuted topic + indexed taker)",
    probeOk,
    probeOk ? `${probe.width ?? chunkSize} blocks: ${probe.logs ?? 0} matching log(s)` : `${probe?.detail ?? "no probe result"} — ${rateLimited ? RPC_RATE_LIMITED_MESSAGE : "the historical certification cannot proceed"}`,
  );

  push(
    "the smoke RPC is not answering with HTTP 429 / quota errors",
    rateLimited !== true,
    rateLimited === true ? `${RPC_RATE_LIMITED_MESSAGE}${retryAfterMs ? ` (Retry-After ${retryAfterMs}ms)` : ""}` : "no quota response observed",
  );

  if (mainnetMode) {
    const width = bigintOf(chunkSize);
    const requested = bigintOf(requestedChunkSize);
    push(
      `the historical scan uses an eth_getLogs width this endpoint SERVED (${width} blocks, ceiling ${MAX_SAFE_LOG_CHUNK})`,
      width !== null && width >= LOG_CHUNK && width <= MAX_SAFE_LOG_CHUNK && (requested === null || width <= requested),
      `${width ?? "unknown"} block(s) per request (requested ${requested ?? "?"})`,
    );
  }

  return { checks, allowed: checks.every((c) => c.ok) };
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
export function evaluateModeGuard({ mode, rpcUrls, configuredRpcUrl, keyEnvValue, walletPinEnvValue, githubActions, emergencyDisabled }) {
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
    push(
      `preflight uses exactly ONE dedicated configured RPC endpoint (${RPC_ENV}) — no public fallback list`,
      urls.length === 1 && typeof configuredRpcUrl === "string" && configuredRpcUrl.length > 0 && urls[0] === configuredRpcUrl,
      urls.length === 0 ? RPC_MISSING_MESSAGE : `${urls.length} endpoint(s): ${urls.join(", ")}`,
    );
    push(
      "preflight RPC is NOT a local/fork endpoint (it audits real mainnet state)",
      urls.every((u) => !isPrivateOrLocalRpc(u)),
      urls.join(", ") || "none",
    );
    push("preflight reads no private key", keyEnvValue === undefined || keyEnvValue === "", keyEnvValue ? `${KEY_ENV} is set — preflight ignores it (read-only mode)` : "keyless");
    push(`${WALLET_PIN_ENV} is a valid address`, normalizeAddress(walletPinEnvValue, WALLET_PIN_ENV).ok, normalizeAddress(walletPinEnvValue, WALLET_PIN_ENV).detail);
  } else if (mode === MODES.LIVE) {
    push("live runs only inside GitHub Actions (the environment approval gate)", githubActions === "true", `GITHUB_ACTIONS='${githubActions ?? "unset"}'`);
    push(
      `live uses exactly ONE dedicated configured RPC endpoint (${RPC_ENV}) — the same one preflight certified with`,
      urls.length === 1 && typeof configuredRpcUrl === "string" && configuredRpcUrl.length > 0 && urls[0] === configuredRpcUrl,
      urls.length === 0 ? RPC_MISSING_MESSAGE : `${urls.length} endpoint(s): ${urls.join(", ")}`,
    );
    push(
      "live RPCs are NOT a local/fork endpoint",
      urls.length > 0 && urls.every((u) => !isPrivateOrLocalRpc(u)),
      urls.join(", ") || "none",
    );
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

  // -- allowance / permit state ----------------------------------------------
  // The executor is NEVER approved, and Permit2 is NEVER given a standing
  // AllowanceTransfer approval. The ONE allowance that must exist is the
  // canonical one-time ERC-20 approval to the Permit2 CONTRACT: Permit2's
  // SignatureTransfer executes `USDC.transferFrom(owner, executor, gross)`
  // itself, so a zero token allowance makes `_pullFromOwner` revert
  // `Error("TRANSFER_FROM_FAILED")` before any executor logic runs.
  push("ERC-20 allowance wallet->executor is 0 (delegated trades never rely on an approval)", bigintOf(f("walletAllowanceToExecutor")) === 0n, `${f("walletAllowanceToExecutor")}`);
  const permit2TokenAllowance = bigintOf(f("walletAllowanceToPermit2"));
  push(
    "ERC-20 allowance wallet->Permit2 covers the gross (the one-time approval every SignatureTransfer pull needs)",
    permit2TokenAllowance !== null && permit2TokenAllowance >= REQUIRED_PERMIT2_TOKEN_ALLOWANCE,
    permit2TokenAllowance === null
      ? unavailable("walletAllowanceToPermit2")
      : `${permit2TokenAllowance} raw (need >= ${REQUIRED_PERMIT2_TOKEN_ALLOWANCE}; Permit2 calls USDC.transferFrom itself)`,
  );
  push(
    "ERC-20 allowance wallet->Permit2 is exactly the campaign gross (least privilege; larger is allowed but noted)",
    permit2TokenAllowance === REQUIRED_PERMIT2_TOKEN_ALLOWANCE,
    permit2TokenAllowance === null
      ? unavailable("walletAllowanceToPermit2")
      : `${permit2TokenAllowance} raw vs exactly ${REQUIRED_PERMIT2_TOKEN_ALLOWANCE}`,
    false,
  );
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
    // The detail carries the DECODED revert (see describeContractError), so a
    // failing simulation names its cause instead of only saying "it reverted".
    const simulationCause = [f("simulationRevert"), f("simulationError")].filter((v) => typeof v === "string" && v.length > 0).join(" | ");
    push(
      "eth_call simulation of the signed delegated swap succeeds",
      f("simulationOk") === true,
      simulationCause.length > 0 ? simulationCause.slice(0, 300) : f("simulationOk") ? "ok" : unavailable("simulationOk"),
    );
    // A reverted simulation produces NO amountOut. This check must therefore
    // depend on the simulation having actually succeeded — otherwise a
    // fallback value (e.g. the quoter's number) would make the slippage proof
    // "pass" for a trade that never executed, which is exactly the misleading
    // signal that made a reverting canary look like a healthy one.
    const simulatedOut = bigintOf(f("simulationAmountOut"));
    push(
      "simulation returns amountOut >= the signed amountOutMinimum",
      f("simulationOk") === true && minOut !== null && simulatedOut !== null && simulatedOut >= minOut,
      f("simulationOk") === true
        ? `${f("simulationAmountOut")} >= ${minOut}`
        : "no simulation result — the eth_call reverted (see the preceding check for the decoded revert)",
    );
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

/**
 * True for a recorded OBSERVATION that is deliberately not a verdict.
 *
 * The only such rows are the REHEARSAL's notes about REAL MAINNET state that
 * the fork then provisions locally (the principal's mainnet USDC balance and
 * its mainnet USDC->Permit2 approval). They are derived from freshly derived,
 * never-funded fork accounts, so they are ALWAYS unsatisfied by construction —
 * recording them keeps the report honest, but letting them decide the run
 * would mean a local fork rehearsal can never succeed.
 *
 * Informational is a REHEARSAL-ONLY concept applied to reads of mainnet state
 * the fork is about to replace. It never applies to a fork-state check and
 * never to `preflight`/`live`, where those same preconditions are read from
 * the real wallet and stay fatal in `evaluateLivePreconditions`.
 */
export function isInformational(check) {
  return check?.informational === true;
}

/**
 * The checks that DECIDE the run — the single source of truth for the exit
 * code. Everything that is not an informational note must hold.
 */
export function blockingFailures(checks = []) {
  return checks.filter((c) => !c.ok && !isInformational(c));
}

export function summarizeChecks(checks = []) {
  const decisive = checks.filter((c) => !isInformational(c));
  const passed = decisive.filter((c) => c.ok).length;
  return {
    passed,
    total: decisive.length,
    failed: blockingFailures(checks).map((c) => `${c.stage}: ${c.name}`),
    informational: checks.length - decisive.length,
  };
}

/** Trims the noise out of an error before it can reach a report. */
export function safeErrorMessage(err, secrets = []) {
  const raw = err instanceof Error ? (err.shortMessage ?? err.message ?? String(err)) : String(err);
  return redact(String(raw).split("\n")[0].slice(0, 500), secrets);
}

// ---------------------------------------------------------------------------
// Revert decoding — so a failing eth_call reports WHY, not just "it reverted"
//
// `safeErrorMessage` keeps only the FIRST line of viem's `shortMessage`, and
// viem puts the actual revert reason on the SECOND line
// ("The contract function "x" reverted with the following reason:\n<reason>").
// A simulation failure therefore used to be reported as a bare
// "...reverted..." with the cause silently dropped. These helpers are pure
// (no network, no clock, no key material) so the decoding is unit-testable
// offline, exactly like every other gate in this file.
// ---------------------------------------------------------------------------

/**
 * Every custom error that can legitimately come out of the delegated swap
 * call frame: the executor's own set, the canonical Permit2 set, and the
 * OpenZeppelin v5 ERC-20 set. Order is irrelevant (selectors are unique).
 */
export const KNOWN_REVERT_SIGNATURES = Object.freeze([
  // --- MPGRExecutorDelegated (contracts/executor/MPGRExecutorDelegated.sol) --
  "ZeroAddress()",
  "NotAContract(address)",
  "FeeBpsAboveCap(uint16,uint16)",
  "InvalidFeeRecipient(address)",
  "RouterNotAllowed(address,uint8)",
  "TokenNotAllowed(address)",
  "SameToken()",
  "ZeroAmount()",
  "ZeroMinimumOutput()",
  "DeadlineExpired(uint256,uint256)",
  "InvalidRecipient(address,address)",
  "OwnerIsFeeRecipient(address)",
  "FeeMismatch(uint256,uint256)",
  "FeeRoundsToZero(uint256)",
  "InvalidTickSpacing(int24)",
  "InvalidPoolFee(uint24)",
  "UnsupportedTransferAmount(uint256,uint256)",
  "InputNotFullyConsumed(uint256,uint256)",
  "InsufficientOutput(uint256,uint256)",
  "UnwrapRequiresWethOut()",
  "NativeTransferFailed(address,uint256)",
  "UnexpectedNativeSender(address)",
  "RenounceDisabled()",
  "ConflictingAllowlist(address)",
  "InvalidWitness()",
  "NativeInputUnsupported()",
  "SwapModuleNotAllowed(address)",
  "InvalidSwapModule(address)",
  "ModuleInputNotConsumed(address,uint256,uint256)",
  // --- Pausable / Ownable (OpenZeppelin v5) ---------------------------------
  "EnforcedPause()",
  "ReentrancyGuardReentrantCall()",
  "OwnableUnauthorizedAccount(address)",
  // --- canonical Permit2 (SignatureTransfer + AllowanceTransfer) ------------
  "SignatureExpired(uint256)",
  "InvalidNonce()",
  "InvalidAmount(uint256)",
  "LengthMismatch()",
  "InvalidSignature()",
  "InvalidSigner()",
  "InvalidSignatureLength()",
  "InvalidContractSignature()",
  "AllowanceExpired(uint256)",
  "InsufficientAllowance(uint256)",
  "ExcessiveInvalidation()",
  // --- ERC-20 (OpenZeppelin v5 custom errors) -------------------------------
  "ERC20InsufficientAllowance(address,uint256,uint256)",
  "ERC20InsufficientBalance(address,uint256,uint256)",
  "ERC20InvalidApprover(address)",
  "ERC20InvalidSpender(address)",
  "ERC20InvalidReceiver(address)",
  "ERC20InvalidSender(address)",
]);

/** selector (lowercase 0x + 8 hex) -> signature, built once from the list above. */
export const KNOWN_REVERT_SELECTORS = Object.freeze(
  Object.fromEntries(KNOWN_REVERT_SIGNATURES.map((sig) => [keccak256(toHex(sig)).slice(0, 10).toLowerCase(), sig])),
);

/** `Error(string)` — the shape solmate's SafeTransferLib (and `require`) uses. */
const ERROR_STRING_SELECTOR = "0x08c379a0";
/** `Panic(uint256)` — solidity assertion/overflow panics. */
const PANIC_SELECTOR = "0x4e487b71";

const PANIC_REASONS = Object.freeze({
  0x01: "assert(false)",
  0x11: "arithmetic overflow/underflow",
  0x12: "division or modulo by zero",
  0x21: "invalid enum value",
  0x22: "invalid storage byte array encoding",
  0x31: "pop() on an empty array",
  0x32: "array index out of bounds",
  0x41: "out of memory",
  0x51: "call to an uninitialized internal function",
});

/** Decodes an ABI-encoded `string` that starts at `words[0]` (offset form). */
function decodeAbiString(body) {
  if (body.length < 128) return null;
  const offset = Number(BigInt(`0x${body.slice(0, 64)}`));
  const start = offset * 2;
  if (!Number.isSafeInteger(offset) || body.length < start + 64) return null;
  const length = Number(BigInt(`0x${body.slice(start, start + 64)}`));
  if (!Number.isSafeInteger(length) || length > 1024) return null;
  const hex = body.slice(start + 64, start + 64 + length * 2);
  if (hex.length !== length * 2) return null;
  try {
    return Buffer.from(hex, "hex").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Decodes raw EVM revert data into `{ selector, kind, name, reason, text }`.
 * Never throws — unknown data is reported verbatim (truncated) so an operator
 * can still paste it into a decoder.
 */
export function decodeRevertData(data) {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]*$/.test(data)) {
    return { selector: null, kind: "none", name: null, reason: null, text: "no revert data" };
  }
  if (data === "0x" || data.length < 10) {
    return {
      selector: null,
      kind: "empty",
      name: null,
      reason: null,
      text: "reverted with EMPTY return data (out-of-gas, invalid opcode, or a bare revert())",
    };
  }
  const selector = data.slice(0, 10).toLowerCase();
  const body = data.slice(10);
  if (selector === ERROR_STRING_SELECTOR) {
    const reason = decodeAbiString(body);
    return {
      selector,
      kind: "Error(string)",
      name: "Error",
      reason,
      text: reason === null ? `Error(string) with undecodable payload ${data.slice(0, 74)}` : `Error("${reason}")`,
    };
  }
  if (selector === PANIC_SELECTOR) {
    const code = body.length >= 64 ? Number(BigInt(`0x${body.slice(0, 64)}`)) : null;
    const reason = code !== null ? (PANIC_REASONS[code] ?? `panic code 0x${code.toString(16)}`) : null;
    return { selector, kind: "Panic(uint256)", name: "Panic", reason, text: `Panic(${reason ?? "unknown"})` };
  }
  const signature = KNOWN_REVERT_SELECTORS[selector];
  if (signature) {
    const name = signature.slice(0, signature.indexOf("("));
    return { selector, kind: "custom", name, reason: null, text: `${signature} [${selector}]` };
  }
  return { selector, kind: "unknown", name: null, reason: null, text: `unknown revert selector ${selector} data ${data.slice(0, 138)}` };
}

/** Pulls the first `0x…` revert payload out of a (possibly nested) error object. */
function revertDataOf(err) {
  const seen = new Set();
  let node = err;
  for (let depth = 0; node && typeof node === "object" && depth < 12; depth++) {
    if (seen.has(node)) break;
    seen.add(node);
    for (const key of ["data", "raw", "returnData"]) {
      const value = node[key];
      if (typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value) && value.length >= 10) return value;
      // viem wraps decoded errors as { data: { errorName, args } }
      if (value && typeof value === "object" && typeof value.errorName === "string") {
        return { errorName: value.errorName, args: value.args };
      }
    }
    node = node.cause;
  }
  return null;
}

/**
 * A single-line, SECRET-REDACTED description of a contract call failure that
 * keeps the decoded revert instead of dropping it.
 *
 * Used for the delegated swap's eth_call simulation, so a failing rehearsal or
 * preflight names the exact on-chain cause (e.g.
 * `Error("TRANSFER_FROM_FAILED")` — the Permit2 pull — rather than a bare
 * "execution reverted").
 */
export function describeContractError(err, secrets = []) {
  const parts = [];
  const payload = revertDataOf(err);
  let decoded = null;
  if (typeof payload === "string") {
    decoded = decodeRevertData(payload);
    parts.push(decoded.text);
  } else if (payload && typeof payload === "object") {
    const args = Array.isArray(payload.args) ? payload.args.map((a) => String(a)).join(", ") : "";
    decoded = { selector: null, kind: "custom", name: payload.errorName, reason: null, text: `${payload.errorName}(${args})` };
    parts.push(decoded.text);
  }
  const message = err instanceof Error ? (err.shortMessage ?? err.message ?? String(err)) : String(err);
  const flattened = String(message).replace(/\s*\n+\s*/g, " | ").trim();
  if (flattened.length > 0) parts.push(flattened);
  const joined = parts.join(" — ") || "unknown error";
  return { detail: redact(joined.slice(0, 500), secrets), decoded };
}
