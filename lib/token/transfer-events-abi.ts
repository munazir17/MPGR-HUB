// lib/token/transfer-events-abi.ts

import { parseAbiItem } from "viem";

// Phase 3E Part 2 — Transfer Event ABI.
//
// Standalone ERC20 Transfer event fragment, kept separate from
// lib/erc20-abi.ts (which only lists the read functions Phase 3E Part 1
// needs for balanceOf/decimals/symbol) so the log-reading path has
// exactly the one ABI item it needs, typed precisely enough for viem to
// infer `args.from` / `args.to` / `args.value` on decoded logs.
//
// Never modifies or duplicates lib/erc20-abi.ts — that file is untouched
// by this phase.

export const transferEventAbiItem = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

export const transferEventAbi = [transferEventAbiItem] as const;
