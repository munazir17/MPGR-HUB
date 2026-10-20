// lib/swap/v2/posture-abi.ts
// Governance/pause posture reads and the path event for MPGRSwapExecutorV2.
//
// `./abi.ts` is a generated artifact (solc 0.8.24) covering the swap entry
// points, the SwapExecuted event and the errors. It intentionally is not
// hand-edited. The entries below are the remaining public surface the app
// needs in order to (a) fail closed on the live posture before quoting and
// (b) verify settlement hop accounting. `lib/swap/v2/abi-parity.test.ts`
// proves the union of both ABIs covers every public getter and event declared
// in contracts/swap/MPGRSwapExecutorV2.sol, so this split cannot silently
// drift from the contract.
//
// Signatures are copied verbatim from the deployed source revision:
//   uint16  public feeBps;              address public feeRecipient;
//   uint16  public pendingFeeBps;       address public pendingFeeRecipient;
//   uint48  public pendingEffectiveAt;  (Pausable) bool public paused;
//   uint256 public constant BPS_DENOMINATOR = 10_000;
//   uint16  public constant MAX_FEE_BPS = 100;
//   uint48  public constant FEE_TIMELOCK_SECONDS = 48 hours;   // 172800
//   address public constant GOVERNANCE_SAFE;   address public constant PINNED_FEE_RECIPIENT;
//   address public constant V4_POOL_MANAGER;
//   uint8   public constant FLAG_NATIVE_IN = 1;  uint8 public constant FLAG_NATIVE_OUT = 2;
//   event SwapPathExecuted(bytes32 indexed intentId, bytes32 indexed pathHash, uint8 hops);
import type { Abi } from "viem";

const view = (name: string, type: string) => ({
  type: "function", name, inputs: [], outputs: [{ name: "", type, internalType: type }], stateMutability: "view",
}) as const;

export const SWAP_V2_POSTURE_ABI = [
  view("paused", "bool"),
  view("pendingFeeBps", "uint16"),
  view("pendingFeeRecipient", "address"),
  view("pendingEffectiveAt", "uint48"),
  view("BPS_DENOMINATOR", "uint256"),
  view("FEE_TIMELOCK_SECONDS", "uint48"),
  view("GOVERNANCE_SAFE", "address"),
  view("PINNED_FEE_RECIPIENT", "address"),
  view("V4_POOL_MANAGER", "address"),
  view("FLAG_NATIVE_IN", "uint8"),
  view("FLAG_NATIVE_OUT", "uint8"),
  {
    type: "event", name: "SwapPathExecuted", anonymous: false,
    inputs: [
      { name: "intentId", type: "bytes32", indexed: true, internalType: "bytes32" },
      { name: "pathHash", type: "bytes32", indexed: true, internalType: "bytes32" },
      { name: "hops", type: "uint8", indexed: false, internalType: "uint8" },
    ],
  },
] as const satisfies Abi;

/** Public getters/events the generated swap ABI already carries. Kept explicit
 * so the parity test can assert full coverage without duplicating entries. */
export const SWAP_V2_ABI_COVERED_NAMES: readonly string[] = [
  "MAX_FEE_BPS", "feeBps", "feeRecipient", "owner", "quoteFee", "routerFactory",
  "routerKind", "swapExactInput", "swapExactInputSplit", "SwapExecuted",
] as const;

export const SWAP_V2_POSTURE_NAMES: readonly string[] = SWAP_V2_POSTURE_ABI
  .map((entry) => entry.name) as readonly string[];
