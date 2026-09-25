#!/usr/bin/env node
// Direct MPGR Executor smoke test on Base Mainnet: exactly 1 USDC -> WETH via
// MPGRExecutor.swapSlipstreamExactInputSingle, with the 25 bps MPGR fee taken
// atomically inside the same swap transaction.
//
// Two modes (SMOKE_MODE):
//   rehearsal  Local anvil fork of Base Mainnet (RPC must be 127.0.0.1/localhost).
//              The test wallet is impersonated by anvil; NO private key is used
//              and nothing is broadcast to Base Mainnet.
//   live       Real Base Mainnet. The signer key is read ONLY from the
//              SMOKE_PRIVATE_KEY env var (a GitHub environment secret injected
//              into the Actions runner after the `base-mainnet` environment
//              approval). The key is never printed, logged or written anywhere.
//
// Sequence (both modes):
//   preflight -> fresh quote #1 -> simulate approve + simulate swap (allowance
//   state-override) -> approve EXACTLY 1 USDC to the executor -> wait for
//   confirmation -> fresh quote #2 -> simulate swap -> send swap -> verify the
//   confirmed receipt, logs, transfers and balances on-chain.
//
// Any failed preflight/simulation check aborts BEFORE the next transaction.
// Outputs: SMOKE_JSON (machine-readable) and SMOKE_MD (human report).
// Exit code 0 only if every check passed.

import { readFileSync, writeFileSync } from "node:fs";
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
  http,
  isAddressEqual,
  keccak256,
  pad,
  parseAbi,
  parseEventLogs,
  toHex,
  hexToBigInt,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

// ---------------------------------------------------------------------------
// Fixed parameters (hard-coded on purpose: this script does exactly one thing)
// ---------------------------------------------------------------------------
const CHAIN_ID = 8453;
const WALLET = getAddress("0xB54900f2c355CB0A61c62f8220191D3aAA6f4455"); // dedicated test wallet
const EXECUTOR = getAddress("0xD982726e28275661F8aB64054E6b17a70a63505A");
const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const WETH = getAddress("0x4200000000000000000000000000000000000006");
const ROUTER = getAddress("0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F"); // Aerodrome Slipstream SwapRouter
const QUOTER = getAddress("0x514c8B5f54112481E28028F1166Bd78501089259"); // Slipstream QuoterV2
const FACTORY = getAddress("0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef"); // Slipstream CL factory
const EXPECTED_POOL = getAddress("0x3FE04A59Ebd38cF06080a6F60a98D124eb59392A"); // WETH/USDC ts=50
const FEE_RECIPIENT = getAddress("0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4");
const OWNER = getAddress("0xE0e0d239853c5F2Fe0a524d544eC9eB71fef486e");
const DEPLOY_BLOCK = 51767139n;

const TICK_SPACING = 50;
const GROSS_AMOUNT_IN = 1_000_000n; // exactly 1 USDC (6 decimals)
const FEE_BPS = 25n;
const EXPECTED_FEE = 2_500n; // 25 bps of 1,000,000
const SWAP_AMOUNT_IN = 997_500n;
const SLIPPAGE_BPS = 100n; // 1% tolerance -> minOut = quote * 99%
const DEADLINE_SECONDS = 300n;
const ROUTER_KIND_SLIPSTREAM = 1;
const AUTH_KIND_APPROVAL = 0;
const SELECTOR_SWAP = "0x9befc6c5"; // swapSlipstreamExactInputSingle
const SELECTOR_APPROVE = "0x095ea7b3"; // approve(address,uint256)

// Sanity bands (abort if outside): implied ETH price $500..$20,000 for 0.9975 USDC.
const QUOTE_MIN_WEI = 40_000_000_000_000n; // 0.00004 WETH
const QUOTE_MAX_WEI = 2_000_000_000_000_000n; // 0.002 WETH
// Gas guards (Base normally runs at ~0.005-0.05 gwei).
const MAX_FEE_PER_GAS_CAP = 1_000_000_000n; // 1 gwei hard cap on what we sign
const PRIORITY_FEE_CAP = 50_000_000n; // 0.05 gwei tip cap (Base typically ~0.001 gwei)
const MAX_L2_COST_PER_TX_WEI = 300_000_000_000_000n; // 0.0003 ETH
const LOG_CHUNK = 2_000n;

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------
const EXECUTOR_ABI = JSON.parse(
  readFileSync(new URL("../deployments/base-mainnet/MPGRExecutor.abi.json", import.meta.url), "utf8"),
);
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
]);
const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, int24 tickSpacing, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const FACTORY_ABI = parseAbi(["function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address)"]);
const SWAP_EXECUTED_EVENT = EXECUTOR_ABI.find((x) => x.type === "event" && x.name === "SwapExecuted");

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
const MODE = (process.env.SMOKE_MODE ?? "").trim();
const RPC_URL = (process.env.SMOKE_RPC_URL ?? "").trim(); // optional in live mode (private RPC secret)
// Public Base Mainnet fallbacks used in LIVE mode after the (optional) secret RPC.
// Every value the script acts on is re-checked on-chain afterwards, and the raw
// signed txs are public anyway; a failing/lagging endpoint is simply skipped.
const PUBLIC_BASE_RPCS = [
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.drpc.org",
  "https://base.llamarpc.com",
  "https://1rpc.io/base",
];
const RPC_URLS = LIVE_MODE_FROM_ENV()
  ? [...new Set([RPC_URL, ...PUBLIC_BASE_RPCS].filter((u) => u.length > 0))]
  : RPC_URL.length > 0
    ? [RPC_URL]
    : [];
function LIVE_MODE_FROM_ENV() {
  return (process.env.SMOKE_MODE ?? "").trim() === "live";
}
const OUT_JSON = process.env.SMOKE_JSON ?? "smoke-results.json";
const OUT_MD = process.env.SMOKE_MD ?? "smoke-report.md";
const LIVE = MODE === "live";
const EXPLORER = "https://basescan.org";

// ---------------------------------------------------------------------------
// Result bookkeeping
// ---------------------------------------------------------------------------
const report = {
  mode: MODE,
  chainId: CHAIN_ID,
  status: "running",
  stage: "init",
  abortReason: null,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  signer: null,
  constants: {
    wallet: WALLET,
    executor: EXECUTOR,
    usdc: USDC,
    weth: WETH,
    router: ROUTER,
    quoterV2: QUOTER,
    pool: EXPECTED_POOL,
    feeRecipient: FEE_RECIPIENT,
    tickSpacing: TICK_SPACING,
    grossAmountIn: GROSS_AMOUNT_IN.toString(),
    expectedFeeAmount: EXPECTED_FEE.toString(),
    swapAmountIn: SWAP_AMOUNT_IN.toString(),
    slippageBps: SLIPPAGE_BPS.toString(),
    deadlineSeconds: DEADLINE_SECONDS.toString(),
    unwrapNativeOut: false,
    authKind: "APPROVAL",
  },
  facts: {},
  txs: { approve: null, swap: null },
  checks: [],
};

class Abort extends Error {}

function stage(name) {
  report.stage = name;
  console.log(`\n== ${name}`);
}

/** Records a check. Pre-send checks use must() so a failure aborts before the next tx. */
function check(name, ok, detail = "") {
  report.checks.push({ stage: report.stage, name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  return Boolean(ok);
}

function must(name, ok, detail = "") {
  if (!check(name, ok, detail)) throw new Abort(`${name}${detail ? ` (${detail})` : ""}`);
}

function fact(key, value) {
  report.facts[key] = typeof value === "bigint" ? value.toString() : value;
}

const usdc = (v) => `${formatUnits(v, 6)} USDC (${v} units)`;
const weth = (v) => `${formatEther(v)} WETH (${v} wei)`;
const eth = (v) => `${formatEther(v)} ETH`;
const eq = (a, b) => typeof a === "string" && typeof b === "string" && isAddressEqual(a, b);

// ---------------------------------------------------------------------------
// Environment guards (no network access before these pass)
// ---------------------------------------------------------------------------
function isLocalRpc(url) {
  try {
    const h = new URL(url).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

function resolveAccount() {
  if (!LIVE) return WALLET; // rehearsal: anvil impersonates the wallet, no key involved
  const raw = process.env.SMOKE_PRIVATE_KEY;
  delete process.env.SMOKE_PRIVATE_KEY; // keep it out of anything inherited later
  const key = (raw ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Abort("SMOKE_PRIVATE_KEY is missing or not a 32-byte 0x-hex key (value not shown)");
  }
  try {
    return privateKeyToAccount(key);
  } catch {
    throw new Abort("could not derive an account from SMOKE_PRIVATE_KEY (value not shown)");
  }
}

// ---------------------------------------------------------------------------
// RPC transport: sticky endpoint, retry with backoff, failover, concurrency cap
// ---------------------------------------------------------------------------
// Public Base RPCs rate-limit bursts with JSON-RPC errors (e.g. -32016 "over rate
// limit") that viem does not retry. This pool:
//   * sends every request to ONE active endpoint while it keeps working (sticky),
//   * retries transient failures with exponential backoff + jitter,
//   * rotates to the next endpoint after repeated failures, but only once that
//     endpoint's head has reached the highest block already observed (so a
//     lagging node can never serve pre-approval state after the approve),
//   * never retries deterministic failures (execution reverted),
//   * treats eth_sendRawTransaction idempotently: the same signed bytes may be
//     re-sent, and "already known" / tx-found-by-hash counts as success,
//   * caps in-flight requests to avoid bursts.
// The secret RPC URL (which may embed an API key) is never printed.
const RPC_MAX_ATTEMPTS = 12;
const RPC_MAX_IN_FLIGHT = 2;
const RPC_FAILS_BEFORE_ROTATE = 2;
const RPC_TIMEOUT_MS = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rpcLabel(url) {
  if (url === RPC_URL && LIVE_MODE_FROM_ENV()) return "BASE_MAINNET_RPC_URL (secret)";
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

function redact(text) {
  let out = String(text);
  if (RPC_URL.length > 0) out = out.split(RPC_URL).join("<secret-rpc>");
  return out;
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
      else if ((method === "eth_getTransactionReceipt" || method === "eth_getBlockByNumber" || method === "eth_getBlockByHash") && result?.blockNumber) bn = BigInt(result.blockNumber);
      else if ((method === "eth_getBlockByNumber" || method === "eth_getBlockByHash") && result?.number) bn = BigInt(result.number);
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
    console.log(`RPC   switching ${from} -> ${this.endpoints[this.active].label} (${redact(reason).slice(0, 160)})`);
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
        if (method === "eth_sendTransaction") {
          throw err; // node-signed send (local fork rehearsal only): never blindly re-sent
        }
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
          console.log(`RPC   retry ${attempt}/${RPC_MAX_ATTEMPTS - 1} ${method} on ${ep.label} in ${backoff}ms: ${redact(errText(err)).slice(0, 160)}`);
          await sleep(backoff);
        }
      }
    }
    throw lastErr;
  }

  /** After a send error: the same signed tx may already be in the mempool / mined. */
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
 * Finds the storage key of a Solidity mapping entry by eth_call state override
 * (read-only): writes `expected` to the candidate key in call state only and
 * checks that `callData` then returns `expected`. Native USDC (FiatToken) keeps
 * balances in slot 9 and allowances in slot 10; OZ ERC20 uses slots 0/1.
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  stage("0. environment guards");
  must("SMOKE_MODE is 'rehearsal' or 'live'", MODE === "rehearsal" || MODE === "live", `got '${MODE}'`);
  must("RPC endpoint(s) provided", RPC_URLS.length > 0);
  if (LIVE) {
    must("live mode runs only inside GitHub Actions", process.env.GITHUB_ACTIONS === "true");
    must("live mode RPCs are NOT a local fork", RPC_URLS.every((u) => !isLocalRpc(u)), RPC_URLS.map(rpcLabel).join(", "));
  } else {
    must("rehearsal RPC is a local anvil fork (127.0.0.1/localhost)", RPC_URLS.length === 1 && isLocalRpc(RPC_URLS[0]));
  }

  const account = resolveAccount();
  const signer = typeof account === "string" ? account : account.address;
  report.signer = signer;
  must("signer is exactly the dedicated test wallet", eq(signer, WALLET), `signer ${signer}`);

  // Transport only: sticky endpoint + retry/backoff + failover + concurrency cap.
  // No effect on what is quoted, simulated, signed or verified.
  const rpcPool = new RpcPool(RPC_URLS);
  const transport = custom({ request: (args) => rpcPool.request(args) }, { retryCount: 0 });
  const pub = createPublicClient({ chain: base, transport });
  const wallet = createWalletClient({ account, chain: base, transport });
  const confirmations = LIVE ? 2 : 1;

  // ------------------------------------------------------------------ preflight
  stage("1. preflight (read-only)");
  const chainId = await pub.getChainId();
  must("RPC chainId is 8453 (Base Mainnet)", chainId === CHAIN_ID, `chainId ${chainId}`);
  const startBlock = await pub.getBlockNumber();
  fact("preflightBlock", startBlock);

  const record = JSON.parse(
    readFileSync(new URL("../deployments/base-mainnet/mpgr-executor.json", import.meta.url), "utf8"),
  );
  must(
    "hard-coded addresses match the committed deployment record",
    eq(record.executor, EXECUTOR) &&
      eq(record.feeRecipient, FEE_RECIPIENT) &&
      eq(record.owner, OWNER) &&
      eq(record.deployer, WALLET) &&
      eq(record.router?.router, ROUTER) &&
      eq(record.router?.quoterV2, QUOTER) &&
      eq(record.router?.factory, FACTORY) &&
      eq(record.allowedTokens?.USDC, USDC) &&
      eq(record.weth, WETH) &&
      Number(record.chainId) === CHAIN_ID &&
      BigInt(record.deployBlock) === DEPLOY_BLOCK,
    "deployments/base-mainnet/mpgr-executor.json",
  );

  const code = await pub.getCode({ address: EXECUTOR });
  must("executor has bytecode", Boolean(code && code !== "0x"), `${code ? (code.length - 2) / 2 : 0} bytes`);

  const ex = (functionName, args = []) => pub.readContract({ address: EXECUTOR, abi: EXECUTOR_ABI, functionName, args });
  const [paused, feeBps, feeRecipient, owner, routerKind, usdcAllowed, wethAllowed, quoteFee, exWeth] = await Promise.all([
    ex("paused"),
    ex("feeBps"),
    ex("feeRecipient"),
    ex("owner"),
    ex("routerKind", [ROUTER]),
    ex("isTokenAllowed", [USDC]),
    ex("isTokenAllowed", [WETH]),
    ex("quoteFee", [GROSS_AMOUNT_IN]),
    ex("WETH"),
  ]);
  must("executor not paused", paused === false);
  must("executor feeBps == 25", BigInt(feeBps) === FEE_BPS, `feeBps ${feeBps}`);
  must("executor feeRecipient == 0x96F7…64A4", eq(feeRecipient, FEE_RECIPIENT), feeRecipient);
  must("executor owner == 0xE0e0…486e", eq(owner, OWNER), owner);
  must("router 0x698C…A92F allowlisted as AERODROME_SLIPSTREAM", Number(routerKind) === ROUTER_KIND_SLIPSTREAM, `kind ${routerKind}`);
  must("USDC and WETH are allowlisted", usdcAllowed === true && wethAllowed === true);
  must("executor WETH() == 0x4200…0006", eq(exWeth, WETH), exWeth);
  must(
    "quoteFee(1,000,000) == (2,500, 997,500)",
    quoteFee[0] === EXPECTED_FEE && quoteFee[1] === SWAP_AMOUNT_IN,
    `(${quoteFee[0]}, ${quoteFee[1]})`,
  );

  const pool = await pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: "getPool", args: [USDC, WETH, TICK_SPACING] });
  must("Slipstream factory getPool(USDC, WETH, 50) == 0x3FE0…392A", eq(pool, EXPECTED_POOL), pool);

  must("test wallet is not the fee recipient", !eq(WALLET, FEE_RECIPIENT));

  const bal = (token, who, blockNumber) =>
    pub.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [who], ...(blockNumber !== undefined ? { blockNumber } : {}) });
  const allowanceOf = (blockNumber) =>
    pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "allowance", args: [WALLET, EXECUTOR], ...(blockNumber !== undefined ? { blockNumber } : {}) });

  const [walletUsdc0, walletWeth0, walletEth0, exUsdc0, exWeth0, exEth0, feeRecUsdc0, allowance0] = await Promise.all([
    bal(USDC, WALLET),
    bal(WETH, WALLET),
    pub.getBalance({ address: WALLET }),
    bal(USDC, EXECUTOR),
    bal(WETH, EXECUTOR),
    pub.getBalance({ address: EXECUTOR }),
    bal(USDC, FEE_RECIPIENT),
    allowanceOf(),
  ]);
  fact("walletUsdcBefore", walletUsdc0);
  fact("walletWethBefore", walletWeth0);
  fact("walletEthBefore", walletEth0);
  fact("feeRecipientUsdcBefore", feeRecUsdc0);
  fact("allowanceBefore", allowance0);
  if (walletUsdc0 >= GROSS_AMOUNT_IN || LIVE) {
    must("wallet USDC balance >= 1,000,000 units", walletUsdc0 >= GROSS_AMOUNT_IN, usdc(walletUsdc0));
  } else {
    // Rehearsal only: record the live-readiness failure (so this run FAILS and the
    // live job cannot start), then top up the balance on the LOCAL FORK ONLY so the
    // rest of the sequence is still rehearsed against real mainnet contracts.
    check(
      "wallet USDC balance >= 1,000,000 units (LIVE READINESS)",
      false,
      `${usdc(walletUsdc0)} on Base Mainnet; short by ${GROSS_AMOUNT_IN - walletUsdc0} units. Fork-only top-up applied to continue the rehearsal; live will not run until the wallet is funded`,
    );
    const balanceData = encodeFunctionData({ abi: ERC20_ABI, functionName: "balanceOf", args: [WALLET] });
    const target = GROSS_AMOUNT_IN + 1n;
    const found = await probeMappingSlot(pub, USDC, balanceData, target, (slot) =>
      keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [WALLET, slot])),
    );
    must("located USDC balance storage slot for the fork-only top-up", found !== null, found ? `mapping slot ${found.slot}` : "not found");
    await pub.request({ method: "anvil_setStorageAt", params: [USDC, found.key, pad(toHex(target), { size: 32 })] });
    const topped = await bal(USDC, WALLET);
    must("fork-only top-up applied (local anvil state, not Base Mainnet)", topped === target, usdc(topped));
    fact("forkTopUpUnits", target - walletUsdc0);
  }
  must("executor USDC/WETH/ETH balances are 0 before the test", exUsdc0 === 0n && exWeth0 === 0n && exEth0 === 0n, `USDC ${exUsdc0}, WETH ${exWeth0}, ETH ${exEth0}`);
  must(
    "existing USDC allowance wallet->executor is 0 or exactly 1,000,000",
    allowance0 === 0n || allowance0 === GROSS_AMOUNT_IN,
    `allowance ${allowance0}`,
  );

  // Double-run guard: this is a one-shot test.
  let priorSwaps = 0;
  for (let from = DEPLOY_BLOCK; from <= startBlock; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n > startBlock ? startBlock : from + LOG_CHUNK - 1n;
    const logs = await pub.getLogs({ address: EXECUTOR, event: SWAP_EXECUTED_EVENT, args: { taker: WALLET }, fromBlock: from, toBlock: to });
    priorSwaps += logs.length;
  }
  must("no earlier SwapExecuted for this wallet (one-shot guard)", priorSwaps === 0, `${priorSwaps} found since block ${DEPLOY_BLOCK}`);

  // Explicit EIP-1559 fees: tip = node suggestion capped at 0.05 gwei,
  // maxFee = 2 x latest baseFee + tip, and the signed maxFee is capped at 1 gwei.
  const gasFees = async () => {
    const [block, suggestedTip] = await Promise.all([pub.getBlock({ blockTag: "latest" }), pub.estimateMaxPriorityFeePerGas()]);
    const maxPriorityFeePerGas = suggestedTip < PRIORITY_FEE_CAP ? suggestedTip : PRIORITY_FEE_CAP;
    return { maxFeePerGas: (block.baseFeePerGas ?? 0n) * 2n + maxPriorityFeePerGas, maxPriorityFeePerGas };
  };
  const fees = await gasFees();
  fact("maxFeePerGas", fees.maxFeePerGas);
  fact("maxPriorityFeePerGas", fees.maxPriorityFeePerGas);
  must("maxFeePerGas within 1 gwei cap", fees.maxFeePerGas <= MAX_FEE_PER_GAS_CAP, `${fees.maxFeePerGas} wei`);
  const worstCaseEth = 500_000n * fees.maxFeePerGas + 5_000_000_000_000n; // approve+swap gas + L1 data margin
  must("wallet ETH covers worst-case gas for approve + swap", walletEth0 >= worstCaseEth, `${eth(walletEth0)} >= ${eth(worstCaseEth)}`);

  // ------------------------------------------------------------ quote #1 + sims
  stage("2. fresh quote #1 + simulations (before approval)");
  const quote = async () => {
    const { result } = await pub.simulateContract({
      address: QUOTER,
      abi: QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn: USDC, tokenOut: WETH, amountIn: SWAP_AMOUNT_IN, tickSpacing: TICK_SPACING, sqrtPriceLimitX96: 0n }],
    });
    const blockNumber = await pub.getBlockNumber();
    return { amountOut: result[0], blockNumber };
  };
  const buildParams = (minOut, deadline) => [
    {
      router: ROUTER,
      tokenIn: USDC,
      tokenOut: WETH,
      grossAmountIn: GROSS_AMOUNT_IN,
      expectedFeeAmount: EXPECTED_FEE,
      amountOutMinimum: minOut,
      recipient: WALLET,
      deadline,
      intentId: zeroHash,
      unwrapNativeOut: false,
    },
    TICK_SPACING,
    { kind: AUTH_KIND_APPROVAL, deadline: 0n, nonce: 0n, v: 0, r: zeroHash, s: zeroHash, signature: "0x" },
  ];
  const freshDeadline = async () => (await pub.getBlock({ blockTag: "latest" })).timestamp + DEADLINE_SECONDS;

  const q1 = await quote();
  const minOut1 = (q1.amountOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  fact("quote1AmountOut", q1.amountOut);
  fact("quote1Block", q1.blockNumber);
  fact("quote1MinOut", minOut1);
  must("quote #1 within sanity band (ETH $500..$20,000)", q1.amountOut >= QUOTE_MIN_WEI && q1.amountOut <= QUOTE_MAX_WEI, weth(q1.amountOut));

  const approveSim = await pub.simulateContract({ account: WALLET, address: USDC, abi: ERC20_ABI, functionName: "approve", args: [EXECUTOR, GROSS_AMOUNT_IN] });
  must("simulate approve(executor, 1,000,000) returns true", approveSim.result === true);

  // Pre-approval swap simulation: override the wallet->executor allowance to
  // exactly 1,000,000 in eth_call state only (nothing is written on-chain).
  const allowanceData = encodeFunctionData({ abi: ERC20_ABI, functionName: "allowance", args: [WALLET, EXECUTOR] });
  const allowanceOverride = await probeMappingSlot(pub, USDC, allowanceData, GROSS_AMOUNT_IN, (slot) => {
    const inner = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [WALLET, slot]));
    return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [EXECUTOR, inner]));
  });
  must("located USDC allowance storage slot for the pre-approval simulation", allowanceOverride !== null, allowanceOverride ? `mapping slot ${allowanceOverride.slot}` : "not found");
  const sim1 = await pub.simulateContract({
    account: WALLET,
    address: EXECUTOR,
    abi: EXECUTOR_ABI,
    functionName: "swapSlipstreamExactInputSingle",
    args: buildParams(minOut1, await freshDeadline()),
    stateOverride: allowanceOverride.stateOverride,
  });
  fact("sim1AmountOut", sim1.result);
  must("pre-approval swap simulation succeeds with amountOut >= minOut #1", sim1.result >= minOut1, `${weth(sim1.result)} >= ${minOut1}`);

  // ------------------------------------------------------------------ approve
  stage("3. approve EXACTLY 1 USDC to the executor");
  if (allowance0 === GROSS_AMOUNT_IN) {
    report.txs.approve = { skipped: true, reason: "allowance already exactly 1,000,000 (from an earlier run)" };
    check("approve skipped: allowance already exactly 1,000,000", true);
  } else {
    const approveGas = await pub.estimateContractGas({ account: WALLET, address: USDC, abi: ERC20_ABI, functionName: "approve", args: [EXECUTOR, GROSS_AMOUNT_IN] });
    must("approve L2 gas cost within cap", approveGas * fees.maxFeePerGas <= MAX_L2_COST_PER_TX_WEI, `${approveGas} gas`);
    const approveData = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [EXECUTOR, GROSS_AMOUNT_IN] });
    must("approve calldata is approve(executor, 1000000)", approveData.startsWith(SELECTOR_APPROVE) && approveData.toLowerCase().endsWith("00000000000f4240"));
    console.log(`SEND  approve: to=${USDC} (USDC) spender=${EXECUTOR} amount=1000000 (exactly 1 USDC)`);
    const hash = await wallet.writeContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [EXECUTOR, GROSS_AMOUNT_IN],
      gas: (approveGas * 13n) / 10n,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    report.txs.approve = { hash };
    console.log(`approve tx: ${hash}`);
    const rcpt = await pub.waitForTransactionReceipt({ hash, confirmations, timeout: 240_000, pollingInterval: 2_000 });
    report.txs.approve = { hash, blockNumber: rcpt.blockNumber.toString(), status: rcpt.status, gasUsed: rcpt.gasUsed.toString(), effectiveGasPrice: rcpt.effectiveGasPrice?.toString() };
    must("approve tx confirmed with status success", rcpt.status === "success", rcpt.status);
    const tx = await pub.getTransaction({ hash });
    must("approve tx from == test wallet", eq(tx.from, WALLET), tx.from);
    must("approve tx to == USDC", eq(tx.to, USDC), tx.to);
    must("approve tx value == 0", tx.value === 0n);
    must("approve tx input == approve(executor, 1000000)", tx.input.toLowerCase() === approveData.toLowerCase());
    const approvals = parseEventLogs({ abi: ERC20_ABI, eventName: "Approval", logs: rcpt.logs }).filter((l) => eq(l.address, USDC));
    must(
      "Approval(owner=wallet, spender=executor, value=1,000,000) emitted",
      approvals.length === 1 && eq(approvals[0].args.owner, WALLET) && eq(approvals[0].args.spender, EXECUTOR) && approvals[0].args.value === GROSS_AMOUNT_IN,
    );
  }
  const allowance1 = await allowanceOf();
  must("allowance wallet->executor is exactly 1,000,000 (not unlimited)", allowance1 === GROSS_AMOUNT_IN, `${allowance1}`);

  // --------------------------------------------------------- quote #2 + sim
  stage("4. fresh quote #2 + simulation (after approval)");
  const q2 = await quote();
  const minOut = (q2.amountOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  const deadline = await freshDeadline();
  fact("quote2AmountOut", q2.amountOut);
  fact("quote2Block", q2.blockNumber);
  fact("amountOutMinimum", minOut);
  fact("deadline", deadline);
  must("quote #2 within sanity band (ETH $500..$20,000)", q2.amountOut >= QUOTE_MIN_WEI && q2.amountOut <= QUOTE_MAX_WEI, weth(q2.amountOut));
  const args = buildParams(minOut, deadline);
  const swapData = encodeFunctionData({ abi: EXECUTOR_ABI, functionName: "swapSlipstreamExactInputSingle", args });
  must("swap calldata selector == 0x9befc6c5", swapData.slice(0, 10).toLowerCase() === SELECTOR_SWAP);
  const sim2 = await pub.simulateContract({ account: WALLET, address: EXECUTOR, abi: EXECUTOR_ABI, functionName: "swapSlipstreamExactInputSingle", args });
  fact("sim2AmountOut", sim2.result);
  must("swap simulation succeeds with amountOut >= minOut", sim2.result >= minOut, `${weth(sim2.result)} >= ${minOut}`);
  const swapGas = await pub.estimateContractGas({ account: WALLET, address: EXECUTOR, abi: EXECUTOR_ABI, functionName: "swapSlipstreamExactInputSingle", args });
  const fees2 = await gasFees();
  must("maxFeePerGas still within 1 gwei cap", fees2.maxFeePerGas <= MAX_FEE_PER_GAS_CAP, `${fees2.maxFeePerGas} wei`);
  must("swap L2 gas cost within cap", swapGas * fees2.maxFeePerGas <= MAX_L2_COST_PER_TX_WEI, `${swapGas} gas`);

  // --------------------------------------------------------------------- swap
  stage("5. execute swapSlipstreamExactInputSingle");
  console.log(
    `SEND  swap: to=${EXECUTOR} (MPGR Executor) gross=1000000 fee=2500 swap=997500 minOut=${minOut} deadline=${deadline} recipient=${WALLET} tickSpacing=50`,
  );
  const swapHash = await wallet.writeContract({
    address: EXECUTOR,
    abi: EXECUTOR_ABI,
    functionName: "swapSlipstreamExactInputSingle",
    args,
    gas: (swapGas * 13n) / 10n,
    maxFeePerGas: fees2.maxFeePerGas,
    maxPriorityFeePerGas: fees2.maxPriorityFeePerGas,
  });
  report.txs.swap = { hash: swapHash };
  console.log(`swap tx: ${swapHash}`);
  const rcpt = await pub.waitForTransactionReceipt({ hash: swapHash, confirmations, timeout: 240_000, pollingInterval: 2_000 });
  report.txs.swap = { hash: swapHash, blockNumber: rcpt.blockNumber.toString(), status: rcpt.status, gasUsed: rcpt.gasUsed.toString(), effectiveGasPrice: rcpt.effectiveGasPrice?.toString() };

  // ------------------------------------------------------------- verification
  stage("6. on-chain verification of the confirmed swap");
  const N = rcpt.blockNumber;
  check("swap tx confirmed with status success", rcpt.status === "success", `block ${N}`);
  const tx = await pub.getTransaction({ hash: swapHash });
  check("tx from == test wallet", eq(tx.from, WALLET), tx.from);
  check("tx to == MPGR Executor 0xD982…505A", eq(tx.to, EXECUTOR), tx.to);
  check("tx value == 0", tx.value === 0n, `${tx.value}`);
  check("input selector == 0x9befc6c5 (swapSlipstreamExactInputSingle)", tx.input.slice(0, 10).toLowerCase() === SELECTOR_SWAP, tx.input.slice(0, 10));
  check("tx input == the simulated calldata byte-for-byte", tx.input.toLowerCase() === swapData.toLowerCase());
  const decoded = decodeFunctionData({ abi: EXECUTOR_ABI, data: tx.input });
  const p = decoded.args[0];
  check(
    "decoded params: router/tokens/gross/fee/recipient/unwrap/tickSpacing",
    decoded.functionName === "swapSlipstreamExactInputSingle" &&
      eq(p.router, ROUTER) &&
      eq(p.tokenIn, USDC) &&
      eq(p.tokenOut, WETH) &&
      p.grossAmountIn === GROSS_AMOUNT_IN &&
      p.expectedFeeAmount === EXPECTED_FEE &&
      p.amountOutMinimum === minOut &&
      eq(p.recipient, WALLET) &&
      p.deadline === deadline &&
      p.unwrapNativeOut === false &&
      Number(decoded.args[1]) === TICK_SPACING &&
      Number(decoded.args[2].kind) === AUTH_KIND_APPROVAL,
  );

  const swapEvents = parseEventLogs({ abi: EXECUTOR_ABI, eventName: "SwapExecuted", logs: rcpt.logs }).filter((l) => eq(l.address, EXECUTOR));
  check("exactly one SwapExecuted emitted by the executor", swapEvents.length === 1, `${swapEvents.length} found`);
  const se = swapEvents[0]?.args;
  let amountOut = 0n;
  if (se) {
    amountOut = se.amountOut;
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
    check("SwapExecuted.taker == test wallet", eq(se.taker, WALLET), se.taker);
    check("SwapExecuted.router == Slipstream router", eq(se.router, ROUTER), se.router);
    check("SwapExecuted tokenIn USDC / tokenOut WETH", eq(se.tokenIn, USDC) && eq(se.tokenOut, WETH));
    check("SwapExecuted.grossAmountIn == 1,000,000", se.grossAmountIn === GROSS_AMOUNT_IN, `${se.grossAmountIn}`);
    check("SwapExecuted.feeAmount == 2,500", se.feeAmount === EXPECTED_FEE, `${se.feeAmount}`);
    check("SwapExecuted.swapAmountIn == 997,500", se.swapAmountIn === SWAP_AMOUNT_IN, `${se.swapAmountIn}`);
    check("SwapExecuted.feeRecipient == 0x96F7…64A4 and feeBps == 25", eq(se.feeRecipient, FEE_RECIPIENT) && BigInt(se.feeBps) === FEE_BPS);
    check("SwapExecuted.routerKind == 1 and flags == 0", Number(se.routerKind) === ROUTER_KIND_SLIPSTREAM && Number(se.flags) === 0);
    check("SwapExecuted.amountOut >= amountOutMinimum", se.amountOut >= minOut, `${se.amountOut} >= ${minOut}`);
  }

  const transfers = parseEventLogs({ abi: ERC20_ABI, eventName: "Transfer", logs: rcpt.logs });
  const usdcT = transfers.filter((l) => eq(l.address, USDC));
  const wethT = transfers.filter((l) => eq(l.address, WETH));
  fact(
    "usdcTransfers",
    usdcT.map((l) => ({ from: l.args.from, to: l.args.to, value: l.args.value.toString() })),
  );
  fact(
    "wethTransfers",
    wethT.map((l) => ({ from: l.args.from, to: l.args.to, value: l.args.value.toString() })),
  );
  check("USDC Transfer wallet -> executor of exactly 1,000,000", usdcT.some((l) => eq(l.args.from, WALLET) && eq(l.args.to, EXECUTOR) && l.args.value === GROSS_AMOUNT_IN));
  const feeTransfers = usdcT.filter((l) => eq(l.args.to, FEE_RECIPIENT));
  check(
    "USDC Transfer executor -> fee recipient of exactly 2,500 (same tx, only one)",
    feeTransfers.length === 1 && eq(feeTransfers[0].args.from, EXECUTOR) && feeTransfers[0].args.value === EXPECTED_FEE,
    feeTransfers.map((l) => `${l.args.from}->${l.args.value}`).join(", ") || "none",
  );
  const swapLeg = usdcT.filter((l) => eq(l.args.from, EXECUTOR) && l.args.value === SWAP_AMOUNT_IN);
  check("USDC Transfer executor -> pool of exactly 997,500", swapLeg.length === 1 && eq(swapLeg[0].args.to, EXPECTED_POOL), swapLeg.map((l) => l.args.to).join(", ") || "none");
  const wethToWallet = wethT.filter((l) => eq(l.args.to, WALLET)).reduce((s, l) => s + l.args.value, 0n);
  check("WETH Transfer(s) to wallet sum == SwapExecuted.amountOut", wethToWallet === amountOut && amountOut > 0n, `${wethToWallet}`);

  const prev = N - 1n;
  const [feeRecBefore, feeRecAfter, wWethBefore, wWethAfter, wUsdcBefore, wUsdcAfter, exUsdcN, exWethN, exEthN, allowanceN] = await Promise.all([
    bal(USDC, FEE_RECIPIENT, prev),
    bal(USDC, FEE_RECIPIENT, N),
    bal(WETH, WALLET, prev),
    bal(WETH, WALLET, N),
    bal(USDC, WALLET, prev),
    bal(USDC, WALLET, N),
    bal(USDC, EXECUTOR, N),
    bal(WETH, EXECUTOR, N),
    pub.getBalance({ address: EXECUTOR, blockNumber: N }),
    allowanceOf(N),
  ]);
  const feeDelta = feeRecAfter - feeRecBefore;
  const wethDelta = wWethAfter - wWethBefore;
  const usdcDelta = wUsdcBefore - wUsdcAfter;
  fact("feeRecipientUsdcDelta", feeDelta);
  fact("walletWethDelta", wethDelta);
  fact("walletUsdcSpent", usdcDelta);
  fact("executorBalancesAfter", { usdc: exUsdcN.toString(), weth: exWethN.toString(), eth: exEthN.toString() });
  fact("allowanceAfter", allowanceN);
  check("fee recipient USDC balance delta (block N-1 -> N) == 2,500", feeDelta === EXPECTED_FEE, `${feeDelta}`);
  check("wallet USDC balance delta == -1,000,000", usdcDelta === GROSS_AMOUNT_IN, `${usdcDelta}`);
  check("wallet WETH balance delta >= amountOutMinimum", wethDelta >= minOut, `${weth(wethDelta)} >= ${minOut}`);
  check("wallet WETH balance delta == SwapExecuted.amountOut", wethDelta === amountOut, `${wethDelta}`);
  check("executor USDC balance back to 0", exUsdcN === 0n, `${exUsdcN}`);
  check("executor WETH balance back to 0", exWethN === 0n, `${exWethN}`);
  check("executor ETH balance is 0", exEthN === 0n, `${exEthN}`);
  check("USDC allowance wallet->executor consumed back to 0", allowanceN === 0n, `${allowanceN}`);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function txLink(hash) {
  if (!hash) return "—";
  return LIVE ? `[\`${hash}\`](${EXPLORER}/tx/${hash})` : `\`${hash}\` (local fork only — not on Base Mainnet)`;
}

function renderMarkdown() {
  const f = report.facts;
  const ok = report.status === "passed";
  const title = LIVE ? "MPGR Executor — Base Mainnet smoke test (LIVE)" : "MPGR Executor — Base Mainnet smoke test (FORK REHEARSAL, nothing broadcast)";
  const lines = [];
  lines.push(`### ${ok ? "✅" : "❌"} ${title}`, "");
  lines.push(`**Status:** ${report.status.toUpperCase()}${report.abortReason ? ` — aborted at stage \`${report.stage}\`: ${report.abortReason}` : ""}`, "");
  lines.push("| | |", "|---|---|");
  lines.push(`| Signer (derived) | \`${report.signer ?? "—"}\` |`);
  lines.push(`| Chain | Base ${CHAIN_ID} |`);
  lines.push(`| Executor | \`${EXECUTOR}\` |`);
  lines.push(`| Trade | 1 USDC → WETH, gross 1,000,000 / fee 2,500 (25 bps) / swap 997,500, tickSpacing 50, recipient = test wallet, unwrapNativeOut false |`);
  if (f.walletUsdcBefore !== undefined) lines.push(`| Wallet before | ${usdc(BigInt(f.walletUsdcBefore))}, ${eth(BigInt(f.walletEthBefore))} |`);
  if (f.quote1AmountOut !== undefined) lines.push(`| Quote #1 (pre-approval) | ${weth(BigInt(f.quote1AmountOut))} @ block ${f.quote1Block} |`);
  if (f.quote2AmountOut !== undefined) lines.push(`| Quote #2 (post-approval) | ${weth(BigInt(f.quote2AmountOut))} @ block ${f.quote2Block} |`);
  if (f.amountOutMinimum !== undefined) lines.push(`| amountOutMinimum (quote #2 − 1%) | ${f.amountOutMinimum} wei |`);
  if (f.deadline !== undefined) lines.push(`| deadline | ${f.deadline} (${new Date(Number(f.deadline) * 1000).toISOString()}) |`);
  const a = report.txs.approve;
  lines.push(`| Tx 1 — approve 1 USDC | ${a?.skipped ? `skipped (${a.reason})` : txLink(a?.hash)}${a?.blockNumber ? ` · block ${a.blockNumber} · ${a.status}` : ""} |`);
  const s = report.txs.swap;
  lines.push(`| Tx 2 — swap | ${txLink(s?.hash)}${s?.blockNumber ? ` · block ${s.blockNumber} · ${s.status}` : ""} |`);
  if (f.swapExecuted) lines.push(`| SwapExecuted.amountOut | ${weth(BigInt(f.swapExecuted.amountOut))} |`);
  if (f.feeRecipientUsdcDelta !== undefined) lines.push(`| Fee recipient USDC delta | ${f.feeRecipientUsdcDelta} units |`);
  if (f.walletWethDelta !== undefined) lines.push(`| Wallet WETH delta | ${weth(BigInt(f.walletWethDelta))} |`);
  if (f.executorBalancesAfter) lines.push(`| Executor after (USDC / WETH / ETH) | ${f.executorBalancesAfter.usdc} / ${f.executorBalancesAfter.weth} / ${f.executorBalancesAfter.eth} |`);
  lines.push("");
  const passed = report.checks.filter((c) => c.ok).length;
  lines.push(`<details${ok ? "" : " open"}><summary>Checks: ${passed}/${report.checks.length} passed</summary>`, "");
  lines.push("| | Stage | Check | Detail |", "|---|---|---|---|");
  for (const c of report.checks) lines.push(`| ${c.ok ? "✅" : "❌"} | ${c.stage} | ${c.name} | ${c.detail.replace(/\|/g, "\\|")} |`);
  lines.push("", "</details>", "");
  if (f.forkTopUpUnits !== undefined) {
    lines.push(
      `> ⚠️ **Test wallet is short on Base Mainnet** (${usdc(BigInt(f.walletUsdcBefore))}). Send at least ${f.forkTopUpUnits} more USDC units to \`${WALLET}\`, then remove and re-add the \`smoke-base-mainnet\` label. The rest of this rehearsal used a fork-only top-up.`,
      "",
    );
  }
  if (!LIVE) lines.push("_Rehearsal ran on a local anvil fork with the wallet impersonated; no key was used and nothing was sent to Base Mainnet._");
  return lines.join("\n");
}

function jsonReplacer(_k, v) {
  return typeof v === "bigint" ? v.toString() : v;
}

let exitCode = 1;
try {
  await main();
  const failed = report.checks.filter((c) => !c.ok);
  report.status = failed.length === 0 ? "passed" : "failed";
  exitCode = failed.length === 0 ? 0 : 1;
} catch (err) {
  report.status = "aborted";
  // Error messages come from our own guards or from viem RPC errors; the key is
  // never part of either (it is only held inside the local viem account).
  const msg = err instanceof Abort ? err.message : (err?.shortMessage ?? err?.message ?? String(err));
  report.abortReason = redact(String(msg).split("\n")[0].slice(0, 500));
  console.error(`\nABORTED at stage '${report.stage}': ${report.abortReason}`);
  if (!(err instanceof Abort) && err?.stack) console.error(redact(String(err.stack).split("\n").slice(0, 8).join("\n")));
  exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(OUT_JSON, JSON.stringify(report, jsonReplacer, 2));
  writeFileSync(OUT_MD, renderMarkdown());
  console.log(`\nresult: ${report.status} (${report.checks.filter((c) => c.ok).length}/${report.checks.length} checks passed)`);
  console.log(`approve tx: ${report.txs.approve?.hash ?? (report.txs.approve?.skipped ? "skipped" : "not sent")}`);
  console.log(`swap tx:    ${report.txs.swap?.hash ?? "not sent"}`);
}
process.exit(exitCode);
