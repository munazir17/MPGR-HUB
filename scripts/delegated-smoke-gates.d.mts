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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export declare function sameAddress(a: unknown, b: unknown): boolean;
export declare function normalizeAddress(value: unknown, label?: string): NormalizeResult;
export declare function isPrivateKeyShape(value: unknown): boolean;
export declare function isBytes32(value: unknown): boolean;
export declare function redact(text: string, secrets?: ReadonlyArray<string | undefined>): string;
export declare function isLocalRpc(url: unknown): boolean;
export declare function priorSwapScanWindow(input: {
  head: bigint;
  deployBlock?: bigint;
  rehearsal?: boolean;
  window?: bigint;
}): { from: bigint; to: bigint };
export declare function codeDispatchesSelector(code: unknown, selector: string): boolean;
export declare function safeErrorMessage(err: unknown, secrets?: ReadonlyArray<string | undefined>): string;

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
  keyEnvValue: unknown;
  walletPinEnvValue: unknown;
  githubActions: unknown;
  emergencyDisabled: unknown;
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
export declare function summarizeChecks(checks?: GateCheck[]): { passed: number; total: number; failed: string[] };
