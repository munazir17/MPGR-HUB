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
  MAX_FEE_PER_GAS_CAP,
  MODES,
  NETWORK_LABEL,
  OWNER,
  PRIORITY_FEE_CAP,
  REHEARSAL_LOG_WINDOW,
  REQUIRED_PERMIT2_TOKEN_ALLOWANCE,
  REVIEWED_CONFIG_PATH,
  RPC_ENV,
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
  describeContractError,
  evaluateConfigPins,
  evaluateLedgerClaim,
  evaluateLedgerGuard,
  evaluateLivePreconditions,
  evaluateModeGuard,
  evaluatePostTradeVerification,
  evaluateSignerIdentity,
  isPrivateKeyShape,
  minOutFromQuote,
  nonceBitPosition,
  nonceBitmapWordMarks,
  normalizeAddress,
  priorSwapScanWindow,
  redact,
  renderTitle,
  rehearsalPrincipal,
  safeErrorMessage,
  sameAddress,
  summarizeChecks,
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

const RPC_URL = env(RPC_ENV);
// Public Base Mainnet fallbacks for preflight/live. Every value the script acts
// on is re-read from the chain and judged by the gate table; a failing or
// lagging endpoint is simply skipped.
const PUBLIC_BASE_RPCS = [
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.drpc.org",
  "https://base.llamarpc.com",
  "https://1rpc.io/base",
];
const RPC_URLS = REHEARSAL
  ? RPC_URL.length > 0
    ? [RPC_URL]
    : []
  : [...new Set([RPC_URL, ...PUBLIC_BASE_RPCS].filter((u) => u.length > 0))];

const OUT_JSON = env("SMOKE_DELEGATED_JSON") || "smoke-delegated-results.json";
const OUT_MD = env("SMOKE_DELEGATED_MD") || "smoke-delegated-report.md";
const LEDGER_DIR_PATH = resolve(process.cwd(), env(LEDGER_DIR_ENV) || LEDGER_DIR);
const CONFIRM_PHRASE = env("SMOKE_DELEGATED_CONFIRM");
const EXPECTED_CODE_HASH = env(CODE_HASH_PIN_ENV) || null;
const EMERGENCY_DISABLED = env(EMERGENCY_ENV).toLowerCase() === "true";
/**
 * The historical SwapExecuted scan is bounded on two axes.
 *
 * Window: `live`/`preflight` scan from the deployment block to the observed head
 * (the full one-shot certification). `rehearsal` scans only the last
 * REHEARSAL_LOG_WINDOW blocks of the local fork — see priorSwapScanWindow.
 *
 * Span: 2 000 chunks x 2 000 blocks covers ~4M blocks (~3 months of Base 2s
 * blocks) since the deployment. Beyond that the run FAILS CLOSED rather than
 * certifying a one-shot on a partial scan — an operator facing that must point
 * SMOKE_DELEGATED_RPC_URL at their own full node (or start a new campaign with a
 * new wallet, which is the intended answer anyway).
 */
const MAX_LOG_CHUNKS = 2_000n;

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
    this.endpoints = urls.map((url) => ({
      url,
      label: rpcLabel(url),
      transport: http(url, { retryCount: 0, timeout: RPC_TIMEOUT_MS })({ chain: base, retryCount: 0 }),
      needsSyncCheck: false,
    }));
    this.active = 0;
    this.fails = 0;
    this.highWater = 0n;
    this.inFlight = 0;
    this.waiters = [];
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
        this.fails++;
        if (this.fails >= RPC_FAILS_BEFORE_ROTATE) this.rotate(`${method}: ${errText(err)}`);
        if (attempt < RPC_MAX_ATTEMPTS) {
          const backoff = Math.min(8_000, 400 * 2 ** Math.min(attempt - 1, 5)) + Math.floor(Math.random() * 300);
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
 * Chunks the historical SwapExecuted scan; a range it cannot cover is fatal.
 *
 * The window comes from priorSwapScanWindow: the deployment-block-anchored full
 * scan in `live`/`preflight`, and the last REHEARSAL_LOG_WINDOW blocks in
 * `rehearsal` — a local anvil fork cannot serve its pre-fork history locally, and
 * its upstream caps how many blocks one eth_getLogs may span.
 */
async function countPriorSwapEvents(pub, wallet) {
  const head = await pub.getBlockNumber();
  if (head < DELEGATED_DEPLOY_BLOCK) return { count: 0, from: DELEGATED_DEPLOY_BLOCK, to: head, chunks: 0n };
  const { from: scanFrom, to: scanTo } = priorSwapScanWindow({ head, rehearsal: REHEARSAL });
  const chunks = (scanTo - scanFrom + LOG_CHUNK) / LOG_CHUNK;
  if (chunks > MAX_LOG_CHUNKS) {
    throw new Abort(`prior-swap scan would need ${chunks} chunks (> ${MAX_LOG_CHUNKS}): refusing to certify a one-shot from a partial scan — use a full-node RPC`);
  }
  let count = 0;
  let used = 0n;
  for (let from = scanFrom; from <= scanTo; from += LOG_CHUNK) {
    used += 1n;
    const to = from + LOG_CHUNK - 1n > scanTo ? scanTo : from + LOG_CHUNK - 1n;
    const logs = await pub.getLogs({
      address: DELEGATED_EXECUTOR,
      event: SWAP_EXECUTED_EVENT,
      args: { taker: wallet },
      fromBlock: from,
      toBlock: to,
    });
    count += logs.length;
  }
  return { count, from: scanFrom, to: scanTo, chunks: used };
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
    countPriorSwapEvents(pub, wallet), // 35
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
    priorScan,
  ] = reads;

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
  fact("priorSwapScan", {
    count: priorScan.count,
    from: priorScan.from.toString(),
    to: priorScan.to.toString(),
    chunks: priorScan.chunks.toString(),
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
  lines.push(`| Authorization | Permit2 witness permit (no ERC-20 approval) via \`swapOnBehalfOfUniswapV3\` |`);
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
  console.log(`swap tx:  ${report.txs.swap?.hash ?? "not sent"}`);
  if (report.broadcastCount > 1) console.log(`!! ${report.broadcastCount} broadcasts (at most 1 is allowed)`);
}
process.exit(exitCode);
