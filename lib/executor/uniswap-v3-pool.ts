// lib/executor/uniswap-v3-pool.ts
//
// Deterministic Uniswap V3 pool address derivation (CREATE2). Pure math: no
// RPC, no signing, no sending. Used to PROVE that a registered route points at
// the pool the official Uniswap V3 factory would create, instead of trusting a
// copy-pasted address.
//
//   pool = keccak256(0xff ++ factory ++ keccak256(token0, token1, fee) ++ INIT_CODE_HASH)[12:32]
//
// `token0` is the lower of the two addresses (Uniswap V3 orders the pair).

import { concat, encodeAbiParameters, getAddress, keccak256, type Address, type Hex } from "viem";

/**
 * keccak256 of the `UniswapV3Pool` creation bytecode published in
 * @uniswap/v3-core@1.0.1 (the canonical hash the v3 SDK uses).
 *
 * Cross-checked in lib/executor/__tests__/uniswap-v3-mainnet-route.test.ts: the
 * same formula reproduces the well-known Base WETH/USDC 0.05% pool
 * 0xd0b53D9277642d899DF5C87A3966A349A798F224, so the hash is correct for the
 * Base factory and not just for Ethereum mainnet.
 */
export const UNISWAP_V3_POOL_INIT_CODE_HASH: Hex = "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";

/** Uniswap V3 orders the pair by address: token0 < token1. */
export function uniswapV3TokenOrder(tokenA: Address, tokenB: Address): [Address, Address] {
  return tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
}

/** The address the factory would create for (tokenA, tokenB, fee) — and the only
 *  address `factory.getPool(tokenA, tokenB, fee)` can ever return for it. */
export function computeUniswapV3PoolAddress(
  factory: Address,
  tokenA: Address,
  tokenB: Address,
  fee: number,
  initCodeHash: Hex = UNISWAP_V3_POOL_INIT_CODE_HASH,
): Address {
  const [token0, token1] = uniswapV3TokenOrder(getAddress(tokenA), getAddress(tokenB));
  const salt = keccak256(
    encodeAbiParameters(
      [
        { name: "token0", type: "address" },
        { name: "token1", type: "address" },
        { name: "fee", type: "uint24" },
      ],
      [token0, token1, fee],
    ),
  );
  const hash = keccak256(concat(["0xff", factory, salt, initCodeHash]));
  return getAddress(`0x${hash.slice(26)}`);
}
