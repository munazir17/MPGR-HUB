#!/usr/bin/env node
// Dedicated Base Mainnet smoke/canary test for **MPGRExecutorDelegated**
// (0x39B1C6Ea88A01e70cbF4899BF3cEfB2c43cD32Bb) — the delegated, Permit2
// witness-permit executor. It is SEPARATE from script/smoke-executor-base-mainnet.mjs
// (the v1 assisted-executor smoke test), which is not modified, not imported
// and not reused here in any form.
//
// What it does — exactly one trade:
//   0.50 USDC -> WETH through the official Base Uniswap V3 SwapRouter02,
//   authorized by a user-signed Permit2 witness permit and redeemed by
//   MPGRExecutorDelegated.swapOnBehalfOfUniswapV3 (the deployed delegated
//   path), with the 25 bps MPGR fee taken atomically inside the same swap.
//   No ERC-20 approval is ever created, requested or relied upon.
//
// Modes (SMOKE_DELEGATED_MODE):
//   rehearsal  Local anvil fork of Base Mainnet (RPC must be 127.0.0.1 /
//              localhost). Signs with FORK-ONLY, deterministically derived
//              principals (public labels; no key material exists in this repo),
//              funds them on the fork only, and executes the whole sequence —
//              including a SEPARATE broadcaster account, which the single-key
//              live canary cannot exercise, so "anyone may broadcast a
//              user-signed permit and nobody may redirect the output" is really
//              rehearsed. The env key is never read. Nothing is broadcast to
//              Base Mainnet.
//   preflight  Strictly READ-ONLY against real Base Mainnet for the pinned
//              smoke wallet: the whole precondition table is evaluated and
//              printed; nothing is signed and no key is read at all. The live
//              job may not start unless this is green.
//   live       Real Base Mainnet. The key is read ONLY from
//              SMOKE_DELEGATED_PRIVATE_KEY and its derived address MUST equal
//              the non-secret SMOKE_DELEGATED_WALLET_ADDRESS pin. Re-runs every
//              precondition, claims the one-shot ledger exclusively, signs,
//              sends exactly ONE transaction, then verifies the confirmed
//              receipt, events, transfers and balance deltas on-chain.
//
// Hard rules (decided in scripts/delegated-smoke-gates.mjs, enforced here):
//   * a fresh, dedicated smoke wallet — the v1 smoke wallet, the Phase-5/6
//     canary wallet, the deployer, the owner, the fee recipient, both
//     executors and every venue address are refused by denylist;
//   * the target is MPGRExecutorDelegated — never MPGRExecutor v1 (0xD982…505A
//     is denylisted and is structurally incapable of delegated execution);
//   * chain id, executor posture, venue/router/quoter/pool, token allowlist,
//     owner/pending-owner, fee, funding, allowance/permit state, the EIP-712
//     witness encoding and the one-shot guards are ALL validated before the
//     live step. The gate runs TWICE: once before the key is used to sign (the
//     pre-sign pass) and once over the exact signed+simulated payload before
//     anything is broadcast; any fatal failure aborts there and then.
//   * this script never deploys, never approves, never pauses, never
//     reconfigures, and never retries a broadcast.
//
// Outputs: SMOKE_DELEGATED_JSON (machine readable) + SMOKE_DELEGATED_MD
// (human report). Exit code 0 only when every check passed.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  formatUnits,
  getEventSelector,
  getAddress,
  hexToBigInt,
  http,
  keccak256,
  pad,
  parseAbi,
  parseEventLogs,
  toHex,
  verifyTypedData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import {
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
  EMERGENCY_ENV,
  EXPECTED_FEE_AMOUNT,
  EXPECTED_GAS_LIMIT,
  EXPLORER,
  FEE_BPS,
  FEE_RECIPIENT,
  GROSS_AMOUNT_IN,
  KEY_ENV,
  LEDGER_ACK_ENV,
  LEDGER_DIR,
  LEDGER_DIR_ENV,
  LEDGER_VERSION,
  LOG_CHUNK,
  LOG_SCAN_CHUNK_MAX_ATTEMPTS,
  LOG_SCAN_LATENCY_ESTIMATE_MS,
  LOG_SCAN_CONCURRENCY,
  LOG_SCAN_PACE_ENV,
  LOG_SCAN_TAIL_MAX_ROUNDS,
  LOG_SCAN_TIME_BUDGET_MS,
  FREE_TIER_MAX_LOG_BLOCKS,
  MAX_FEE_PER_GAS_CAP,
  MAX_LOG_CHUNK_ENV,
  MAX_LOG_SCAN_BLOCKS,
  MODES,
  NETWORK_LABEL,
  OWNER,
  PRIORITY_FEE_CAP,
  REHEARSAL_LOG_WINDOW,
  REQUIRED_PERMIT2_TOKEN_ALLOWANCE,
  REVIEWED_CONFIG_PATH,
  RPC_ENV,
  RPC_MISSING_MESSAGE,
  RPC_RATE_LIMITED_MESSAGE,
  SLIPPAGE_BPS,
  SWAP_AMOUNT_IN,
  UNISWAP_V3_FACTORY,
  UNISWAP_V3_POOL,
  UNISWAP_V3_POOL_FEE,
  UNISWAP_V3_QUOTER,
  UNISWAP_V3_ROUTER,
  USDC,
  USDC_DECIMALS,
  V1_MAINNET_EXECUTOR,
  WALLET_PIN_ENV,
  WETH_DECIMALS,
  actionWitnessHash,
  buildActionWitness,
  buildLedgerEntry,
  buildPermit2Authorization,
  buildPermitTypedData,
  blockingFailures,
  buildSwapParams,
  canaryIdentityFor,
  classifyRpcError,
  clampPaceMs,
  describeContractError,
  evaluateConfigPins,
  evaluateLedgerClaim,
  evaluateLedgerGuard,
  evaluateLivePreconditions,
  evaluateModeGuard,
  evaluatePostTradeVerification,
  evaluateRpcReadiness,
  evaluateSignerIdentity,
  isPrivateKeyShape,
  minOutFromQuote,
  nonceBitPosition,
  nonceBitmapWordMarks,
  normalizeAddress,
  parseRetryAfter,
  planHistoricalLogScan,
  priorSwapScanWindow,
  RATE_LIMIT_HTTP_STATUSES,
  redact,
  renderTitle,
  rehearsalPrincipal,
  runCertifiedLogScan,
  safeErrorMessage,
  sameAddress,
  scanChunkSize,
  shouldRetryRateLimit,
  summarizeChecks,
  swapExecutedLogFilter,
  SWAP_EXECUTED_TOPIC,
} from "../scripts/delegated-smoke-gates.mjs";

// ---------------------------------------------------------------------------
// ABIs — only what this one canary needs. The delegated entrypoint mirrors
// contracts/executor/MPGRExecutorDelegated.sol exactly. The v1 ABI artifact
// (deployments/base-mainnet/MPGRExecutor.abi.json) is deliberately NOT used:
// it does not contain the delegated entrypoints.
// ---------------------------------------------------------------------------

const SWAP_PARAMS_COMPONENTS = [
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
];
const WITNESS_COMPONENTS = [
  { name: "owner", type: "address" },
  { name: "buyToken", type: "address" },
  { name: "minAmountOut", type: "uint256" },
  { name: "deadline", type: "uint256" },
  { name: "actionId", type: "bytes32" },
  { name: "policyHash", type: "bytes32" },
];
const PERMIT_COMPONENTS = [
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
];
const AUTH_COMPONENTS = [
  { name: "permit", type: "tuple", components: PERMIT_COMPONENTS },
  { name: "witness", type: "tuple", components: WITNESS_COMPONENTS },
  { name: "signature", type: "bytes" },
];

const fn = (name, inputs, outputs, stateMutability = "view") => ({ type: "function", name, stateMutability, inputs, outputs });
const addrArg = (name = "") => ({ name, type: "address" });
const addrOut = { type: "address" };
const boolOut = { type: "bool" };

const DELEGATED_ABI = [
  fn(
    "swapOnBehalfOfUniswapV3",
    [
      { name: "p", type: "tuple", components: SWAP_PARAMS_COMPONENTS },
      { name: "poolFee", type: "uint24" },
      { name: "auth", type: "tuple", components: AUTH_COMPONENTS },
    ],
    [{ name: "amountOut", type: "uint256" }],
    "payable",
  ),
  fn("owner", [], [addrOut]),
  fn("pendingOwner", [], [addrOut]),
  fn("paused", [], [boolOut]),
  fn("feeBps", [], [{ type: "uint16" }]),
  fn("MAX_FEE_BPS", [], [{ type: "uint16" }]),
  fn("feeRecipient", [], [addrOut]),
  fn("WETH", [], [addrOut]),
  fn("PERMIT2", [], [addrOut]),
  fn("WITNESS_TYPE_STRING", [], [{ type: "string" }]),
  fn("ACTION_WITNESS_STRUCT_TYPE_STRING", [], [{ type: "string" }]),
  fn("ACTION_WITNESS_TYPEHASH", [], [{ type: "bytes32" }]),
  fn("isTokenAllowed", [addrArg("token")], [boolOut]),
  fn("routerKind", [addrArg("router")], [{ name: "kind", type: "uint8" }]),
  fn("swapModuleForRouter", [addrArg("router")], [addrOut]),
  fn("swapModuleCodeHash", [addrArg("router")], [{ type: "bytes32" }]),
  fn("quoteFee", [{ name: "grossAmountIn", type: "uint256" }], [
    { name: "fee", type: "uint256" },
    { name: "swapAmount", type: "uint256" },
  ]),
  fn("witnessHashOf", [{ name: "w", type: "tuple", components: WITNESS_COMPONENTS }], [{ type: "bytes32" }]),
  {
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
  },
];

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
]);
const PERMIT2_ABI = parseAbi([
  "function nonceBitmap(address owner, uint256 word) view returns (uint256)",
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration)",
]);
const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const FACTORY_ABI = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)"]);
const SWAP_EXECUTED_EVENT = DELEGATED_ABI.find((x) => x.type === "event" && x.name === "SwapExecuted");

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
const env = (name) => (process.env[name] ?? "").trim();

const MODE = env("SMOKE_DELEGATED_MODE");
const LIVE = MODE === MODES.LIVE;
const PREFLIGHT = MODE === MODES.PREFLIGHT;
const REHEARSAL = MODE === MODES.REHEARSAL;

// ONE endpoint per run, in every mode. There is deliberately NO public-fallback
// list any more:
//   * rehearsal -> the local anvil fork (http://127.0.0.1:8545);
//   * preflight/live -> the dedicated configured smoke RPC (RPC_ENV, supplied by
//     the workflow from the BASE_MAINNET_RPC_URL secret).
// Rotating through public Base endpoints used to look like resilience, but the
// historical certification is a long walk of small eth_getLogs calls, so a
// fallback list only spread the load until EVERY endpoint answered 429 ("1rpc
// usage limit exceeded", compute-unit/sec caps) — smoke run #6's preflight died
// that way after ~13 minutes. A rate-limited endpoint is a fail-closed
// provisioning error with an operator message, never a cue to grind.
//
// The ONE configured endpoint does not have to be provisioned beyond its free
// tier any more: the walk is capped at the range that tier accepts (10 blocks),
// runs one request at a time, and paces itself under its CU/s throughput. The
// price of that is time, and the time is budgeted explicitly
// (LOG_SCAN_TIME_BUDGET_MS) instead of being paid in retries.
const RPC_URL = env(RPC_ENV);
const RPC_URLS = RPC_URL.length > 0 ? [RPC_URL] : [];

const OUT_JSON = env("SMOKE_DELEGATED_JSON") || "smoke-delegated-results.json";
const OUT_MD = env("SMOKE_DELEGATED_MD") || "smoke-delegated-report.md";
const LEDGER_DIR_PATH = resolve(process.cwd(), env(LEDGER_DIR_ENV) || LEDGER_DIR);
const CONFIRM_PHRASE = env("SMOKE_DELEGATED_CONFIRM");
const EXPECTED_CODE_HASH = env(CODE_HASH_PIN_ENV) || null;
const EMERGENCY_DISABLED = env(EMERGENCY_ENV).toLowerCase() === "true";
/**
 * The historical SwapExecuted scan is bounded on four axes, and none of the four
 * may be relaxed to make a run finish. All four are decided by the gates module
 * (`scripts/delegated-smoke-gates.mjs`) against the FREE-TIER behaviour of the
 * configured Base Mainnet RPC — nothing here assumes a wider endpoint than the
 * one this workflow is actually pointed at.
 *
 * Window: `live`/`preflight` scan from the deployment block to the observed head
 * (the full one-shot certification). `rehearsal` scans only the last
 * REHEARSAL_LOG_WINDOW blocks of the local fork — see priorSwapScanWindow.
 *
 * Requests: MAX_LOG_CHUNKS caps how many eth_getLogs calls one run may make,
 * MAX_LOG_SCAN_BLOCKS caps how many blocks it may certify and
 * LOG_SCAN_TIME_BUDGET_MS caps how long the walk may take. All three are
 * enforced BEFORE the first request (the time budget is re-checked as the walk
 * proceeds) and all three FAIL CLOSED — a run that cannot certify every block
 * refuses, it does not narrow the window to fit.
 *
 * Span: one request is at most `SCAN_CHUNK` blocks, and that width is not
 * probed, negotiated or discovered — it is clamped to FREE_TIER_MAX_LOG_BLOCKS
 * (10), the strictest maximum any Base endpoint documents (Alchemy's free tier
 * rejects anything wider outright, with "you can make eth_getLogs requests with
 * up to a 10 block range"). There is deliberately no width ladder: a request the
 * plan already knows is invalid costs 60 CU, a retry and the throughput the scan
 * needs for real coverage — which is what turned runs #6/#7 into a grind.
 * `swapExecutedLogFilter` re-asserts the bound on the way to the wire, so no
 * caller can build an oversized request.
 *
 * Concurrency: one request in flight, spaced by at least SCAN_PACE_MS
 * (~4.2 requests/s ≈ 250 CUPs/s against Alchemy's 60 CU per eth_getLogs and the
 * free tier's 300 CUPs/s throughput). A rate limit slows the scan down; it never
 * makes it skip a block, re-read a certified one, or switch endpoints.
 */
const MAX_LOG_CHUNKS = 400_000n;
/**
 * The eth_getLogs width in force for the whole run. The non-secret
 * SMOKE_DELEGATED_MAX_LOG_CHUNK variable may only LOWER it (1..10 blocks):
 * `scanChunkSize` clamps anything wider down to the free-tier maximum, so no CI
 * configuration can reintroduce a request the endpoint documents as invalid.
 */
const SCAN_CHUNK = scanChunkSize(env(MAX_LOG_CHUNK_ENV) || LOG_CHUNK);
/**
 * Milliseconds between two scan requests. SMOKE_DELEGATED_LOG_SCAN_PACE_MS may
 * only stretch it, inside [LOG_SCAN_PACE_MIN_MS, 60s]; that floor is exactly the
 * endpoint's documented throughput ceiling (5 requests/s × 60 CU = 300 CUPs/s),
 * so even the fastest legal setting cannot burst the bucket that throttled run #7.
 */
const SCAN_PACE_MS = clampPaceMs(env(LOG_SCAN_PACE_ENV));

/** The zero signature used ONLY to build and re-decode calldata in preflight. */
const UNSIGNED_SENTINEL_SIGNATURE = `0x${"00".repeat(65)}`;

// ---------------------------------------------------------------------------
// Result bookkeeping
// ---------------------------------------------------------------------------
const report = {
  campaign: CAMPAIGN,
  ledgerVersion: LEDGER_VERSION,
  mode: MODE || null,
  chainId: CHAIN_ID,
  network: NETWORK_LABEL,
  status: "running",
  stage: "init",
  abortReason: null,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  signer: null,
  broadcaster: null,
  constants: {
    executor: DELEGATED_EXECUTOR,
    executorDeployTx: DELEGATED_DEPLOY_TX,
    executorDeployBlock: DELEGATED_DEPLOY_BLOCK.toString(),
    deployer: DELEGATED_DEPLOYER,
    v1ExecutorNeverTargeted: V1_MAINNET_EXECUTOR,
    usdc: USDC,
    weth: CANONICAL_WETH,
    router: UNISWAP_V3_ROUTER,
    quoterV2: UNISWAP_V3_QUOTER,
    factory: UNISWAP_V3_FACTORY,
    pool: UNISWAP_V3_POOL,
    poolFee: UNISWAP_V3_POOL_FEE,
    permit2: CANONICAL_PERMIT2,
    owner: OWNER,
    feeRecipient: FEE_RECIPIENT,
    feeBps: Number(FEE_BPS),
    grossAmountIn: GROSS_AMOUNT_IN.toString(),
    expectedFeeAmount: EXPECTED_FEE_AMOUNT.toString(),
    swapAmountIn: SWAP_AMOUNT_IN.toString(),
    slippageBps: SLIPPAGE_BPS.toString(),
    deadlineSeconds: DEADLINE_SECONDS.toString(),
    maxFeePerGasCap: MAX_FEE_PER_GAS_CAP.toString(),
    unwrapNativeOut: false,
    authorizationKind: "PERMIT2_WITNESS_PERMIT",
    entrypoint: "swapOnBehalfOfUniswapV3",
  },
  facts: {},
  identity: null,
  txs: { swap: null },
  broadcastCount: 0,
  checks: [],
};

class Abort extends Error {}

/**
 * The dedicated smoke RPC refused to serve the historical certification because
 * it is over quota — after the scan already paced itself under the endpoint's
 * documented throughput and spent its bounded, Retry-After-aware retries on the
 * chunk that failed. Deliberately an Abort: this is a quota condition the operator
 * settles outside this run (a gentler SMOKE_DELEGATED_LOG_SCAN_PACE_MS, or waiting
 * for the quota window to refill), never something to retry endlessly, paper over
 * with a public fallback list, or downgrade to a note.
 */
class RpcRateLimited extends Abort {
  constructor(detail) {
    super(`${RPC_RATE_LIMITED_MESSAGE}${detail ? ` Last response: ${detail}` : ""}`);
    this.name = "RpcRateLimited";
  }
}

function stage(name) {
  report.stage = name;
  console.log(`\n== ${name}`);
}

function check(name, ok, detail = "", { skipped = false, stageName = report.stage, informational = false } = {}) {
  report.checks.push({
    stage: stageName,
    name,
    ok: Boolean(ok),
    detail: String(detail),
    skipped,
    ...(informational ? { informational: true } : {}),
  });
  const label = informational ? "INFO" : skipped ? "SKIP" : ok ? "PASS" : "FAIL";
  console.log(`${label}  ${name}${detail ? `  (${redact(String(detail), SECRETS).slice(0, 300)})` : ""}`);
  return Boolean(ok);
}

/**
 * A REHEARSAL-ONLY observation of REAL MAINNET state that the local fork is
 * about to provision — recorded and printed, but never a verdict.
 *
 * The rehearsal's principals are derived fresh from public labels
 * (`keccak256("mpgr-delegated-smoke-rehearsal:<label>")`), so on real mainnet
 * they hold 0 USDC and have granted Permit2 nothing. That is true BY
 * CONSTRUCTION and can never be otherwise: letting it decide the run would
 * mean the fork rehearsal always exits non-zero no matter how perfectly the
 * delegated sequence executed. The note keeps the report honest about what
 * mainnet actually looks like; the fork-state `must()` assertions that follow
 * are what the rehearsal is judged on.
 *
 * This refuses to exist outside rehearsal: `preflight` and `live` read these
 * same two preconditions from the REAL pinned wallet, where they stay FATAL
 * in `evaluateLivePreconditions`. No live gate can ever be downgraded to a
 * note by reusing this helper.
 */
function rehearsalNote(name, detail, stageName = report.stage) {
  if (!REHEARSAL) {
    throw new Abort(`internal: rehearsalNote(${JSON.stringify(name)}) is rehearsal-only — ${MODE} must enforce this precondition`);
  }
  check(name, false, detail, { stageName, informational: true });
}

/** A single must-hold check: a failure aborts before anything can be signed. */
function must(name, ok, detail = "") {
  if (!check(name, ok, detail)) throw new Abort(`${name}${detail ? ` (${redact(String(detail), SECRETS).slice(0, 200)})` : ""}`);
}

/**
 * Applies one gate group. Every check is evaluated and logged FIRST (so a
 * report always shows the complete picture), then any fatal failure aborts.
 */
function applyGate(result) {
  const fatal = [];
  for (const c of result.checks) {
    const ok = check(c.name, c.ok, c.detail, { skipped: Boolean(c.skipped), stageName: c.stage ?? report.stage });
    if (!ok && c.fatal !== false) fatal.push(`${c.stage}: ${c.name}`);
  }
  if (fatal.length > 0) {
    throw new Abort(`gate refused — ${fatal.length} fatal check(s): ${fatal.join("; ")}`.slice(0, 1500));
  }
}

function fact(key, value) {
  report.facts[key] = typeof value === "bigint" ? value.toString() : value;
}

const SECRETS = []; // every secret that ever passed through this process, for redaction
const usdcFmt = (v) => `${formatUnits(v, USDC_DECIMALS)} USDC (${v} raw)`;
const wethFmt = (v) => `${formatEther(v)} WETH (${v} wei)`;

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------
function readLiveKey() {
  const raw = process.env[KEY_ENV];
  delete process.env[KEY_ENV]; // keep it out of anything inherited later
  if (raw) SECRETS.push(String(raw));
  if (!isPrivateKeyShape(raw ?? "")) {
    throw new Abort(`${KEY_ENV} is missing or not a 32-byte 0x-hex key (value not shown)`);
  }
  try {
    return privateKeyToAccount(String(raw).trim());
  } catch {
    throw new Abort(`could not derive an account from ${KEY_ENV} (value not shown)`);
  }
}

/** Fork-only rehearsal principal (no key literal exists in this repository). */
function forkAccount(label) {
  return privateKeyToAccount(rehearsalPrincipal(label).privateKey);
}

// ---------------------------------------------------------------------------
// RPC transport: sticky endpoint, bounded retry with backoff, failover that
// never reads behind the highest block already observed, idempotent send.
// Independently implemented — the v1 smoke script is not imported.
// ---------------------------------------------------------------------------
const RPC_MAX_ATTEMPTS = 12;
const RPC_MAX_IN_FLIGHT = 2;
const RPC_FAILS_BEFORE_ROTATE = 2;
const RPC_TIMEOUT_MS = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The deterministic backoff ladder for the ordinary reads (never for the log
 * scan, which owns its own pacing). Exponential, capped, and deliberately free
 * of jitter: a CI job must be reproducible and describable in a test, and the
 * provider's own `Retry-After` — not a random sleep — is what a throttle needs.
 */
function rpcRetryBackoffMs(attempt, { baseMs = 400, maxMs = 8_000, steps = 5 } = {}) {
  const n = Number(attempt);
  if (!Number.isFinite(n) || n < 1) throw new Error(`rpcRetryBackoffMs: attempt must be >= 1 (got ${String(attempt)})`);
  return Math.min(maxMs, baseMs * 2 ** Math.min(n - 1, steps));
}

function rpcLabel(url) {
  if (url === RPC_URL && RPC_URL.length > 0) return REHEARSAL ? "local anvil fork" : "configured RPC (may be a secret endpoint)";
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

function errText(err) {
  return [err?.shortMessage, err?.details, err?.message, err?.cause?.message].filter(Boolean).join(" | ");
}

function isRevert(err) {
  return err?.code === 3 || /revert/i.test(errText(err));
}

class RpcPool {
  constructor(urls) {
    this.endpoints = urls.map((url) => {
      const endpoint = {
        url,
        label: rpcLabel(url),
        needsSyncCheck: false,
        // Quota bookkeeping per endpoint, read by the stage-2b readiness gate and
        // the report. `onFetchResponse` sees the RAW response, so a provider that
        // answers 429 with a JSON-RPC error body (which viem does not turn into
        // an HttpRequestError) is still counted, and its Retry-After is captured.
        quota: { hits: 0, lastStatus: null, lastRetryAfterMs: null },
        transport: null,
      };
      endpoint.transport = http(url, {
        retryCount: 0,
        timeout: RPC_TIMEOUT_MS,
        onFetchResponse: (response) => {
          const status = response?.status;
          if (typeof status !== "number" || !RATE_LIMIT_HTTP_STATUSES.includes(status)) return;
          endpoint.quota.hits += 1;
          endpoint.quota.lastStatus = status;
          const retryAfterMs = parseRetryAfter(response.headers?.get?.("retry-after") ?? null);
          if (retryAfterMs !== null) endpoint.quota.lastRetryAfterMs = retryAfterMs;
        },
      })({ chain: base, retryCount: 0 });
      return endpoint;
    });
    this.active = 0;
    this.fails = 0;
    this.highWater = 0n;
    this.inFlight = 0;
    this.waiters = [];
    /** Attempts already spent on quota errors; the budget is finite and shared. */
    this.quotaAttempts = 0;
  }

  /** True when any endpoint has been answered with a 429/quota response. */
  rateLimited() {
    return this.endpoints.some((ep) => ep.quota.hits > 0);
  }

  quotaFacts() {
    const ep = this.endpoints[this.active];
    return ep
      ? {
          endpoint: ep.label,
          quotaResponses: ep.quota.hits,
          lastStatus: ep.quota.lastStatus,
          lastRetryAfterMs: ep.quota.lastRetryAfterMs,
        }
      : null;
  }

  async acquire() {
    if (this.inFlight < RPC_MAX_IN_FLIGHT) {
      this.inFlight++;
      return;
    }
    await new Promise((r) => this.waiters.push(r));
    this.inFlight++;
  }

  release() {
    this.inFlight--;
    const next = this.waiters.shift();
    if (next) next();
  }

  observe(method, result) {
    let bn = null;
    try {
      if (method === "eth_blockNumber" && typeof result === "string") bn = BigInt(result);
      else if (method === "eth_getTransactionReceipt" && result?.blockNumber) bn = BigInt(result.blockNumber);
      else if ((method === "eth_getBlockByNumber" || method === "eth_getBlockByHash") && (result?.number ?? result?.blockNumber)) {
        bn = BigInt(result.number ?? result.blockNumber);
      }
    } catch {
      bn = null;
    }
    if (bn !== null && bn > this.highWater) this.highWater = bn;
  }

  rotate(reason) {
    if (this.endpoints.length < 2) return;
    const from = this.endpoints[this.active].label;
    this.active = (this.active + 1) % this.endpoints.length;
    this.endpoints[this.active].needsSyncCheck = true;
    this.fails = 0;
    console.log(`RPC   switching ${from} -> ${this.endpoints[this.active].label} (${redact(reason, SECRETS).slice(0, 160)})`);
  }

  async request(args) {
    await this.acquire();
    try {
      return await this.requestInner(args);
    } finally {
      this.release();
    }
  }

  /**
   * ONE attempt, no retry loop, no rotation, no in-flight allowance beyond the
   * pool's own cap. This is what the historical scan calls per chunk: the scan
   * owns its retry policy (same chunk, bounded attempts, paced), so a second
   * retry loop underneath it would multiply the attempts per block by
   * RPC_MAX_ATTEMPTS and turn one throttle into dozens of requests — the exact
   * failure this path must not have. A permanent refusal (an oversized range, a
   * malformed request) reaches the scan's classifier on the first attempt and
   * aborts there instead of being retried twelve times.
   */
  async requestOnce({ method, params }) {
    await this.acquire();
    try {
      const ep = this.endpoints[this.active];
      const result = await ep.transport.request({ method, params });
      this.observe(method, result);
      return result;
    } finally {
      this.release();
    }
  }

  /**
   * The `Retry-After` of the most recent quota response seen on the RAW
   * transport, which is how a 429 carrying a JSON-RPC body (viem does not raise
   * an HttpRequestError for it) still gets honoured by the caller's policy.
   */
  lastQuotaRetryAfterMs() {
    let best = null;
    for (const ep of this.endpoints) {
      const ms = ep.quota.lastRetryAfterMs;
      if (typeof ms === "number" && (best === null || ms > best)) best = ms;
    }
    return best;
  }

  async requestInner({ method, params }) {
    let lastErr;
    for (let attempt = 1; attempt <= RPC_MAX_ATTEMPTS; attempt++) {
      const ep = this.endpoints[this.active];
      try {
        if (ep.needsSyncCheck && this.highWater > 0n) {
          const head = BigInt(await ep.transport.request({ method: "eth_blockNumber" }));
          if (head < this.highWater) throw new Error(`endpoint lagging: head ${head} < observed ${this.highWater}`);
        }
        ep.needsSyncCheck = false;
        const result = await ep.transport.request({ method, params });
        this.observe(method, result);
        this.fails = 0;
        return result;
      } catch (err) {
        lastErr = err;
        if (method === "eth_sendTransaction") throw err; // node-signed (rehearsal only): never re-sent blindly
        if (method === "eth_sendRawTransaction") {
          const known = await this.sentTxHashIfKnown(params?.[0], err);
          if (known) return known;
          if (/nonce too low|insufficient funds|underpriced|exceeds the configured cap|intrinsic gas/i.test(errText(err))) throw err;
        } else if (isRevert(err)) {
          throw err; // deterministic: never retried, never masked
        }
        // A quota response gets its OWN bounded budget: Retry-After-aware, finite,
        // and fatal when exhausted. It never rotates into a public endpoint (there
        // is no fallback list any more) and never loops.
        const cls = classifyRpcError(err);
        if (cls.kind === "rate-limit") {
          this.quotaAttempts += 1;
          const decision = shouldRetryRateLimit({
            attempt: this.quotaAttempts,
            retryAfterMs: cls.retryAfterMs ?? ep.quota.lastRetryAfterMs,
          });
          if (!decision.retry) throw new RpcRateLimited(`${method} on ${ep.label}: ${decision.reason}`);
          console.log(
            `RPC   quota ${this.quotaAttempts} on ${ep.label}, waiting ${decision.waitMs}ms (${decision.source}): ${redact(errText(err), SECRETS).slice(0, 160)}`,
          );
          await sleep(decision.waitMs);
          continue;
        }
        this.fails++;
        if (this.fails >= RPC_FAILS_BEFORE_ROTATE) this.rotate(`${method}: ${errText(err)}`);
        if (attempt < RPC_MAX_ATTEMPTS) {
          const backoff = rpcRetryBackoffMs(attempt);
          console.log(`RPC   retry ${attempt}/${RPC_MAX_ATTEMPTS - 1} ${method} on ${ep.label} in ${backoff}ms: ${redact(errText(err), SECRETS).slice(0, 160)}`);
          await sleep(backoff);
        }
      }
    }
    throw lastErr;
  }

  /** After a send error, the same signed tx may already be known/mined: never re-send. */
  async sentTxHashIfKnown(rawTx, err) {
    if (typeof rawTx !== "string") return null;
    const hash = keccak256(rawTx);
    if (/already known|known transaction|already imported/i.test(errText(err))) return hash;
    for (const ep of this.endpoints) {
      try {
        const tx = await ep.transport.request({ method: "eth_getTransactionByHash", params: [hash] });
        if (tx && tx.hash) return hash;
      } catch {
        // endpoint unavailable; try the next one
      }
    }
    return null;
  }
}

/**
 * Finds the storage key of a mapping entry with a read-only eth_call state
 * override (fork rehearsal only): writes `expected` into the candidate key in
 * call state and checks that `callData` then returns it. Native USDC
 * (FiatToken) keeps balances in slot 9 and allowances in slot 10.
 */
async function probeMappingSlot(pub, token, callData, expected, keyForSlot) {
  const order = [9n, 10n, 0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 11n];
  for (let i = 12n; i < 64n; i++) order.push(i);
  for (const slot of order) {
    const key = keyForSlot(slot);
    const stateOverride = [{ address: token, stateDiff: [{ slot: key, value: pad(toHex(expected), { size: 32 }) }] }];
    const { data } = await pub.call({ to: token, data: callData, stateOverride });
    if (data && data !== "0x" && hexToBigInt(data) === expected) return { slot, key, stateOverride };
  }
  return null;
}

/**
 * The run's ONE historical SwapExecuted certification — the on-chain half of the
 * one-shot guard, and the ONLY place in this script that asks the endpoint for
 * historical logs.
 *
 * Everything mechanical about the walk lives in `runCertifiedLogScan`
 * (`scripts/delegated-smoke-gates.mjs`): the 10-block ceiling, the contiguous
 * plan, one request in flight, the pacing, the per-chunk retry policy and the
 * final coverage proof. That function is unit-tested against a simulated
 * Free-tier endpoint, so this factory only supplies the three things the runner
 * alone knows: how to make one `eth_getLogs` on THIS endpoint, what the returned
 * logs mean for the one-shot guard, and how to be sure the same history is never
 * walked twice inside one run.
 *
 * Three properties, all structural rather than hopeful:
 *   1. the stage-2b readiness probe is NOT a separate ping and NOT a width
 *      ladder. It is chunk 1 of the certification itself — same filter, same
 *      ≤10-block width, same retry policy — and its result goes into this scan's
 *      chunk cache. Readiness therefore costs exactly the work that had to be
 *      done anyway, and no request this run makes is one the plan already knows
 *      the endpoint would reject.
 *   2. `certify()` memoizes its promise: stage 3, the pre-sign pass and the full
 *      pass of the gate all await the SAME scan, so the deployment→head range is
 *      walked once per run however many readers want the answer — and never from
 *      inside a `Promise.all`, where it would interleave with the other 35 reads
 *      and destroy its own pacing.
 *   3. after the bulk walk it re-reads the head and certifies whatever the chain
 *      produced while it was walking — through the same cache, so a tail round
 *      costs one request per TEN NEW BLOCKS and re-reads nothing. The certified
 *      window therefore ends at a head observed AFTER the walk, not at one
 *      glimpsed before it.
 */
function createHistoricalSwapScan({ pub, wallet, rpcPool }) {
  /** Every chunk this run has certified, keyed by its exact inclusive range. */
  const cache = new Map();
  const quota = { hits: 0, lastRetryAfterMs: null };
  const state = { head: null, plan: null, startedAt: null, rounds: 0 };
  /**
   * Live progress of the walk, recorded as a fact and printed every 250 tiles.
   * A ~30-minute scan that says nothing is indistinguishable from a hung job —
   * which is how these failures looked from the outside. With a counter the log
   * proves the walk is advancing, and an aborted run can state exactly how much
   * of the window it had certified when it stopped.
   */
  const progress = { chunks: 0n, requests: 0n, cacheHits: 0n, retries: 0n, lastCertified: null, paceMs: SCAN_PACE_MS };
  let certified = null;

  /** Projected time left for the bulk walk at the pace currently in force. */
  const etaMs = () => {
    const plan = state.plan;
    if (plan === null || plan.empty === true) return 0;
    const remaining = plan.requests > progress.chunks ? plan.requests - progress.chunks : 0n;
    return Math.max(0, Math.round(Number(remaining) * (progress.paceMs + LOG_SCAN_LATENCY_ESTIMATE_MS)));
  };

  const reportProgress = () => {
    const plan = state.plan;
    fact("logScanProgress", {
      chunks: progress.chunks.toString(),
      plannedChunks: plan === null ? null : plan.requests.toString(),
      requests: progress.requests.toString(),
      cacheHits: progress.cacheHits.toString(),
      retries: progress.retries.toString(),
      lastCertifiedBlock: progress.lastCertified === null ? null : progress.lastCertified.toString(),
      window: plan === null ? null : `${plan.from}->${plan.to}`,
      elapsedMs: state.startedAt === null ? 0 : Date.now() - state.startedAt,
      etaMs: etaMs(),
      paceMs: progress.paceMs,
    });
  };

  /** Records a throttle response so its `Retry-After` can reach the retry policy. */
  const noteQuota = (err) => {
    const cls = classifyRpcError(err);
    if (cls.kind !== "rate-limit") return cls;
    quota.hits += 1;
    const ms = cls.retryAfterMs ?? rpcPool.lastQuotaRetryAfterMs();
    if (typeof ms === "number" && ms > 0) quota.lastRetryAfterMs = ms;
    return cls;
  };

  /**
   * ONE attempt at ONE chunk of at most `SCAN_CHUNK` blocks. `requestOnce` is
   * deliberate: the scan owns the retry policy (same chunk, bounded attempts,
   * paced), so the transport's generic retry loop must stay out of it —
   * otherwise a single throttle becomes 6 × RPC_MAX_ATTEMPTS requests, which is
   * exactly how a "handled" 429 still empties a throughput bucket. The width
   * bound itself is enforced by `swapExecutedLogFilter`, which throws rather than
   * sending a request the free tier documents as invalid.
   */
  const requestChunk = async (fromBlock, toBlock) => {
    const params = [swapExecutedLogFilter({ wallet, fromBlock, toBlock, maxChunk: SCAN_CHUNK })];
    try {
      return await rpcPool.requestOnce({ method: "eth_getLogs", params });
    } catch (err) {
      const cls = noteQuota(err);
      if (cls.kind === "rate-limit" && err && err.retryAfter == null && quota.lastRetryAfterMs !== null) {
        err.retryAfter = quota.lastRetryAfterMs;
      }
      throw err;
    }
  };

  const walk = (from, to, label) =>
    runCertifiedLogScan({
      fetchChunk: requestChunk,
      from,
      to,
      chunkSize: SCAN_CHUNK,
      maxChunks: MAX_LOG_CHUNKS,
      maxBlocks: MAX_LOG_SCAN_BLOCKS,
      cache,
      paceMs: SCAN_PACE_MS,
      startedAtMs: state.startedAt,
      deadlineMs: LOG_SCAN_TIME_BUDGET_MS,
      onEvent: (event) => {
        if (event.type === "retry") {
          progress.retries += 1n;
          progress.paceMs = event.paceMs;
          console.log(
            `RPC   ${label} chunk ${event.from}-${event.to} attempt ${event.attempt} ${event.kind}: retrying the SAME chunk in ${event.waitMs}ms (${event.source}), pacing now ${event.paceMs}ms — no block is skipped and none is re-read`,
          );
        } else if (event.type === "request") {
          progress.requests += 1n;
          // Every 250 tiles (~1 minute at the default pace): enough for someone
          // watching CI to see the walk advancing, rare enough to leave a 4.6k
          // -tile scan's log readable.
          if (progress.requests % 250n === 0n) {
            const planned = state.plan === null ? 0 : Number(state.plan.requests);
            const done = Number(progress.chunks);
            console.log(
              `SCAN  ${done}/${planned || "?"} tile(s) certified through block ${progress.lastCertified ?? "?"}` +
                `${planned ? ` (${Math.round((done / planned) * 100)}%)` : ""}, pacing ${progress.paceMs}ms, ` +
                `${Math.round((Date.now() - (state.startedAt ?? Date.now())) / 1000)}s elapsed, ~${Math.round(etaMs() / 60000)}min left`,
            );
            reportProgress();
          }
        } else if (event.type === "chunk" || event.type === "cache") {
          progress.chunks += 1n;
          progress.lastCertified = event.to;
          if (event.type === "cache") progress.cacheHits += 1n;
        }
      },
    });

  const readHead = () => pub.getBlockNumber();

  /**
   * stage 2b — prove the endpoint can carry the certification, and prove it by
   * carrying the first chunk of the certification. Every failure is returned as
   * a fact for `evaluateRpcReadiness` to turn into a fatal check: this function
   * decides nothing itself and can never downgrade a refusal to a note.
   */
  const probe = async () => {
    // The topic0 pinned in the gates module must be the topic0 of the ABI this
    // runner decodes with; a drift would silently narrow the historical scan.
    const abiTopic = getEventSelector(SWAP_EXECUTED_EVENT);
    if (abiTopic !== SWAP_EXECUTED_TOPIC) {
      throw new Abort(`SwapExecuted topic0 drift: the ABI hashes to ${abiTopic} but the scan filter pins ${SWAP_EXECUTED_TOPIC}`);
    }
    const facts = {
      role: MODE,
      endpoint: rpcLabel(RPC_URL),
      freeTierMaxBlocks: FREE_TIER_MAX_LOG_BLOCKS.toString(),
      chunkSize: SCAN_CHUNK.toString(),
      paceMs: SCAN_PACE_MS,
      concurrency: LOG_SCAN_CONCURRENCY,
      timeBudgetMs: LOG_SCAN_TIME_BUDGET_MS,
      chunkMaxAttempts: LOG_SCAN_CHUNK_MAX_ATTEMPTS,
      chainId: null,
      head: null,
      probe: null,
      plan: null,
      rateLimited: false,
      retryAfterMs: null,
      quota: null,
    };
    const note = (err) => {
      const cls = noteQuota(err);
      if (cls.kind === "rate-limit") {
        facts.rateLimited = true;
        if (cls.retryAfterMs !== null) facts.retryAfterMs = cls.retryAfterMs;
      }
      return cls;
    };
    try {
      facts.chainId = await pub.getChainId();
    } catch (err) {
      note(err);
      facts.probe = { ok: false, detail: `chainId could not be read: ${safeErrorMessage(err, SECRETS)}` };
      facts.quota = rpcPool.quotaFacts();
      return facts;
    }
    let head;
    try {
      head = await readHead();
    } catch (err) {
      note(err);
      facts.probe = { ok: false, detail: `head block could not be read: ${safeErrorMessage(err, SECRETS)}` };
      facts.quota = rpcPool.quotaFacts();
      return facts;
    }
    facts.head = head;
    state.head = head;
    const plan = planHistoricalLogScan({
      head,
      rehearsal: REHEARSAL,
      chunkSize: SCAN_CHUNK,
      maxChunks: MAX_LOG_CHUNKS,
      maxBlocks: MAX_LOG_SCAN_BLOCKS,
      paceMs: SCAN_PACE_MS,
      budgetMs: LOG_SCAN_TIME_BUDGET_MS,
    });
    state.plan = plan;
    state.startedAt = Date.now();
    facts.plan = {
      from: plan.from.toString(),
      to: plan.to.toString(),
      blocks: plan.blocks.toString(),
      requests: plan.requests.toString(),
      widestRequest: plan.widestRequest.toString(),
      chunkSize: plan.chunkSize.toString(),
      contiguous: plan.contiguous === true,
      empty: plan.empty === true,
      estimatedSeconds: Math.round(plan.estimatedMs / 1000),
      budgetSeconds: Math.round(Number(plan.budgetMs) / 1000),
      withinBudget: plan.withinBudget === true,
    };
    if (plan.empty) {
      // The head has not reached the deployment block: there is nothing to scan,
      // and the run says so instead of reporting "no prior swap".
      facts.probe = {
        ok: true,
        width: "0",
        logs: 0,
        from: plan.from.toString(),
        to: plan.to.toString(),
        detail: "the head has not reached the deployment block — no range to certify",
      };
      facts.quota = rpcPool.quotaFacts();
      return facts;
    }
    if (!plan.withinBudget) {
      facts.probe = {
        ok: false,
        width: plan.chunkSize.toString(),
        logs: 0,
        from: plan.firstChunk?.from.toString() ?? "",
        to: plan.firstChunk?.to.toString() ?? "",
        detail:
          `the certification needs ${plan.requests} eth_getLogs request(s) of at most ${FREE_TIER_MAX_LOG_BLOCKS} blocks over ${plan.blocks} block(s), ` +
          `projected ${Math.round(plan.estimatedMs / 60000)}min at ${SCAN_PACE_MS}ms pacing — past this run's ${Math.round(Number(plan.budgetMs) / 60000)}min budget. ` +
          "Refusing to start a walk it cannot finish: no partial scan is ever certified.",
      };
      facts.quota = rpcPool.quotaFacts();
      return facts;
    }
    try {
      const one = await walk(plan.firstChunk.from, plan.firstChunk.to, "readiness");
      // The probe's logs are as decisive as the scan's: an endpoint that answers a
      // filtered request with somebody else's log is refused here, not later.
      const decoded = decodeScanLogs(one.logs, wallet);
      facts.probe = {
        ok: decoded.error === null,
        width: (one.to - one.from + 1n).toString(),
        logs: decoded.count,
        from: one.from.toString(),
        to: one.to.toString(),
        requests: one.requests.toString(),
        detail: decoded.error ?? `served ${one.from}-${one.to}, the first tile of the plan`,
      };
    } catch (err) {
      note(err);
      facts.probe = { ok: false, detail: safeErrorMessage(err, SECRETS) };
    }
    facts.quota = rpcPool.quotaFacts();
    return facts;
  };

  /**
   * stage 3 — the authoritative certification. Resolves once per run; every
   * later reader gets the same object and the chunks already in `cache`.
   */
  const certify = () => {
    if (certified !== null) return certified;
    certified = (async () => {
      const plan = state.plan;
      if (plan === null) throw new Abort("internal: the historical certification ran before stage 2b planned it");
      if (plan.empty) {
        return {
          count: 0,
          from: plan.from,
          to: plan.to,
          empty: true,
          requests: 0n,
          chunks: 0n,
          cacheHits: 0n,
          retries: 0n,
          rateLimits: 0n,
          waitsMs: 0,
          rounds: 0,
          chunkSize: SCAN_CHUNK.toString(),
          paceMs: SCAN_PACE_MS,
          maxRequestBlocks: 0n,
          blocks: "0",
          contiguous: true,
        };
      }
      const runs = [];
      // The bulk walk: deployment -> the head observed at stage 2b. Chunk 1 is
      // already in `cache` (that was the readiness probe), so this requests only
      // the tiles that have not answered yet — nothing more, nothing less.
      runs.push(await walk(plan.from, plan.to, "scan"));
      let cursor = plan.to;
      // Tail rounds: every block the chain produced while the walk was running.
      for (;;) {
        const headNow = await readHead();
        if (headNow <= cursor) break;
        if (state.rounds >= LOG_SCAN_TAIL_MAX_ROUNDS) {
          throw new Abort(
            `${NETWORK_LABEL} kept moving for ${LOG_SCAN_TAIL_MAX_ROUNDS} tail rounds of the certification: refusing to certify a one-shot against a window that is already behind (covered through ${cursor}, head ${headNow})`,
          );
        }
        state.rounds += 1;
        console.log(
          `RPC   head moved ${cursor} -> ${headNow} during the walk; certifying ${headNow - cursor} more block(s) (round ${state.rounds}/${LOG_SCAN_TAIL_MAX_ROUNDS}; cached chunks are reused, not re-read)`,
        );
        runs.push(await walk(cursor + 1n, headNow, "tail"));
        cursor = headNow;
      }
      for (let i = 1; i < runs.length; i++) {
        if (runs[i].from !== runs[i - 1].to + 1n) {
          throw new Abort(`internal: certification round ${i + 1} starts at ${runs[i].from}, not at ${runs[i - 1].to} + 1 — the walk would have a gap`);
        }
      }
      const logs = [];
      let requests = 0n;
      let cacheHits = 0n;
      let retries = 0n;
      let rateLimits = 0n;
      let waitsMs = 0;
      let paceMs = SCAN_PACE_MS;
      let maxRequestBlocks = 0n;
      for (const r of runs) {
        for (const item of r.logs) logs.push(item);
        requests += r.requests;
        cacheHits += r.cacheHits;
        retries += r.retries;
        rateLimits += r.rateLimits;
        waitsMs += r.waitsMs;
        paceMs = r.paceMs;
        if (r.maxRequestBlocks > maxRequestBlocks) maxRequestBlocks = r.maxRequestBlocks;
      }
      // The topic filter is an optimisation, not the verdict.
      const decoded = decodeScanLogs(logs, wallet);
      if (decoded.error !== null) throw new Abort(decoded.error);
      const chunks = runs.reduce((sum, r) => sum + r.chunks, 0n);
      if (chunks !== requests + cacheHits) {
        throw new Abort(`internal: ${chunks} chunk(s) certified but ${requests} requested + ${cacheHits} reused do not account for them — refusing to certify a one-shot from a scan it cannot prove`);
      }
      return {
        count: decoded.count,
        from: plan.from,
        to: cursor,
        empty: false,
        requests,
        chunks,
        cacheHits,
        retries,
        rateLimits,
        waitsMs,
        rounds: state.rounds,
        chunkSize: SCAN_CHUNK.toString(),
        paceMs,
        maxRequestBlocks,
        blocks: (cursor - plan.from + 1n).toString(),
        // Proven by runCertifiedLogScan re-proving the chunks that ANSWERED;
        // carried on the fact so the report and the tests can assert it.
        contiguous: runs.every((r) => r.coverage.contiguous === true && r.coverage.complete === true),
      };
    })();
    return certified;
  };

  return { cache, quota, state, probe, certify };
}

/**
 * Decodes what the endpoint returned and proves it is this wallet's
 * SwapExecuted events. The topic filter is an optimisation, not the verdict: an
 * endpoint that answers a filter pinned to `taker == wallet` with somebody
 * else's log — or with logs this ABI does not recognise — cannot certify a
 * one-shot at all. Returns `{ count, error: null }`, or an `error`; both the
 * readiness probe and the scan treat it as fatal.
 */
function decodeScanLogs(logs, wallet) {
  if (!Array.isArray(logs)) {
    return { count: 0, error: "the RPC returned a non-array eth_getLogs result: refusing to certify a one-shot from an unrecognised response" };
  }
  if (logs.length === 0) return { count: 0, error: null };
  let decoded;
  try {
    decoded = parseEventLogs({ abi: DELEGATED_ABI, logs });
  } catch (err) {
    return {
      count: 0,
      error: `the RPC's logs did not decode as this executor's SwapExecuted (${safeErrorMessage(err, SECRETS)}): refusing to certify a one-shot from an unrecognised response`,
    };
  }
  for (const log of decoded) {
    if (!sameAddress(log.args?.taker, wallet)) {
      return {
        count: decoded.length,
        error: `the RPC returned a SwapExecuted log for ${log.args?.taker} under a filter pinned to ${wallet}: refusing to certify a one-shot from an endpoint that ignores its log filter`,
      };
    }
  }
  if (decoded.length !== logs.length) {
    return {
      count: decoded.length,
      error: `${logs.length - decoded.length} of ${logs.length} log(s) are not a SwapExecuted of this ABI: refusing to certify a one-shot from an unrecognised response`,
    };
  }
  return { count: decoded.length, error: null };
}

// ---------------------------------------------------------------------------
// One-shot ledger (the local half of the guard; the on-chain half is the
// deterministic single-use Permit2 nonce plus the SwapExecuted scan)
// ---------------------------------------------------------------------------
function ledgerPathFor(wallet) {
  const claim = evaluateLedgerClaim({ wallet, ledgerDir: LEDGER_DIR, campaign: CAMPAIGN });
  return resolve(LEDGER_DIR_PATH, claim.fileName);
}

function readLedger(wallet) {
  const path = ledgerPathFor(wallet);
  if (!existsSync(path)) return null;
  try {
    return { path, ...JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    // An unreadable/corrupt ledger is treated as a claim, never as "clean".
    return { path, claimId: null, broadcastTx: null, status: "unreadable" };
  }
}

/** O_EXCL create: a second concurrent or serial live run cannot claim it again. */
function claimLedger(wallet) {
  const path = ledgerPathFor(wallet);
  mkdirSync(dirname(path), { recursive: true });
  const claimId = keccak256(toHex(`mpgr-ledger:${CAMPAIGN}:${wallet}:${Date.now()}:${process.pid}`)).slice(2, 18);
  const entry = buildLedgerEntry({ wallet, mode: MODE, claimId, startedAt: report.startedAt });
  try {
    writeFileSync(path, JSON.stringify({ ...entry, status: "claimed" }, null, 2), { flag: "wx" });
  } catch (err) {
    if (err?.code === "EEXIST") {
      throw new Abort(`one-shot ledger is already claimed for ${wallet} — refusing a second live canary (${path})`);
    }
    throw err;
  }
  return { path, ...entry };
}

function updateLedger(ledger, patch) {
  if (!ledger?.path) return ledger;
  try {
    const next = { ...ledger, ...patch };
    writeFileSync(`${ledger.path}.tmp`, JSON.stringify(next, null, 2));
    renameSync(`${ledger.path}.tmp`, ledger.path);
    return next;
  } catch (err) {
    // The ledger is a convenience layer; the authoritative record is on-chain.
    console.log(`LEDGER update failed (non-fatal): ${err?.code ?? err}`);
    return ledger;
  }
}

// ---------------------------------------------------------------------------
// Committed configuration (the repository is the source of truth)
// ---------------------------------------------------------------------------
function readCommittedConfig() {
  let config = null;
  let record = null;
  try {
    config = JSON.parse(readFileSync(new URL(`../${REVIEWED_CONFIG_PATH}`, import.meta.url), "utf8"));
  } catch {
    config = null;
  }
  try {
    record = JSON.parse(readFileSync(new URL("../deployments/base-mainnet/mpgr-executor-delegated.json", import.meta.url), "utf8"));
  } catch {
    record = null; // not committed: the deployment report constants are the pin instead
  }
  return { config, record };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // ------------------------------------------------------------ stage 0
  stage("0. environment guards");
  const pinnedEnv = env(WALLET_PIN_ENV);
  // Passed to the gate for presence/shape validation ONLY; the key itself is
  // read into a viem account in live mode and never used anywhere else.
  const keyPresentInEnv = process.env[KEY_ENV];
  applyGate(
    evaluateModeGuard({
      mode: MODE,
      rpcUrls: RPC_URLS,
      // The one endpoint this run is allowed to use: preflight/live must certify
      // against it and nothing else (no public fallback rotation).
      configuredRpcUrl: RPC_URL,
      keyEnvValue: keyPresentInEnv,
      walletPinEnvValue: pinnedEnv,
      githubActions: process.env.GITHUB_ACTIONS,
      emergencyDisabled: EMERGENCY_DISABLED,
    }),
  );
  fact("mode", MODE);
  fact("rpcEndpoints", RPC_URLS.map((u) => rpcLabel(u)).join(", "));

  // ------------------------------------------------------------ stage 1
  stage("1. principals (fresh dedicated smoke wallet, never a reused one)");
  let ownerAccount = null;
  let broadcasterAccount = null;
  if (LIVE) {
    ownerAccount = readLiveKey();
    broadcasterAccount = ownerAccount; // one dedicated key: the owner pays for its own gas
  } else if (REHEARSAL) {
    ownerAccount = forkAccount("owner");
    broadcasterAccount = forkAccount("broadcaster");
  } else {
    const pin = normalizeAddress(pinnedEnv, WALLET_PIN_ENV);
    if (!pin.ok) throw new Abort(`${WALLET_PIN_ENV} is required for preflight: ${pin.detail}`);
    ownerAccount = { address: pin.address }; // read-only: no signer, no key
  }
  const wallet = getAddress(ownerAccount.address);
  report.signer = wallet;
  report.broadcaster = broadcasterAccount ? getAddress(broadcasterAccount.address) : null;

  applyGate(
    evaluateSignerIdentity({
      mode: MODE,
      derivedSigner: wallet,
      // In rehearsal the fork-derived principal IS the declared identity;
      // in preflight/live the non-secret pin is the authority.
      pinnedWallet: REHEARSAL ? wallet : pinnedEnv,
    }),
  );
  const identity = canaryIdentityFor(wallet);
  report.identity = {
    mode: MODE,
    wallet,
    pinned: REHEARSAL ? "(fork-only rehearsal principal — live pin not applicable)" : pinnedEnv,
    broadcaster: report.broadcaster,
    separateBroadcaster: Boolean(report.broadcaster) && !sameAddress(report.broadcaster, wallet),
    actionId: identity.actionId,
    permitNonce: identity.permitNonce,
  };
  fact("canaryIdentity", identity);

  // ------------------------------------------------------------ stage 2
  stage("2. committed configuration (the repository is the source of truth)");
  const { config, record } = readCommittedConfig();
  applyGate(evaluateConfigPins({ config, record }));
  fact("reviewedConfigLoaded", config !== null);
  fact("deploymentRecordLoaded", record !== null);

  // ------------------------------------------------------------ transport
  const rpcPool = new RpcPool(RPC_URLS);
  const transport = custom({ request: (args) => rpcPool.request(args) }, { retryCount: 0 });
  const pub = createPublicClient({ chain: base, transport });
  const walletClient = broadcasterAccount ? createWalletClient({ account: broadcasterAccount, chain: base, transport }) : null;
  const confirmations = LIVE ? 2 : 1;

  // ------------------------------------------------------------ stage 2b
  // BEFORE any historical read: prove the ONE configured endpoint can carry the
  // deployment -> head certification — by carrying the first chunk of that
  // certification, at the width the endpoint documents (<=10 blocks), through the
  // same paced policy the walk itself uses. There is deliberately no width probe:
  // a request the free tier rejects outright is not information, it is a wasted
  // 60 CU and a retry (runs #6/#7). A missing, foreign, fork-shaped or throttled
  // RPC stops here in seconds with an operator message. Every row is fatal — see
  // evaluateRpcReadiness — and the plan it checks is the SAME object the scan
  // walks, so a run cannot announce one coverage and certify another.
  stage("2b. RPC readiness (dedicated endpoint for the historical certification)");
  if (RPC_URLS.length === 0) {
    throw new Abort(RPC_MISSING_MESSAGE);
  }
  const historicalScan = createHistoricalSwapScan({ pub, wallet, rpcPool });
  const rpcReadiness = await historicalScan.probe();
  rpcReadiness.quota = rpcPool.quotaFacts();
  // A quota response observed at the transport layer counts even when the error
  // itself was unclassifiable (a 429 carrying a JSON-RPC body, for instance).
  if (rpcPool.rateLimited() || historicalScan.quota.hits > 0) {
    rpcReadiness.rateLimited = true;
    rpcReadiness.retryAfterMs = rpcReadiness.quota?.lastRetryAfterMs ?? historicalScan.quota.lastRetryAfterMs ?? rpcReadiness.retryAfterMs;
  }
  applyGate(
    evaluateRpcReadiness({
      mode: MODE,
      rpcUrl: RPC_URL,
      chainId: rpcReadiness.chainId,
      headBlock: rpcReadiness.head,
      probe: rpcReadiness.probe,
      plan: rpcReadiness.plan,
      rateLimited: rpcReadiness.rateLimited,
      retryAfterMs: rpcReadiness.retryAfterMs,
      chunkSize: rpcReadiness.chunkSize ?? LOG_CHUNK,
      paceMs: rpcReadiness.paceMs,
      concurrency: rpcReadiness.concurrency,
    }),
  );
  fact("rpcReadiness", rpcReadiness);
  fact("rpcRole", REHEARSAL ? "local anvil fork (rehearsal only)" : "dedicated configured Base Mainnet RPC (no public fallback)");
  console.log(
    `RPC   ${rpcReadiness.endpoint}: chainId ${rpcReadiness.chainId}, head ${rpcReadiness.head}, eth_getLogs ${rpcReadiness.chunkSize ?? SCAN_CHUNK} block(s) ` +
      `(free-tier max ${FREE_TIER_MAX_LOG_BLOCKS}) paced at ${SCAN_PACE_MS}ms, one at a time`,
  );
  if (rpcReadiness.plan) {
    console.log(
      `SCAN  ${rpcReadiness.plan.requests} request(s) over blocks ${rpcReadiness.plan.from}->${rpcReadiness.plan.to} ` +
        `(${rpcReadiness.plan.blocks} block(s)), projected ${rpcReadiness.plan.estimatedSeconds}s of a ${rpcReadiness.plan.budgetSeconds}s budget`,
    );
  }

  // ------------------------------------------------------------ stage 3
  stage("3. live posture reads (read-only)");
  const [chainId, head] = await Promise.all([pub.getChainId(), pub.getBlockNumber()]);
  fact("readBlock", head);
  // Fail here with a clear message rather than inside 36 contract reads that
  // cannot possibly succeed against another chain (the gate table still checks it).
  if (chainId !== CHAIN_ID) {
    throw new Abort(`the RPC serves chain ${chainId}, not ${CHAIN_ID} (${NETWORK_LABEL}) — ${REHEARSAL ? "anvil must be started with --fork-url against a real Base Mainnet upstream" : "refusing to continue"}`);
  }

  const ex = (functionName, args = []) => pub.readContract({ address: DELEGATED_EXECUTOR, abi: DELEGATED_ABI, functionName, args });
  const bal = (token, who, blockNumber) =>
    pub.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [who], ...(blockNumber !== undefined ? { blockNumber } : {}) });
  const allowance = (token, owner, spender, blockNumber) =>
    pub.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [owner, spender], ...(blockNumber !== undefined ? { blockNumber } : {}) });

  const noncePos = nonceBitPosition(identity.permitNonce);

  const reads = await Promise.all([
    pub.getCode({ address: DELEGATED_EXECUTOR }), // 0
    ex("paused"), // 1
    ex("feeBps"), // 2
    ex("MAX_FEE_BPS"), // 3
    ex("owner"), // 4
    ex("pendingOwner"), // 5
    ex("feeRecipient"), // 6
    ex("WETH"), // 7
    ex("PERMIT2"), // 8
    ex("WITNESS_TYPE_STRING"), // 9
    ex("ACTION_WITNESS_STRUCT_TYPE_STRING"), // 10
    ex("ACTION_WITNESS_TYPEHASH"), // 11
    ex("routerKind", [UNISWAP_V3_ROUTER]), // 12
    ex("isTokenAllowed", [USDC]), // 13
    ex("isTokenAllowed", [CANONICAL_WETH]), // 14
    ex("swapModuleForRouter", [UNISWAP_V3_ROUTER]), // 15
    ex("swapModuleCodeHash", [UNISWAP_V3_ROUTER]), // 16
    ex("quoteFee", [GROSS_AMOUNT_IN]), // 17
    pub.getCode({ address: UNISWAP_V3_ROUTER }), // 18
    pub.getCode({ address: UNISWAP_V3_QUOTER }), // 19
    pub.readContract({ address: UNISWAP_V3_FACTORY, abi: FACTORY_ABI, functionName: "getPool", args: [USDC, CANONICAL_WETH, UNISWAP_V3_POOL_FEE] }), // 20
    pub.getCode({ address: UNISWAP_V3_POOL }), // 21
    pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "decimals" }), // 22
    pub.readContract({ address: CANONICAL_WETH, abi: ERC20_ABI, functionName: "decimals" }), // 23
    bal(USDC, wallet), // 24
    pub.getBalance({ address: wallet }), // 25
    bal(USDC, DELEGATED_EXECUTOR), // 26
    bal(CANONICAL_WETH, DELEGATED_EXECUTOR), // 27
    pub.getBalance({ address: DELEGATED_EXECUTOR }), // 28
    allowance(USDC, wallet, DELEGATED_EXECUTOR), // 29
    allowance(USDC, wallet, CANONICAL_PERMIT2), // 30
    pub.readContract({ address: CANONICAL_PERMIT2, abi: PERMIT2_ABI, functionName: "allowance", args: [wallet, USDC, DELEGATED_EXECUTOR] }), // 31
    pub.readContract({ address: CANONICAL_PERMIT2, abi: PERMIT2_ABI, functionName: "nonceBitmap", args: [wallet, noncePos.wordIndex] }), // 32
    allowance(USDC, DELEGATED_EXECUTOR, UNISWAP_V3_ROUTER), // 33
    bal(USDC, FEE_RECIPIENT), // 34
  ]);

  const [
    executorCode,
    paused,
    liveFeeBps,
    liveMaxFeeBps,
    liveOwner,
    livePendingOwner,
    liveFeeRecipient,
    liveWeth,
    livePermit2,
    liveWitnessTypeString,
    liveWitnessStructTypeString,
    liveActionWitnessTypehash,
    liveRouterKind,
    liveUsdcAllowed,
    liveWethAllowed,
    liveSwapModule,
    liveSwapModuleCodeHash,
    onChainFeeSplit,
    routerCode,
    quoterCode,
    poolFromFactory,
    poolCode,
    usdcDecimals,
    wethDecimals,
    walletUsdc,
    walletEth,
    executorUsdc,
    executorWeth,
    executorEth,
    walletAllowanceToExecutor,
    walletAllowanceToPermit2,
    permit2Allowance,
    permit2NonceBitmapWord,
    executorRouterAllowance,
    feeRecipientUsdc,
  ] = reads;

  // The one-shot certification, awaited on its own — NOT as another entry of the
  // read batch above. It is the run's single walk of the deployment -> head
  // range: `certify()` memoizes the result (so the pre-sign pass and the full
  // pass of the gate reuse it rather than re-scanning) and the scan is strictly
  // one paced request at a time, which only holds while nothing else on the
  // socket is interleaving with it.
  const priorScan = await historicalScan.certify();
  const scanPlan = historicalScan.state.plan;
  must(
    "the one-shot certification covers the whole window it planned, with zero gaps",
    priorScan.contiguous === true &&
      priorScan.from === scanPlan.from &&
      priorScan.to >= scanPlan.to &&
      (REHEARSAL || (priorScan.from === DELEGATED_DEPLOY_BLOCK && priorScan.to >= head)),
    `blocks ${priorScan.from}->${priorScan.to}: ${priorScan.blocks} block(s) in ${priorScan.chunks} tile(s) — ${priorScan.requests} eth_getLogs request(s) plus ${priorScan.cacheHits} reused chunk(s), ${priorScan.rounds} tail round(s)`,
  );
  must(
    `no eth_getLogs this run made was wider than the endpoint's ${FREE_TIER_MAX_LOG_BLOCKS}-block free-tier maximum`,
    priorScan.maxRequestBlocks <= FREE_TIER_MAX_LOG_BLOCKS && BigInt(priorScan.chunkSize) <= FREE_TIER_MAX_LOG_BLOCKS,
    `widest request ${priorScan.maxRequestBlocks} block(s) at a fixed ${priorScan.chunkSize}-block tile, paced at ${priorScan.paceMs}ms`,
  );

  const executorCodeHash = executorCode && executorCode !== "0x" ? keccak256(executorCode) : null;
  const permit2Amount = Array.isArray(permit2Allowance) ? permit2Allowance[0] : permit2Allowance;
  const permit2UsedBefore = nonceBitmapWordMarks(permit2NonceBitmapWord, identity.permitNonce);

  fact("executorCodeHash", executorCodeHash);
  fact("executorCodeBytes", executorCode ? (executorCode.length - 2) / 2 : 0);
  fact("livePosture", {
    paused,
    feeBps: Number(liveFeeBps),
    maxFeeBps: Number(liveMaxFeeBps),
    owner: liveOwner,
    pendingOwner: livePendingOwner,
    feeRecipient: liveFeeRecipient,
    weth: liveWeth,
    permit2: livePermit2,
    routerKind: Number(liveRouterKind),
    usdcAllowed: liveUsdcAllowed,
    wethAllowed: liveWethAllowed,
    swapModule: liveSwapModule,
    swapModuleCodeHash: liveSwapModuleCodeHash,
  });
  fact("walletBefore", { usdc: walletUsdc, eth: walletEth, weth: await bal(CANONICAL_WETH, wallet) });
  fact("executorBefore", { usdc: executorUsdc, weth: executorWeth, eth: executorEth });
  fact("feeRecipientBefore", { usdc: feeRecipientUsdc });
  fact("permit2StateBefore", {
    standingAllowance: permit2Amount,
    nonceWordIndex: noncePos.wordIndex.toString(),
    nonceWord: permit2NonceBitmapWord,
    nonceUsed: permit2UsedBefore,
  });
  fact("logScanProgress", {
    ...((report.facts && report.facts.logScanProgress) || {}),
    done: true,
    certifiedBlocks: priorScan.blocks,
    tailRounds: priorScan.rounds,
  });
  fact("priorSwapScan", {
    count: priorScan.count,
    from: priorScan.from.toString(),
    to: priorScan.to.toString(),
    blocks: priorScan.blocks,
    chunks: priorScan.chunks.toString(),
    requests: priorScan.requests.toString(),
    cacheHits: priorScan.cacheHits.toString(),
    retries: priorScan.retries.toString(),
    rateLimits: priorScan.rateLimits.toString(),
    waitsMs: priorScan.waitsMs,
    paceMs: priorScan.paceMs,
    tailRounds: priorScan.rounds,
    // The width actually requested and the widest request actually sent — both
    // are reported, because "never wider than the free tier" is a property of the
    // requests, not of the plan, and the report has to be able to prove it.
    chunkSize: priorScan.chunkSize,
    maxRequestBlocks: priorScan.maxRequestBlocks.toString(),
    contiguous: priorScan.contiguous === true,
    // The request count is an efficiency fact; the block span is the coverage
    // fact. The report shows both so a cheap scan can never be mistaken for a
    // narrow one, and a narrow one can never be mistaken for a full certification.
    takerFiltered: true, // the pinned wallet is an indexed topic of every request
    // Rehearsal scans only the fork's most recent blocks (REHEARSAL_LOG_WINDOW);
    // live/preflight scan from the deployment block. Recorded so the report can
    // never present the bounded rehearsal scan as a full mainnet certification.
    rehearsalBounded: REHEARSAL ? REHEARSAL_LOG_WINDOW.toString() : null,
  });

  // Rehearsal only: the fork principals start penniless, so fund them on the
  // LOCAL FORK (never on Base Mainnet) and record the mainnet shortfall.
  if (REHEARSAL && walletUsdc < GROSS_AMOUNT_IN) {
    const shortfall = usdcFmt(walletUsdc);
    rehearsalNote(
      "rehearsal principal holds 0.50 USDC on real mainnet (informational: a fork top-up follows)",
      `${shortallNote(shortfall)} — fork-only top-up applied so the sequence is still rehearsed against real mainnet contracts`,
      "3. live posture reads (read-only)",
    );
    const balanceData = encodeFunctionData({ abi: ERC20_ABI, functionName: "balanceOf", args: [wallet] });
    // Least privilege, mirroring the fork-only Permit2 approval below: the
    // principal is given EXACTLY the campaign gross and nothing more, so the
    // one canary trade consumes its whole balance and no fork-only surplus can
    // ever mask a wrong amount.
    const target = GROSS_AMOUNT_IN;
    const found = await probeMappingSlot(pub, USDC, balanceData, target, (slot) =>
      keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [wallet, slot])),
    );
    must("located the USDC balance slot for the fork-only top-up", found !== null, found ? `mapping slot ${found.slot}` : "not found");
    await pub.request({ method: "anvil_setStorageAt", params: [USDC, found.key, pad(toHex(target), { size: 32 })] });
    const topped = await bal(USDC, wallet);
    must(
      "fork-only USDC top-up applied for exactly the campaign gross (local anvil state only)",
      topped === GROSS_AMOUNT_IN,
      `${usdcFmt(topped)} == exactly ${GROSS_AMOUNT_IN} raw`,
    );
    fact("forkTopUpUnits", (target - walletUsdc).toString());
  }
  if (REHEARSAL) {
    for (const account of [ownerAccount, broadcasterAccount]) {
      await pub.request({ method: "anvil_setBalance", params: [account.address, toHex(10n ** 16n)] });
    }
    fact("forkEthTopUpWei", (10n ** 16n).toString());
  }

  /**
   * Rehearsal only — the canonical one-time Permit2 token approval.
   *
   * Permit2's SignatureTransfer does NOT move tokens by magic: it calls
   * `USDC.transferFrom(owner, executor, gross)` FROM THE PERMIT2 CONTRACT
   * (permit2 `src/SignatureTransfer.sol::_permitTransferFrom` -> solmate
   * `SafeTransferLib.safeTransferFrom`). A wallet that has never approved
   * Permit2 therefore makes `MPGRExecutorDelegated._pullFromOwner` revert
   * `Error("TRANSFER_FROM_FAILED")` before any executor logic runs — which is
   * exactly what a freshly derived fork principal looks like.
   *
   * A real user grants this ONCE, off-band, before signing anything (see
   * docs/DELEGATED-MAINNET-SMOKE-RUNBOOK.md §3 and the `sendApprovalTransaction`
   * step in lib/mcp/mcp-trade-service.ts). On the fork we reproduce that
   * precondition in LOCAL ANVIL STATE ONLY, at EXACTLY the campaign gross
   * (least privilege — never unlimited), so the rehearsal exercises the real
   * delegated sequence instead of a state that cannot exist for a live user.
   * Nothing is approved, signed or broadcast on Base Mainnet, and the
   * executor is still never approved by anyone.
   */
  if (REHEARSAL && walletAllowanceToPermit2 < REQUIRED_PERMIT2_TOKEN_ALLOWANCE) {
    rehearsalNote(
      "rehearsal principal already holds the one-time USDC->Permit2 approval on real mainnet (informational: a fork-only approval follows)",
      `allowance ${walletAllowanceToPermit2} raw < ${REQUIRED_PERMIT2_TOKEN_ALLOWANCE} — a fork-only approval of exactly the gross is applied so the Permit2 pull is rehearsed against the real Permit2 contract`,
      "3. live posture reads (read-only)",
    );
    const allowanceData = encodeFunctionData({ abi: ERC20_ABI, functionName: "allowance", args: [wallet, CANONICAL_PERMIT2] });
    // FiatToken keeps allowances in a nested mapping: allowed[owner][spender].
    const foundAllowance = await probeMappingSlot(pub, USDC, allowanceData, REQUIRED_PERMIT2_TOKEN_ALLOWANCE, (slot) =>
      keccak256(
        encodeAbiParameters(
          [{ type: "address" }, { type: "bytes32" }],
          [CANONICAL_PERMIT2, keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [wallet, slot]))],
        ),
      ),
    );
    must(
      "located the USDC allowance slot for the fork-only Permit2 approval",
      foundAllowance !== null,
      foundAllowance ? `mapping slot ${foundAllowance.slot}` : "not found",
    );
    await pub.request({
      method: "anvil_setStorageAt",
      params: [USDC, foundAllowance.key, pad(toHex(REQUIRED_PERMIT2_TOKEN_ALLOWANCE), { size: 32 })],
    });
    const approved = await allowance(USDC, wallet, CANONICAL_PERMIT2);
    must(
      "fork-only one-time USDC->Permit2 approval applied for exactly the gross (local anvil state only)",
      approved === REQUIRED_PERMIT2_TOKEN_ALLOWANCE,
      `${approved} raw`,
    );
    must(
      "the fork-only approval went to Permit2 ONLY — the executor is still not approved",
      (await allowance(USDC, wallet, DELEGATED_EXECUTOR)) === 0n,
      "wallet->executor allowance remains 0",
    );
    fact("forkPermit2ApprovalUnits", REQUIRED_PERMIT2_TOKEN_ALLOWANCE.toString());
  }

  // ------------------------------------------------------------ stage 4
  stage("4. quote, witness and the PRE-SIGN gate (the key is used only after this)");
  const latestBlock = await pub.getBlock({ blockTag: "latest" });
  const quoteResult = await pub.simulateContract({
    address: UNISWAP_V3_QUOTER,
    abi: QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn: USDC, tokenOut: CANONICAL_WETH, amountIn: SWAP_AMOUNT_IN, fee: UNISWAP_V3_POOL_FEE, sqrtPriceLimitX96: 0n }],
  });
  const quoteAmountOut = quoteResult.result[0];
  const amountOutMinimum = minOutFromQuote(quoteAmountOut, SLIPPAGE_BPS);
  const deadline = latestBlock.timestamp + DEADLINE_SECONDS;
  const witness = buildActionWitness({
    owner: wallet,
    minAmountOut: amountOutMinimum,
    deadline,
    actionId: identity.actionId,
    policyHash: identity.policyHash,
  });
  const permit = { token: USDC, amount: GROSS_AMOUNT_IN.toString(), nonce: identity.permitNonce, deadline: Number(deadline) };
  const typedData = buildPermitTypedData({ permit, witness }, CHAIN_ID, DELEGATED_EXECUTOR);
  const witnessHashLocal = actionWitnessHash(witness);
  const witnessHashOnChain = await ex("witnessHashOf", [
    {
      owner: witness.owner,
      buyToken: witness.buyToken,
      minAmountOut: BigInt(witness.minAmountOut),
      deadline: BigInt(witness.deadline),
      actionId: witness.actionId,
      policyHash: witness.policyHash,
    },
  ]);
  const params = buildSwapParams({ owner: wallet, quoteMinOut: amountOutMinimum, deadline, actionId: identity.actionId });

  /** Encodes the payload and proves it decodes back to EXACTLY the intended params. */
  function encodeAuthorization(signature) {
    const builtAuth = buildPermit2Authorization({ owner: wallet, permit, witness, signature });
    const data = encodeFunctionData({ abi: DELEGATED_ABI, functionName: "swapOnBehalfOfUniswapV3", args: [params, UNISWAP_V3_POOL_FEE, builtAuth] });
    const decoded = decodeFunctionData({ abi: DELEGATED_ABI, data });
    const p = decoded.args[0];
    const matches =
      decoded.functionName === "swapOnBehalfOfUniswapV3" &&
      sameAddress(p.router, UNISWAP_V3_ROUTER) &&
      sameAddress(p.tokenIn, USDC) &&
      sameAddress(p.tokenOut, CANONICAL_WETH) &&
      p.grossAmountIn === GROSS_AMOUNT_IN &&
      p.expectedFeeAmount === EXPECTED_FEE_AMOUNT &&
      p.amountOutMinimum === amountOutMinimum &&
      sameAddress(p.recipient, wallet) &&
      p.deadline === deadline &&
      p.intentId === identity.actionId &&
      p.unwrapNativeOut === false &&
      Number(decoded.args[1]) === UNISWAP_V3_POOL_FEE;
    return { auth: builtAuth, data, matches, selector: data.slice(0, 10) };
  }
  // The calldata SHAPE is checked with a zero placeholder signature: encoding is
  // pure local math and needs no key. The real signature is produced only after
  // the pre-sign gate below has passed, and the payload is re-checked with it.
  const shaped = encodeAuthorization(UNSIGNED_SENTINEL_SIGNATURE);

  // Gas policy (a read; the pre-sign gate bounds the WORST case with it).
  const feeBlock = await pub.getBlock({ blockTag: "latest" });
  const suggestedTip = LIVE || REHEARSAL ? await pub.estimateMaxPriorityFeePerGas() : 0n;
  const maxPriorityFeePerGas = suggestedTip < PRIORITY_FEE_CAP ? suggestedTip : PRIORITY_FEE_CAP;
  const maxFeePerGas = (feeBlock.baseFeePerGas ?? 0n) * 2n + maxPriorityFeePerGas;

  fact("quote", { amountOut: quoteAmountOut, block: head.toString(), minOut: amountOutMinimum, slippageBps: SLIPPAGE_BPS.toString() });
  fact("deadline", deadline.toString());
  fact("witnessHash", { local: witnessHashLocal, onChain: witnessHashOnChain });
  fact("fees", { maxFeePerGas, maxPriorityFeePerGas });

  const walletUsdcNow = await bal(USDC, wallet);
  const walletEthNow = await pub.getBalance({ address: wallet });
  // Re-read after the rehearsal's fork-only provisioning: the gate must judge
  // the state the simulation will actually run against, never a stale read.
  const walletAllowanceToPermit2Now = await allowance(USDC, wallet, CANONICAL_PERMIT2);
  const walletAllowanceToExecutorNow = await allowance(USDC, wallet, DELEGATED_EXECUTOR);
  fact("permit2TokenAllowance", {
    walletToPermit2: walletAllowanceToPermit2Now.toString(),
    walletToExecutor: walletAllowanceToExecutorNow.toString(),
    requiredForGross: REQUIRED_PERMIT2_TOKEN_ALLOWANCE.toString(),
  });
  const ledger = readLedger(wallet);
  applyGate(evaluateLedgerGuard({ mode: MODE, ledger, wallet, ack: env(LEDGER_ACK_ENV) }));
  if (ledger) fact("ledger", { path: ledger.path, claimId: ledger.claimId ?? null, broadcastTx: ledger.broadcastTx ?? null, status: ledger.status ?? null });

  // Facts shared by the pre-sign pass and the full pass of the same table.
  const sharedFacts = {
    mode: MODE,
    confirmedPhrase: CONFIRM_PHRASE,
    expectedCodeHash: EXPECTED_CODE_HASH,
    chainId,
    targetExecutor: DELEGATED_EXECUTOR,
    executorCode,
    executorCodeHash,
    livePaused: paused,
    liveFeeBps,
    liveMaxFeeBps,
    liveOwner,
    livePendingOwner,
    liveFeeRecipient,
    liveWeth,
    livePermit2,
    liveWitnessTypeString,
    liveWitnessStructTypeString,
    liveActionWitnessTypehash,
    liveRouterKind,
    liveUsdcAllowed,
    liveWethAllowed,
    liveSwapModule,
    liveSwapModuleCodeHash,
    onChainFee: onChainFeeSplit[0],
    onChainSwapAmount: onChainFeeSplit[1],
    witnessHashOnChain,
    witnessHashLocal,
    unwrapNativeOut: params.unwrapNativeOut,
    signer: wallet,
    routerCode,
    quoterCode,
    poolFromFactory,
    poolCode,
    usdcDecimals,
    wethDecimals,
    quoteAmountOut,
    amountOutMinimum,
    latestBlockTimestamp: latestBlock.timestamp,
    deadline,
    walletUsdc: walletUsdcNow,
    walletEth: walletEthNow,
    executorUsdc,
    executorWeth,
    executorEth,
    feeRecipientUsdc,
    walletAllowanceToExecutor: walletAllowanceToExecutorNow,
    walletAllowanceToPermit2: walletAllowanceToPermit2Now,
    permit2AllowanceAmount: permit2Amount,
    permit2NonceUsed: permit2UsedBefore === true,
    permit2Nonce: identity.permitNonce,
    permit2NonceBitmapWord,
    permit2NonceDerivedFor: wallet,
    executorRouterAllowance,
    priorSwapEvents: priorScan.count,
    ledgerExists: ledger !== null,
    ledgerPath: ledger?.path ?? null,
    ledgerClaimId: ledger?.claimId ?? null,
    ledgerTx: ledger?.broadcastTx ?? null,
    maxFeePerGas,
    maxPriorityFeePerGas,
    // Worst case until the real estimate exists (the full pass replaces it).
    swapGasEstimate: EXPECTED_GAS_LIMIT,
    calldataSelector: shaped.selector,
    calldataMatchesParams: shaped.matches,
  };

  // The gate that decides whether the key may be used at all: the whole table,
  // minus exactly the three proofs that require a signature.
  applyGate(evaluateLivePreconditions({ ...sharedFacts, preSigning: true }));

  // ------------------------------------------------------------ stage 5
  stage("5. sign the authorization, simulate that exact payload, re-run the full gate");
  let signature = UNSIGNED_SENTINEL_SIGNATURE;
  let signatureRecovers = null;
  if (LIVE || REHEARSAL) {
    signature = await ownerAccount.signTypedData(typedData);
    signatureRecovers = await verifyTypedData({
      address: wallet,
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
      signature,
    });
  }
  const { auth, data: swapData, matches: calldataMatchesParams } = encodeAuthorization(signature);

  // Simulation + gas estimate: the decisive read-only proof that THIS signed
  // delegation redeems for at least the signed minimum. Skipped in preflight
  // (there is no signature there to redeem).
  let simulationOk = true;
  let simulationAmountOut = quoteAmountOut;
  let simulationError = null;
  let simulationRevert = null;
  let swapGasEstimate = EXPECTED_GAS_LIMIT;
  if (LIVE || REHEARSAL) {
    const simAccount = getAddress(broadcasterAccount.address);
    try {
      const sim = await pub.simulateContract({
        account: simAccount,
        address: DELEGATED_EXECUTOR,
        abi: DELEGATED_ABI,
        functionName: "swapOnBehalfOfUniswapV3",
        args: [params, UNISWAP_V3_POOL_FEE, auth],
      });
      simulationAmountOut = sim.result;
    } catch (err) {
      simulationOk = false;
      // No simulated output exists when the call reverted: never fall back to
      // the quoter's number, or the minOut proof would pass on a trade that
      // did not execute.
      simulationAmountOut = null;
      // The DECODED revert, not just "execution reverted": viem keeps the
      // reason on the second line of shortMessage and safeErrorMessage drops
      // everything after the first newline, which used to hide the cause
      // (e.g. Permit2's Error("TRANSFER_FROM_FAILED")) completely.
      const described = describeContractError(err, SECRETS);
      simulationError = described.detail; // already redacted by describeContractError
      // Chain-returned bytes cannot carry the key, but the JSON report is
      // written with a replacer that only stringifies bigints — so every
      // string that reaches an artifact goes through redact() regardless.
      simulationRevert = described.decoded?.text ? redact(String(described.decoded.text), SECRETS) : null;
      const simulationRevertReason = described.decoded?.reason ? redact(String(described.decoded.reason), SECRETS) : null;
      // Non-secret diagnostics for the report: the exact frame that reverted.
      // Deliberately absent: the private key (never in scope here), the
      // signature, the raw calldata and the typed-data message.
      fact("simulationFailure", {
        revert: simulationRevert,
        selector: described.decoded?.selector ?? null,
        kind: described.decoded?.kind ?? null,
        reason: simulationRevertReason,
        from: simAccount,
        to: DELEGATED_EXECUTOR,
        value: "0",
        calldataSelector: swapData.slice(0, 10),
        calldataBytes: (swapData.length - 2) / 2,
        tokenIn: USDC,
        tokenOut: CANONICAL_WETH,
        grossAmountIn: GROSS_AMOUNT_IN.toString(),
        expectedFeeAmount: EXPECTED_FEE_AMOUNT.toString(),
        amountOutMinimum: amountOutMinimum.toString(),
        recipient: wallet,
        deadline: deadline.toString(),
        blockTimestamp: latestBlock.timestamp.toString(),
        permitNonce: identity.permitNonce,
        witnessHash: witnessHashLocal,
        signatureRecoversToSigner: signatureRecovers === true,
        walletUsdc: walletUsdcNow.toString(),
        walletAllowanceToPermit2: walletAllowanceToPermit2Now.toString(),
        walletAllowanceToExecutor: walletAllowanceToExecutorNow.toString(),
        permit2StandingAllowance: String(permit2Amount),
        executorUsdcBefore: executorUsdc.toString(),
      });
      console.log(`REVERT simulation: ${redact(String(simulationError), SECRETS).slice(0, 300)}`);
    }
    if (simulationOk) {
      swapGasEstimate = await pub.estimateContractGas({
        account: simAccount,
        address: DELEGATED_EXECUTOR,
        abi: DELEGATED_ABI,
        functionName: "swapOnBehalfOfUniswapV3",
        args: [params, UNISWAP_V3_POOL_FEE, auth],
      });
    }
  }
  fact("signedPayload", {
    selector: swapData.slice(0, 10),
    signatureRecoversToSigner: signatureRecovers === true,
    simulationOk,
    simulationAmountOut: simulationAmountOut === null ? null : String(simulationAmountOut),
    simulationRevert,
    swapGasEstimate: String(swapGasEstimate),
  });
  fact("fees", { maxFeePerGas, maxPriorityFeePerGas, swapGasEstimate });

  // ------------------------------------------------------------ stage 5b
  stage("5b. the full gate — every precondition, then the live decision");
  const gate = evaluateLivePreconditions({
    ...sharedFacts,
    swapGasEstimate,
    simulationOk,
    simulationAmountOut,
    simulationError,
    simulationRevert,
    calldataSelector: swapData.slice(0, 10),
    calldataMatchesParams,
    signatureRecoversToSigner: signatureRecovers === true,
    recoveredSigner: signatureRecovers === true ? wallet : null,
  });
  applyGate(gate);
  fact("gateAllowed", gate.allowed);

  if (PREFLIGHT) {
    console.log(
      `\npreflight: ${gate.allowed ? "ALL PRECONDITIONS SATISFIED (a live run would be allowed)" : "PRECONDITIONS NOT SATISFIED (the live step would be refused)"}`,
    );
    console.log("read-only mode: nothing was signed and nothing was broadcast.");
    return;
  }

  // ------------------------------------------------------------ stage 6
  stage(LIVE ? "6. claim the one-shot ledger, then broadcast EXACTLY ONE transaction" : "6. broadcast on the local fork (exactly one transaction)");
  let ledgerRecord = ledger;
  if (LIVE) {
    ledgerRecord = claimLedger(wallet); // O_EXCL: a second run for this wallet cannot pass
    fact("ledgerClaimed", { path: ledgerRecord.path, claimId: ledgerRecord.claimId });
  }

  const gasLimit = swapGasEstimate < EXPECTED_GAS_LIMIT ? EXPECTED_GAS_LIMIT : (swapGasEstimate * 13n) / 10n;
  let swapHash = null;
  try {
    swapHash = await walletClient.writeContract({
      address: DELEGATED_EXECUTOR,
      abi: DELEGATED_ABI,
      functionName: "swapOnBehalfOfUniswapV3",
      args: [params, UNISWAP_V3_POOL_FEE, auth],
      gas: gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    report.broadcastCount += 1;
    report.txs.swap = { hash: swapHash };
    fact("broadcast", swapHash);
    console.log(
      `SEND  swap: to=${DELEGATED_EXECUTOR} (MPGRExecutorDelegated) gross=${GROSS_AMOUNT_IN} fee=${EXPECTED_FEE_AMOUNT} swap=${SWAP_AMOUNT_IN} minOut=${amountOutMinimum} deadline=${deadline} recipient=${wallet} poolFee=${UNISWAP_V3_POOL_FEE}`,
    );
    console.log(`swap tx: ${swapHash}`);
  } catch (err) {
    const message = safeErrorMessage(err, SECRETS);
    if (LIVE && ledgerRecord) updateLedger(ledgerRecord, { status: "broadcast-failed", error: message.slice(0, 300) });
    throw new Abort(`delegated swap broadcast failed before confirmation: ${message}`);
  }
  if (LIVE && ledgerRecord) updateLedger(ledgerRecord, { status: "broadcast", broadcastTx: swapHash });

  const rcpt = await pub.waitForTransactionReceipt({ hash: swapHash, confirmations, timeout: 240_000, pollingInterval: 2_000 });
  report.txs.swap = {
    hash: swapHash,
    blockNumber: rcpt.blockNumber.toString(),
    status: rcpt.status,
    gasUsed: rcpt.gasUsed.toString(),
    effectiveGasPrice: rcpt.effectiveGasPrice?.toString(),
  };
  if (LIVE && ledgerRecord) updateLedger(ledgerRecord, { status: `confirmed-${rcpt.status}`, blockNumber: rcpt.blockNumber.toString() });

  // ------------------------------------------------------------ stage 7
  stage("7. on-chain verification of the confirmed delegated swap");
  const N = rcpt.blockNumber;
  const tx = await pub.getTransaction({ hash: swapHash });
  const decoded = decodeFunctionData({ abi: DELEGATED_ABI, data: tx.input });
  const dParams = decoded.args[0];
  const dAuth = decoded.args[2];

  const swapEvents = parseEventLogs({ abi: DELEGATED_ABI, eventName: "SwapExecuted", logs: rcpt.logs }).filter((l) => sameAddress(l.address, DELEGATED_EXECUTOR));
  const se = swapEvents[0]?.args;
  const transfers = parseEventLogs({ abi: ERC20_ABI, eventName: "Transfer", logs: rcpt.logs });
  const usdcTransfers = transfers.filter((l) => sameAddress(l.address, USDC));
  const wethTransfers = transfers.filter((l) => sameAddress(l.address, CANONICAL_WETH));

  const [feeRecBefore, feeRecAfter, wethBefore, wethAfter, usdcBefore, usdcAfter, exUsdcAfter, exWethAfter, exEthAfter, routerAllowAfter, nonceWordAfter] =
    await Promise.all([
      bal(USDC, FEE_RECIPIENT, N - 1n),
      bal(USDC, FEE_RECIPIENT, N),
      bal(CANONICAL_WETH, wallet, N - 1n),
      bal(CANONICAL_WETH, wallet, N),
      bal(USDC, wallet, N - 1n),
      bal(USDC, wallet, N),
      bal(USDC, DELEGATED_EXECUTOR, N),
      bal(CANONICAL_WETH, DELEGATED_EXECUTOR, N),
      pub.getBalance({ address: DELEGATED_EXECUTOR, blockNumber: N }),
      allowance(USDC, DELEGATED_EXECUTOR, UNISWAP_V3_ROUTER, N),
      pub.readContract({ address: CANONICAL_PERMIT2, abi: PERMIT2_ABI, functionName: "nonceBitmap", args: [wallet, noncePos.wordIndex], blockNumber: N }),
    ]);

  const feeTransfers = usdcTransfers.filter((l) => sameAddress(l.args.to, FEE_RECIPIENT));
  const swapLeg = usdcTransfers.filter((l) => sameAddress(l.args.from, DELEGATED_EXECUTOR) && l.args.value === SWAP_AMOUNT_IN);
  const wethToWallet = wethTransfers.filter((l) => sameAddress(l.args.to, wallet)).reduce((sum, l) => sum + l.args.value, 0n);
  const unexpectedWeth = wethTransfers.some((l) => !sameAddress(l.args.to, wallet) && !sameAddress(l.args.from, wallet));

  fact("usdcTransfers", usdcTransfers.map((l) => ({ from: l.args.from, to: l.args.to, value: l.args.value.toString() })));
  fact("wethTransfers", wethTransfers.map((l) => ({ from: l.args.from, to: l.args.to, value: l.args.value.toString() })));
  fact("balanceDeltas", {
    feeRecipientUsdcDelta: (feeRecAfter - feeRecBefore).toString(),
    walletWethDelta: (wethAfter - wethBefore).toString(),
    walletUsdcSpent: (usdcBefore - usdcAfter).toString(),
  });
  fact("executorBalancesAfter", { usdc: exUsdcAfter.toString(), weth: exWethAfter.toString(), eth: exEthAfter.toString() });
  if (se) {
    fact("swapExecuted", {
      taker: se.taker,
      router: se.router,
      intentId: se.intentId,
      tokenIn: se.tokenIn,
      tokenOut: se.tokenOut,
      grossAmountIn: se.grossAmountIn.toString(),
      feeAmount: se.feeAmount.toString(),
      swapAmountIn: se.swapAmountIn.toString(),
      amountOut: se.amountOut.toString(),
      feeRecipient: se.feeRecipient,
      feeBps: Number(se.feeBps),
      routerKind: Number(se.routerKind),
      flags: Number(se.flags),
    });
  }

  const post = evaluatePostTradeVerification({
    mode: MODE,
    broadcaster: getAddress(broadcasterAccount.address),
    receiptStatus: rcpt.status,
    txTo: tx.to,
    txFrom: tx.from,
    txValue: tx.value,
    txSelector: tx.input.slice(0, 10),
    txInputMatchesEncoded: tx.input.toLowerCase() === swapData.toLowerCase(),
    decodedWitnessOwner: dAuth.witness.owner,
    decodedRecipient: dParams.recipient,
    decodedIntentId: dParams.intentId,
    expectedActionId: identity.actionId,
    decodedPermitToken: dAuth.permit.permitted.token,
    decodedPermitAmount: dAuth.permit.permitted.amount,
    signer: wallet,
    swapEventCount: swapEvents.length,
    eventTaker: se?.taker,
    eventRouter: se?.router,
    eventTokenIn: se?.tokenIn,
    eventTokenOut: se?.tokenOut,
    eventGrossAmountIn: se?.grossAmountIn,
    eventFeeAmount: se?.feeAmount,
    eventSwapAmountIn: se?.swapAmountIn,
    eventAmountOut: se?.amountOut,
    eventFeeRecipient: se?.feeRecipient,
    eventFeeBps: se?.feeBps,
    eventRouterKind: se ? Number(se.routerKind) : undefined,
    eventFlags: se ? Number(se.flags) : undefined,
    usdcPullVerified: usdcTransfers.some(
      (l) => sameAddress(l.args.from, wallet) && sameAddress(l.args.to, DELEGATED_EXECUTOR) && l.args.value === GROSS_AMOUNT_IN,
    ),
    feeTransferCount: feeTransfers.length,
    feeTransferVerified:
      feeTransfers.length === 1 && sameAddress(feeTransfers[0].args.from, DELEGATED_EXECUTOR) && feeTransfers[0].args.value === EXPECTED_FEE_AMOUNT,
    swapLegVerified: swapLeg.length === 1 && sameAddress(swapLeg[0].args.to, UNISWAP_V3_POOL),
    wethToOwnerVerified: wethToWallet === (se?.amountOut ?? -1n) && (se?.amountOut ?? 0n) > 0n,
    unexpectedWethRecipient: unexpectedWeth,
    walletUsdcBefore: usdcBefore,
    walletUsdcAfter: usdcAfter,
    walletWethBefore: wethBefore,
    walletWethAfter: wethAfter,
    feeRecipientUsdcBefore: feeRecBefore,
    feeRecipientUsdcAfter: feeRecAfter,
    amountOutMinimum,
    executorUsdcAfter: exUsdcAfter,
    executorWethAfter: exWethAfter,
    executorEthAfter: exEthAfter,
    executorRouterAllowanceAfter: routerAllowAfter,
    permit2NonceUsedAfter: nonceBitmapWordMarks(nonceWordAfter, identity.permitNonce) === true,
    broadcastCount: report.broadcastCount,
  });
  for (const c of post.checks) check(c.name, c.ok, c.detail, { stageName: c.stage });
  check("all post-trade conditions hold", post.ok, post.ok ? `${post.checks.length} checks` : `failed: ${post.failed.join("; ")}`);
}

function shortallNote(shortfall) {
  return `rehearsal principal holds ${shortfall} on ${NETWORK_LABEL}`;
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------
function txLink(hash) {
  if (!hash) return "—";
  return LIVE ? `[\`${hash}\`](${EXPLORER}/tx/${hash})` : `\`${hash}\` (local fork only — not on ${NETWORK_LABEL})`;
}

function renderMarkdown() {
  const f = report.facts;
  const ok = report.status === "passed";
  const lines = [];
  lines.push(`### ${ok ? "✅" : "❌"} ${renderTitle(MODE)}`, "");
  lines.push(`**Status:** ${report.status.toUpperCase()}${report.abortReason ? ` — aborted at stage \`${report.stage}\`: ${redact(report.abortReason, SECRETS)}` : ""}`, "");
  lines.push("| | |", "|---|---|");
  lines.push(`| Campaign | \`${CAMPAIGN}\` |`);
  lines.push(`| Owner of the permit (signer) | \`${report.signer ?? "—"}\` |`);
  lines.push(`| Broadcaster (msg.sender) | \`${report.broadcaster ?? "— (read-only mode)"}\` |`);
  lines.push(`| Chain | ${NETWORK_LABEL} ${CHAIN_ID} |`);
  lines.push(`| Executor (delegated) | \`${DELEGATED_EXECUTOR}\` |`);
  lines.push(
    `| Authorization | Permit2 witness permit via \`swapOnBehalfOfUniswapV3\`, which needs the operator's one-time USDC.approve(Permit2, 500000); the executor is NEVER approved |`,
  );
  lines.push(
    `| Trade | 0.50 USDC → WETH · gross ${GROSS_AMOUNT_IN} / fee ${EXPECTED_FEE_AMOUNT} (25 bps) / swap ${SWAP_AMOUNT_IN} · Uniswap V3 fee ${UNISWAP_V3_POOL_FEE} · recipient = signer · unwrapNativeOut false |`,
  );
  if (f.quote) lines.push(`| Quote | ${wethFmt(BigInt(f.quote.amountOut))} @ block ${f.quote.block} → amountOutMinimum ${f.quote.minOut} |`);
  if (f.deadline) lines.push(`| deadline | ${f.deadline} (${new Date(Number(f.deadline) * 1000).toISOString()}) |`);
  if (f.witnessHash) lines.push(`| witnessHashOf == local EIP-712 hash | \`${f.witnessHash.onChain}\` |`);
  if (f.executorCodeHash) lines.push(`| executor runtime code hash | \`${f.executorCodeHash}\` |`);
  const s = report.txs.swap;
  lines.push(`| Tx — delegated swap | ${txLink(s?.hash)}${s?.blockNumber ? ` · block ${s.blockNumber} · ${s.status}` : ""} |`);
  if (f.swapExecuted) lines.push(`| SwapExecuted.amountOut | ${wethFmt(BigInt(f.swapExecuted.amountOut))} |`);
  if (f.balanceDeltas) {
    lines.push(
      `| Deltas | fee recipient +${f.balanceDeltas.feeRecipientUsdcDelta} raw USDC · wallet +${f.balanceDeltas.walletWethDelta} wei WETH · wallet −${f.balanceDeltas.walletUsdcSpent} raw USDC |`,
    );
  }
  if (f.executorBalancesAfter) lines.push(`| Executor after (USDC / WETH / ETH) | ${f.executorBalancesAfter.usdc} / ${f.executorBalancesAfter.weth} / ${f.executorBalancesAfter.eth} |`);
  if (f.priorSwapScan)
    lines.push(
      `| One-shot scan | ${f.priorSwapScan.count} prior SwapExecuted for this wallet (blocks ${f.priorSwapScan.from}→${f.priorSwapScan.to})${f.priorSwapScan.rehearsalBounded ? ` — **rehearsal only**: the last ${f.priorSwapScan.rehearsalBounded} blocks of the local fork; live/preflight scan from the deployment block` : ""} |`,
    );
  if (f.priorSwapScan && !f.priorSwapScan.rehearsalBounded)
    lines.push(
      `| Scan coverage | **every** block ${f.priorSwapScan.from}→${f.priorSwapScan.to} (${f.priorSwapScan.blocks} blocks, contiguous: ${f.priorSwapScan.contiguous ? "proven, zero gaps" : "NOT PROVEN"}) — ${f.priorSwapScan.requests} eth_getLogs request(s) + ${f.priorSwapScan.cacheHits} cached chunk(s) over ${f.priorSwapScan.chunks} tile(s) of ≤ ${f.priorSwapScan.chunkSize} blocks (widest sent: ${f.priorSwapScan.maxRequestBlocks}, free-tier max ${FREE_TIER_MAX_LOG_BLOCKS}), paced at ${f.priorSwapScan.paceMs}ms with ${f.priorSwapScan.retries} retry(ies) and ${f.priorSwapScan.rateLimits} rate-limit(s) absorbed (${f.priorSwapScan.waitsMs}ms spent waiting on the endpoint), ${f.priorSwapScan.tailRounds} tail round(s); filtered at the RPC by executor + SwapExecuted topic + this wallet as indexed \`taker\` |`,
    );
  if (f.rpcReadiness)
    lines.push(
      `| Smoke RPC | ${f.rpcRole ?? "—"} — \`${f.rpcReadiness.endpoint}\`, chainId ${f.rpcReadiness.chainId}, head ${f.rpcReadiness.head}, verified eth_getLogs width ${f.rpcReadiness.chunkSize ?? LOG_CHUNK} block(s)${f.rpcReadiness.rateLimited ? " — **rate-limited during this run**" : ""} |`,
    );
  lines.push("");
  const summary = summarizeChecks(report.checks);
  lines.push(
    `<details${ok ? "" : " open"}><summary>Checks: ${summary.passed}/${summary.total} passed${summary.informational > 0 ? ` (+ ${summary.informational} informational rehearsal note${summary.informational === 1 ? "" : "s"} — real mainnet state the fork provisions locally; never a verdict)` : ""}</summary>`,
    "",
  );
  lines.push("| | Stage | Check | Detail |", "|---|---|---|---|");
  const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\n/g, " ");
  for (const c of report.checks) {
    const icon = c.informational ? "ℹ️" : c.skipped ? "⏭️" : c.ok ? "✅" : "❌";
    lines.push(`| ${icon} | ${cell(c.stage)} | ${cell(c.name)} | ${cell(redact(c.detail, SECRETS)).slice(0, 400)} |`);
  }
  lines.push("", "</details>", "");
  if (f.simulationFailure) {
    const sf = f.simulationFailure;
    lines.push(
      "<details open><summary>Decoded revert of the signed delegated <code>eth_call</code></summary>",
      "",
      "| | |",
      "|---|---|",
      `| Decoded revert | \`${cell(sf.revert ?? "—")}\` |`,
      `| Selector / kind | \`${sf.selector ?? "—"}\` · ${sf.kind ?? "—"}${sf.reason ? ` · reason \`${cell(sf.reason)}\`` : ""} |`,
      `| eth_call from → to (value) | \`${sf.from}\` → \`${sf.to}\` (${sf.value} wei) |`,
      `| Calldata | selector \`${sf.calldataSelector}\`, ${sf.calldataBytes} bytes |`,
      `| tokenIn → tokenOut | \`${sf.tokenIn}\` → \`${sf.tokenOut}\` |`,
      `| gross / fee / minOut | ${sf.grossAmountIn} / ${sf.expectedFeeAmount} / ${sf.amountOutMinimum} |`,
      `| recipient · deadline (block ts) | \`${sf.recipient}\` · ${sf.deadline} (${sf.blockTimestamp}) |`,
      `| Permit2 nonce · witness hash | ${sf.permitNonce} · \`${sf.witnessHash}\` |`,
      `| Signature recovers to signer | ${sf.signatureRecoversToSigner} |`,
      `| Wallet USDC · allowance →Permit2 · →executor | ${sf.walletUsdc} · ${sf.walletAllowanceToPermit2} · ${sf.walletAllowanceToExecutor} |`,
      `| Permit2 standing allowance · executor USDC before | ${sf.permit2StandingAllowance} · ${sf.executorUsdcBefore} |`,
      "",
      "</details>",
      "",
    );
  }
  if (f.forkTopUpUnits) {
    lines.push(`> ⚠️ A fork-only USDC top-up of ${f.forkTopUpUnits} raw units was applied on the LOCAL anvil fork only. It is never a mainnet state change.`, "");
  }
  if (f.forkPermit2ApprovalUnits) {
    lines.push(
      `> ⚠️ A fork-only one-time USDC→Permit2 approval of exactly ${f.forkPermit2ApprovalUnits} raw units was written to LOCAL anvil state. Permit2's SignatureTransfer pulls with \`transferFrom\`, so a live wallet needs this approval once, granted by its owner — it is never a mainnet state change made by this script, and the executor is never approved.`,
      "",
    );
  }
  if (f.walletBefore && BigInt(f.walletBefore.usdc) < GROSS_AMOUNT_IN && !REHEARSAL) {
    lines.push(
      `> The smoke wallet holds ${usdcFmt(BigInt(f.walletBefore.usdc))} on ${NETWORK_LABEL}; it needs at least ${GROSS_AMOUNT_IN} raw USDC plus gas. Fund it, then re-run.`,
      "",
    );
  }
  if (REHEARSAL) lines.push(`_Rehearsal ran on a local anvil fork with fork-only derived principals; no repository key exists, and nothing was sent to ${NETWORK_LABEL}._`);
  if (PREFLIGHT) lines.push("_Read-only preflight: every precondition was evaluated against real mainnet state; nothing was signed and no key was read._");
  if (LIVE) lines.push("_Live canary: exactly one Base Mainnet transaction, guarded by the one-shot ledger and the deterministic single-use Permit2 nonce._");
  return lines.join("\n");
}

function jsonReplacer(_k, v) {
  return typeof v === "bigint" ? v.toString() : v;
}

let exitCode = 1;
try {
  await main();
  // The exit code is decided by blockingFailures(): every check EXCEPT the
  // rehearsal-only notes about real mainnet state the fork then provisions.
  // Those are unsatisfiable by construction for a freshly derived principal,
  // so counting them would make a perfect rehearsal exit non-zero forever.
  const failed = blockingFailures(report.checks);
  report.status = failed.length === 0 ? "passed" : "failed";
  exitCode = failed.length === 0 ? 0 : 1;
} catch (err) {
  report.status = "aborted";
  // Messages come from our own guards or from viem RPC errors; the key never
  // appears in either (it lives only inside the local viem account object).
  report.abortReason = safeErrorMessage(err, SECRETS);
  // An abort IS a verdict, and it has to be counted as one. Every check the run
  // appended before it died was true, so the summary used to print
  //   "36 checks passed; a live run would be allowed"
  // for a run that never reached its own conclusion — the report of the last
  // three failing preflights read that way, and it is the single most damaging
  // thing a safety gate can do. Record the failure as a real, fatal row: the
  // count can then never claim a pass, in the console line, in the markdown
  // report, or in the workflow annotation that reads these same checks.
  const coverage = report.facts?.priorSwapScan ?? report.facts?.rpcReadiness?.plan ?? null;
  check(
    `the run reached its verdict (aborted in stage '${report.stage}')`,
    false,
    `${report.abortReason}${
      coverage
        ? ` — certified coverage at the moment it stopped: blocks ${coverage.from ?? "?"}->${coverage.to ?? "?"} of the planned ${report.facts?.rpcReadiness?.plan?.from ?? "?"}->${report.facts?.rpcReadiness?.plan?.to ?? "?"} (${coverage.requests ?? "?"} eth_getLogs request(s), ${coverage.chunks ?? "?"} tile(s), widest ${coverage.maxRequestBlocks ?? "?"} blocks)`
        : ` — no historical coverage was certified at all`
    }`,
    { stageName: report.stage },
  );
  console.error(`\nABORTED at stage '${report.stage}': ${report.abortReason}`);
  if (!(err instanceof Abort) && err?.stack) console.error(redact(String(err.stack).split("\n").slice(0, 8).join("\n"), SECRETS));
  exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  try {
    writeFileSync(resolve(process.cwd(), OUT_JSON), JSON.stringify(report, jsonReplacer, 2));
    writeFileSync(resolve(process.cwd(), OUT_MD), `${renderMarkdown()}\n`);
  } catch (err) {
    console.log(`report write failed: ${err?.code ?? err}`);
  }
  const summary = summarizeChecks(report.checks);
  console.log(
    `\nresult: ${report.status} (${summary.passed}/${summary.total} checks passed${summary.informational > 0 ? `, ${summary.informational} informational rehearsal note(s) not counted` : ""})`,
  );
  // The one number a reader needs first: an aborted run says "aborted", and it
  // never inherits the pass count of the checks that happened to be green.
  if (report.status !== "passed") {
    console.log(`NOT CERTIFIED: ${report.abortReason ?? `the gate refused this run (${summary.failed.length} blocking failure(s))`}`);
  }
  const scan = report.facts?.priorSwapScan;
  if (scan) {
    console.log(
      `SCAN  ${report.status === "passed" ? "certified" : "coverage at abort"}: blocks ${scan.from}->${scan.to} (${scan.blocks} block(s)), ${scan.chunks} tile(s) via ${scan.requests} request(s) + ${scan.cacheHits} reused, widest ${scan.maxRequestBlocks} block(s), ${scan.retries} retry(ies), ${scan.rateLimits} rate-limit(s), pacing ${scan.paceMs}ms, gaps: ${scan.contiguous ? "none" : "UNKNOWN"}`,
    );
  }
  console.log(`swap tx:  ${report.txs.swap?.hash ?? "not sent"}`);
  if (report.broadcastCount > 1) console.log(`!! ${report.broadcastCount} broadcasts (at most 1 is allowed)`);
}
process.exit(exitCode);
