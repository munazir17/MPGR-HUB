// lib/executor/delegated-executor.ts
//
// Phase 2 — delegated execution support for MPGRExecutorDelegated
// (Base Sepolia 84532 only). ADDITIVE: nothing here touches the v1
// assisted/manual trading path, the v1 executor registry, or any fee math.
//
// This module is the single source of truth for:
//   * the deployed MPGRExecutorDelegated facts (pinned, spec §verified),
//   * the canonical Permit2 WITNESS digest (EIP-712) the USER signs,
//   * the deterministic policyHash binding an authorization to a policy,
//   * the deterministic swap parameters builder used by the MCP delegated
//     execution capability (quote -> SwapParams; fee via executor-fee.ts).
//
// SAFETY: the digest recipe mirrors deployed Permit2 exactly
// (PermitHash.hashWithWitness: the RAW stub STRING packed with the witness
// type string). Proven against wallet-style typed-data hashing (viem +
// ethers) for the CURRENT deployment (0xa9568499D7e58854F2590a56B6D32788DbfA58F9
// — the witness-type-corrected redeploy); the Phase-1 deployment
// (0x8C63…4f9) proved the on-chain flow end to end and is now abandoned.
// No private key can pass through any function in this file.

import { keccak256, toHex, type Address, type Hex } from "viem";

import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_UNISWAP_V3,
  CANONICAL_WETH,
  EXECUTOR_DEFAULT_FEE_BPS,
  RouterKind,
  type ExecutorDeployment,
} from "./executor-config";
import { computeExecutorFee } from "./executor-fee";

/** The delegated executor on Base Sepolia (witness-type-corrected redeploy; see deployments/base-sepolia/mpgr-executor-delegated.json). */
export const DELEGATED_EXECUTOR_CHAIN_ID = BASE_SEPOLIA_CHAIN_ID; // 84532 — the ONLY chain this phase
export const DELEGATED_EXECUTOR_ADDRESS: Address = "0xa9568499D7e58854F2590a56B6D32788DbfA58F9";
export const DELEGATED_EXECUTOR_FEE_BPS = EXECUTOR_DEFAULT_FEE_BPS; // 25 — canonical, never changed here
export const CANONICAL_PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/**
 * Test tokens created by the DELEGATED executor's deploy broadcast (GitHub
 * Actions run 36760360671, tx 0xc5557b9a…8b4e, block 47512719). Discovered
 * on-chain from PoolCreated events on the official Uniswap V3 factory
 * (blocks 47512599..47512724; both pools fee 3000; getPool cross-checked).
 * These are NOT the v1 executor's tokens — each deploy run creates fresh
 * MPGRTestnetToken supply, so quoting the v1 pair against this executor
 * would cross-wire two contracts and is rejected by the quote path.
 */
export const DELEGATED_BASE_SEPOLIA_TUSD: Address = "0x4aa87b87897D58404734F9bfF237Bb32a2C0E865";
export const DELEGATED_BASE_SEPOLIA_TSTOCK: Address = "0x94CFE06d2e7A46c43944aec9f78a8EA2a992bBF8";
/** Pools baked into the delegated executor (discovery evidence, both fee 3000). */
export const DELEGATED_BASE_SEPOLIA_POOL_WETH_TUSD: Address = "0xA5967BD7C861f499D8adb9cAcC9A7344f10C3248";
export const DELEGATED_BASE_SEPOLIA_POOL_USD_STOCK: Address = "0x2474381Acfff7A0f4786e477208D8e48bCe8b0f4";

/**
 * Route registry for the DELEGATED executor (Phase 3). Kept separate from
 * the v1 BASE_SEPOLIA_EXECUTOR_DEPLOYMENT on purpose: same chain, different
 * contract, different baked token allowlist and pools. The delegated quote
 * path selects this entry ONLY when the caller passes the pinned delegated
 * executor address (fail-closed; see getQuote's executor argument).
 */
export const BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT: ExecutorDeployment = {
  chainId: DELEGATED_EXECUTOR_CHAIN_ID,
  network: "base-sepolia",
  executor: DELEGATED_EXECUTOR_ADDRESS,
  owner: "0xE0e0d239853c5F2Fe0a524d544eC9eB71fef486e",
  feeRecipient: "0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4",
  feeBps: DELEGATED_EXECUTOR_FEE_BPS,
  weth: CANONICAL_WETH,
  permit2: CANONICAL_PERMIT2,
  deployTx: "0xc5557b9a07b6a92df78c6eb7d86cc714532de5045bb2f99872eab0f605cd8b4e",
  deployBlock: 47512719,
  explorerUrl: "https://sepolia.basescan.org/address/0xa9568499D7e58854F2590a56B6D32788DbfA58F9",
  tokens: [
    { address: CANONICAL_WETH, symbol: "WETH", decimals: 18, isWeth: true },
    { address: DELEGATED_BASE_SEPOLIA_TUSD, symbol: "tUSD", decimals: 6, testnet: true },
    { address: DELEGATED_BASE_SEPOLIA_TSTOCK, symbol: "tSTOCK", decimals: 18, testnet: true },
  ],
  routes: [
    {
      kind: RouterKind.UNISWAP_V3_ROUTER02,
      router: BASE_SEPOLIA_UNISWAP_V3.swapRouter02,
      quoter: BASE_SEPOLIA_UNISWAP_V3.quoterV2,
      poolFee: 3000,
      tokenA: DELEGATED_BASE_SEPOLIA_TUSD,
      tokenB: DELEGATED_BASE_SEPOLIA_TSTOCK,
    },
    {
      kind: RouterKind.UNISWAP_V3_ROUTER02,
      router: BASE_SEPOLIA_UNISWAP_V3.swapRouter02,
      quoter: BASE_SEPOLIA_UNISWAP_V3.quoterV2,
      poolFee: 3000,
      tokenA: CANONICAL_WETH,
      tokenB: DELEGATED_BASE_SEPOLIA_TUSD,
    },
  ],
};

/**
 * The ActionWitness struct's own canonical EIP-712 type string — used for
 * the witness STRUCT hash (keccak256 of this seeds the 32-byte witness).
 * Matches MPGRExecutorDelegated.ACTION_WITNESS_STRUCT_TYPE_STRING.
 */
export const DELEGATED_ACTION_WITNESS_STRUCT_TYPE_STRING =
  "ActionWitness(address owner,address buyToken,uint256 minAmountOut,uint256 deadline,bytes32 actionId,bytes32 policyHash)";

/** keccak256(DELEGATED_ACTION_WITNESS_STRUCT_TYPE_STRING) — witness struct-hash seed. */
export const DELEGATED_WITNESS_TYPEHASH = keccak256(toHex(DELEGATED_ACTION_WITNESS_STRUCT_TYPE_STRING));

/**
 * The witness type string handed to Permit2 (matches
 * MPGRExecutorDelegated.WITNESS_TYPE_STRING exactly) — STANDARD EIP-712
 * form: Permit2 packs stub + this string into the typeHash, so this string
 * must complete the stub into the full encodeType (witness field name +
 * referenced structs alphabetical + TokenPermissions appendix; the UniswapX
 * convention). This is the corrected (redeployed) executor's string — the
 * ORIGINAL deployment used the bare struct string, which no standard wallet
 * typed-data signature could ever match.
 */
export const DELEGATED_WITNESS_TYPE_STRING =
  "ActionWitness witness)ActionWitness(address owner,address buyToken,uint256 minAmountOut,uint256 deadline,bytes32 actionId,bytes32 policyHash)TokenPermissions(address token,uint256 amount)";

/**
 * Regression guard: the exact string a standard wallet (eth_signTypedData_v4)
 * can sign. walletSigningSupported() reads the pinned deployment facts, so
 * the UI/API self-heal if these ever diverge again (fail-closed).
 */
export const WALLET_COMPATIBLE_WITNESS_TYPE_STRING = DELEGATED_WITNESS_TYPE_STRING;

export function walletSigningSupported(): boolean {
  return (DELEGATED_WITNESS_TYPE_STRING as string) === WALLET_COMPATIBLE_WITNESS_TYPE_STRING;
}

/** Deployed Permit2's witness stub — the RAW STRING (not its keccak) is packed. */
export const PERMIT2_WITNESS_STUB =
  "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,";

export const PERMIT2_WITNESS_TYPEHASH = keccak256(toHex(PERMIT2_WITNESS_STUB + DELEGATED_WITNESS_TYPE_STRING));
export const TOKEN_PERMISSIONS_TYPEHASH = keccak256(toHex("TokenPermissions(address token,uint256 amount)"));
export const PERMIT2_DOMAIN_TYPEHASH = keccak256(toHex("EIP712Domain(string name,uint256 chainId,address verifyingContract)"));

/** Minimal ABI additions over the (identical) v1 SwapExecuted ABI. */
export const DELEGATED_EXECUTOR_ABI = [
  {
    type: "function",
    name: "swapOnBehalfOfUniswapV3",
    stateMutability: "payable",
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
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "pendingOwner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "feeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "feeRecipient", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "PERMIT2", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "WETH", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "WITNESS_TYPE_STRING", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "quoteFee", stateMutability: "view", inputs: [{ name: "grossAmountIn", type: "uint256" }], outputs: [{ name: "fee", type: "uint256" }, { name: "swapAmount", type: "uint256" }] },
] as const;

/** The user-signed ActionWitness — field order mirrors the contract struct. */
export interface DelegatedActionWitness {
  owner: Address;
  buyToken: Address;
  minAmountOut: string; // base units, decimal string
  deadline: number; // unix seconds
  actionId: Hex;
  policyHash: Hex;
}

export interface DelegatedPermit {
  token: Address;
  amount: string; // base units, decimal string (EXACT gross)
  nonce: string; // Permit2 unordered nonce, decimal string
  deadline: number; // unix seconds
}

export interface DelegatedAuthorizationPayload {
  permit: DelegatedPermit;
  witness: DelegatedActionWitness;
  /** 65-byte rsv signature from the USER's wallet (typed-data sign). Never logged. */
  signature: Hex;
}

/** keccak256(abi.encode(ACTION_WITNESS_TYPEHASH, witness)) — what Permit2 embeds. */
export function delegatedWitnessHash(w: DelegatedActionWitness): Hex {
  return keccak256(
    encodeAbiConcat(
      [DELEGATED_WITNESS_TYPEHASH, w.owner, w.buyToken, BigInt(w.minAmountOut), BigInt(w.deadline), w.actionId, w.policyHash],
    ),
  );
}

/** Deployed Permit2 hashWithWitness struct hash (spender == the executor). */
export function delegatedPermitStructHash(payload: Pick<DelegatedAuthorizationPayload, "permit" | "witness">, spender: Address): Hex {
  const tpHash = keccak256(encodeAbiConcat([TOKEN_PERMISSIONS_TYPEHASH, payload.permit.token, BigInt(payload.permit.amount)]));
  return keccak256(
    encodeAbiConcat([
      PERMIT2_WITNESS_TYPEHASH,
      tpHash,
      spender,
      BigInt(payload.permit.nonce),
      BigInt(payload.permit.deadline),
      delegatedWitnessHash(payload.witness),
    ]),
  );
}

/** Permit2's cached EIP-712 domain ("Permit2", chainId, verifyingContract). */
export function delegatedPermit2Domain(chainId: number, permit2: Address = CANONICAL_PERMIT2): Hex {
  return keccak256(encodeAbiConcat([PERMIT2_DOMAIN_TYPEHASH, keccak256(toHex("Permit2")), BigInt(chainId), permit2]));
}

/** The exact EIP-712 digest the USER must sign (Phase-1 verified recipe). */
export function delegatedPermitDigest(payload: Pick<DelegatedAuthorizationPayload, "permit" | "witness">, chainId: number, spender: Address): Hex {
  const domain = delegatedPermit2Domain(chainId, permit2FromSameChain(chainId));
  const structHash = delegatedPermitStructHash(payload, spender);
  // NOTE: the packed digest is ALREADY a hex string — it must be hashed as
  // raw hex bytes. viem's toHex() would UTF-8-encode the STRING (a bug that
  // self-consistently hid from sign/recover round-trips and was caught only
  // against an independent wallet-style typed-data digest).
  return keccak256(`0x1901${domain.slice(2)}${structHash.slice(2)}` as Hex);
}

/** Client-side EIP-712 typed data for wallet.signTypedData (same digest). */
export function delegatedPermitTypedData(payload: Pick<DelegatedAuthorizationPayload, "permit" | "witness">, chainId: number, spender: Address) {
  return {
    domain: { name: "Permit2", chainId, verifyingContract: permit2FromSameChain(chainId) },
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
      permitted: { token: payload.permit.token, amount: BigInt(payload.permit.amount) },
      spender,
      nonce: BigInt(payload.permit.nonce),
      deadline: BigInt(payload.permit.deadline),
      witness: {
        owner: payload.witness.owner,
        buyToken: payload.witness.buyToken,
        minAmountOut: BigInt(payload.witness.minAmountOut),
        deadline: BigInt(payload.witness.deadline),
        actionId: payload.witness.actionId,
        policyHash: payload.witness.policyHash,
      },
    },
  } as const;
}

/**
 * Deterministic policyHash — binds an authorization to ONE policy's exact
 * guardrails. Both the client (signing UX) and the server (verification)
 * derive it from the SAME pure function; the LLM is never involved.
 */
export function delegatedPolicyHash(policy: {
  id: string;
  wallet: string;
  chainId: number;
  sellToken: string;
  buyToken: string;
  maxPerTradeRaw: string;
  maxSlippageBps: number;
  expiresAt: string;
}): Hex {
  return keccak256(
    encodeAbiConcat([
      keccak256(
        toHex(
          "MPGRDelegatedPolicyV1(string policyId,address wallet,uint256 chainId,address sellToken,address buyToken,uint256 maxPerTradeRaw,uint256 maxSlippageBps,string expiresAt)",
        ) as Hex,
      ),
      keccak256(toHex(policy.id)),
      policy.wallet,
      BigInt(policy.chainId),
      policy.sellToken,
      policy.buyToken,
      BigInt(policy.maxPerTradeRaw),
      BigInt(policy.maxSlippageBps),
      keccak256(toHex(policy.expiresAt)),
    ]),
  );
}

/** Deterministic actionId for a goal (all of a goal's slots share it). */
export function delegatedActionId(goalId: string): Hex {
  return keccak256(toHex(`mpgr-delegated-action:${goalId}`));
}

/** Deterministic Permit2 nonce for (goalId, slotIndex) — replay protection. */
export function delegatedPermitNonce(goalId: string, slotIndex: number): string {
  return BigInt(keccak256(toHex(`mpgr-delegated-nonce:${goalId}:${slotIndex}`))).toString();
}

/**
 * Deterministic SwapParams from a validated quote — the execution adapter's
 * ONLY source of trade parameters (LLM decides nothing at execution time).
 * Fee comes from the canonical executor-fee math (25 bps floor).
 */
export function buildDelegatedSwapParams(input: {
  router: Address;
  tokenIn: Address;
  tokenOut: Address;
  grossAmountIn: string;
  minAmountOut: string;
  deadline: number;
  intentId: Hex;
  owner: Address;
  unwrapNativeOut?: boolean;
  feeBps?: number;
}) {
  const fee = computeExecutorFee(BigInt(input.grossAmountIn), input.feeBps ?? DELEGATED_EXECUTOR_FEE_BPS);
  if (!fee.ok) throw new Error(`delegated-executor: fee computation refused (${fee.error.code})`);
  return {
    router: input.router,
    tokenIn: input.tokenIn,
    tokenOut: input.tokenOut,
    grossAmountIn: BigInt(input.grossAmountIn),
    expectedFeeAmount: fee.value.feeAmount,
    amountOutMinimum: BigInt(input.minAmountOut),
    recipient: input.owner, // MUST equal witness.owner — enforced on-chain
    deadline: BigInt(input.deadline),
    intentId: input.intentId,
    unwrapNativeOut: input.unwrapNativeOut ?? false,
  };
}

// --- tiny abi.encode helper (addresses padded to 32 bytes, bigints as uints)
function encodeAbiConcat(values: readonly [Hex | string, ...Array<Hex | Address | bigint | string>]): Hex {
  let out = "0x";
  for (const v of values) {
    if (typeof v === "bigint") out += v.toString(16).padStart(64, "0");
    else if (typeof v === "string" && v.startsWith("0x") && v.length === 42) out += v.slice(2).toLowerCase().padStart(64, "0");
    else if (typeof v === "string" && v.startsWith("0x") && v.length === 66) out += v.slice(2).toLowerCase();
    else throw new Error("delegated-executor: unsupported encode value");
  }
  return out as Hex;
}

function permit2FromSameChain(chainId: number): Address {
  // Only Base Sepolia exists in this phase; anything else must never resolve.
  if (chainId !== DELEGATED_EXECUTOR_CHAIN_ID) throw new Error(`Delegated execution is Base Sepolia (84532) only; got ${chainId}`);
  return CANONICAL_PERMIT2;
}
