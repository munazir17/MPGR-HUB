/**
 * Type surface for scripts/delegated-smoke-gates.mjs — the pure safety gates of
 * the MPGRExecutorDelegated Base Mainnet smoke/canary.
 *
 * The implementation is plain JavaScript (it has to run under `node` in CI
 * without a build step); this declaration is what makes it type-safe to import
 * from TypeScript (scripts/delegated-smoke-gates.test.ts and any future
 * tooling). Every fact bag is intentionally `Record<string, unknown>`: the
 * gates must never trust a caller's types, only the values it reads.
 */

export type Hex = `0x${string}`;

/** One evaluated gate row. `fatal: false` rows are reported but never block. */
export interface GateCheck {
  stage: string;
  name: string;
  ok: boolean;
  detail: string;
  fatal?: boolean;
  skipped?: boolean;
  /**
   * A recorded observation that is deliberately NOT a verdict: rehearsal-only
   * notes about real mainnet state the local fork then provisions. Never set
   * on a fork-state check, and never in preflight/live.
   */
  informational?: boolean;
}

export interface GateResult {
  checks: GateCheck[];
  allowed: boolean;
}

export interface BlockedGateResult extends GateResult {
  blockers: string[];
}

export interface PostTradeResult {
  checks: GateCheck[];
  ok: boolean;
  failed: string[];
}

export interface NormalizeResult {
  ok: boolean;
  address: string | null;
  detail: string;
}

/** The EVM null address (pending-owner / swap-module posture). */
export declare const ZERO_ADDRESS: Hex;

export interface FeeSplit {
  fee: bigint;
  swapAmount: bigint;
}

export interface NonceBitPosition {
  wordIndex: bigint;
  bit: bigint;
}

export interface CanaryIdentity {
  actionId: Hex;
  intentId: Hex;
  policyHash: Hex;
  permitNonce: string;
}

/** The signed `ActionWitness` (wallet/typed-data shape). */
export interface ActionWitness {
  owner: Hex;
  buyToken: Hex;
  minAmountOut: string;
  deadline: number;
  actionId: Hex;
  policyHash: Hex;
}

/** The same witness as it appears inside the calldata tuple (uints as bigint). */
export interface AbiActionWitness {
  owner: Hex;
  buyToken: Hex;
  minAmountOut: bigint;
  deadline: bigint;
  actionId: Hex;
  policyHash: Hex;
}

export interface PermitInput {
  token: Hex;
  amount: string | bigint;
  nonce: string | bigint;
  deadline: number | bigint;
}

export interface SwapParams {
  router: Hex;
  tokenIn: Hex;
  tokenOut: Hex;
  grossAmountIn: bigint;
  expectedFeeAmount: bigint;
  amountOutMinimum: bigint;
  recipient: Hex;
  deadline: bigint;
  intentId: Hex;
  unwrapNativeOut: boolean;
}

export interface Permit2Authorization {
  permit: {
    permitted: { token: Hex; amount: bigint };
    nonce: bigint;
    deadline: bigint;
  };
  witness: AbiActionWitness;
  signature: Hex;
}

export interface Eip712TypedData {
  domain: { name: string; chainId: number; verifyingContract: Hex };
  primaryType: string;
  types: {
    EIP712Domain: Array<{ name: string; type: string }>;
    TokenPermissions: Array<{ name: string; type: string }>;
    PermitWitnessTransferFrom: Array<{ name: string; type: string }>;
    ActionWitness: Array<{ name: string; type: string }>;
  };
  message: {
    permitted: { token: Hex; amount: bigint };
    spender: Hex;
    nonce: bigint;
    deadline: bigint;
    witness: AbiActionWitness;
  };
}

export interface LedgerEntry {
  version: number;
  campaign: string;
  chainId: number;
  mode: string;
  wallet: string;
  executor: string;
  grossAmountIn: string;
  claimId: string;
  startedAt: string;
}

// ---------------------------------------------------------------------------
// Pinned deployment facts
// ---------------------------------------------------------------------------
export declare const CHAIN_ID: number;
export declare const NETWORK_LABEL: string;
export declare const EXPLORER: string;
export declare const DELEGATED_EXECUTOR: Hex;
export declare const DELEGATED_DEPLOYER: Hex;
export declare const DELEGATED_DEPLOY_TX: string;
export declare const DELEGATED_DEPLOY_BLOCK: bigint;
export declare const DEPLOYMENT_RECORD_PATH: string;
export declare const REVIEWED_CONFIG_PATH: string;
export declare const OWNER: Hex;
export declare const FEE_RECIPIENT: Hex;
export declare const FEE_BPS: bigint;
export declare const MAX_FEE_BPS: bigint;
export declare const BPS_DENOMINATOR: bigint;
export declare const CANONICAL_WETH: Hex;
export declare const CANONICAL_PERMIT2: Hex;
export declare const USDC: Hex;
export declare const USDC_DECIMALS: number;
export declare const WETH_DECIMALS: number;
export declare const UNISWAP_V3_ROUTER: Hex;
export declare const UNISWAP_V3_QUOTER: Hex;
export declare const UNISWAP_V3_FACTORY: Hex;
export declare const UNISWAP_V3_POOL: Hex;
export declare const UNISWAP_V3_POOL_FEE: number;
export declare const ROUTER_KIND_UNISWAP_V3: number;
export declare const ROUTER_KIND_SLIPSTREAM: number;
export declare const WITNESS_TYPE_STRING: string;
export declare const ACTION_WITNESS_STRUCT_TYPE_STRING: string;
export declare const ACTION_WITNESS_TYPEHASH: Hex;
export declare const PERMIT2_DOMAIN_NAME: string;
export declare const SWAP_ON_BEHALF_OF_UNISWAP_V3_SELECTOR: string;
export declare const SWAP_ON_BEHALF_OF_SLIPSTREAM_SELECTOR: string;
export declare const SWAP_ON_BEHALF_OF_TYPED_MODULE_SELECTOR: string;

// ---------------------------------------------------------------------------
// Campaign economics
// ---------------------------------------------------------------------------
export declare const GROSS_AMOUNT_IN: bigint;
export declare const EXPECTED_FEE_AMOUNT: bigint;
export declare const SWAP_AMOUNT_IN: bigint;
/**
 * The one-time ERC-20 allowance the signing wallet must have granted to the
 * CANONICAL PERMIT2 CONTRACT (not to the executor) so Permit2's
 * SignatureTransfer `transferFrom` pull can succeed.
 */
export declare const REQUIRED_PERMIT2_TOKEN_ALLOWANCE: bigint;
export declare const SLIPPAGE_BPS: bigint;
export declare const DEADLINE_SECONDS: bigint;
export declare const MIN_DEADLINE_MARGIN_SECONDS: bigint;
export declare const QUOTE_MIN_WEI: bigint;
export declare const QUOTE_MAX_WEI: bigint;
export declare const MAX_FEE_PER_GAS_CAP: bigint;
export declare const PRIORITY_FEE_CAP: bigint;
export declare const EXPECTED_GAS_LIMIT: bigint;
export declare const MAX_L2_COST_PER_TX_WEI: bigint;
export declare const L1_FEE_MARGIN_WEI: bigint;

// ---------------------------------------------------------------------------
// Identity policy + environment contract
// ---------------------------------------------------------------------------
export declare const V1_SMOKE_WALLET: Hex;
export declare const PHASE5_CANARY_WALLET: Hex;
export declare const V1_MAINNET_EXECUTOR: Hex;
export declare const SEPOLIA_DELEGATED_EXECUTOR: Hex;
export declare const SEPOLIA_V1_EXECUTOR: Hex;
export declare const FORBIDDEN_SIGNERS: Readonly<Record<string, string>>;
export declare const KEY_ENV: string;
export declare const WALLET_PIN_ENV: string;
export declare const RPC_ENV: string;
export declare const MODE_ENV: string;
export declare const CODE_HASH_PIN_ENV: string;
export declare const LEDGER_DIR_ENV: string;
export declare const LEDGER_ACK_ENV: string;
export declare const EMERGENCY_ENV: string;
export declare const LIVE_CONFIRM_PHRASE: string;
export declare const MODES: Readonly<{ REHEARSAL: "rehearsal"; PREFLIGHT: "preflight"; LIVE: "live" }>;
export declare const CAMPAIGN: string;
export declare const LEDGER_VERSION: number;
export declare const LEDGER_DIR: string;
export declare const LOG_CHUNK: bigint;
export declare const REHEARSAL_LOG_WINDOW: bigint;

/** Hard ceiling for one eth_getLogs request; only a PROBED width is ever used. */
export declare const MAX_SAFE_LOG_CHUNK: bigint;
/** The explicit ascending widths the readiness probe offers an endpoint. */
export declare const LOG_CHUNK_PROBE_LADDER: ReadonlyArray<bigint>;
/** Non-secret operator override for MAX_SAFE_LOG_CHUNK (clamped, never wider). */
export declare const MAX_LOG_CHUNK_ENV: string;
/** Block budget one run may certify (400 000 x the 10-block floor). */
export declare const MAX_LOG_SCAN_BLOCKS: bigint;
/** Bounded 429/quota policy: attempts, backoff and the Retry-After cap. */
export declare const RATE_LIMIT_MAX_ATTEMPTS: number;
export declare const RATE_LIMIT_BACKOFF_BASE_MS: number;
export declare const RATE_LIMIT_BACKOFF_MAX_MS: number;
export declare const RETRY_AFTER_MAX_MS: number;
/** HTTP statuses that mean "over quota", and the JSON-RPC codes that say the same. */
export declare const RATE_LIMIT_HTTP_STATUSES: ReadonlyArray<number>;
export declare const RATE_LIMIT_RPC_CODES: ReadonlyArray<number>;
/** The exact operator messages for a missing / rate-limited dedicated smoke RPC. */
export declare const RPC_RATE_LIMITED_MESSAGE: string;
export declare const RPC_MISSING_MESSAGE: string;
/** The delegated executor's one event, and its topic0. */
export declare const SWAP_EXECUTED_EVENT_SIGNATURE: string;
export declare const SWAP_EXECUTED_TOPIC: Hex;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export declare function sameAddress(a: unknown, b: unknown): boolean;
export declare function normalizeAddress(value: unknown, label?: string): NormalizeResult;
export declare function isPrivateKeyShape(value: unknown): boolean;
export declare function isBytes32(value: unknown): boolean;
export declare function redact(text: string, secrets?: ReadonlyArray<string | undefined>): string;
export declare function isLocalRpc(url: unknown): boolean;
/** True for loopback, RFC-1918/link-local or `.local` endpoints (refused in preflight/live). */
export declare function isPrivateOrLocalRpc(url: unknown): boolean;
/** True only for a TLS endpoint — required for preflight/live. */
export declare function isHttpsRpc(url: unknown): boolean;
export declare function priorSwapScanWindow(input: {
  head: bigint;
  deployBlock?: bigint;
  rehearsal?: boolean;
  window?: bigint;
}): { from: bigint; to: bigint };

/** One inclusive [from, to] eth_getLogs chunk of a bounded historical scan. */
export interface LogScanChunk {
  from: bigint;
  to: bigint;
}

/** The aggregated result of a bounded historical scan (chunks in deterministic order). */
export interface LogScanResult<T = unknown> {
  logs: T[];
  from: bigint;
  to: bigint;
  chunks: bigint;
}

/**
 * The exact inclusive chunk plan for a bounded eth_getLogs scan: ascending,
 * gap-free, overlap-free, first/last block included, every chunk at most
 * `chunkSize` (default LOG_CHUNK) blocks, final partial chunk intact.
 */
export declare function planLogScan(input: {
  from: bigint | number | string;
  to: bigint | number | string;
  chunkSize?: bigint | number | string;
}): LogScanChunk[];

/**
 * Runs a bounded historical scan through the injected `fetchChunk`, one
 * planned chunk at a time. FAILS CLOSED: any unreadable chunk rejects (cause
 * preserved) with no partial result, and an optional `maxChunks` budget
 * refuses oversized scans before the first request.
 */
export declare function runLogScan<T = unknown>(input: {
  fetchChunk: (from: bigint, to: bigint) => Promise<T[]> | T[];
  from: bigint | number | string;
  to: bigint | number | string;
  chunkSize?: bigint | number | string;
  maxChunks?: bigint | number | string | null;
}): Promise<LogScanResult<T>>;

/** Clamps a requested eth_getLogs width into [min, max]; rejects garbage. */
export declare function clampChunkSize(
  value: bigint | number | string,
  bounds?: { min?: bigint | number; max?: bigint | number },
): bigint;
/** Halves a width, never below `min`. Strictly decreasing. */
export declare function shrinkChunkSize(size: bigint | number | string, min?: bigint | number): bigint;
/** The strictly-ascending ladder widths above `current`, inside [min, max]. */
export declare function probeWidthsAbove(
  current: bigint | number | string,
  input?: { ladder?: ReadonlyArray<bigint | number>; min?: bigint | number; max?: bigint | number },
): bigint[];

/** What the readiness probe discovered about one endpoint's eth_getLogs width. */
export interface LogChunkProbe {
  chunkSize: bigint;
  accepted: bigint[];
  refused: { chunkSize: bigint; detail: string } | null;
  unavailable: { chunkSize: bigint; detail: string } | null;
}

/**
 * Discovers the widest eth_getLogs width an endpoint actually SERVED, one
 * request per width, ascending, stopping at the first refusal or quota error.
 * Throws when even the conservative floor cannot be served.
 */
export declare function probeLogChunkSize(input: {
  requestChunk: (width: bigint) => Promise<unknown> | unknown;
  ladder?: ReadonlyArray<bigint | number>;
  maxChunk?: bigint | number;
  isRangeError?: (err: unknown) => boolean;
  isQuotaError?: (err: unknown) => boolean;
}): Promise<LogChunkProbe>;

/** One recorded width reduction during an adaptive scan. */
export interface LogScanShrink {
  from: bigint;
  to: bigint;
  at: bigint;
}

export interface AdaptiveLogScanResult<T = unknown> extends LogScanResult<T> {
  /** The width in force when the scan finished (only ever narrower than asked). */
  chunkSize: bigint;
  requestedChunkSize: bigint;
  shrinks: LogScanShrink[];
}

/**
 * The adaptive superset of runLogScan: the same complete, gap-free, ordered
 * certification, allowed to shrink the width when the endpoint refuses a range.
 * Fails closed on anything else, and enforces the chunk/block budgets (worst
 * case, at the floor width) before the first request.
 */
export declare function runAdaptiveLogScan<T = unknown>(input: {
  fetchChunk: (from: bigint, to: bigint) => Promise<T[]> | T[];
  from: bigint | number | string;
  to: bigint | number | string;
  chunkSize?: bigint | number | string;
  maxChunk?: bigint | number | string;
  minChunk?: bigint | number | string;
  maxChunks?: bigint | number | string | null;
  maxBlocks?: bigint | number | string | null;
  isRangeError?: (err: unknown) => boolean;
  onShrink?: (shrink: LogScanShrink & { detail: string }) => void;
}): Promise<AdaptiveLogScanResult<T>>;

/** How an RPC failure must be treated. */
export type RpcErrorKind = "rate-limit" | "range-limit" | "revert" | "transient" | "unknown";

export interface ClassifiedRpcError {
  kind: RpcErrorKind;
  status: number | null;
  code: number | null;
  retryAfterMs: number | null;
  reason: string;
}

/** Classifies an RPC failure (never throws). */
export declare function classifyRpcError(err: unknown, opts?: { nowMs?: number }): ClassifiedRpcError;
/** Parses a `Retry-After` value (delta-seconds or HTTP-date) into milliseconds. */
export declare function parseRetryAfter(value: unknown, opts?: { nowMs?: number }): number | null;

export interface RateLimitBackoff {
  waitMs: number;
  source: "retry-after" | "exponential";
  exceedsBudget: boolean;
}
export declare function rateLimitBackoffMs(input?: {
  attempt: number;
  retryAfterMs?: number | null;
  baseMs?: number;
  maxMs?: number;
  retryAfterCapMs?: number;
  jitterMs?: number;
}): RateLimitBackoff;

export interface RateLimitDecision extends RateLimitBackoff {
  retry: boolean;
  reason: string | null;
}
export declare function shouldRetryRateLimit(input?: {
  attempt: number;
  maxAttempts?: number;
  retryAfterMs?: number | null;
  baseMs?: number;
  maxMs?: number;
  retryAfterCapMs?: number;
  jitterMs?: number;
}): RateLimitDecision;

/** The exact JSON-RPC `eth_getLogs` params for the historical one-shot scan. */
export interface SwapExecutedLogFilter {
  address: Hex;
  topics: [Hex, Hex];
  fromBlock: Hex;
  toBlock: Hex;
}
/** An address as an indexed topic (left-padded to 32 bytes, lowercase). */
export declare function takerTopicFor(wallet: string): Hex;
export declare function swapExecutedLogFilter(input: {
  executor?: string;
  wallet: string;
  fromBlock: bigint | number | string;
  toBlock: bigint | number | string;
  maxChunk?: bigint | number | string;
}): SwapExecutedLogFilter;
export declare function codeDispatchesSelector(code: unknown, selector: string): boolean;
export declare function safeErrorMessage(err: unknown, secrets?: ReadonlyArray<string | undefined>): string;

/** A decoded EVM revert payload (never throws; unknown data is reported verbatim). */
export interface DecodedRevert {
  selector: string | null;
  kind: "none" | "empty" | "custom" | "unknown" | "Error(string)" | "Panic(uint256)";
  name: string | null;
  reason: string | null;
  text: string;
}

/** Every custom error reachable from the delegated swap call frame. */
export declare const KNOWN_REVERT_SIGNATURES: ReadonlyArray<string>;
/** selector -> signature, derived from KNOWN_REVERT_SIGNATURES. */
export declare const KNOWN_REVERT_SELECTORS: Readonly<Record<string, string>>;
export declare function decodeRevertData(data: unknown): DecodedRevert;
/**
 * One-line, secret-redacted description of a failed contract call that KEEPS
 * the decoded revert reason (viem puts it on the second line of
 * `shortMessage`, which `safeErrorMessage` drops).
 */
export declare function describeContractError(
  err: unknown,
  secrets?: ReadonlyArray<string | undefined>,
): { detail: string; decoded: DecodedRevert | null };

// ---------------------------------------------------------------------------
// Deterministic identity + math
// ---------------------------------------------------------------------------
export declare function canaryIdentityFor(wallet: string): CanaryIdentity;
export declare function nonceBitPosition(permitNonce: string | bigint): NonceBitPosition | null;
export declare function nonceBitmapWordMarks(bitmapWord: unknown, permitNonce: unknown): boolean | null;
export declare function feeSplit(gross: unknown, feeBps?: unknown): FeeSplit | null;
export declare function minOutFromQuote(quote: unknown, slippageBps?: unknown): bigint | null;
export declare function quoteWithinSanityBand(quote: unknown): { ok: boolean; detail: string };

// ---------------------------------------------------------------------------
// Authorization construction (must agree with the deployed contract)
// ---------------------------------------------------------------------------
export declare function actionWitnessHash(witness: ActionWitness): Hex;
export declare function buildActionWitness(input: {
  owner: string | Hex;
  minAmountOut: unknown;
  deadline: unknown;
  actionId: Hex;
  policyHash: Hex;
}): ActionWitness;
export declare function buildPermitTypedData(
  payload: { permit: PermitInput; witness: ActionWitness },
  chainId?: number,
  spender?: Hex,
): Eip712TypedData;
export declare function buildSwapParams(input: { owner: string; quoteMinOut: unknown; deadline: unknown; actionId: Hex }): SwapParams;
export declare function buildPermit2Authorization(input: {
  owner: string;
  permit: PermitInput;
  witness: ActionWitness;
  signature: Hex;
}): Permit2Authorization;

// ---------------------------------------------------------------------------
// The gates
// ---------------------------------------------------------------------------
export declare function evaluateModeGuard(input: {
  mode: unknown;
  rpcUrls: unknown;
  /** The one endpoint this run may use (SMOKE_DELEGATED_RPC_URL). */
  configuredRpcUrl?: unknown;
  keyEnvValue: unknown;
  walletPinEnvValue: unknown;
  githubActions: unknown;
  emergencyDisabled: unknown;
}): GateResult;
/**
 * Readiness of the ONE endpoint that will certify the historical scan. Every
 * row is fatal: a run that cannot read the chain completely may not certify a
 * one-shot and may not broadcast.
 */
export declare function evaluateRpcReadiness(input: {
  mode: unknown;
  rpcUrl: unknown;
  chainId: unknown;
  headBlock: unknown;
  probe: unknown;
  rateLimited?: unknown;
  retryAfterMs?: unknown;
  chunkSize?: bigint | number | string;
  requestedChunkSize?: bigint | number | string;
  deployBlock?: bigint | number | string;
}): GateResult;
export declare function evaluateSignerIdentity(input: { mode: unknown; derivedSigner: unknown; pinnedWallet: unknown; extraForbidden?: unknown[] }): GateResult;
export declare function evaluateConfigPins(input: { config: unknown; record: unknown }): GateResult;
export declare function evaluateLivePreconditions(facts?: Record<string, unknown>): BlockedGateResult;
export declare function evaluatePostTradeVerification(facts?: Record<string, unknown>): PostTradeResult;

// ---------------------------------------------------------------------------
// One-shot ledger
// ---------------------------------------------------------------------------
export declare function ledgerFileName(input?: { chainId?: number; wallet?: string; campaign?: string }): string;
export declare function evaluateLedgerGuard(input: { mode: unknown; ledger: unknown; wallet: string; ack?: unknown; campaign?: string; chainId?: number }): BlockedGateResult;
export declare function buildLedgerEntry(input: { wallet: string; mode: string; claimId: string; startedAt: string; chainId?: number; campaign?: string }): LedgerEntry;
export declare function evaluateLedgerClaim(input?: { wallet?: string; ledgerDir?: string; campaign?: string }): {
  fileName: string;
  path: string;
  instruction: string;
};

// ---------------------------------------------------------------------------
// Rehearsal principals + reporting
// ---------------------------------------------------------------------------
export declare function rehearsalPrincipal(label: string): { privateKey: Hex; label: string };
export declare function rehearsalPrincipals(): { owner: { privateKey: Hex; label: string }; broadcaster: { privateKey: Hex; label: string } };
export declare function renderTitle(mode: unknown): string;
/** True for a recorded observation that is deliberately not a verdict. */
export declare function isInformational(check: unknown): boolean;
/** The checks that decide the exit code: everything that is not informational. */
export declare function blockingFailures(checks?: GateCheck[]): GateCheck[];
export declare function summarizeChecks(checks?: GateCheck[]): {
  passed: number;
  total: number;
  failed: string[];
  informational: number;
};
