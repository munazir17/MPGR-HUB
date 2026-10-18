// lib/swap/swap-executor-abi.ts
// Typed ABI slice for contracts/swap/MPGRSwapExecutor.sol (release candidate).
// Swap-only: the deployed MPGR Executor ABI and Agent code paths are untouched.
export const MPGR_SWAP_EXECUTOR_ABI = [
  { type: "function", name: "swapExactInput", stateMutability: "payable",
    inputs: [
      { name: "p", type: "tuple", components: [
        { name: "router", type: "address" }, { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
        { name: "grossAmountIn", type: "uint256" }, { name: "expectedFeeAmount", type: "uint256" },
        { name: "amountOutMinimum", type: "uint256" }, { name: "recipient", type: "address" },
        { name: "deadline", type: "uint256" }, { name: "intentId", type: "bytes32" }, { name: "unwrapNativeOut", type: "bool" }] },
      { name: "path", type: "tuple[]", components: [
        { name: "router", type: "address" }, { name: "tokenOut", type: "address" }, { name: "kind", type: "uint8" },
        { name: "poolFee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "stable", type: "bool" },
        { name: "pool", type: "address" }] },
      { name: "auth", type: "tuple", components: [
        { name: "kind", type: "uint8" }, { name: "deadline", type: "uint256" }, { name: "nonce", type: "uint256" },
        { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }, { name: "signature", type: "bytes" }] },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }] },
  { type: "function", name: "quoteFee", stateMutability: "pure",
    inputs: [{ name: "grossAmountIn", type: "uint256" }],
    outputs: [{ name: "fee", type: "uint256" }, { name: "swapAmount", type: "uint256" }] },
  { type: "function", name: "feeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "feeRecipient", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "routerKind", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint8" }] },
  { type: "function", name: "routerFactory", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] },
  { type: "function", name: "isTokenAllowed", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "event", name: "SwapExecuted", anonymous: false,
    inputs: [
      { name: "taker", type: "address", indexed: true }, { name: "router", type: "address", indexed: true },
      { name: "intentId", type: "bytes32", indexed: true }, { name: "tokenIn", type: "address", indexed: false },
      { name: "tokenOut", type: "address", indexed: false }, { name: "grossAmountIn", type: "uint256", indexed: false },
      { name: "feeAmount", type: "uint256", indexed: false }, { name: "swapAmountIn", type: "uint256", indexed: false },
      { name: "amountOut", type: "uint256", indexed: false }, { name: "feeRecipient", type: "address", indexed: false },
      { name: "feeBps", type: "uint16", indexed: false }, { name: "routerKind", type: "uint8", indexed: false },
      { name: "flags", type: "uint8", indexed: false }] },
  { type: "event", name: "SwapPathExecuted", anonymous: false,
    inputs: [
      { name: "intentId", type: "bytes32", indexed: true }, { name: "pathHash", type: "bytes32", indexed: true },
      { name: "hops", type: "uint8", indexed: false }] },
  { type: "error", name: "InvalidPath", inputs: [] },
  { type: "error", name: "FeeMismatch", inputs: [{ name: "expected", type: "uint256" }, { name: "actual", type: "uint256" }] },
  { type: "error", name: "FeeRoundsToZero", inputs: [{ name: "grossAmountIn", type: "uint256" }] },
  { type: "error", name: "FeeDeliveryMismatch", inputs: [] },
  { type: "error", name: "InsufficientOutput", inputs: [{ name: "amountOut", type: "uint256" }, { name: "amountOutMinimum", type: "uint256" }] },
  { type: "error", name: "InputNotFullyConsumed", inputs: [{ name: "balanceBefore", type: "uint256" }, { name: "balanceAfter", type: "uint256" }] },
  { type: "error", name: "TokenNotAllowed", inputs: [{ name: "token", type: "address" }] },
  { type: "error", name: "RouterNotAllowed", inputs: [{ name: "router", type: "address" }, { name: "expected", type: "uint8" }] },
  { type: "error", name: "DeadlineExpired", inputs: [{ name: "deadline", type: "uint256" }, { name: "nowTs", type: "uint256" }] },
  { type: "error", name: "InvalidRecipient", inputs: [{ name: "recipient", type: "address" }, { name: "taker", type: "address" }] },
  { type: "error", name: "NativeValueMismatch", inputs: [{ name: "msgValue", type: "uint256" }, { name: "grossAmountIn", type: "uint256" }] },
  { type: "error", name: "UnwrapRequiresWethOut", inputs: [] },
] as const;
